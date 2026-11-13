/**
 * E2b sleep replay (plan criteria 6 and 17's sleep half). Model runs, at Close; about $5.
 *
 *   npx vite-node scripts/learn-eval/sleep-replay.ts -- [--dry-run] [--max-run-usd 4] [--cli dist/index.js] [--fixture]
 *
 * Builds the owner-words ledger the write points WOULD have written for the frozen week (typed
 * turns only, `own` text only, `session` = the transcript's session id; no card answer, D15),
 * in a fake HOME, through the real `appendOwnerTurn`. Then, in two scratch vaults (the two
 * projects), the real sleep: `dreamcontext sleep start`, the sleep-product procedure as an agent
 * (`claude -p --agent sleep-product`, its doctrine from W1 L3), `dreamcontext sleep done`.
 * Scored against the 41 hand-labelled clusters:
 *   - of the clusters typed on two or more occasions (lib.ts e2bDenominator), at least three
 *     quarters come out as a rule; A14 is among them;
 *   - 0 rules whose only quotes are card answers;
 *   - a sample of 20 learned rules written for hand labels (not his rule at most 2; stricter 0).
 * D16 cases seeded in the same run (synthetic words, fictional project):
 *   - three contradictions: a rule stated on two occasions against a step of a pattern saying the
 *     opposite: at least two flagged with --supersedes, no file rewritten; `undo` of one flagged
 *     rule removes its flag and leaves the file byte-identical;
 *   - one sleep-state run over seeded transcripts holding `(eval):1: command not found: timeout`
 *     (and `zsh:1:`) in two sessions on two days: exactly one Known Issues line for it, with a fix.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REAL_HOME, REPO, SpendGuard, dc, dcEnv, denyRules, e2bDenominator, evalClaudeArgs, flagNum, flagStr, loadFixture, loadFrozen, makeScratch,
  parseArgs, pct, pinHooksToShim, resultsDir, runClaude, sample, spendLedgerPath, stamp, table, writePrivate, type Proj,
} from './lib.js';

const { flags } = parseArgs(process.argv.slice(2));
const dryRun = flags['dry-run'] === true;
const maxRunUsd = flagNum(flags, 'max-run-usd', 4);
const useFixture = flags.fixture === true;
const data = useFixture ? loadFixture() : loadFrozen();
const typed = data.turns.filter((t) => t.kind === 'typed');
const denom = e2bDenominator(data.clusters, data.turns);
const included = denom.filter((d) => d.included);

const RUNS = 3; // sleep-product per vault (2) + one sleep-state run
const guard = new SpendGuard({ plan: { script: 'sleep-replay', runs: RUNS, perRunEstimateUsd: 1.7, perRunMaxUsd: maxRunUsd }, ledgerPath: spendLedgerPath() });
guard.announce();
console.log(`Ledger to build: ${typed.length} typed turns (card answers left out: ${data.turns.length - typed.length}); E2b denominator ${included.length} clusters.`);
if (dryRun) { console.log('Dry run: nothing spent, nothing built.'); process.exit(0); }

// ─── Scratch, ledger ────────────────────────────────────────────────────────
const scratch = makeScratch(mkdtempSync(join(tmpdir(), 'learn-e2b-')), ['D', 'T'], flagStr(flags, 'cli', join(REPO, 'dist', 'index.js')));
for (const v of Object.values(scratch.vaults)) if (v) pinHooksToShim(scratch, v);
const rootOf = (p: Proj): string => scratch.vaults[p === 'T' ? 'T' : 'D']!;
process.env.HOME = scratch.home;
const ow = await import('../../src/lib/owner-words.js') as { appendOwnerTurn: (line: Record<string, unknown>, opts?: { home?: string }) => void };
const turnId = (n: number): string => `frz-${n}`;
for (const t of typed) {
  ow.appendOwnerTurn({
    at: t.at, turn: turnId(t.n), vault: realpathSync(rootOf(t.proj)), surface: t.surf === 'basic' ? 'plain' : t.surf,
    via: t.surf === 'telegram' ? 'telegram' : 'composer', keys: [t.sid], session: t.sid, own: t.own,
  }, { home: scratch.home });
}

// ─── D16 seeds: contradictions and a repeated tool error ────────────────────
const D = rootOf('D');
const patternsDir = join(D, '_dream_context', 'knowledge', 'patterns');
mkdirSync(patternsDir, { recursive: true });
const contradictions = [
  { slug: 'release-notes-recipe', rule: 'Write release notes in Turkish first, English second.', says1: 'sürüm notlarını önce Türkçe yaz, sonra İngilizce', says2: 'yine İngilizce başlamışsın, sürüm notu önce Türkçe olacak', step: '3. Write the release notes in English only; never add a Turkish version.' },
  { slug: 'nightly-build-recipe', rule: 'Never rerun a nightly build that already passed.', says1: 'geçmiş bir gece derlemesini tekrar çalıştırma', says2: 'geçen derlemeyi neden yeniden çalıştırdın, geçtiyse dokunma', step: '4. Always rerun the nightly build once more after it passes, to be sure.' },
  { slug: 'invoice-export-recipe', rule: 'Export invoices as CSV, not PDF.', says1: 'faturaları CSV olarak dışa aktar, PDF değil', says2: 'yine PDF vermişsin, fatura dışa aktarımı CSV olacak', step: '2. Export every invoice as a PDF; CSV is not supported.' },
];
const hashOf = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const seededFiles: Record<string, string> = {};
for (const c of contradictions) {
  const p = join(patternsDir, `${c.slug}.md`);
  writeFileSync(p, `---\nname: ${c.slug.replace(/-/g, ' ')}\ndescription: Synthetic recipe for the Lumen Ledger eval.\n---\n\n# ${c.slug}\n\n1. Read the task.\n2. Plan the change.\n${c.step}\n5. Report.\n`);
  seededFiles[c.slug] = hashOf(p);
}
const days = ['2026-11-04T10:00:00.000Z', '2026-11-06T15:00:00.000Z'];
for (const [i, c] of contradictions.entries()) {
  for (const [k, words] of [c.says1, c.says2].entries()) {
    ow.appendOwnerTurn({ at: days[k]!, turn: `syn-${i}-${k}`, vault: realpathSync(D), surface: 'super', via: 'composer', keys: [`syn-sess-${i}-${k}`], session: `syn-sess-${i}-${k}`, own: words }, { home: scratch.home });
  }
}
// Transcripts the sleep reads under the fake HOME: one `user` record holding a `tool_result`,
// not marked as an error, in two sessions on two days, two shell spellings (criterion 17).
const slug = realpathSync(D).replace(/[/.]/g, '-');
const tdir = join(scratch.home, '.claude', 'projects', slug);
mkdirSync(tdir, { recursive: true });
for (const [k, spelling] of ['(eval):1: command not found: timeout', 'zsh:1: command not found: timeout'].entries()) {
  const sid = randomUUID();
  const at = days[k]!;
  const lines = [
    { type: 'user', sessionId: sid, timestamp: at, cwd: realpathSync(D), message: { role: 'user', content: 'Run the slow test with a time limit.' } },
    { type: 'assistant', sessionId: sid, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${k}`, name: 'Bash', input: { command: 'timeout 60 npm test' } }] } },
    { type: 'user', sessionId: sid, timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${k}`, content: spelling, is_error: false }] } },
    { type: 'assistant', sessionId: sid, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'timeout is not installed on this Mac; perl -e \'alarm 60; exec @ARGV\' npm test worked instead.' }] } },
  ];
  writeFileSync(join(tdir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const coreLines = (): string[] => {
  const core = join(D, '_dream_context', 'core');
  try { return readdirSync(core).filter((n) => n.endsWith('.md')).flatMap((n) => readFileSync(join(core, n), 'utf-8').split('\n')); } catch { return []; }
};
const timeoutLinesBefore = coreLines().filter((l) => /timeout/i.test(l)).length;

// ─── Sleep ──────────────────────────────────────────────────────────────────
const claudeEnv = dcEnv(scratch, { HOME: REAL_HOME }); // Claude keeps the real HOME for its sign-in; the shim pins every dreamcontext call to the fake one.
const settingsPath = join(scratch.dir, 'settings.json');
writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: denyRules(REAL_HOME) } }, null, 2));
const allowed = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(dreamcontext *)'];
const packets: Record<string, string> = {};
const sleepRuns: Array<{ vault: string; agent: string; ok: boolean; usd: number; note: string }> = [];
let stopped = '';

async function agentRun(vault: string, agent: string, prompt: string, run: string): Promise<void> {
  const chk = guard.check();
  if (!chk.ok) { stopped = chk.reason ?? 'cap'; console.log(`STOP before ${run}: ${stopped}`); return; }
  const args = [...evalClaudeArgs({ prompt, settings: settingsPath, maxUsd: maxRunUsd, allowed, permissionMode: 'acceptEdits', skills: true }), '--agent', agent];
  const r = await runClaude(args, { cwd: vault, env: claudeEnv, guard, run });
  sleepRuns.push({ vault, agent, ok: r.ok, usd: r.costUsd, note: r.result.slice(0, 400) });
  console.log(`${run}: ${r.ok ? 'done' : 'error'} $${r.costUsd.toFixed(2)}`);
}

for (const p of ['D', 'T'] as const) {
  const v = rootOf(p);
  const start = dc(scratch, v, ['sleep', 'start']);
  const packet = join(v, '_dream_context', 'tmp', 'learn-eval-packet.md');
  mkdirSync(join(v, '_dream_context', 'tmp'), { recursive: true });
  writeFileSync(packet, start.stdout);
  packets[p] = packet;
  await agentRun(v, 'sleep-product', `Sleep is running in this vault. The sleep packet is in ${packet}. Do your owner-words step only: read the owner's words in the packet and, per finding, run one \`dreamcontext learn --by sleep\` call as your procedure says (quotes verbatim, never stricter than his words, the opposite-instruction search first). Do not edit any other file. End with the list of ids you learned.`, `sleep-product/${p}`);
  if (stopped) break;
}
if (!stopped) {
  await agentRun(D, 'sleep-state', `Sleep is running in this vault. The sleep packet is in ${packets.D}. Do only the repeated tool errors step: for each error in the packet's repeated-errors block, read one of its sessions for what worked instead and write ONE Known Issues line (the error, the fix, since when), or nothing when no fix is on record. Change nothing else.`, 'sleep-state/D');
}
const done: Record<string, string> = {};
for (const p of ['D', 'T'] as const) done[p] = dc(scratch, rootOf(p), ['sleep', 'done']).stdout;

// ─── Score ──────────────────────────────────────────────────────────────────
interface Rec { id: string; scope?: string; events?: Array<{ op?: string; by?: string; quotes?: Array<{ turn?: string; text?: string }>; quote?: { turn?: string }; [k: string]: unknown }>; [k: string]: unknown }
/** A store file (rules-store.ts RulesStoreFile: {version, rules}); a store that does not parse reads as none. */
const readStore = (file: string): Rec[] => {
  if (!existsSync(file)) return [];
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8')) as { rules?: unknown } | unknown[];
    const arr = Array.isArray(v) ? v : Array.isArray((v as { rules?: unknown }).rules) ? (v as { rules: unknown[] }).rules : [];
    return (arr as Rec[]).filter((x) => x && typeof x === 'object' && typeof x.id === 'string');
  } catch { return []; }
};
const records = [
  ...readStore(join(scratch.home, '.dreamcontext', 'me', 'rules.json')),
  ...readStore(join(D, '_dream_context', 'core', 'RULES.json')),
  ...readStore(join(rootOf('T'), '_dream_context', 'core', 'RULES.json')),
];
const citedTurns = (r: Rec): string[] => (r.events ?? []).flatMap((e) => [...(e.quotes ?? []).map((q) => q.turn), e.quote?.turn]).filter((t): t is string => typeof t === 'string' && t !== '');
const byTurn = new Map(data.turns.map((t) => [turnId(t.n), t]));
const clusterOfN = new Map<number, string[]>();
for (const c of data.clusters) for (const n of c.turns) clusterOfN.set(n, [...(clusterOfN.get(n) ?? []), c.id]);
const covered = new Set<string>();
for (const r of records) for (const t of citedTurns(r)) { const ft = byTurn.get(t); if (ft) for (const cid of clusterOfN.get(ft.n) ?? []) covered.add(cid); }
const coveredIncluded = included.filter((d) => covered.has(d.id));
const cardOnly = records.filter((r) => { const ts = citedTurns(r).map((t) => byTurn.get(t)).filter(Boolean); return ts.length > 0 && ts.every((t) => t!.kind === 'answer'); }).length;

