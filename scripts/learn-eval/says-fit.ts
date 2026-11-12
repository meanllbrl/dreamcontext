/**
 * G-pos, second pass (Super decision 2026-11-13): backfill each rule's `says` phrasings from the
 * owner's OWN words, then fit and freeze T. $0, deterministic, no model call.
 *
 *   npx tsx scripts/learn-eval/says-fit.ts [--max-len 120]
 *
 * Per cluster, his typed turns in time order are split in two: the FIT half (the earliest
 * ceil(n/2), what a learn call and its repeats would have stored) and the HELD-OUT half (what the
 * matcher must catch later). A rule's phrases are its text, its headline and every short sentence of
 * its fit turns (his words verbatim, cut at a sentence mark, at most --max-len chars, at least two
 * content terms). Nothing is written or invented.
 * T is chosen on the fit half only (leave one fit turn out, its rule's phrases from the other fit
 * turns), then measured once on the held-out half. Non-rule turns are scored against every rule.
 * Writes results/says-fit-<stamp>.{json,md}; the says lists themselves stay in the frozen dir.
 */
import { join } from 'node:path';
import {
  T_CANDIDATES, bestCoverage, buildIdf, flagNum, loadFrozen, parseArgs, pct, resultsDir, shapeText, stamp, table, writePrivate,
  type FrozenTurn,
} from './lib.js';
import { tokenize } from '../../src/lib/recall.js';

const { flags } = parseArgs(process.argv.slice(2));
const maxLen = flagNum(flags, 'max-len', 120);
const data = loadFrozen();
const byN = new Map(data.turns.map((t) => [t.n, t]));
const ruleTurns = new Set(data.clusters.flatMap((c) => c.turns));
const nonRule = data.turns.filter((t) => !ruleTurns.has(t.n));
const { idf } = buildIdf([...data.turns.map((t) => t.own), ...data.childBriefs.map((b) => b.brief), ...data.clusters.map((c) => c.rule)]);

/** His sentences, verbatim: split at sentence marks and line breaks, short, at least two content terms. */
function sentences(own: string): string[] {
  return own.split(/(?<=[.!?…])\s+|\n+|;\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && new Set(tokenize(s)).size >= 2)
    .map((s) => (s.length > maxLen ? shapeText(s, maxLen) : s));
}

interface Split { cid: string; fit: FrozenTurn[]; held: FrozenTurn[]; cards: FrozenTurn[]; base: string[] }
const splits: Split[] = data.clusters.map((c) => {
  const ts = c.turns.map((n) => byN.get(n)).filter((t): t is FrozenTurn => !!t).sort((a, b) => a.at.localeCompare(b.at));
  const typed = ts.filter((t) => t.kind === 'typed');
  const k = Math.ceil(typed.length / 2);
  return { cid: c.id, fit: typed.slice(0, k), held: typed.slice(k), cards: ts.filter((t) => t.kind === 'answer'), base: [shapeText(c.rule, 240), shapeText(c.rule, 60)] };
});
const saysOf = (turns: readonly FrozenTurn[]): string[] => [...new Set(turns.flatMap((t) => sentences(t.own)))];
const phrases = new Map(splits.map((s) => [s.cid, [...s.base, ...saysOf(s.fit)]]));

// ─── Fit T on the fit half (leave one fit turn out) ─────────────────────────
const loo: Array<{ cid: string; cov: number }> = [];
for (const s of splits) {
  if (s.fit.length < 2) continue;
  for (const t of s.fit) loo.push({ cid: s.cid, cov: bestCoverage(t.own, [...s.base, ...saysOf(s.fit.filter((x) => x !== t))], idf) });
}
const negBest = nonRule.map((t) => Math.max(0, ...splits.map((s) => bestCoverage(t.own, phrases.get(s.cid)!, idf))));
const share = (xs: number[], T: number): number => (xs.length ? xs.filter((v) => v >= T).length / xs.length : 0);
const held = splits.flatMap((s) => s.held.map((t) => ({ cid: s.cid, cov: bestCoverage(t.own, phrases.get(s.cid)!, idf) })));
const cards = splits.flatMap((s) => s.cards.map((t) => ({ cid: s.cid, cov: bestCoverage(t.own, phrases.get(s.cid)!, idf) })));
const rows = T_CANDIDATES.map((T) => [
  T.toFixed(2),
  pct(loo.filter((x) => x.cov >= T).length, loo.length),
  pct(held.filter((x) => x.cov >= T).length, held.length),
  pct(cards.filter((x) => x.cov >= T).length, cards.length),
  `${negBest.filter((v) => v >= T).length}/${negBest.length}`,
]);
const chosen = [...T_CANDIDATES].reverse().find((T) => share(loo.map((x) => x.cov), T) >= 0.8) ?? null;
const heldAt = chosen === null ? null : share(held.map((x) => x.cov), chosen);
const BAR = 0.8;
const verdict = chosen === null
  ? `No T reaches ${BAR * 100}% even on the fit half (best ${pct(loo.filter((x) => x.cov >= T_CANDIDATES[0]!).length, loo.length)} at T=${T_CANDIDATES[0]}).`
  : heldAt! >= BAR
    ? `T=${chosen} frozen: fit half ${pct(loo.filter((x) => x.cov >= chosen).length, loo.length)}, held-out ${pct(held.filter((x) => x.cov >= chosen).length, held.length)} (bar ${BAR * 100}%).`
    : `T=${chosen} fits the fit half but the held-out half reaches ${pct(held.filter((x) => x.cov >= chosen).length, held.length)} (bar ${BAR * 100}%): not frozen.`;
// The best held-out reach any T gives, to say how far off it is.
const bestHeld = Math.max(...T_CANDIDATES.map((T) => share(held.map((x) => x.cov), T)));

const perCluster = splits.map((s) => [s.cid, s.fit.length, s.held.length, saysOf(s.fit).length,
  s.held.length ? `${held.filter((x) => x.cid === s.cid && chosen !== null && x.cov >= chosen).length}/${s.held.length}` : '-']);
const md = [
  '# says backfill and T fit (G-pos, second pass)',
  '',
  `Phrases: rule text, headline, and his own sentences from the fit half (verbatim, at most ${maxLen} chars). Clusters ${splits.length}; fit turns ${splits.reduce((n, s) => n + s.fit.length, 0)}; held-out typed turns ${held.length}; card answers ${cards.length} (reported, not in the bar); says phrases ${[...phrases.values()].reduce((n, p) => n + p.length - 2, 0)}.`,
  '',
  table(['T', 'fit half (leave one out)', 'held-out owner', 'card answers', 'non-rule turns firing'], rows),
  '',
  verdict,
  `Best held-out reach at any T: ${(bestHeld * 100).toFixed(0)}%.`,
  '',
  table(['cluster', 'fit', 'held', 'says', `held hit at T=${chosen ?? '-'}`], perCluster),
].join('\n');
const s = stamp();
writePrivate(join(resultsDir(), `says-fit-${s}.md`), md + '\n');
writePrivate(join(resultsDir(), `says-fit-${s}.json`), JSON.stringify({ maxLen, chosen, heldAt, bestHeld, rows, says: Object.fromEntries(phrases) }, null, 2));
console.log(md);
