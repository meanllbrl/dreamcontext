import { bm25Search, docKey, tokenize, type Bm25Options, type CorpusDoc, type RecallHit } from '../recall.js';
import { embedQuery, isEmbedModelComplete } from './embedder.js';
import { EMBED_PROFILE } from './profiles.js';
import { refreshEmbeddings, embeddingCacheUsable, type DenseIndex } from './store.js';

/**
 * Whether hybrid recall should ACTUALLY run for a vault right now — the single
 * gate every automatic recall path shares (the always-on hook, the dashboard's
 * live `/api/recall`, `memory recall`). Hybrid engages only when the mode is
 * 'hybrid', the model is already fully downloaded, AND the vault's embedding cache is
 * present and USABLE for the active model/version. This keeps the two EXPENSIVE,
 * one-time operations off the keystroke/prompt path — the model download and a
 * full corpus (re)index — since both are provisioned in the background
 * (`dreamcontext embed ensure`, kicked off by SessionStart/init/update) or paid
 * explicitly (the Settings card / `dreamcontext embed refresh`). When it returns
 * false, callers fall back to BM25 — silently, never blocking the prompt.
 *
 * NOTE: this does not promise zero latency — a dense search embeds the query
 * and, in a freshly-started process, pays a one-time in-process model load on the
 * FIRST such query. That per-process load is inherent to the daemonless design
 * (see decision-embedding-layer), and it is why {@link hybridSearch} first asks
 * whether BM25 is already sure ({@link bm25Confident}) and skips the dense channel
 * when it is. What THIS gate guarantees is no DOWNLOAD and no COLD FULL INDEX inline.
 */