const learnedSample = sample(records.filter((r) => citedTurns(r).some((t) => t.startsWith('frz-'))), 20, 20261113);
const labelsPath = join(resultsDir(), 'e2b-labels.json');
let labels: { notHis: number; stricter: number; labelled: number } | null = null;
if (existsSync(labelsPath)) {
  const l = JSON.parse(readFileSync(labelsPath, 'utf-8')) as Record<string, { his?: boolean; stricter?: boolean }>;
  labels = { notHis: 0, stricter: 0, labelled: 0 };
  for (const r of learnedSample) { const x = l[r.id]; if (!x) continue; labels.labelled++; if (x.his === false) labels.notHis++; if (x.stricter) labels.stricter++; }
}

const flagged = contradictions.filter((c) => records.some((r) => JSON.stringify(r).includes(`${c.slug}.md`)));
const untouched = contradictions.filter((c) => hashOf(join(patternsDir, `${c.slug}.md`)) === seededFiles[c.slug]).length;
let undoCase: { id: string; flagShownBefore: boolean; flagGone: boolean; byteIdentical: boolean } | null = null;
const flagLines = (): string => dc(scratch, D, ['learn', 'list']).stdout;
const f0 = flagged[0];
if (f0) {
  const rec = records.find((r) => JSON.stringify(r).includes(`${f0.slug}.md`))!;
  const before = flagLines();
  dc(scratch, D, ['learn', 'undo', rec.id]);
  const after = flagLines();
  // `learn list` prints the flag on its own line under the rule: "old text still says the opposite: <path>: ...".
  const mentions = (s: string): boolean => s.split('\n').some((l) => /still says the opposite/i.test(l) && l.includes(`${f0.slug}.md`));
  undoCase = { id: rec.id, flagShownBefore: mentions(before), flagGone: !mentions(after), byteIdentical: hashOf(join(patternsDir, `${f0.slug}.md`)) === seededFiles[f0.slug] };
}
const timeoutLinesAfter = coreLines().filter((l) => /timeout/i.test(l)).length;

