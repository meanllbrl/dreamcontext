/**
 * E3 reach (plan criterion 7). $0, deterministic, no model call.
 *
 *   npx vite-node scripts/learn-eval/reach.ts -- [--phase before|after] [--cli dist/index.js] [--fixture]
 *
 * Two halves:
 *   1. Offline T candidates (gate G-pos freezes T from this, C6/D7): for every frozen positive
 *      (job text, rule) the best share of one phrase's IDF mass the job covers with at least two
 *      distinct content terms; the same for every non-rule turn against every rule. Tokens from
 *      recall's `tokenize()`, IDF over the frozen turns + briefs + rules. Printed as a table per T.
 *   2. The real path: the 41 rules seeded into scratch stores through the `learn` CLI (as D11's
 *      list would write them, taught from each cluster's first saying), the Tilki patterns copied
 *      in before any backfill, then every positive, non-rule turn and machine turn through
 *      `deliverForTurn`. With the W1 stub this measures today (0); after W2 it runs unchanged.
 *
 * Writes results/e3-<phase>-<stamp>.json + .md and, for hand labels, e3-fire-sample-<phase>.md
 * (30 fires on non-rule turns). Labels go in results/e3-fire-labels-<phase>.json as
 * {"<n>": "on-point"|"partly"|"off"}; a later run counts them (bar: at least 23 of 30).
 */
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO, T_CANDIDATES, bestCoverage, buildIdf, clusterSeeds, dc, delivered, flagStr, hookInput, listFiles, loadDeliver, loadFixture, loadFrozen,
  makeScratch, parseArgs, pct, resultsDir, sample, seedRules, slugOfFile, stamp, table, teachingTurn, writePrivate,
  type FrozenTurn, type Proj, type SeededRule, type Surface,
} from './lib.js';

const { flags } = parseArgs(process.argv.slice(2));
const phase = flagStr(flags, 'phase', 'before');
const useFixture = flags.fixture === true;
const data = useFixture ? loadFixture() : loadFrozen();
// Machine turns: the fixture's synthetic server notices, plus the replay's server-written prompts
// (source machine, server or notice; a replay prompt from a brief is neither owner nor machine).
const MACHINE_SOURCES = new Set(['machine', 'server', 'notice']);
const machineTexts = [...loadFixture().machine, ...(useFixture ? [] : data.replay.filter((r) => MACHINE_SOURCES.has(r.source)).map((r) => r.text))];

const byN = new Map(data.turns.map((t) => [t.n, t]));
const ruleTurnSet = new Set(data.clusters.flatMap((c) => c.turns));

// ─── Positives ──────────────────────────────────────────────────────────────
type Channel = 'owner' | 'owner-card' | 'child' | 'dispatch';
interface Positive { channel: Channel; cid: string; text: string; proj: Proj; n?: number }
const positives: Positive[] = [];
for (const c of data.clusters) {
  const teach = teachingTurn(c, byN);
  for (const n of c.turns) {
    const t = byN.get(n);
    if (!t || t.n === teach?.n) continue;
    positives.push({ channel: t.kind === 'typed' ? 'owner' : 'owner-card', cid: c.id, text: t.own, proj: t.proj, n });
  }
}
for (const b of data.childBriefs) {
  const c = data.clusters.find((x) => x.id === b.cid);
  if (c) positives.push({ channel: 'child', cid: b.cid, text: b.brief, proj: c.scope.startsWith('T') ? 'T' : 'D' });
}
for (const d of data.dispatch) {
  const c = data.clusters.find((x) => x.id === d.cid);
  if (c) positives.push({ channel: 'dispatch', cid: d.cid, text: d.prompt, proj: c.scope.startsWith('T') ? 'T' : 'D' });
}
const nonRule: FrozenTurn[] = data.turns.filter((t) => !ruleTurnSet.has(t.n));
const replayOwner = data.replay.filter((r) => r.source === 'owner').map((r) => r.text);

// ─── 1. Offline T candidates ────────────────────────────────────────────────
const seeds = clusterSeeds(data.clusters, data.turns);
const phrasesOf = new Map(seeds.map((s) => [s.key, [s.text, s.headline, s.quote]]));
const { idf } = buildIdf([...data.turns.map((t) => t.own), ...data.childBriefs.map((b) => b.brief), ...data.clusters.map((c) => c.rule)]);
const posCov = positives.map((p) => ({ ...p, cov: bestCoverage(p.text, phrasesOf.get(p.cid) ?? [], idf) }));
const negCov = nonRule.map((t) => {
  let best = 0; let cid = '';
  for (const s of seeds) { const v = bestCoverage(t.own, phrasesOf.get(s.key)!, idf); if (v > best) { best = v; cid = s.key; } }
  return { n: t.n, cov: best, cid };
});
const machCov = machineTexts.map((text) => Math.max(0, ...seeds.map((s) => bestCoverage(text, phrasesOf.get(s.key)!, idf))));
const channels: Channel[] = ['owner', 'owner-card', 'child', 'dispatch'];
const tRows = T_CANDIDATES.map((T) => [
  T.toFixed(2),
  ...channels.map((ch) => { const xs = posCov.filter((p) => p.channel === ch); return pct(xs.filter((p) => p.cov >= T).length, xs.length); }),
  `${negCov.filter((x) => x.cov >= T).length}/${negCov.length}`,
  `${machCov.filter((v) => v >= T).length}/${machCov.length}`,
]);
const ownerAt = (T: number): number => { const xs = posCov.filter((p) => p.channel === 'owner'); return xs.length ? xs.filter((p) => p.cov >= T).length / xs.length : 0; };
const highestT80 = [...T_CANDIDATES].reverse().find((T) => ownerAt(T) >= 0.8) ?? null;

