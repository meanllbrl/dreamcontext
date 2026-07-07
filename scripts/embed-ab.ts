// Embedding A/B: BM25-only vs hybrid (RRF) vs dense-only on the FROZEN gold
// sets — the prove-it-or-kill-it gate for the experimental embedding layer
// (knowledge/decisions/decision-embedding-layer.md).
//
// Same corpus discipline as recall-ab.ts: git-tracked docs only, no capture
// docs, no in-flight tracking noise (v3 measurement-discipline lesson).
//
// Usage:
//   npx tsx scripts/embed-ab.ts                 # gold.jsonl (60q train)
//   npx tsx scripts/embed-ab.ts --heldout       # gold-heldout.jsonl (30q)
//   npx tsx scripts/embed-ab.ts --misses hybrid # per-query miss diff for a mode
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus, bm25Search, docKey, type CorpusDoc } from '../src/lib/recall.js';
import { hybridSearch, denseSearch } from '../src/lib/embeddings/hybrid.js';
import { refreshEmbeddings } from '../src/lib/embeddings/store.js';
import { loadGold, evaluateSearch, formatComparison, type ExtendedReport, type SearchFn } from '../eval/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const ROOT = join(PROJECT, '_dream_context');
const EXCLUDED_SLUGS = new Set(['recall-context-uplift-v07']);

function stableCorpus(): CorpusDoc[] {
  return buildCorpus(ROOT).filter(
    (d) => !d.capture && !d.slug.startsWith('digest#') && !d.slug.startsWith('bookmark#')
      && !EXCLUDED_SLUGS.has(d.slug),
  );
}

const corpus = stableCorpus();
const goldPath = process.argv.includes('--heldout')
  ? join(PROJECT, 'eval', 'gold-heldout.jsonl')
  : join(PROJECT, 'eval', 'gold.jsonl');
const gold = loadGold(goldPath);

// Warm the embedding cache once, up front, so per-query latency measures
// SEARCH cost (as production would see it), not one-off indexing cost.
const tIndex = performance.now();
const refreshed = await refreshEmbeddings(ROOT, corpus);
if (refreshed === null) {
  console.error('Embedding model unavailable — cannot run the A/B.');
  process.exit(1);
}
const indexMs = Math.round(performance.now() - tIndex);

// --sweep: tune the convex BM25 weight in the RRF combination on this gold set.
// Constraint first (exact-term/field-match r@1 must hold BM25's level), then
// overall r@1/MRR. Tune on train ONLY; validate the chosen weight on held-out.
if (process.argv.includes('--sweep')) {
  const rrfMode = process.argv.includes('--rrf');
  const weights = rrfMode
    ? [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9] // w_bm25 for rrf
    : [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]; // λ (dense) for relative
  const base = await evaluateSearch(async (q, k) => bm25Search(q, corpus, k), gold);
  console.log(`\nbm25 baseline: r@1 ${base.overall.recall1.toFixed(1)} · r@3 ${base.overall.recall3.toFixed(1)} · MRR ${base.overall.mrr.toFixed(3)} · exact r@1 ${base.byCategory['exact-term']?.recall1.toFixed(1)}`);
  console.log(`${rrfMode ? 'w_bm25' : 'λdense'} | r@1  | r@3  | r@5  | MRR   | exact r@1 | field r@1 | tr r@3 | recency r@1`);
  for (const w of weights) {
    const rep = await evaluateSearch(
      (q, k) => hybridSearch(q, corpus, ROOT, k, rrfMode ? { fusion: 'rrf', bm25Weight: w } : { denseWeight: w }),
      gold,
    );
    const o = rep.overall;
    console.log([
      w.toFixed(2).padStart(6),
      o.recall1.toFixed(1).padStart(4),
      o.recall3.toFixed(1).padStart(4),
      o.recall5.toFixed(1).padStart(4),
      o.mrr.toFixed(3).padStart(5),
      (rep.byCategory['exact-term']?.recall1 ?? 0).toFixed(1).padStart(9),
      (rep.byCategory['field-match']?.recall1 ?? 0).toFixed(1).padStart(9),
      (rep.byCategory.turkish?.recall3 ?? 0).toFixed(1).padStart(6),
      (rep.byCategory.recency?.recall1 ?? 0).toFixed(1).padStart(11),
    ].join(' | '));
  }
  process.exit(0);
}

// --w <val>: override the BM25 weight for the hybrid mode in this run.
const wOverride = (() => {
  const i = process.argv.indexOf('--w');
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
})();

const MODES: Record<string, SearchFn> = {
  bm25: async (q, k) => bm25Search(q, corpus, k),
  hybrid: (q, k) => hybridSearch(q, corpus, ROOT, k, wOverride !== undefined ? { bm25Weight: wOverride } : {}),
  dense: (q, k) => denseSearch(q, corpus, ROOT, k),
};

const reports: Record<string, ExtendedReport> = {};
for (const [name, fn] of Object.entries(MODES)) {
  reports[name] = await evaluateSearch(fn, gold);
}

console.log(`corpus: ${corpus.length} docs (stable) · gold: ${goldPath.split('/').pop()} (${gold.length}q)`);
console.log(`index: ${refreshed.index.chunks.length} chunks · refresh ${indexMs}ms (embedded ${refreshed.stats.embedded}, reused ${refreshed.stats.reused})`);
console.log(formatComparison(reports));

// Per-query diff: where do the modes disagree?
const missMode = (() => {
  const i = process.argv.indexOf('--misses');
  return i >= 0 ? (process.argv[i + 1] ?? 'hybrid') : null;
})();
if (missMode && reports[missMode]) {
  const bm25ByQ = new Map(reports.bm25.perQuery.map((p) => [p.id, p.rank]));
  console.log(`\n## per-query: ${missMode} vs bm25 (only differences)`);
  for (const p of reports[missMode].perQuery) {
    const before = bm25ByQ.get(p.id) ?? null;
    if (before === p.rank) continue;
    const q = gold.find((g) => g.id === p.id);
    const arrow = `bm25 rank=${before ?? 'MISS'} → ${missMode} rank=${p.rank ?? 'MISS'}`;
    console.log(`\n[${p.id}] (${p.category}/${p.lang}) ${arrow}\n  "${q?.query}"`);
    if (q) {
      const targets = new Set([...q.expected, ...(q.alt ?? [])]);
      const hits = await MODES[missMode](q.query, 5);
      hits.forEach((h, i) => {
        const key = docKey('doc' in h && h.doc ? h.doc : (h as CorpusDoc));
        console.log(`  ${i + 1}. ${targets.has(key) ? '✓' : ' '} ${key}`);
      });
    }
  }
}
