/**
 * Meaning-based relevance for rules (Super decision 2026-11-13, after says-fit.ts): the same
 * frozen split as says-fit.ts, scored by embedding similarity instead of word overlap.
 *
 *   npx tsx scripts/learn-eval/says-embed.ts            (local multilingual-e5-small, $0, no egress)
 *   npx tsx scripts/learn-eval/says-embed.ts --voyage   (voyage-4, the cloud index's model, through the
 *     egress gate: an eval-frozen snapshot root, the secret scan, the eval spend ceiling; cents)
 *
 * A rule's vectors: its text and every short sentence of his fit-half turns (passages). A turn is a
 * query; its score for a rule is the best cosine over that rule's vectors. T is chosen on the fit
 * half only (leave one fit turn out), then measured once on the held-out half. A non-rule turn fires
 * when any rule scores at or above T. "Right rule" = the held-out turn's own rule is among those fired;
 * "top-1" = it is the highest-scoring rule.
 */
import { join } from 'node:path';
import { buildIdf, loadFrozen, pct, resultsDir, shapeText, stamp, table, writePrivate, type FrozenTurn } from './lib.js';
import { tokenize } from '../../src/lib/recall.js';
import { embedPassages, embedQuery, EMBED_MODEL } from '../../src/lib/embeddings/embedder.js';
import { buildEgressPayload } from '../../src/lib/embeddings/egress.js';
import { openRouterEmbed } from '../../src/lib/embeddings/openrouter.js';
import { VOYAGE_4_MODEL } from '../../src/lib/embeddings/profiles.js';
import { evalFrozenDir } from '../../src/lib/recall-cloud-config.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import type { CorpusDoc } from '../../src/lib/recall.js';

const voyage = process.argv.includes('--voyage');
let cloudUsd = 0;
let withheldCount = 0;
// The eval snapshot root the egress gate accepts (FINGERPRINT.json + now.txt beside it).
const snap = join(evalFrozenDir(), 'learn-202611', 'voyage');
const vroot = join(snap, '_dream_context');
const vdocPath = join(vroot, 'knowledge', 'rule-phrases.md');
if (voyage) {
  mkdirSync(join(vroot, 'knowledge'), { recursive: true, mode: 0o700 });
  if (!existsSync(join(snap, 'FINGERPRINT.json'))) writeFileSync(join(snap, 'FINGERPRINT.json'), JSON.stringify({ for: 'learn-202611 rule relevance', at: new Date().toISOString() }), { mode: 0o600 });
  if (!existsSync(join(snap, 'now.txt'))) writeFileSync(join(snap, 'now.txt'), new Date().toISOString(), { mode: 0o600 });
  if (!existsSync(vdocPath)) writeFileSync(vdocPath, '# rule phrases\n', { mode: 0o600 });
}
const vdoc = { type: 'knowledge', path: vdocPath, relPath: 'knowledge/rule-phrases.md', slug: 'rule-phrases', title: 'rule phrases', description: '', tags: [], body: '', tokens: [] } as unknown as CorpusDoc;
const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
async function cloudPassages(texts: string[]): Promise<Float32Array[] | null> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const r = buildEgressPayload({ kind: 'index', profile: 'voyage-4', contextRoot: vroot, tier: 'cloud', evalConsent: true, items: batch.map((t, j) => ({ doc: vdoc, chunk: { seq: i + j, hash: sha(t), text: t } })) });
    if (!r.payload) { console.log('index payload withheld:', JSON.stringify(r.withheld.slice(0, 3))); return null; }
    if (r.withheld.length) { console.log('withheld in batch:', r.withheld.length); return null; }
    const e = await openRouterEmbed(r.payload, { timeoutMs: 60_000 });
    cloudUsd += e.costUsd; out.push(...e.vectors);
  }
  return out;
}
async function cloudQuery(text: string): Promise<Float32Array | null> {
  const r = buildEgressPayload({ kind: 'query', query: text, contextRoot: vroot, tier: 'cloud', evalConsent: true });
  if (!r.payload) { withheldCount++; return null; }
  const e = await openRouterEmbed(r.payload, { timeoutMs: 60_000 });
  cloudUsd += e.costUsd;
  return e.vectors[0] ?? null;
}

void buildIdf;
const data = loadFrozen();
const byN = new Map(data.turns.map((t) => [t.n, t]));
const ruleTurns = new Set(data.clusters.flatMap((c) => c.turns));
const nonRule = data.turns.filter((t) => !ruleTurns.has(t.n));

function sentences(own: string): string[] {
  return own.split(/(?<=[.!?…])\s+|\n+|;\s+/).map((s) => s.trim())
    .filter((s) => s.length >= 8 && new Set(tokenize(s)).size >= 2)
    .map((s) => (s.length > 120 ? shapeText(s, 120) : s));
}
interface Split { cid: string; rule: string; fit: FrozenTurn[]; held: FrozenTurn[]; cards: FrozenTurn[] }
const splits: Split[] = data.clusters.map((c) => {
  const ts = c.turns.map((n) => byN.get(n)).filter((t): t is FrozenTurn => !!t).sort((a, b) => a.at.localeCompare(b.at));
  const typed = ts.filter((t) => t.kind === 'typed');
  const k = Math.ceil(typed.length / 2);
  return { cid: c.id, rule: shapeText(c.rule, 240), fit: typed.slice(0, k), held: typed.slice(k), cards: ts.filter((t) => t.kind === 'answer') };
});