// ─── 2. The real path through deliverForTurn ────────────────────────────────
const scratchDir = mkdtempSync(join(tmpdir(), 'learn-e3-'));
const cli = flagStr(flags, 'cli', join(REPO, 'dist', 'index.js'));
const scratch = makeScratch(scratchDir, ['D', 'T'], cli);
const seeded: SeededRule[] = seedRules(scratch, seeds);
const seedErrors = seeded.filter((s) => s.error);
let tilkiCopied = 0;
if (data.tilkiPatternsDir && scratch.vaults.T) {
  const dest = join(scratch.vaults.T, '_dream_context', 'knowledge', 'patterns');
  for (const p of listFiles(data.tilkiPatternsDir, /\.md$/)) { cpSync(p, join(dest, p.split('/').pop()!)); tilkiCopied++; }
}
for (const v of Object.values(scratch.vaults)) if (v) dc(scratch, v, ['patterns', 'sync']);

const { deliver, error: deliverError } = await loadDeliver(scratch.home);
const seedBy = new Map(seeded.map((s) => [s.key, s]));
const rootOf = (p: Proj): string => scratch.vaults[p === 'T' ? 'T' : 'D']!;
const surfaceOf = (ch: Channel): Surface => (ch === 'child' ? 'child' : ch === 'dispatch' ? 'dispatch' : 'owner');

interface Live { measurable: boolean; reach: Record<Channel, { k: number; n: number }>; nonRuleFires: Array<{ n: number; ids: string[] }>; replayFires: number; machineFires: number; machineAsOwnerFires: number; tilki: { k: number; n: number; misses: string[] }; chars: number[] }
const live: Live = { measurable: !!deliver, reach: { owner: { k: 0, n: 0 }, 'owner-card': { k: 0, n: 0 }, child: { k: 0, n: 0 }, dispatch: { k: 0, n: 0 } }, nonRuleFires: [], replayFires: 0, machineFires: 0, machineAsOwnerFires: 0, tilki: { k: 0, n: 0, misses: [] }, chars: [] };

