/**
 * Gate G-pos, step 1: freeze the measurement inputs OUTSIDE the repo and print the "today"
 * numbers `eval/learn/BASELINE.md` records. $0, deterministic, no model call.
 *
 *   npx vite-node scripts/learn-eval/freeze.ts -- [--olcum2 DIR] [--olcum3 DIR] [--notes DIR]
 *       [--tilki DIR] [--replay FILE] [--dispatch FILE] [--force]
 *
 * Copies into ~/.dreamcontext/eval-frozen/learn-202611/ (0700, files 0600):
 *   raw/olcum-2/*, raw/olcum-3/*      the measurement scripts' data ($TMPDIR/ogrenme-olcum-{2,3})
 *   raw/notes/olcum-{1,2,3,4}-*.md   the brain's measurement notes
 *   raw/tilki-patterns/*.md          the Tilki vault's patterns, before any backfill (criterion 7)
 *   raw/replay.json                  the 101-prompt replay, when one is handed over (--replay)
 *   raw/dispatch.json                frozen dispatch positives, when handed over (--dispatch)
 *   derived/*.json                   the shapes every other script reads (lib.ts loadFrozen)
 *   manifest.json                    sha256 + bytes of every frozen file
 * Nothing it writes is under the repo, and it never prints a turn's text: counts and ids only.
 * A second run refuses to overwrite a frozen set unless --force (the set is frozen once).
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import {
  e2bDenominator, ensurePrivateDir, repeatBucket, flagStr, frozenDir, listFiles, loadJson, parseArgs, projOf, sha256, table, writePrivate,
  type FrozenChildBrief, type FrozenCluster, type FrozenRepeat, type FrozenTurn,
} from './lib.js';

const { flags } = parseArgs(process.argv.slice(2));
const TMP = process.env.TMPDIR || tmpdir();
const BRAIN_PLAN = join(homedir(), 'projects', 'dreamcontext-brain', '_dream_context', 'tmp', 'plans', 'ogrenme-dongusu');
const SRC = {
  olcum2: flagStr(flags, 'olcum2', join(TMP, 'ogrenme-olcum-2')),
  olcum3: flagStr(flags, 'olcum3', join(TMP, 'ogrenme-olcum-3')),
  notes: flagStr(flags, 'notes', BRAIN_PLAN),
  tilki: flagStr(flags, 'tilki', join(homedir(), 'projects', 'tilki_dreamcontext', '_dream_context', 'knowledge', 'patterns')),
  replay: typeof flags.replay === 'string' ? flags.replay : '',
  dispatch: typeof flags.dispatch === 'string' ? flags.dispatch : '',
};

const OUT = frozenDir();
if (existsSync(join(OUT, 'manifest.json')) && flags.force !== true) {
  console.error(`Already frozen: ${OUT}/manifest.json. The set is frozen once; pass --force only to redo the freeze before G-pos is recorded.`);
  process.exit(1);
}
for (const need of [join(SRC.olcum2, 'owner_final.json'), join(SRC.olcum2, 'clusters.json'), join(SRC.olcum3, 'the68.json')]) {
  if (!existsSync(need)) { console.error(`Missing input: ${need}`); process.exit(1); }
}
if (flags.force === true) for (const sub of ['raw', 'derived']) rmSync(join(OUT, sub), { recursive: true, force: true });
ensurePrivateDir(OUT);

function copyDir(from: string, to: string, re: RegExp = /./): number {
  ensurePrivateDir(to);
  let n = 0;
  for (const p of listFiles(from, re)) {
    const dest = join(to, basename(p));
    copyFileSync(p, dest);
    try { chmodSync(dest, 0o600); } catch { /* best effort */ }
    n++;
  }
  return n;
}