// ─── Embed (cached by text) ─────────────────────────────────────────────────
const cut = (s: string): string => s.slice(0, 2000);
const passageTexts = new Set<string>();
for (const s of splits) { passageTexts.add(s.rule); for (const t of s.fit) for (const x of sentences(t.own)) passageTexts.add(x); }
const pList = [...passageTexts];
const pVecs = voyage ? await cloudPassages(pList) : await embedPassages(pList);
if (!pVecs) { console.log('local embedding model not available'); process.exit(2); }
const P = new Map(pList.map((t, i) => [t, pVecs[i]!]));
const qTurns = [...new Set([...splits.flatMap((s) => [...s.fit, ...s.held, ...s.cards]), ...nonRule])];
const Q = new Map<number, Float32Array>();
for (const t of qTurns) { const v = voyage ? await cloudQuery(cut(t.own)) : await embedQuery(cut(t.own)); if (v) Q.set(t.n, v); }
const qOk = (t: FrozenTurn): boolean => Q.has(t.n);
const dot = (a: Float32Array, b: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

const vecsOf = (s: Split, fit: readonly FrozenTurn[]): Float32Array[] =>
  [s.rule, ...new Set(fit.flatMap((t) => sentences(t.own)))].map((x) => P.get(x)!).filter(Boolean);
const ruleVecs = new Map(splits.map((s) => [s.cid, vecsOf(s, s.fit)]));
const score = (q: Float32Array, vs: Float32Array[]): number => Math.max(-1, ...vs.map((v) => dot(q, v)));
const allScores = (n: number): Array<[string, number]> => splits.map((s) => [s.cid, score(Q.get(n)!, ruleVecs.get(s.cid)!)]);

const loo: number[] = [];
for (const s of splits) {
  if (s.fit.length < 2) continue;
  for (const t of s.fit.filter(qOk)) loo.push(score(Q.get(t.n)!, vecsOf(s, s.fit.filter((x) => x !== t))));
}
const heldRows = splits.flatMap((s) => s.held.filter(qOk).map((t) => ({ cid: s.cid, own: score(Q.get(t.n)!, ruleVecs.get(s.cid)!), all: allScores(t.n) })));
const cardRows = splits.flatMap((s) => s.cards.filter(qOk).map((t) => ({ cid: s.cid, own: score(Q.get(t.n)!, ruleVecs.get(s.cid)!) })));
const nonRuleQ = nonRule.filter(qOk);
const negBest = nonRuleQ.map((t) => Math.max(...allScores(t.n).map(([, v]) => v)));
const negFired = (T: number): number => nonRuleQ.map((t) => allScores(t.n).filter(([, v]) => v >= T).length).reduce((a, b) => a + b, 0);

const Ts = voyage ? Array.from({ length: 36 }, (_, i) => +(0.3 + i * 0.01).toFixed(2)) : Array.from({ length: 31 }, (_, i) => +(0.7 + i * 0.01).toFixed(2));
const share = (xs: number[], T: number): number => (xs.length ? xs.filter((v) => v >= T).length / xs.length : 0);
const rows = Ts.map((T) => {
  const top1 = heldRows.filter((r) => r.own >= T && r.all.every(([c, v]) => c === r.cid || v <= r.own)).length;
  return [T.toFixed(2), pct(loo.filter((v) => v >= T).length, loo.length), pct(heldRows.filter((r) => r.own >= T).length, heldRows.length),
    `${top1}/${heldRows.length}`, pct(cardRows.filter((r) => r.own >= T).length, cardRows.length),
    `${negBest.filter((v) => v >= T).length}/${negBest.length}`, String(negFired(T))];
});
const chosen = [...Ts].reverse().find((T) => share(loo, T) >= 0.8) ?? null;
const heldAt = chosen === null ? null : share(heldRows.map((r) => r.own), chosen);
const md = [
  `# Meaning-based rule relevance (${voyage ? `${VOYAGE_4_MODEL}, cloud, $${cloudUsd.toFixed(4)}, queries withheld ${withheldCount}` : `${EMBED_MODEL}, local`})`,
  '',
  `Same split as says-fit.ts: fit turns ${splits.reduce((n, s) => n + s.fit.length, 0)}, held-out typed ${heldRows.length}, card answers ${cardRows.length}, non-rule turns ${nonRule.length}; rule vectors ${pList.length}.`,
  '',
  table(['T (cosine)', 'fit half LOO', 'held-out owner', 'held-out top-1', 'card answers', 'non-rule turns firing', 'false rule fires total'], rows),
  '',
  chosen === null ? 'No T reaches 80% on the fit half.' : `T=${chosen} chosen on the fit half; held-out reach ${(heldAt! * 100).toFixed(0)}% (bar 80%); non-rule turns firing ${negBest.filter((v) => v >= chosen).length}/${negBest.length}.`,
].join('\n');
const s = stamp();
writePrivate(join(resultsDir(), `says-embed-${voyage ? 'voyage' : 'local'}-${s}.md`), md + '\n');
console.log(md);
