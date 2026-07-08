import { bm25Search, docKey, type Bm25Options, type CorpusDoc, type RecallHit } from '../recall.js';
import { embedQuery, isEmbedModelDownloaded } from './embedder.js';
import { refreshEmbeddings, embeddingCacheUsable, type DenseIndex } from './store.js';

/**
 * Whether hybrid recall should ACTUALLY run for a vault right now — the single
 * gate every automatic recall path shares (the always-on hook, the dashboard's
 * live `/api/recall`, `memory recall`). Hybrid engages only when the mode is
 * 'hybrid', the model is already downloaded, AND the vault's embedding cache is
 * present and USABLE for the current model/version. This keeps the two EXPENSIVE,
 * one-time operations off the keystroke/prompt path — a 113 MB model download and
 * a full corpus (re)index — since both are paid explicitly (the Settings card /
 * `dreamcontext embed refresh`). When it returns false, callers fall back to BM25.
 *
 * NOTE: this does not promise zero latency — a warm search embeds the query
 * (~22 ms) and, in a freshly-started process, pays a one-time in-process model
 * load (~1 s) on the FIRST hybrid query. That per-process load is inherent to the
 * daemonless design (see decision-embedding-layer) and is why hybrid recall is
 * opt-in; what this gate guarantees is no DOWNLOAD and no COLD FULL INDEX inline.
 */
export function hybridReady(root: string, mode: string): boolean {
  return mode === 'hybrid' && isEmbedModelDownloaded() && embeddingCacheUsable(root);
}

/**
 * Hybrid recall: BM25 (backbone) + dense vectors (overlay), fused with
 * Reciprocal Rank Fusion. BM25 is NEVER replaced — pure-vector regresses on
 * exact tokens (slugs, identifiers, error codes) that this corpus is full of;
 * hybrid beats either alone by +5–18% nDCG on BEIR.
 *
 * Decoupling invariant (sacred): dense/RRF feeds `rankScore` ONLY. Every hit's
 * raw `score` is the untouched flat-BM25 value (0 for dense-only hits), so the
 * hook's hard gates (`>= 2.0` etc.) behave identically in every mode.
 */

/** RRF constant — k=60 is the original tuned value (Cormack et al., SIGIR 2009). */
export const RRF_K = 60;

/** Candidate pool depth per rank list. RRF fuses the top-POOL of each ranker. */
const POOL = 50;

export interface DenseHit {
  docKey: string;
  /** Max cosine similarity over the doc's chunks (vectors are L2-normalized → dot). */
  sim: number;
}

/**
 * Rank corpus docs by dense similarity: a doc's score is the MAX dot product
 * over its chunk vectors (best-passage semantics — a long doc with one sharply
 * relevant section should rank as high as a short doc that is all about it).
 */