// ─── Raw copies ─────────────────────────────────────────────────────────────
const copied = {
  olcum2: copyDir(SRC.olcum2, join(OUT, 'raw', 'olcum-2')),
  olcum3: copyDir(SRC.olcum3, join(OUT, 'raw', 'olcum-3')),
  notes: copyDir(SRC.notes, join(OUT, 'raw', 'notes'), /^olcum-[1-4]-.*\.md$/),
  tilki: existsSync(SRC.tilki) ? copyDir(SRC.tilki, join(OUT, 'raw', 'tilki-patterns'), /\.md$/) : 0,
};
if (SRC.replay) {
  if (!existsSync(SRC.replay) || lstatSync(SRC.replay).isSymbolicLink()) { console.error(`--replay ${SRC.replay}: not a regular file`); process.exit(1); }
  writePrivate(join(OUT, 'raw', 'replay.json'), readFileSync(SRC.replay, 'utf-8'));
}
if (SRC.dispatch) {
  if (!existsSync(SRC.dispatch) || lstatSync(SRC.dispatch).isSymbolicLink()) { console.error(`--dispatch ${SRC.dispatch}: not a regular file`); process.exit(1); }
  writePrivate(join(OUT, 'raw', 'dispatch.json'), readFileSync(SRC.dispatch, 'utf-8'));
}

// ─── Derived shapes ─────────────────────────────────────────────────────────
interface RawTurn { i: number; n: number; ts: string; sid: string; proj: string; surf: string; kind: string; w: string }
const rawTurns = loadJson<RawTurn[]>(join(SRC.olcum2, 'owner_final.json'));
const turns: FrozenTurn[] = rawTurns.map((t) => ({
  n: t.n, at: t.ts, sid: t.sid, proj: projOf(t.proj), surf: t.surf, kind: t.kind === 'typed' ? 'typed' : 'answer', own: t.w ?? '',
}));

type RawCluster = [string, string, string, string, number[], string, ...unknown[]];
const clusters: FrozenCluster[] = loadJson<RawCluster[]>(join(SRC.olcum2, 'clusters.json')).map((c) => ({
  id: c[0], group: c[1], scope: c[2], rule: c[3], turns: c[4], landing: c[5],
}));

interface RawRepeat { cid: string; n: number; ts: string; sid: string; proj: string; surf: string }
interface RawRow { cid: string; n: number; g: string; act: string; where: string | null }
interface RawScan { cid: string; n: number; chars_between?: number | null }
const the68 = loadJson<RawRepeat[]>(join(SRC.olcum3, 'the68.json'));
const rows = existsSync(join(SRC.olcum3, 'rows.json')) ? loadJson<RawRow[]>(join(SRC.olcum3, 'rows.json')) : [];
const scan = existsSync(join(SRC.olcum3, 'scan.json')) ? loadJson<RawScan[]>(join(SRC.olcum3, 'scan.json')) : [];
const key = (cid: string, n: number): string => `${cid}#${n}`;
const rowBy = new Map(rows.map((r) => [key(r.cid, r.n), r]));
const scanBy = new Map(scan.map((r) => [key(r.cid, r.n), r]));
const repeats: FrozenRepeat[] = the68.map((r) => {
  const row = rowBy.get(key(r.cid, r.n));
  const sc = scanBy.get(key(r.cid, r.n));
  return {
    cid: r.cid, n: r.n, at: r.ts, sid: r.sid, proj: projOf(r.proj), surf: r.surf,
    g: row?.g ?? 'U', act: row?.act ?? 'U', where: row?.where ?? '',
    charsBetween: typeof sc?.chars_between === 'number' ? sc.chars_between : null,
  };
});

const childBriefs: FrozenChildBrief[] = [];
for (const p of listFiles(SRC.olcum3, /^child_.*\.json$/)) {
  try {
    const xs = loadJson<Array<{ cid?: string; brief?: string }>>(p);
    for (const x of xs) if (x.cid && typeof x.brief === 'string' && x.brief.trim()) childBriefs.push({ cid: x.cid, brief: x.brief });
  } catch { /* not that shape */ }
}

