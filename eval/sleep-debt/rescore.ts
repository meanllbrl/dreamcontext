/**
 * Real-transcript before/after for the sleep-debt honesty fix (`npm run verify:sleep-debt`).
 *
 * Re-scores the sessions a finished consolidation processed (`.sleep-history.json[i]`) plus
 * whatever the live ledger still holds, twice over the SAME transcripts:
 *
 *   - OLD: the frozen `7eca3421` behaviour in `./legacy.ts` (flat `"name"` regexes, per-record
 *     usage sums, raw-line markers, no spawned-session rule, sub-agent briefs mined as user text).
 *   - NEW: the shipped `analyzeSession` + `scoreSession` + `captureSessionMoments`, with a spawned
 *     session's debt forced to 0 exactly as `upsertSessionOnStop` does.
 *
 * Read-only by construction: it reads the brain's state files and `~/.claude/projects`
 * transcripts and returns a report; it never writes. Every vault file it reads is refused when it
 * is a symlink, so a shared brain repo cannot point this at an arbitrary local file.
 *
 * Spawned sessions are recognised AFTER the fact, because the env a builder ran with is gone:
 *   1. the marker the Stop hook stored on a live ledger record (`via` as recorded);
 *   2. a goal-live file that still registers the id (`findRegisteredActor`);
 *   3. a Develop registry line in a task log, `wN-L spawned|resumed|respawned sid <uuid>`,
 *      labelled `via: 'task-log'` so the table never passes inference off as a hook marker.
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeSession,
  captureSessionMoments,
  scoreSession,
  type TranscriptAnalysis,
} from '../../src/cli/commands/hook.js';
import { findRegisteredActor } from '../../src/lib/goal-live.js';
import type { SpawnMarker, SpawnVia } from '../../src/lib/session-origin.js';
import { humanTurnText } from '../../src/lib/transcript-records.js';
import {
  findTranscriptBySessionId,
  resolveTranscript,
  type TranscriptLocation,
} from '../../src/lib/transcript-locate.js';
import type { SalientMoment } from '../../src/lib/salience.js';
import { legacyAnalyzeSession, legacyCaptureMoments, legacyScoreSession } from './legacy.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RescoreOptions {
  /** The `_dream_context/` directory whose history and ledger are re-scored. */
  contextRoot: string;
  /** Home holding `.claude/projects` (injectable for tests). Defaults to the real home. */
  home?: string;
  /** Which `.sleep-history.json` entry to re-score, newest first. Default 0. */
  historyIndex?: number;
}

/** One session to re-score and the consolidation bound its Stop hook scored under. */
export interface SessionSelection {
  sessionId: string;
  sinceISO: string | null;
  source: 'history' | 'ledger';
  /** Ledger records only: the path the Stop hook recorded. */
  transcriptPath: string | null;
  /** Ledger records only: the spawn marker the Stop hook stored. */
  storedSpawn: SpawnMarker | null;
}

export interface RescoreSpawn {
  by: string;
  via: SpawnVia | 'task-log';
}

export interface AxisBreakdown {
  changes: number;
  tools: number;
  tokens: number;
  score: number;
}

export interface MomentCounts {
  corrections: number;
  decisions: number;
  /** Corrections whose body is an orchestrator brief or a hand-back, never a human. */
  briefShaped: number;
}

export interface RescoreRow {
  sessionId: string;
  source: 'history' | 'ledger';
  preview: string;
  found: boolean;
  spawn: RescoreSpawn | null;
  old: AxisBreakdown;
  /** `score` is the debt the session adds now: 0 when spawned. */
  next: AxisBreakdown;
  /** What the new scorer gives the work itself, before the spawned rule zeroes it. */
  scorerScore: number;
  humanTurns: number;
  oldMoments: MomentCounts;
  newMoments: MomentCounts;
  /** Per-record usage sum over per-message usage sum, main transcript only. Null without usage. */
  dedupRatio: number | null;
}