export function denseRank(queryVec: Float32Array, index: DenseIndex, topK = POOL): DenseHit[] {
  const best = new Map<string, number>();
  for (const chunk of index.chunks) {
    const v = chunk.vector;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * queryVec[i];
    const cur = best.get(chunk.docKey);
    if (cur === undefined || dot > cur) best.set(chunk.docKey, dot);
  }
  return Array.from(best.entries())
    .map(([key, sim]) => ({ docKey: key, sim }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topK);
}

/**
 * Default BM25 weight for the EXPLICIT 'rrf' fusion mode (dense gets 1 − w).
 * Plain RRF (w = 0.5) was measured FIRST, per the decision doc — and it
 * regressed exact-term recall@1 from 100% to 83.3% on the train gold set (an
 * equal dense vote drags down exact-token queries: slugs, identifiers, error
 * codes). No global weight fixed that (rank fusion erases score margins), which
 * is why the production default is the ADAPTIVE switch below; 'rrf' remains as
 * an explicit mode for the A/B harness.
 */
export const BM25_RRF_WEIGHT = 0.7;

/**
 * Fuse rank lists (docKey order) with weighted RRF:
 * RRF(d) = Σ w_i / (k + rank_i(d)). Rank is 1-based; a doc absent from a list
 * contributes nothing for it. Rank-based, no score normalization (scores from
 * the two channels are not comparable and never mixed directly). Weights
 * default to 1 (plain RRF, Cormack et al.).
 */
export function rrfFuse(lists: string[][], k = RRF_K, weights?: number[]): Map<string, number> {
  const fused = new Map<string, number>();
  for (let li = 0; li < lists.length; li++) {
    const list = lists[li];
    const w = weights?.[li] ?? 1;
    for (let i = 0; i < list.length; i++) {
      const key = list[i];
      fused.set(key, (fused.get(key) ?? 0) + w / (k + i + 1));
    }
  }
  return fused;
}

/**
 * Default dense share λ for the EXPLICIT 'relative' fusion mode (BM25 gets
 * 1 − λ). Relative-score fusion (min-max-normalized convex combination,
 * Weaviate-style) preserves BM25's score MARGINS — a decisive BM25 winner
 * needs a large dense advantage to be displaced — unlike rank-based RRF, which
 * erases margins and let a tiny dense vote flip decisive exact-term top-1s.
 * The production default is the ADAPTIVE switch below, which uses relative
 * fusion only in the BM25-confident zone.
 */
export const DENSE_FUSION_WEIGHT = 0.3;

/**
 * Relative-score fusion: min-max normalize each channel's scores over its own
 * candidate pool, then combine convexly: fused = (1−λ)·bm25ₙ + λ·denseₙ.
 * A doc absent from a channel contributes 0 for it. Unlike RRF this is
 * score-aware — normalization (not raw mixing) makes the two channels
 * comparable while preserving within-channel margins.
 */
export function relativeFuse(
  bm25Scores: Map<string, number>,
  denseScores: Map<string, number>,
  denseWeight = DENSE_FUSION_WEIGHT,
): Map<string, number> {
  const normalize = (scores: Map<string, number>): Map<string, number> => {
    if (scores.size === 0) return new Map();
    let min = Infinity;
    let max = -Infinity;
    for (const v of scores.values()) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max - min;
    const out = new Map<string, number>();
    // A single-doc (or all-equal) pool normalizes to 1 — it IS the best match.
    for (const [k, v] of scores) out.set(k, span > 0 ? (v - min) / span : 1);
    return out;
  };
  const bn = normalize(bm25Scores);
  const dn = normalize(denseScores);
  const fused = new Map<string, number>();
  for (const [k, v] of bn) fused.set(k, (1 - denseWeight) * v);
  for (const [k, v] of dn) fused.set(k, (fused.get(k) ?? 0) + denseWeight * v);
  return fused;
}

// ── Adaptive fusion: BM25 confidence picks the fusion TYPE ───────────────────
// The top raw flat-BM25 score is a trusted per-query confidence signal (the
// hook already hard-gates on it): on the train gold set, exact-token queries
// top out at raw 19–47 while the queries dense actually rescues (turkish,
// recency, weak paraphrase) sit at raw 0–18.
//
// - CONFIDENT (topRaw ≥ cutoff): relative-score fusion with a small λ. Score-
//   aware fusion preserves BM25's margins, so a decisive lexical winner cannot
//   be flipped by a dense near-tie (this is what a pure λ-ramp could not fix:
//   even λ=0.25 broke exact-term recall@1).
// - UNCONFIDENT (topRaw < cutoff): weighted rank-based RRF. When BM25 is weak
//   its score GAPS are noise — rank fusion deliberately flattens them so dense
//   can pull a buried doc (rank 5–7) to the top. This is where the Turkish and
//   recency wins live; score-preserving fusion cannot reach them by design.
//
// Tuned on the 60q train set, validated untouched on the 30q held-out set
// (both improved overall r@1/r@3/MRR with zero exact-term regression — see
// eval/RESULTS.md "Embedding A/B").
export const ADAPTIVE_RAW_CUTOFF = 18;   // below → rank fusion; at/above → score fusion
export const ADAPTIVE_RRF_BM25_WEIGHT = 0.6; // BM25 weight in the unconfident RRF zone
export const ADAPTIVE_RELATIVE_LAMBDA = 0.1; // dense λ in the confident relative zone

/**
 * Top-1 pin guard for the unconfident RRF zone. Rank fusion there deliberately
 * flattens BM25's score gaps — but when BM25's OWN top-1 rankScore margin over
 * its runner-up is decisive (≥ this ratio), BM25 is internally confident even
 * at low raw magnitude, and letting dense outvote it produced the single worst
 * measured regression (train q021: gold at rank 1 → out of top-10; dense had
 * the gold at rank >50). Every measured displacement WIN (dense correctly
 * promoting a doc over BM25's top-1) had a flat margin (1.05–1.32), so pinning
 * at ≥ 1.35 keeps all of them. The pinned doc holds rank 1; the rest of the
 * fused order is untouched.
 */
export const ADAPTIVE_PIN_MARGIN = 1.35;

/**
 * Doc types excluded from the DENSE channel (BM25 still sees them). Changelog
 * entries are one-line POINTERS to work — their short, title-anchored chunks
 * make unusually focused vectors that match broadly and crowd out the canonical
 * doc that actually answers the query. Same canonical-first reasoning as
 * CHANGELOG_RANK_FACTOR in recall.ts, applied at the candidate level.
 */
export const DENSE_EXCLUDED_TYPES: readonly string[] = ['changelog'];

/** Drop excluded-type docs from the dense index (chunks are keyed `type/slug`). */
function denseEligible(index: DenseIndex, excludedTypes: readonly string[]): DenseIndex {
  if (excludedTypes.length === 0) return index;
  const banned = excludedTypes.map((t) => `${t}/`);
  return {
    dims: index.dims,
    chunks: index.chunks.filter((c) => !banned.some((p) => c.docKey.startsWith(p))),
  };
}

/** First ~3 non-heading body lines — snippet fallback for dense-only hits. */
function fallbackSnippet(doc: CorpusDoc): string {
  return doc.body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('---'))
    .slice(0, 3)
    .join('\n');
}