let replay: Array<{ text: string; source: string }> = [];
if (SRC.replay) {
  const v = JSON.parse(readFileSync(SRC.replay, 'utf-8')) as unknown;
  const arr = Array.isArray(v) ? v : (v as { prompts?: unknown[] }).prompts ?? [];
  replay = (arr as Array<Record<string, unknown>>).map((x) => ({ text: String(x.text ?? x.prompt ?? ''), source: String(x.source ?? x.kind ?? 'unknown') })).filter((x) => x.text);
}
let dispatch: Array<{ cid: string; prompt: string }> = [];
if (SRC.dispatch) {
  const v = JSON.parse(readFileSync(SRC.dispatch, 'utf-8')) as Array<Record<string, unknown>>;
  dispatch = v.map((x) => ({ cid: String(x.cid ?? ''), prompt: String(x.prompt ?? '') })).filter((x) => x.cid && x.prompt);
}

const D = join(OUT, 'derived');
writePrivate(join(D, 'turns.json'), JSON.stringify(turns));
writePrivate(join(D, 'clusters.json'), JSON.stringify(clusters));
writePrivate(join(D, 'repeats.json'), JSON.stringify(repeats));
writePrivate(join(D, 'child-briefs.json'), JSON.stringify(childBriefs));
writePrivate(join(D, 'replay.json'), JSON.stringify(replay));
writePrivate(join(D, 'dispatch.json'), JSON.stringify(dispatch));

// ─── Today numbers ──────────────────────────────────────────────────────────
const count = <T>(xs: readonly T[], f: (x: T) => string): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const x of xs) o[f(x)] = (o[f(x)] ?? 0) + 1;
  return o;
};
const ruleTurnSet = new Set(clusters.flatMap((c) => c.turns));
const denom = e2bDenominator(clusters, turns);
const included = denom.filter((r) => r.included);
const ruleTurns = turns.filter((t) => ruleTurnSet.has(t.n));
const cardRuleTurns = ruleTurns.filter((t) => t.kind === 'answer').length;
const cardOnlyClusters = denom.filter((r) => r.typed === 0).map((r) => r.id);
const a14 = denom.find((r) => r.id === 'A14');

const gCounts = count(repeats, (r) => (r.g === 'C-list' ? 'C' : r.g));
const nBuckets = count(repeats.filter((r) => r.g === 'N'), (r) => repeatBucket(r));
const inCtx = repeats.filter((r) => r.g === 'C' || r.g === 'C-list');
const inCtxKnown = inCtx.filter((r) => r.charsBetween !== null);
const within2000 = inCtxKnown.filter((r) => (r.charsBetween ?? Infinity) <= 2000).length;

const tilkiFiles = listFiles(join(OUT, 'raw', 'tilki-patterns'), /\.md$/);
const tilkiWithWhen = tilkiFiles.filter((p) => /^(when|says):/m.test(readFileSync(p, 'utf-8').split(/^---$/m)[1] ?? '')).length;

const baseline = {
  frozenAt: new Date().toISOString(),
  turns: { total: turns.length, typed: turns.filter((t) => t.kind === 'typed').length, answers: turns.filter((t) => t.kind === 'answer').length, bySurface: count(turns, (t) => t.surf), byProject: count(turns, (t) => t.proj) },
  ruleTurns: { total: ruleTurns.length, typed: ruleTurns.length - cardRuleTurns, cardAnswers: cardRuleTurns, nonRuleTurns: turns.length - ruleTurns.length },
  clusters: { total: clusters.length, byGroup: count(clusters, (c) => c.group), byLanding: count(clusters, (c) => c.landing), cardAnswerOnly: cardOnlyClusters },
  e2b: { included: included.map((r) => r.id), excluded: denom.filter((r) => !r.included).map((r) => ({ id: r.id, why: r.why })), a14Occasions: a14?.occasions ?? 0, a14Included: !!a14?.included },
  repeats: { total: repeats.length, byGroup: gCounts, notInContext: nBuckets, inContext: inCtx.length, inContextWithCharsKnown: inCtxKnown.length, inContextWithin2000: within2000 },
  childBriefs: { total: childBriefs.length, clusters: [...new Set(childBriefs.map((b) => b.cid))] },
  dispatchPositives: dispatch.length,
  replay: { found: replay.length > 0, prompts: replay.length, bySource: count(replay, (r) => r.source) },
  tilkiPatterns: { total: tilkiFiles.length, withWhenOrSays: tilkiWithWhen },
  copied,
};
writePrivate(join(D, 'baseline.json'), JSON.stringify(baseline, null, 2));

