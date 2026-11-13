/**
 * E5 repeats (plan criterion 8). $0, deterministic, no model call.
 *
 *   npx vite-node scripts/learn-eval/repeats.ts -- [--phase before|after] [--cli dist/index.js] [--fixture]
 *
 * The 41 clusters' rules go into scratch stores as D11's list would write them (lib.ts
 * clusterSeeds/seedRules), then each of the 68 sayings of an already written rule is replayed:
 *
 *   - The 19 not-in-context sayings split as the plan does: never written 6 (criterion 6), the
 *     quick-edit agent 2 (out of scope), a knowledge file 1 (the memory plan), in scope 10. For
 *     each in-scope saying: is the rule in the acting session's context at that turn? Yes when the
 *     session-start block of its vault (`dreamcontext snapshot`) carries it, or `deliverForTurn`
 *     on any earlier owner turn of the same session carried it. Bar: at least 9 of 10 (today 0).
 *   - The 40 in-context sayings: today's share with the rule inside the last 2,000 characters
 *     before the agent's answer (measurement 3's chars_between); and the after proxy, the rule
 *     delivered next to his turn right before the saying (P1). The 2,000-character measure itself
 *     needs a transcript; the proxy is reported as a proxy.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO, clusterSeeds, dc, delivered, flagStr, hookInput, loadDeliver, loadFixture, loadFrozen, makeScratch, parseArgs, pct,
  repeatBucket, resultsDir, seedRules, stamp, table, writePrivate, type FrozenRepeat, type Proj, type RepeatBucket,
} from './lib.js';

const { flags } = parseArgs(process.argv.slice(2));
const phase = flagStr(flags, 'phase', 'before');
const useFixture = flags.fixture === true;
const data = useFixture ? loadFixture() : loadFrozen();

const scratch = makeScratch(mkdtempSync(join(tmpdir(), 'learn-e5-')), ['D', 'T'], flagStr(flags, 'cli', join(REPO, 'dist', 'index.js')));
const seeded = seedRules(scratch, clusterSeeds(data.clusters, data.turns));
const seedBy = new Map(seeded.map((s) => [s.key, s]));
for (const v of Object.values(scratch.vaults)) if (v) dc(scratch, v, ['patterns', 'sync']);
const rootOf = (p: Proj): string => scratch.vaults[p === 'T' ? 'T' : 'D']!;
const snapshots: Record<'D' | 'T', string> = { D: dc(scratch, rootOf('D'), ['snapshot']).stdout, T: dc(scratch, rootOf('T'), ['snapshot']).stdout };
const inSnapshot = (p: Proj, cid: string): boolean => {
  const s = seedBy.get(cid);
  if (!s?.id) return false;
  const snap = snapshots[p === 'T' ? 'T' : 'D'];
  return snap.includes(s.id) || (s.headline.length >= 12 && snap.includes(s.headline));
};

const { deliver, error: deliverError } = await loadDeliver(scratch.home);
const carries = (p: Proj, cid: string, text: string): boolean => {
  const s = seedBy.get(cid);
  if (!deliver || !s?.id) return false;
  try { return delivered(deliver(rootOf(p), hookInput('owner', text, rootOf(p))), s.id, s.headline); } catch { return false; }
};

const earlier = (r: FrozenRepeat) => data.turns.filter((t) => t.sid === r.sid && t.at < r.at).sort((a, b) => a.at.localeCompare(b.at));

const buckets: Record<RepeatBucket, FrozenRepeat[]> = { 'in-context': [], unknown: [], 'never-written': [], 'quick-edit': [], 'knowledge-file': [], 'in-scope': [] };
for (const r of data.repeats) buckets[repeatBucket(r)].push(r);

const inScope = buckets['in-scope'].map((r) => {
  const viaStart = inSnapshot(r.proj, r.cid);
  const prior = earlier(r);
  const viaTurn = prior.some((t) => carries(r.proj, r.cid, t.own));
  return { cid: r.cid, n: r.n, viaStart, viaTurn, inContext: viaStart || viaTurn, priorTurns: prior.length };
});

const inCtx = buckets['in-context'];
const known = inCtx.filter((r) => r.charsBetween !== null);
const today2000 = known.filter((r) => (r.charsBetween ?? Infinity) <= 2000).length;
const proxy = inCtx.map((r) => {
  const prev = earlier(r).pop();
  return { cid: r.cid, n: r.n, nextToTurn: prev ? carries(r.proj, r.cid, prev.own) : false };
});

const k = inScope.filter((x) => x.inContext).length;
const summary = {
  phase, at: new Date().toISOString(), fixture: useFixture,
  buckets: Object.fromEntries(Object.entries(buckets).map(([b, xs]) => [b, xs.length])),
  seeding: { active: seeded.filter((s) => s.status === 'active').length, of: seeded.length, firstError: seeded.find((s) => s.error)?.error ?? null },
  deliverError: deliverError ?? null,
  inScope: { k, n: inScope.length, rows: inScope },
  inContext: { total: inCtx.length, today2000: { k: today2000, known: known.length }, p1Proxy: { k: proxy.filter((x) => x.nextToTurn).length, n: proxy.length } },
};
const md = [
  `# E5 repeats (${phase})${useFixture ? ' [synthetic fixture]' : ''}`,
  '',
  table(['bucket', 'sayings', 'plan expects'], [
    ['in context (C, C-list)', buckets['in-context'].length, 40],
    ['not in context: never written', buckets['never-written'].length, 6],
    ['not in context: quick-edit agent', buckets['quick-edit'].length, 2],
    ['not in context: knowledge file', buckets['knowledge-file'].length, 1],
    ['not in context: in scope', buckets['in-scope'].length, 10],
    ['unknown', buckets.unknown.length, 9],
  ]),
  '',
  `Seeded rules: ${summary.seeding.active} active of ${summary.seeding.of}${summary.seeding.firstError ? ` (first error: ${summary.seeding.firstError})` : ''}.`,
  deliverError ? `deliverForTurn: not measurable (${deliverError}); only the session-start half was measured.` : '',
  '',
  `## In scope: rule in the acting session's context at that turn (bar: at least 9 of 10; today 0)`,
  '',
  `${pct(k, inScope.length)}: by the session-start block ${inScope.filter((x) => x.viaStart).length}, by an earlier turn's delivery ${inScope.filter((x) => x.viaTurn).length}.`,
  '',
  table(['cluster', 'saying', 'session start', 'earlier turn', 'earlier turns'], inScope.map((x) => [x.cid, x.n, x.viaStart ? 'yes' : 'no', x.viaTurn ? 'yes' : 'no', x.priorTurns])),
  '',
  '## In context (reported, not a bar)',
  '',
  `Today, rule inside the last 2,000 chars before the answer: ${today2000} of ${known.length} with a known distance (${inCtx.length} in context).`,
  `After, proxy: the rule delivered next to his turn right before the saying: ${pct(summary.inContext.p1Proxy.k, summary.inContext.p1Proxy.n)}.`,
].filter((l) => l !== null).join('\n');
if (!useFixture) {
  const s = stamp();
  writePrivate(join(resultsDir(), `e5-${phase}-${s}.json`), JSON.stringify(summary, null, 2));
  writePrivate(join(resultsDir(), `e5-${phase}-${s}.md`), md + '\n');
}
console.log(md);