const s = stamp();
if (!useFixture && learnedSample.length) {
  const md = ['# E2b sample: label each rule', '', `Write ${labelsPath} as {"<id>": {"his": true|false, "stricter": true|false}}.`, ''];
  for (const r of learnedSample) {
    md.push(`## ${r.id}`, '', '```json', JSON.stringify(r, null, 2).slice(0, 3000), '```', '');
    for (const t of citedTurns(r)) md.push(`- ${t}: ${byTurn.get(t)?.own ?? '(not a frozen turn)'}`);
    md.push('');
  }
  writePrivate(join(resultsDir(), `e2b-sample-${s}.md`), md.join('\n'));
}
const a14 = included.find((d) => d.id === 'A14');
const summary = {
  at: new Date().toISOString(), fixture: useFixture, ledgerTurns: typed.length, records: records.length,
  e2b: { denominator: included.length, covered: coveredIncluded.map((d) => d.id), missed: included.filter((d) => !covered.has(d.id)).map((d) => d.id), a14Covered: a14 ? covered.has('A14') : null, cardOnlyRules: cardOnly, sample: learnedSample.length, labels },
  d16: { flagged: flagged.map((c) => c.slug), untouchedFiles: untouched, undoCase, knownIssueTimeoutLinesAdded: timeoutLinesAfter - timeoutLinesBefore },
  runs: sleepRuns, stopped: stopped || null, sleepDone: done, scratch: scratch.dir,
};
const md = [
  `# E2b sleep replay${useFixture ? ' [synthetic fixture]' : ''}`,
  '',
  `Ledger: ${typed.length} typed turns, card answers left out. Records after sleep: ${records.length}.`,
  '',
  table(['measure', 'value', 'bar'], [
    ['denominator clusters covered', pct(coveredIncluded.length, included.length), 'at least 3/4'],
    ['A14 (link and login) among them', a14 ? (covered.has('A14') ? 'yes' : 'no') : 'not in denominator', 'yes'],
    ['rules whose only quotes are card answers', cardOnly, '0'],
    ['sample labelled: not his rule', labels ? `${labels.notHis} of ${labels.labelled}` : 'not labelled', 'at most 2 of 20'],
    ['sample labelled: stricter than quotes', labels ? `${labels.stricter} of ${labels.labelled}` : 'not labelled', '0'],
    ['seeded contradictions flagged (--supersedes)', `${flagged.length} of 3`, 'at least 2'],
    ['seeded pattern files byte-identical', `${untouched} of 3`, '3'],
    ['undo removes the flag, file identical', undoCase ? `${undoCase.flagGone ? 'flag gone' : 'flag stays'}, ${undoCase.byteIdentical ? 'identical' : 'CHANGED'}` : 'no flagged rule', 'flag gone, identical'],
    ['Known Issues lines naming timeout added', timeoutLinesAfter - timeoutLinesBefore, 'exactly 1'],
  ]),
  '',
  `Missed denominator clusters: ${summary.e2b.missed.join(', ') || 'none'}.`,
  stopped ? `Stopped early: ${stopped}` : '',
].join('\n');
writePrivate(join(resultsDir(), `e2b-${s}.json`), JSON.stringify(summary, null, 2));
writePrivate(join(resultsDir(), `e2b-${s}.md`), md + '\n');
console.log(md);