if (deliver) {
  const firedIds = (root: string, surface: Surface, text: string): { ids: string[]; any: boolean; chars: number } => {
    try {
      const d = deliver(root, hookInput(surface, text, root));
      const ids = seeded.filter((s) => s.id && delivered(d, s.id, s.headline)).map((s) => s.key);
      return { ids, any: d.always.length + d.moment.length + d.matched.length > 0, chars: d.chars };
    } catch { return { ids: [], any: false, chars: 0 }; }
  };
  for (const p of positives) {
    const s = seedBy.get(p.cid);
    const r = firedIds(rootOf(p.proj), surfaceOf(p.channel), p.text);
    live.reach[p.channel].n++;
    if (s?.id && r.ids.includes(p.cid)) live.reach[p.channel].k++;
    if (p.channel === 'owner') live.chars.push(r.chars);
  }
  for (const t of nonRule) {
    const r = firedIds(rootOf(t.proj), 'owner', t.own);
    if (r.ids.length) live.nonRuleFires.push({ n: t.n, ids: r.ids });
  }
  for (const text of replayOwner) if (firedIds(rootOf('D'), 'owner', text).ids.length) live.replayFires++;
  for (const text of machineTexts) {
    if (firedIds(rootOf('D'), 'machine', text).any) live.machineFires++;
    if (firedIds(rootOf('D'), 'owner', text).ids.length) live.machineAsOwnerFires++;
  }
  if (data.tilkiPatternsDir) {
    for (const p of listFiles(data.tilkiPatternsDir, /\.md$/)) {
      const raw = readFileSync(p, 'utf-8');
      const name = /^name:\s*(.+)$/m.exec(raw)?.[1]?.replace(/^["']|["']$/g, '').trim() || /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() || slugOfFile(p).replace(/-/g, ' ');
      const job = `Şimdi şu konuda çalışacağız: ${name}. Başla ve bana haber ver.`;
      const slug = slugOfFile(p);
      live.tilki.n++;
      try {
        const d = deliver(rootOf('T'), hookInput('owner', job, rootOf('T')));
        const hit = [...d.matched, ...d.moment].some((l) => l.includes(slug) || l.includes(name));
        if (hit) live.tilki.k++; else live.tilki.misses.push(slug);
      } catch { live.tilki.misses.push(slug); }
    }
  }
}

// ─── Fire sample and labels ─────────────────────────────────────────────────
const OUT = resultsDir();
const fireSample = sample(live.nonRuleFires, 30, 20261113);
const labelsPath = join(OUT, `e3-fire-labels-${phase}.json`);
let labelCount: { onPoint: number; partly: number; off: number; labelled: number } | null = null;
if (existsSync(labelsPath)) {
  const labels = JSON.parse(readFileSync(labelsPath, 'utf-8')) as Record<string, string>;
  labelCount = { onPoint: 0, partly: 0, off: 0, labelled: 0 };
  for (const f of fireSample) {
    const l = labels[String(f.n)];
    if (!l) continue;
    labelCount.labelled++;
    if (l === 'on-point') labelCount.onPoint++; else if (l === 'partly') labelCount.partly++; else labelCount.off++;
  }
}
if (!useFixture && fireSample.length) {
  const md = [`# E3 fire sample (${phase}): label each as on-point, partly or off`, '', `Write labels to ${labelsPath} as {"<n>": "on-point"|"partly"|"off"}.`, ''];
  for (const f of fireSample) {
    md.push(`## turn ${f.n}`, '', byN.get(f.n)?.own ?? '', '', `fired: ${f.ids.map((id) => `${id} "${seedBy.get(id)?.headline ?? ''}"`).join('; ')}`, '');
  }
  writePrivate(join(OUT, `e3-fire-sample-${phase}.md`), md.join('\n'));
}

// ─── Report ─────────────────────────────────────────────────────────────────
const median = (xs: number[]): number => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]!; };
const summary = {
  phase, at: new Date().toISOString(), fixture: useFixture,
  positives: Object.fromEntries(channels.map((ch) => [ch, posCov.filter((p) => p.channel === ch).length])),
  nonRuleTurns: nonRule.length, machineTurns: machineTexts.length, replayOwnerPrompts: replayOwner.length,
  offline: { table: tRows, highestTWithOwnerReach80: highestT80 },
  seeding: { rules: seeded.length, active: seeded.filter((s) => s.status === 'active').length, errors: seedErrors.length, firstError: seedErrors[0]?.error ?? null },
  live: { ...live, deliverError: deliverError ?? null, fireSample: fireSample.length, labels: labelCount, ownerRulesCharsMedian: median(live.chars), ownerRulesCharsMax: Math.max(0, ...live.chars) },
  tilkiCopied, scratchDir,
};
const md = [
  `# E3 reach (${phase})${useFixture ? ' [synthetic fixture]' : ''}`,
  '',
  `Positives: ${channels.map((ch) => `${ch} ${summary.positives[ch]}`).join(', ')}; non-rule turns ${nonRule.length}; machine turns ${machineTexts.length}.`,
  '',
  '## Offline T candidates (IDF-mass coverage of one phrase, at least two distinct terms)',
  '',
  table(['T', ...channels.map((c) => `reach ${c}`), 'non-rule fires', 'machine fires'], tRows),
  '',
  `Highest T with owner-prompt reach at least 80%: ${highestT80 ?? 'none'}.`,
  '',
  '## Through deliverForTurn',
  '',
  live.measurable ? table(['channel', 'reach (bar 80%)'], channels.map((ch) => [ch, pct(live.reach[ch].k, live.reach[ch].n)])) : `not measurable: ${deliverError}`,
  '',
  `Seeded rules: ${summary.seeding.active} active of ${seeded.length}${seedErrors.length ? `; ${seedErrors.length} not seeded (${summary.seeding.firstError})` : ''}.`,
  `Non-rule turns that fired a rule: ${live.nonRuleFires.length} of ${nonRule.length}; 101-prompt replay fires: ${replayOwner.length ? `${live.replayFires} of ${replayOwner.length}` : 'no replay frozen'}.`,
  `Machine turns that fired (surface machine, bar 0): ${live.machineFires} of ${machineTexts.length}; the same texts as owner turns: ${live.machineAsOwnerFires}.`,
  `Tilki patterns with no when/says firing on a job naming the subject: ${data.tilkiPatternsDir ? pct(live.tilki.k, live.tilki.n) : 'no Tilki patterns frozen'}.`,
  `Fire sample: ${fireSample.length}${labelCount ? `; labelled ${labelCount.labelled}: on point ${labelCount.onPoint}, partly ${labelCount.partly}, off ${labelCount.off} (bar: on point or partly at least 23)` : '; not labelled yet'}.`,
  `Rules text on owner prompts: median ${summary.live.ownerRulesCharsMedian} chars, largest ${summary.live.ownerRulesCharsMax}.`,
].join('\n');
if (!useFixture) {
  const s = stamp();
  writePrivate(join(OUT, `e3-${phase}-${s}.json`), JSON.stringify(summary, null, 2));
  writePrivate(join(OUT, `e3-${phase}-${s}.md`), md + '\n');
}
console.log(md);