// ─── Manifest ───────────────────────────────────────────────────────────────
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) { if (name !== 'results') out.push(...walk(p)); } else if (name !== 'spend.jsonl' && name !== 'manifest.json') out.push(p);
  }
  return out;
}
const files = walk(OUT).sort().map((p) => {
  const buf = readFileSync(p);
  return { path: relative(OUT, p), bytes: buf.length, sha256: sha256(buf) };
});
const setHash = sha256(files.map((f) => `${f.path} ${f.sha256}`).join('\n'));
writePrivate(join(OUT, 'manifest.json'), JSON.stringify({ name: 'learn-202611', frozenAt: baseline.frozenAt, setSha256: setHash, files }, null, 2));

// ─── Print (counts and ids only; never a turn's text) ───────────────────────
const derived = files.filter((f) => f.path.startsWith('derived/'));
console.log(`Frozen into ${OUT}: ${files.length} files, set sha256 ${setHash}`);
console.log('');
console.log('## For eval/learn/FROZEN.md');
console.log(table(['file', 'bytes', 'sha256'], derived.map((f) => [f.path, f.bytes, f.sha256])));
console.log(`\nraw files: olcum-2 ${copied.olcum2}, olcum-3 ${copied.olcum3}, notes ${copied.notes}, tilki patterns ${copied.tilki}; set sha256 ${setHash}`);
console.log('');
console.log('## For eval/learn/BASELINE.md');
console.log(`- Owner turns: ${baseline.turns.total} (typed ${baseline.turns.typed}, card answers ${baseline.turns.answers}); by surface ${JSON.stringify(baseline.turns.bySurface)}`);
console.log(`- Rule turns: ${baseline.ruleTurns.total} (typed ${baseline.ruleTurns.typed}, card answers ${baseline.ruleTurns.cardAnswers}); non-rule turns ${baseline.ruleTurns.nonRuleTurns}`);
console.log(`- Clusters: ${clusters.length}; said only on cards: ${cardOnlyClusters.length} (${cardOnlyClusters.join(', ') || 'none'})`);
console.log(`- E2b denominator (typed on two or more occasions, occasion = session id): ${included.length}`);
console.log(`  included: ${included.map((r) => `${r.id}(${r.occasions})`).join(', ')}`);
console.log(`  A14 occasions: ${a14?.occasions ?? 0}, included: ${a14?.included ? 'yes' : 'NO'}`);
console.log('  excluded:');
for (const r of denom.filter((x) => !x.included)) console.log(`  - ${r.id}: ${r.why}`);
console.log(`- Repeats: ${repeats.length}; by group ${JSON.stringify(gCounts)}; not in context ${JSON.stringify(nBuckets)}`);
console.log(`- In context with the rule inside 2,000 chars before the answer (scan.json chars_between): ${within2000} of ${inCtxKnown.length} known (${inCtx.length} in context)`);
console.log(`- Child briefs frozen: ${childBriefs.length} (${baseline.childBriefs.clusters.join(', ') || 'none'}); dispatch positives: ${dispatch.length}`);
console.log(`- 101-prompt replay: ${replay.length ? `${replay.length} prompts ${JSON.stringify(baseline.replay.bySource)}` : 'not found (pass --replay FILE to freeze it)'}`);
console.log(`- Tilki patterns: ${tilkiFiles.length}, with when/says: ${tilkiWithWhen}`);