export interface Percentiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface RescoreResult {
  historyIndex: number;
  consolidatedAt: string | null;
  sinceISO: string | null;
  rows: RescoreRow[];
  totals: {
    sessions: number;
    missing: number;
    spawned: number;
    legacyDebt: number;
    newDebt: number;
    /** Old minus new, over non-spawned sessions: what the counting fix alone removed. */
    phantomDrop: number;
    /** Old score of every spawned session: what the spawned rule removed. */
    spawnedDrop: number;
    oldCorrections: number;
    newCorrections: number;
    oldBriefShaped: number;
    newBriefShaped: number;
    oldDecisions: number;
    newDecisions: number;
  };
  /** New human-session scores (found, not spawned). */
  humanScore: { median: number; p90: number } | null;
  /** New axes over found, non-spawned sessions (post-dedup, post-baseline). */
  axisPercentiles: { tokens: Percentiles; changes: Percentiles; tools: Percentiles } | null;
  dedupRatio: { p50: number; p90: number } | null;
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────────────────

const REGISTRY_SID_RE = /\b(?:spawned|resumed|respawned) sid ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;

/** Every builder session id a Develop task log registers (`develop-recipe.ts` section 4). */
export function parseRegistrySids(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(REGISTRY_SID_RE)) out.add(m[1]);
  return [...out];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function spawnOrNull(v: unknown): SpawnMarker | null {
  if (!isRecord(v) || typeof v.by !== 'string' || typeof v.via !== 'string') return null;
  return v as unknown as SpawnMarker;
}

/**
 * The sessions to re-score: `history[historyIndex].session_ids` bounded at the NEXT-older
 * entry's `consolidated_at` (the `last_consolidated_at` their Stop hooks scored under), then the
 * live ledger's sessions bounded at its own `last_consolidated_at`. First occurrence wins, so an
 * id in both is scored once, under its history bound. Malformed input yields fewer sessions,
 * never a throw.
 */
export function selectSessions(history: unknown, ledger: unknown, historyIndex: number): {
  sessions: SessionSelection[];
  consolidatedAt: string | null;
  sinceISO: string | null;
} {
  const out: SessionSelection[] = [];
  const seen = new Set<string>();
  const entries = Array.isArray(history) ? history : [];
  const entry = entries[historyIndex];
  const older = entries[historyIndex + 1];
  const sinceISO = isRecord(older) ? stringOrNull(older.consolidated_at) : null;
  const consolidatedAt = isRecord(entry) ? stringOrNull(entry.consolidated_at) : null;

  if (isRecord(entry) && Array.isArray(entry.session_ids)) {
    for (const id of entry.session_ids) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      out.push({ sessionId: id, sinceISO, source: 'history', transcriptPath: null, storedSpawn: null });
    }
  }

  if (isRecord(ledger) && Array.isArray(ledger.sessions)) {
    const ledgerSince = stringOrNull(ledger.last_consolidated_at);
    for (const s of ledger.sessions) {
      if (!isRecord(s)) continue;
      const id = stringOrNull(s.session_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        sessionId: id,
        sinceISO: ledgerSince,
        source: 'ledger',
        transcriptPath: stringOrNull(s.transcript_path),
        storedSpawn: spawnOrNull(s.spawn),
      });
    }
  }
  return { sessions: out, consolidatedAt, sinceISO };
}