/**
 * Hybrid BM25+dense search over a corpus. Same signature semantics as
 * bm25Search, plus `contextRoot` for the embedding cache. Falls back to plain
 * bm25Search when the embedding model is unavailable — enabling hybrid mode on
 * a machine without the model must never break recall.
 *
 * The cache refresh runs lazily here: with nothing changed it is an mtime scan
 * (near-instant); after edits it embeds only the changed chunks.
 */
export interface HybridOptions extends Bm25Options {
  /** Fusion algorithm. Default 'adaptive' (confidence-switched fusion type). */
  fusion?: 'adaptive' | 'relative' | 'rrf';
  /** BM25 weight for the 'rrf' fusion (dense gets 1 − w). */
  bm25Weight?: number;
  /** Dense weight λ for the 'relative' fusion (BM25 gets 1 − λ). */
  denseWeight?: number;
  /** Top-1 pin margin for the adaptive RRF zone (0 disables). Default ADAPTIVE_PIN_MARGIN. */
  pinMargin?: number;
  /** Doc types kept out of the dense channel. Default DENSE_EXCLUDED_TYPES. */
  denseExcludedTypes?: readonly string[];
}

export async function hybridSearch(
  query: string,
  corpus: CorpusDoc[],
  contextRoot: string,
  topK = 10,
  opts: HybridOptions = {},
): Promise<RecallHit[]> {
  const bm25Hits = bm25Search(query, corpus, POOL, opts);

  const [refreshed, queryVec] = await Promise.all([
    // ADD-ONLY: `corpus` may be type-scoped (e.g. the dashboard Knowledge search
    // asks only for knowledge+feature). Never evict out-of-scope vectors here, or
    // the next full-corpus query would re-embed the whole corpus inline. Pruning
    // is the explicit refreshers' job.
    refreshEmbeddings(contextRoot, corpus, undefined, { additive: true }),
    embedQuery(query),
  ]);
  if (refreshed === null || queryVec === null) return bm25Hits.slice(0, topK);

  const denseHits = denseRank(
    queryVec,
    denseEligible(refreshed.index, opts.denseExcludedTypes ?? DENSE_EXCLUDED_TYPES),
    POOL,
  );

  let fused: Map<string, number>;
  let pinKey: string | null = null;
  if (opts.fusion === 'rrf') {
    const w = opts.bm25Weight ?? BM25_RRF_WEIGHT;
    fused = rrfFuse(
      [bm25Hits.map((h) => docKey(h.doc)), denseHits.map((h) => h.docKey)],
      RRF_K,
      [w, 1 - w],
    );
  } else if (opts.fusion === 'relative') {
    fused = relativeFuse(
      new Map(bm25Hits.map((h) => [docKey(h.doc), h.rankScore])),
      new Map(denseHits.map((h) => [h.docKey, h.sim])),
      opts.denseWeight,
    );
  } else {
    // Adaptive (default): fusion type switches on BM25's confidence.
    const topRaw = Math.max(0, ...bm25Hits.map((h) => h.score));
    if (topRaw < ADAPTIVE_RAW_CUTOFF) {
      fused = rrfFuse(
        [bm25Hits.map((h) => docKey(h.doc)), denseHits.map((h) => h.docKey)],
        RRF_K,
        [ADAPTIVE_RRF_BM25_WEIGHT, 1 - ADAPTIVE_RRF_BM25_WEIGHT],
      );
      // Pin guard: a decisive BM25 rankScore margin holds rank 1 (see
      // ADAPTIVE_PIN_MARGIN — protects internally-confident BM25 wins from
      // being outvoted by rank fusion).
      const pinMargin = opts.pinMargin ?? ADAPTIVE_PIN_MARGIN;
      if (
        pinMargin > 0 &&
        bm25Hits.length >= 2 &&
        bm25Hits[1].rankScore > 0 &&
        bm25Hits[0].rankScore / bm25Hits[1].rankScore >= pinMargin
      ) {
        pinKey = docKey(bm25Hits[0].doc);
      }
    } else {
      fused = relativeFuse(
        new Map(bm25Hits.map((h) => [docKey(h.doc), h.rankScore])),
        new Map(denseHits.map((h) => [h.docKey, h.sim])),
        ADAPTIVE_RELATIVE_LAMBDA,
      );
    }
  }

  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const bm25ByKey = new Map(bm25Hits.map((h) => [docKey(h.doc), h]));

  const out: RecallHit[] = [];
  for (const [key, rrf] of fused) {
    const bm25Hit = bm25ByKey.get(key);
    if (bm25Hit) {
      // Raw `score` carried over verbatim (decoupling invariant); only the
      // ordering signal is replaced by the fused rank value.
      out.push({ ...bm25Hit, rankScore: rrf });
    } else {
      const doc = byKey.get(key);
      if (!doc) continue; // stale index entry for a doc filtered out of this corpus
      out.push({ doc, score: 0, rankScore: rrf, snippet: fallbackSnippet(doc) });
    }
  }
  out.sort((a, b) => b.rankScore - a.rankScore);
  if (pinKey !== null) {
    const i = out.findIndex((h) => docKey(h.doc) === pinKey);
    if (i > 0) {
      const [pinned] = out.splice(i, 1);
      out.unshift(pinned);
    }
  }
  return out.slice(0, topK);
}

/**
 * Dense-only search (evaluation harness use — never a production recall mode;
 * it exists so the A/B can show WHY hybrid, not just THAT hybrid).
 */
export async function denseSearch(
  query: string,
  corpus: CorpusDoc[],
  contextRoot: string,
  topK = 10,
  denseExcludedTypes: readonly string[] = DENSE_EXCLUDED_TYPES,
): Promise<RecallHit[]> {
  const [refreshed, queryVec] = await Promise.all([
    // ADD-ONLY, same reasoning as hybridSearch — never evict from a query-time corpus.
    refreshEmbeddings(contextRoot, corpus, undefined, { additive: true }),
    embedQuery(query),
  ]);
  if (refreshed === null || queryVec === null) return [];

  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const out: RecallHit[] = [];
  for (const h of denseRank(queryVec, denseEligible(refreshed.index, denseExcludedTypes), topK * 2)) {
    const doc = byKey.get(h.docKey);
    if (!doc) continue;
    out.push({ doc, score: 0, rankScore: h.sim, snippet: fallbackSnippet(doc) });
    if (out.length >= topK) break;
  }
  return out;
}
