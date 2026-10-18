import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvalSet } from './fixtures.js';
import { allLabelItems, labelIndex, readLabels } from './labels.js';
import { listRuns, readRoundOutput, readRunMeta, runsRoot, type RunMeta } from './runner.js';
import {
  aggregate,
  labelsHash,
  lexicalSimilarity,
  scoreRound,
  textsToEmbed,
  vectorSimilarity,
  type RoundOutput,
  type RunScore,
  type Similarity,
} from './score.js';
import { DEFAULT_SCORING, sleepEvalRoot, type SleepEvalScoring } from './types.js';
import { exemptionFor } from './exemptions.js';

/**
 * Scores on disk, the one-page report, and the close gate.
 *
 *   runs/<run>/score.json   the run scored against the labels of `labelsHash`
 *   runs/<run>/report.md    the page the owner reads
 *   baseline.json           which run is the baseline, and which parent task it gates
 */

export type Matcher = 'e5' | 'lexical';

export interface StoredScore {
  runId: string;
  at: string;
  labelsHash: string;
  labelled: number;
  matcher: Matcher;
  scoring: SleepEvalScoring;
  score: RunScore;
}

export interface Baseline {
  runId: string;
  /** Parent tasks whose children may not close below this baseline. */
  parents: string[];
  at: string;
}

export function baselinePath(contextRoot: string): string {
  return join(sleepEvalRoot(contextRoot), 'baseline.json');
}

export function readBaseline(contextRoot: string): Baseline | null {
  const p = baselinePath(contextRoot);
  if (!existsSync(p)) return null;
  try {
    const b = JSON.parse(readFileSync(p, 'utf-8')) as Baseline;
    return typeof b.runId === 'string' && Array.isArray(b.parents) ? b : null;
  } catch {
    return null;
  }
}

export function writeBaseline(contextRoot: string, b: Baseline): void {
  writeFileSync(baselinePath(contextRoot), JSON.stringify(b, null, 2) + '\n');
}

export function readStoredScore(contextRoot: string, runId: string): StoredScore | null {
  const p = join(runsRoot(contextRoot), runId, 'score.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as StoredScore;
  } catch {
    return null;
  }
}

/** Embed every compared text once; fall back to lexical overlap without the model. */
export async function buildSimilarity(texts: string[]): Promise<{ sim: Similarity; matcher: Matcher }> {
  try {
    const { embedPassages } = await import('../embeddings/embedder.js');
    const vectors = texts.length > 0 ? await embedPassages(texts) : [];
    if (vectors && vectors.length === texts.length) {
      const map = new Map(texts.map((t, i) => [t, vectors[i]]));
      return { sim: vectorSimilarity(map), matcher: 'e5' };
    }
  } catch {
    /* the model is optional: lexical below */
  }
  return { sim: lexicalSimilarity, matcher: 'lexical' };
}

/** Lexical overlap runs on a different scale than cosine: its thresholds, not the set's. */
const LEXICAL_SCORING = { matchThreshold: 0.3, duplicateThreshold: 0.6 };

/** Score one run against the current labels and store it. */
export async function scoreRun(contextRoot: string, runId: string, simOverride?: { sim: Similarity; matcher: Matcher }): Promise<StoredScore> {
  const set = readEvalSet(contextRoot);
  if (!set) throw new Error('No test set yet.');
  const meta = readRunMeta(contextRoot, runId);
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  const entries = readLabels(contextRoot);
  const labels = labelIndex(entries);
  const items = allLabelItems(contextRoot);
  const outputs: RoundOutput[] = meta.rounds
    .map((r) => readRoundOutput(contextRoot, runId, r.round))
    .filter((o): o is RoundOutput => o !== null);
  const { sim, matcher } = simOverride ?? await buildSimilarity(textsToEmbed(items, labels, outputs));
  const scoring = set.scoring ?? DEFAULT_SCORING;
  const thresholds = matcher === 'lexical' ? LEXICAL_SCORING : scoring;
  const score = aggregate(outputs.map((o) => scoreRound(items, labels, o, sim, thresholds)));
  const stored: StoredScore = {
    runId,
    at: new Date().toISOString(),
    labelsHash: labelsHash(entries),
    labelled: labels.size,
    matcher,
    scoring,
    score,
  };
  writeFileSync(join(runsRoot(contextRoot), runId, 'score.json'), JSON.stringify(stored, null, 2) + '\n');
  return stored;
}