/** Nearest-rank percentile over an already-sorted ascending array. */
function pick(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function percentiles(values: number[]): Percentiles {
  const s = [...values].sort((a, b) => a - b);
  return { p10: pick(s, 0.1), p25: pick(s, 0.25), p50: pick(s, 0.5), p75: pick(s, 0.75), p90: pick(s, 0.9), p95: pick(s, 0.95) };
}

const BRIEF_SHAPED_RE = /^User correction: (?:You are |Review wave|Another Claude session)/;

export function countMoments(moments: SalientMoment[]): MomentCounts {
  let corrections = 0;
  let decisions = 0;
  let briefShaped = 0;
  for (const m of moments) {
    if (m.message.startsWith('User correction:')) {
      corrections++;
      if (BRIEF_SHAPED_RE.test(m.message)) briefShaped++;
    } else if (m.message.startsWith('Decision:')) {
      decisions++;
    }
  }
  return { corrections, decisions, briefShaped };
}

// ─── Disk readers (read-only, symlink-refusing) ───────────────────────────────

/** A vault file's text, or null when it is absent, not a regular file, or a symlink. */
function readVaultText(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function readVaultJson(path: string): unknown {
  const text = readVaultText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Every registry sid across `state/*.md`. A symlinked `state/` or task file is skipped. */
function collectRegistrySids(contextRoot: string): Set<string> {
  const dir = join(contextRoot, 'state');
  const sids = new Set<string>();
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return sids;
    names = readdirSync(dir);
  } catch {
    return sids;
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const text = readVaultText(join(dir, name));
    if (text) for (const sid of parseRegistrySids(text)) sids.add(sid);
  }
  return sids;
}

interface MainScan {
  preview: string;
  humanTurns: number;
  dedupRatio: number | null;
}

/**
 * One pass over the main transcript for the table's context columns: the first human-typed
 * line (40 chars), the human turn count, and the usage dedup ratio (per-record sum over
 * once-per-`message.id` sum, the over-count the legacy scorer carried).
 */
function scanMain(path: string | null): MainScan {
  const empty: MainScan = { preview: '', humanTurns: 0, dedupRatio: null };
  if (!path) return empty;
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return empty;
  }
  let preview = '';
  let humanTurns = 0;
  let perRecord = 0;
  const perMessage = new Map<string, number>();
  let line = 0;
  for (const raw of content.split('\n')) {
    line++;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (!isRecord(rec)) continue;
    const text = humanTurnText(rec);
    if (text !== null) {
      humanTurns++;
      if (!preview) preview = text.replace(/\s+/g, ' ').slice(0, 40);
    }
    const msg = isRecord(rec.message) ? rec.message : null;
    const usage = msg && isRecord(msg.usage) ? msg.usage : null;
    if (!usage) continue;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const novel = num(usage.output_tokens) + num(usage.cache_creation_input_tokens) + num(usage.input_tokens);
    perRecord += novel;
    const key = stringOrNull(msg?.id) ?? stringOrNull(rec.uuid) ?? `line:${line}`;
    perMessage.set(key, Math.max(perMessage.get(key) ?? 0, novel));
  }
  let deduped = 0;
  for (const v of perMessage.values()) deduped += v;
  return { preview, humanTurns, dedupRatio: deduped > 0 ? perRecord / deduped : null };
}

function locate(sel: SessionSelection, home: string): TranscriptLocation {
  const recorded = sel.transcriptPath ?? findTranscriptBySessionId([sel.sessionId], home);
  return resolveTranscript(recorded, { sessionId: sel.sessionId });
}

function breakdown(a: TranscriptAnalysis, score: number): AxisBreakdown {
  return { changes: a.changeCount, tools: a.toolCount, tokens: a.novelTokens, score };
}

const ZERO_BREAKDOWN: AxisBreakdown = { changes: 0, tools: 0, tokens: 0, score: 0 };
const ZERO_MOMENTS: MomentCounts = { corrections: 0, decisions: 0, briefShaped: 0 };

function inferSpawn(sel: SessionSelection, contextRoot: string, registry: Set<string>): RescoreSpawn | null {
  if (sel.storedSpawn) return sel.storedSpawn;
  const actor = findRegisteredActor(contextRoot, sel.sessionId);
  if (actor) return { by: actor.mode === 'develop' ? 'develop' : 'goal-skill', via: 'goal-live' };
  if (registry.has(sel.sessionId)) return { by: 'develop', via: 'task-log' };
  return null;
}

function rescoreOne(sel: SessionSelection, contextRoot: string, home: string, registry: Set<string>): RescoreRow {
  const spawn = inferSpawn(sel, contextRoot, registry);
  const loc = locate(sel, home);
  if (!loc.mainPath) {
    return {
      sessionId: sel.sessionId, source: sel.source, preview: '', found: false, spawn,
      old: ZERO_BREAKDOWN, next: ZERO_BREAKDOWN, scorerScore: 0, humanTurns: 0,
      oldMoments: ZERO_MOMENTS, newMoments: ZERO_MOMENTS, dedupRatio: null,
    };
  }
  const oldAnalysis = legacyAnalyzeSession(loc, sel.sinceISO);
  const newAnalysis = analyzeSession(loc, sel.sinceISO);
  const scorerScore = scoreSession(newAnalysis);
  const main = scanMain(loc.mainPath);
  return {
    sessionId: sel.sessionId,
    source: sel.source,
    preview: main.preview,
    found: true,
    spawn,
    old: breakdown(oldAnalysis, legacyScoreSession(oldAnalysis)),
    next: breakdown(newAnalysis, spawn ? 0 : scorerScore),
    scorerScore,
    humanTurns: main.humanTurns,
    oldMoments: countMoments(legacyCaptureMoments(loc)),
    newMoments: countMoments(captureSessionMoments(loc, { spawned: spawn !== null }).moments),
    dedupRatio: main.dedupRatio,
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function rescoreSessions(opts: RescoreOptions): RescoreResult {
  const historyIndex = opts.historyIndex ?? 0;
  const home = opts.home ?? homedir();
  const history = readVaultJson(join(opts.contextRoot, 'state', '.sleep-history.json'));
  const ledger = readVaultJson(join(opts.contextRoot, 'state', '.sleep.json'));
  const { sessions, consolidatedAt, sinceISO } = selectSessions(history, ledger, historyIndex);
  const registry = collectRegistrySids(opts.contextRoot);
  const rows = sessions.map(sel => rescoreOne(sel, opts.contextRoot, home, registry));

  const found = rows.filter(r => r.found);
  const spawned = found.filter(r => r.spawn !== null);
  const human = found.filter(r => r.spawn === null);
  const sum = (xs: RescoreRow[], f: (r: RescoreRow) => number): number => xs.reduce((a, r) => a + f(r), 0);

  const humanScores = percentiles(human.map(r => r.next.score));
  const ratios = found.map(r => r.dedupRatio).filter((x): x is number => x !== null);
  const ratioPct = percentiles(ratios);

  return {
    historyIndex,
    consolidatedAt,
    sinceISO,
    rows,
    totals: {
      sessions: rows.length,
      missing: rows.length - found.length,
      spawned: spawned.length,
      legacyDebt: sum(found, r => r.old.score),
      newDebt: sum(found, r => r.next.score),
      phantomDrop: sum(human, r => r.old.score - r.next.score),
      spawnedDrop: sum(spawned, r => r.old.score),
      oldCorrections: sum(found, r => r.oldMoments.corrections),
      newCorrections: sum(found, r => r.newMoments.corrections),
      oldBriefShaped: sum(found, r => r.oldMoments.briefShaped),
      newBriefShaped: sum(found, r => r.newMoments.briefShaped),
      oldDecisions: sum(found, r => r.oldMoments.decisions),
      newDecisions: sum(found, r => r.newMoments.decisions),
    },
    humanScore: human.length > 0 ? { median: humanScores.p50, p90: humanScores.p90 } : null,
    axisPercentiles: human.length > 0
      ? {
          tokens: percentiles(human.map(r => r.next.tokens)),
          changes: percentiles(human.map(r => r.next.changes)),
          tools: percentiles(human.map(r => r.next.tools)),
        }
      : null,
    dedupRatio: ratios.length > 0 ? { p50: ratioPct.p50, p90: ratioPct.p90 } : null,
  };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function kTokens(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

function axes(b: AxisBreakdown): string {
  return `${b.changes}/${b.tools}/${kTokens(b.tokens)}`;
}

function pctLine(label: string, p: Percentiles, fmt: (n: number) => string): string {
  return `  ${label.padEnd(8)} p10 ${fmt(p.p10)}  p25 ${fmt(p.p25)}  p50 ${fmt(p.p50)}  p75 ${fmt(p.p75)}  p90 ${fmt(p.p90)}  p95 ${fmt(p.p95)}`;
}

/** The before/after table as fixed-width text. ASCII only. */
export function formatRescoreTable(r: RescoreResult): string {
  const lines: string[] = [];
  lines.push(`sleep-debt rescore: history[${r.historyIndex}] consolidated ${r.consolidatedAt ?? 'n/a'}, bound ${r.sinceISO ?? 'none'}`);
  lines.push('axes = changes/tools/tokens; score in brackets; spawned sessions add 0 debt (scorer value shown after "work")');
  lines.push('');
  const head = [
    'session '.padEnd(9), 'src'.padEnd(4), 'preview'.padEnd(40), 'spawn'.padEnd(20),
    'old axes'.padEnd(18), 'old'.padStart(4), 'new axes'.padEnd(18), 'new'.padStart(4), 'work'.padStart(5),
    'corr o>n'.padStart(9), 'dec o>n'.padStart(8),
  ];
  lines.push(head.join(' '));
  lines.push('-'.repeat(head.join(' ').length));
  for (const row of r.rows) {
    const spawn = row.spawn ? `${row.spawn.by}/${row.spawn.via}` : '-';
    if (!row.found) {
      lines.push([row.sessionId.slice(0, 8).padEnd(9), row.source.slice(0, 4).padEnd(4), '(transcript not found)'.padEnd(40), spawn.padEnd(20)].join(' '));
      continue;
    }
    lines.push([
      row.sessionId.slice(0, 8).padEnd(9),
      row.source.slice(0, 4).padEnd(4),
      row.preview.padEnd(40),
      spawn.padEnd(20),
      axes(row.old).padEnd(18),
      `[${row.old.score}]`.padStart(4),
      axes(row.next).padEnd(18),
      `[${row.next.score}]`.padStart(4),
      (row.spawn ? String(row.scorerScore) : '').padStart(5),
      `${row.oldMoments.corrections}>${row.newMoments.corrections}`.padStart(9),
      `${row.oldMoments.decisions}>${row.newMoments.decisions}`.padStart(8),
    ].join(' '));
  }
  const t = r.totals;
  lines.push('');
  lines.push(`sessions ${t.sessions} (missing transcript ${t.missing}, spawned ${t.spawned})`);
  lines.push(`debt: legacy ${t.legacyDebt} -> new ${t.newDebt}   phantom drop ${t.phantomDrop}   spawned drop ${t.spawnedDrop}`);
  lines.push(`auto-capture: User correction ${t.oldCorrections} -> ${t.newCorrections} (brief-shaped ${t.oldBriefShaped} -> ${t.newBriefShaped}), Decision ${t.oldDecisions} -> ${t.newDecisions}`);
  if (r.humanScore) lines.push(`human session score (new): median ${r.humanScore.median}, p90 ${r.humanScore.p90}`);
  if (r.axisPercentiles) {
    lines.push('new axes over human sessions (post-dedup, post-baseline):');
    lines.push(pctLine('tokens', r.axisPercentiles.tokens, kTokens));
    lines.push(pctLine('changes', r.axisPercentiles.changes, String));
    lines.push(pctLine('tools', r.axisPercentiles.tools, String));
  }
  if (r.dedupRatio) lines.push(`usage dedup ratio (per-record / per-message): p50 ${r.dedupRatio.p50.toFixed(2)}, p90 ${r.dedupRatio.p90.toFixed(2)}`);
  return lines.join('\n');
}