export function hybridReady(root: string, mode: string): boolean {
  // COMPLETE, not merely downloaded: an interrupted large-model download leaves the small graph
  // file in place without its weights, and a load against that re-opens the remote fetch — a
  // prompt must never be able to start one.
  return mode === 'hybrid' && isEmbedModelComplete() && embeddingCacheUsable(root);
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
// - CONFIDENT (topRaw ≥ cutoff): relative-score fusion. Score-aware fusion
//   preserves BM25's margins, so a decisive lexical winner needs a large dense
//   advantage to be displaced (a rank-based fusion flipped exact-term top-1s on
//   near-ties). The dense share λ is the model's strength: e5-small's weak dense
//   ranking tolerated only λ=0.1; EmbeddingGemma's, measured on the three train
//   sets (dc v1, dc 2026-10, h-f), peaks at λ=0.7 — and the exact-token queries
//   that a large λ would hurt never reach it: BM25 answers them alone (the dense
//   gate, DENSE_GATE_RAW) and the navigational pin holds a doc whose slug the
//   query spells.
// - UNCONFIDENT (topRaw < cutoff): weighted rank-based RRF. When BM25 is weak
//   its score GAPS are noise — rank fusion deliberately flattens them so dense
//   can pull a buried doc (rank 5–7) to the top. This is where the Turkish and
//   recency wins live; score-preserving fusion cannot reach them by design.
//   Rare at today's corpus sizes (train p10 topRaw = 13.5): kept at the T6 weights.
//
// The cutoff and λ are PER MODEL (profiles.ts `adaptiveCutoff` / `adaptiveLambda`): the values here
// are Gemma's, tuned on the train gold sets ONLY (eval/RESULTS.md "T10"; held-out is the validation
// gate's to open, not the tuner's). e5-small keeps exactly the pre-2026-10 fusion: cutoff 18, λ 0.1.
export const ADAPTIVE_RAW_CUTOFF = EMBED_PROFILE.adaptiveCutoff;   // below → rank fusion; at/above → score fusion (per model: profiles.ts)
export const ADAPTIVE_RRF_BM25_WEIGHT = 0.6; // BM25 weight in the unconfident RRF zone
export const ADAPTIVE_RELATIVE_LAMBDA = EMBED_PROFILE.adaptiveLambda; // dense λ in the confident relative zone (per model: profiles.ts)

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

/**
 * When BM25 alone is trusted and the dense channel is skipped ({@link bm25Confident}) — the
 * difference between a hook prompt that costs BM25 only and one that also loads a 300M-parameter
 * model (~1.2 s cold) and embeds the query. Two signals BM25 already has for free:
 *
 *  - its top RAW score: the same per-query confidence the hook hard-gates on. Exact-token queries
 *    (slugs, identifiers, error codes) top out well above the paraphrase / Turkish queries dense
 *    actually rescues. At or above {@link DENSE_GATE_RAW} BM25 answers alone.
 *  - its top-1 MARGIN: rankScore(top-1) / rankScore(top-2). A decisive lead means the lexical match
 *    is unambiguous even at a middling score. Counts only from {@link ADAPTIVE_RAW_CUTOFF} up — below
 *    it the match is weak and a one-hit "lead" is exactly where dense earns its keep.
 *
 * Per model (profiles.ts `denseGate`; e5-small has none): tuned for Gemma on the three train gold sets (dc v1, dc 2026-10, h-f), together with the fusion constants:
 * ~65% of queries skip dense, and the pooled MRR stays within 0.011 of running dense on every query
 * (eval/RESULTS.md "T10"). Raw scores scale with corpus size (IDF); both brains it was tuned on hold
 * 1.4k–2.7k docs, and a much smaller vault simply sees fewer confident queries — it spends the model
 * on more of them, which is the safe direction.
 */
export const DENSE_GATE_RAW = EMBED_PROFILE.denseGate?.raw ?? Infinity;
export const DENSE_GATE_MARGIN = EMBED_PROFILE.denseGate?.margin ?? Infinity;

/** Is BM25 already sure enough of its own answer to skip the dense channel? */
export function bm25Confident(
  hits: RecallHit[],
  gateRaw: number = DENSE_GATE_RAW,
  gateMargin: number = DENSE_GATE_MARGIN,
): boolean {
  // A model whose profile has no gate (or a caller passing a non-finite raw bar) never skips dense.
  if (!Number.isFinite(gateRaw)) return false;
  let topRaw = 0;
  for (const h of hits) if (h.score > topRaw) topRaw = h.score;
  if (topRaw >= gateRaw) return true;
  if (topRaw < ADAPTIVE_RAW_CUTOFF || hits.length === 0) return false;
  const runnerUp = hits[1]?.rankScore ?? 0;
  return runnerUp <= 0 || hits[0].rankScore / runnerUp >= gateMargin;
}

/** Drop excluded-type docs from the dense index (chunks are keyed `type/slug`). */
function denseEligible(index: DenseIndex, excludedTypes: readonly string[]): DenseIndex {
  if (excludedTypes.length === 0) return index;
  const banned = excludedTypes.map((t) => `${t}/`);
  return {
    dims: index.dims,
    chunks: index.chunks.filter((c) => !banned.some((p) => c.docKey.startsWith(p))),
  };
}

/** True when the query's terms are exactly the terms of the doc's slug (order and inflection ignored). */
function spellsSlug(query: string, doc: CorpusDoc): boolean {
  const queryTerms = new Set(tokenize(query));
  const slugTerms = new Set(tokenize(doc.slug));
  if (queryTerms.size === 0 || queryTerms.size !== slugTerms.size) return false;
  for (const t of slugTerms) if (!queryTerms.has(t)) return false;
  return true;
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
 * bm25Search when the embedding model is unavailable — hybrid recall on a machine
 * without the model must never break recall.
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
  /** Adaptive-fusion overrides (default: the ADAPTIVE_* constants) — for the A/B sweep. */
  adaptiveCutoff?: number;
  adaptiveBm25Weight?: number;
  adaptiveLambda?: number;
  /**
   * 'auto' (default): when BM25 is already sure of its answer ({@link bm25Confident}) return its order
   * and never touch the dense channel — no model load, no cache parse, no query embedding. 'always':
   * run the dense channel for every query (the A/B harness and the model experiments).
   */
  denseGate?: 'auto' | 'always';
  /** BM25 raw score from which the 'auto' gate trusts BM25 alone. Default DENSE_GATE_RAW. */
  denseGateRaw?: number;
  /** Top-1 rankScore lead over top-2 that also trusts BM25 alone. Default DENSE_GATE_MARGIN. */
  denseGateMargin?: number;
}

/**
 * Fuse a BM25 ranking with a dense ranking into the final order. Pure: both channels' hits are
 * inputs, so the production path and the offline tuning sweeps run exactly the same code.
 *
 * Decoupling invariant (sacred): the returned hits keep BM25's raw `score` verbatim (0 for
 * dense-only hits); only `rankScore`, the ordering signal, is replaced by the fused value.
 */
export function fuseRankings(
  query: string,
  bm25Hits: RecallHit[],
  denseHits: DenseHit[],
  corpus: CorpusDoc[],
  topK: number,
  opts: HybridOptions = {},
): RecallHit[] {
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
    if (topRaw < (opts.adaptiveCutoff ?? ADAPTIVE_RAW_CUTOFF)) {
      const bm25Weight = opts.adaptiveBm25Weight ?? ADAPTIVE_RRF_BM25_WEIGHT;
      fused = rrfFuse(
        [bm25Hits.map((h) => docKey(h.doc)), denseHits.map((h) => h.docKey)],
        RRF_K,
        [bm25Weight, 1 - bm25Weight],
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
        opts.adaptiveLambda ?? ADAPTIVE_RELATIVE_LAMBDA,
      );
    }
  }

  // Navigational pin: a query that spells BM25's top doc's slug exactly ("publish checklist" →
  // knowledge/publish-checklist) is a request for THAT doc. Dense similarity cannot tell the doc from
  // its same-named siblings (release-publish-checklist, the per-version checklist tasks) and, on a
  // BM25 near-tie, would put one of them first — the one field-match regression the train sets showed
  // that no fusion weight could undo. Holds rank 1 in every fusion mode; the rest of the order is fused.
  if (pinKey === null && bm25Hits.length > 0 && spellsSlug(query, bm25Hits[0].doc)) {
    pinKey = docKey(bm25Hits[0].doc);
  }

  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const bm25ByKey = new Map(bm25Hits.map((h) => [docKey(h.doc), h]));

  const out: RecallHit[] = [];
  for (const [key, rrf] of fused) {
    const bm25Hit = bm25ByKey.get(key);
    if (bm25Hit) {
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

export async function hybridSearch(
  query: string,
  corpus: CorpusDoc[],
  contextRoot: string,
  topK = 10,
  opts: HybridOptions = {},
): Promise<RecallHit[]> {
  const bm25Hits = bm25Search(query, corpus, POOL, opts);

  // BM25 already sure: its order stands, and the dense channel — the model load, the cache
  // parse, the query embedding, the full-index decode — is never paid for.
  if ((opts.denseGate ?? 'auto') === 'auto' && bm25Confident(bm25Hits, opts.denseGateRaw, opts.denseGateMargin)) {
    return bm25Hits.slice(0, topK);
  }

  const [refreshed, queryVec] = await Promise.all([
    // ADD-ONLY: `corpus` may be type-scoped (e.g. the dashboard Knowledge search
    // asks only for knowledge+feature). Never evict out-of-scope vectors here, or
    // the next full-corpus query would re-embed the whole corpus inline. Pruning
    // is the explicit refreshers' job. NEVER waits on the vault's cache lock: this
    // runs in front of a prompt, so a held lock means search what is loaded.
    refreshEmbeddings(contextRoot, corpus, undefined, { additive: true, waitForLock: false }),
    embedQuery(query),
  ]);
  if (refreshed === null || queryVec === null) return bm25Hits.slice(0, topK);

  const denseHits = denseRank(
    queryVec,
    denseEligible(refreshed.index, opts.denseExcludedTypes ?? DENSE_EXCLUDED_TYPES),
    POOL,
  );
  return fuseRankings(query, bm25Hits, denseHits, corpus, topK, opts);
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
    // ADD-ONLY and lock-never-waits, same reasoning as hybridSearch.
    refreshEmbeddings(contextRoot, corpus, undefined, { additive: true, waitForLock: false }),
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