// ─── Report ──────────────────────────────────────────────────────────────────

const pct = (x: number | null) => (x === null ? '—' : `%${Math.round(x * 100)}`);
const delta = (a: number | null, b: number | null) => {
  if (a === null || b === null) return '';
  const d = Math.round((a - b) * 100);
  return d === 0 ? '±0' : d > 0 ? `+${d}` : `${d}`;
};

export interface GateVerdict {
  ok: boolean;
  composite: number | null;
  baseline: number | null;
  tolerance: number;
  reason: string;
}

export function gateVerdict(run: StoredScore, base: StoredScore): GateVerdict {
  const tolerance = base.scoring.gateTolerance;
  if (run.labelsHash !== base.labelsHash) {
    return { ok: false, composite: run.score.composite, baseline: base.score.composite, tolerance, reason: 'the two scores were computed against different labels; re-run `dreamcontext sleep eval score` on both' };
  }
  if (run.matcher !== base.matcher) {
    return { ok: false, composite: run.score.composite, baseline: base.score.composite, tolerance, reason: `the two scores used different matchers (${run.matcher} vs ${base.matcher})` };
  }
  const a = run.score.composite;
  const b = base.score.composite;
  if (a === null || b === null) {
    return { ok: false, composite: a, baseline: b, tolerance, reason: 'no composite score yet (no labelled items matched)' };
  }
  const ok = a >= b - tolerance;
  return {
    ok,
    composite: a,
    baseline: b,
    tolerance,
    reason: ok
      ? `composite ${pct(a)} is within ${Math.round(tolerance * 100)} points of the baseline ${pct(b)}`
      : `composite ${pct(a)} dropped more than ${Math.round(tolerance * 100)} points below the baseline ${pct(b)}`,
  };
}

export function renderReport(meta: RunMeta, s: StoredScore, base: StoredScore | null, pendingLabels: number): string {
  const r = s.score;
  const b = base?.score ?? null;
  const totalMs = meta.rounds.reduce((n, x) => n + x.wallMs, 0);
  const cost = meta.rounds.reduce((n, x) => n + (x.costUsd ?? 0), 0);
  const peak = meta.rounds.reduce((m, x) => Math.max(m, x.load.peak.load1), 0);
  const cores = meta.rounds[0]?.load.before.cores ?? 0;
  const waited = meta.rounds.reduce((n, x) => n + x.load.waitedMs, 0);
  const failed = meta.rounds.filter((x) => x.status !== 'ok');
  const row = (label: string, now: number | null, then: number | null | undefined, count: string) =>
    `| ${label} | ${pct(now)} | ${count} |${base ? ` ${pct(then ?? null)} | ${delta(now, then ?? null)} |` : ''}`;
  const lines: string[] = [];
  lines.push(`# Uyku görev açma ölçümü: ${meta.id}`);
  lines.push('');
  lines.push(`${meta.startedAt.slice(0, 16).replace('T', ' ')} · ${meta.rounds.length} tur · ajan ${meta.agents.join(', ')} (${meta.model ?? 'varsayılan model'}, ${meta.effort ?? 'varsayılan'} effort) · CLI ${meta.cliVersion}${meta.gitSha ? ` @ ${meta.gitSha.slice(0, 8)}` : ''}${meta.label ? ` · ${meta.label}` : ''}${meta.for ? ` · ölçülen alt görev: \`${meta.for}\`` : ''}`);
  lines.push('');
  lines.push('## Skor');
  lines.push('');
  lines.push(`| Ölçü | Değer | Sayım |${base ? ` Taban (${base.runId}) | Fark |` : ''}`);
  lines.push(`|---|---|---|${base ? '---|---|' : ''}`);
  lines.push(row('İsabet: açılan görevden sahibin tutacağı', r.precision, b?.precision, `${r.kept}/${r.opened}`));
  lines.push(row('Açık isteklerin yakalanması', r.askRecall, b?.askRecall, ratioText(r.rounds.map((x) => x.asks))));
  lines.push(row('Doğru ana göreve alt görev olarak gitme', r.parentRate, b?.parentRate, ratioText(r.rounds.map((x) => x.parents))));
  lines.push(row('Tekrar eden düzeltmenin pattern\'e dönüşmesi', r.patternRate, b?.patternRate, ratioText(r.rounds.map((x) => x.patterns))));
  lines.push(row('**Bileşik skor**', r.composite, b?.composite, 'tanımlı oranların ortalaması'));
  lines.push('');
  lines.push(`Gürültü: ${r.duplicates} kopya, ${r.abandoned} vazgeçilmiş iş, ${r.wrongProject} başka projenin işi, ${r.shouldFold ?? 0} var olan göreve eklenmesi gerekirken yeni görev açıldı${b ? ` (taban: ${b.duplicates} / ${b.abandoned} / ${b.wrongProject} / ${b.shouldFold ?? 0})` : ''}.`);
  if (base) {
    const g = gateVerdict(s, base);
    lines.push('');
    lines.push(`**Kapı: ${g.ok ? 'GEÇER' : 'GEÇMEZ'}.** ${g.reason}.`);
  }
  lines.push('');
  lines.push('## Tur tur');
  lines.push('');
  lines.push('| Tur | Açılan | Tutulan | Kopya | Vazgeçilmiş | İstek | Ana görev | Pattern | Süre | Maliyet | Durum |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const rs of r.rounds) {
    const run = meta.rounds.find((x) => x.round === rs.round);
    lines.push(`| ${rs.round} | ${rs.opened} | ${rs.kept} | ${rs.duplicates} | ${rs.abandoned} | ${rs.asks.hit}/${rs.asks.total} | ${rs.parents.hit}/${rs.parents.total} | ${rs.patterns.hit}/${rs.patterns.total} | ${run ? `${Math.round(run.wallMs / 60000)} dk` : '—'} | ${run?.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '—'} | ${run?.status ?? '—'} |`);
  }
  lines.push('');
  lines.push('## Yük');
  lines.push('');
  lines.push(`Turlar sırayla, tek tek koştu. Toplam ${Math.round(totalMs / 60000)} dk, $${cost.toFixed(2)}; en yüksek 1 dk yük ortalaması ${peak.toFixed(2)} (${cores} çekirdek)${waited > 0 ? `; makinenin sakinleşmesi için ${Math.round(waited / 60000)} dk beklendi` : ''}.`);
  if (failed.length > 0) lines.push(`Tamamlanmayan turlar: ${failed.map((f) => `${f.round} (${f.status}${f.note ? `: ${f.note.replace(/\s+/g, ' ').slice(0, 120)}` : ''})`).join('; ')}.`);
  const unknown = r.rounds.flatMap((x) => x.unknown.map((u) => ({ round: x.round, ...u })));
  if (unknown.length > 0) {
    lines.push('');
    lines.push('## Etiketle eşleşmeyen açılan görevler');
    lines.push('');
    lines.push('Tutulmadı sayıldı. Gerçekten iyi bir görevse, bir sonraki etiket turunda eklenir.');
    lines.push('');
    for (const u of unknown.slice(0, 30)) lines.push(`- ${u.round}: **${u.name}**${u.parent ? ` (ana görev \`${u.parent}\`)` : ''}`);
  }
  lines.push('');
  lines.push('## Notlar');
  lines.push('');
  lines.push(`- Eşleştirme: ${s.matcher === 'e5' ? `yerel e5 gömme modeli, kosinüs ≥ ${s.scoring.matchThreshold} aynı iş sayılır` : 'model yok, kelime örtüşmesi'}. Etiketlenen öğe: ${s.labelled}${pendingLabels > 0 ? `, bekleyen: ${pendingLabels}` : ''} (etiket özeti ${s.labelsHash}).`);
  const checked = meta.rounds.reduce((n, x) => n + (x.checked ?? 0), 0);
  const escaped = meta.rounds.flatMap((x) => x.escaped);
  lines.push(escaped.length === 0
    ? `- Her tur kendi scratch vault'unda koştu. Sızıntı denetimi: turların dokunduğu ${checked} gerçek beyin dosyası önce/sonra karşılaştırıldı, değişen yok.`
    : `- SIZINTI: ${escaped.join(', ')} gerçek beyinde değişti; bu koşu geçersiz.`);
  lines.push('- Pano, o turdan önce açılmış bugünkü görev dosyalarıdır (durum ve gövde bugünkü hali); oturumların görev bağları transcriptten çıkarıldı.');
  lines.push('');
  return lines.join('\n');
}

function ratioText(rs: Array<{ hit: number; total: number }>): string {
  const hit = rs.reduce((n, x) => n + x.hit, 0);
  const total = rs.reduce((n, x) => n + x.total, 0);
  return `${hit}/${total}`;
}

export function writeReport(contextRoot: string, runId: string, text: string): string {
  const p = join(runsRoot(contextRoot), runId, 'report.md');
  writeFileSync(p, text);
  return p;
}

// ─── Close gate ──────────────────────────────────────────────────────────────

export interface CloseGate {
  applies: boolean;
  ok: boolean;
  message: string;
}

/**
 * May `child` (a task under a gated parent) close? Only with an eval run made FOR it
 * (`sleep eval run --for <child>`), finished, untainted, scored on the same labels as the
 * baseline, and not below it beyond the set's tolerance. Synchronous on purpose: it reads
 * the stored scores, it never embeds.
 */
export function checkCloseGate(contextRoot: string, child: string, parent: string | null): CloseGate {
  const baseline = readBaseline(contextRoot);
  if (!baseline || !parent || !baseline.parents.includes(parent)) return { applies: false, ok: true, message: '' };
  // An owner's reasoned exemption (journaled and audited, see exemptions.ts). No refusal
  // below names the exempt command: a session that reads a refusal must not be one shell
  // line away from exempting its own task.
  const ex = exemptionFor(contextRoot, child);
  if (ex) return { applies: true, ok: true, message: `Sleep eval gate: exempt (${ex.reason}), recorded ${ex.at} by ${ex.by}.` };
  const runs = listRunsFor(contextRoot, child);
  const run = runs[runs.length - 1];
  const how = `run \`dreamcontext sleep eval run --for ${child}\`, then \`dreamcontext sleep eval score\``;
  if (!run) return { applies: true, ok: false, message: `\`${child}\` sits under \`${parent}\`, which is gated by the sleep eval: ${how}.` };
  if (!run.finishedAt || run.rounds.some((r) => r.status !== 'ok')) {
    return { applies: true, ok: false, message: `The eval run ${run.id} for \`${child}\` did not finish cleanly: ${how}.` };
  }
  const baseMeta = readRunMeta(contextRoot, baseline.runId);
  const sameRounds = (a: RunMeta, b: RunMeta) => {
    const x = a.rounds.map((r) => r.round).sort().join(',');
    return x === b.rounds.map((r) => r.round).sort().join(',');
  };
  if (!baseMeta || baseMeta.setCreatedAt !== run.setCreatedAt || !sameRounds(run, baseMeta)) {
    return { applies: true, ok: false, message: `The eval run ${run.id} did not cover the baseline's test set and rounds (a partial run or a rebuilt set cannot be compared): ${how}.` };
  }
  const s = readStoredScore(contextRoot, run.id);
  const b = readStoredScore(contextRoot, baseline.runId);
  if (!s || !b) return { applies: true, ok: false, message: `The eval run ${run.id} or the baseline ${baseline.runId} is not scored yet: run \`dreamcontext sleep eval score ${run.id}\`.` };
  if (s.labelsHash !== labelsHash(readLabels(contextRoot)) || b.labelsHash !== s.labelsHash) {
    return { applies: true, ok: false, message: `Labels changed since the last score: run \`dreamcontext sleep eval score ${run.id}\` (it re-scores the baseline too).` };
  }
  const g = gateVerdict(s, b);
  return {
    applies: true,
    ok: g.ok,
    message: g.ok
      ? `Sleep eval gate passed: ${g.reason} (run ${run.id}).`
      : `Sleep eval gate: ${g.reason} (run ${run.id} vs baseline ${baseline.runId}). The task cannot close until the score recovers.`,
  };
}

function listRunsFor(contextRoot: string, child: string): RunMeta[] {
  return listRuns(contextRoot).filter((m) => m.for === child);
}
