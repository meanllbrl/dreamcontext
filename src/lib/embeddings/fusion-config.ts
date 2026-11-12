import type { RecallTier, RerankModel } from '../recall-cloud-config.js';

/** Skip the dense channel when BM25 is already sure: top raw ≥ rawSure, or ≥ rawLead with a top1/top2 lead ≥ leadRatio. */
export interface DenseGate {
  rawSure: number;
  rawLead: number;
  leadRatio: number;
  /**
   * Query length (distinct BM25 terms) the thresholds were tuned at. A longer query scales both raw
   * thresholds by queryTerms / refTerms, since raw BM25 is a sum over terms (audit MM-12). Absent =
   * no scaling.
   */
  refTerms?: number;
}

export interface FusionParams {
  rawCutoff: number;
  rrfK: number;
  rrfBm25Weight: number;
  relativeLambda: number;
  /** 0 = pin guard off. */
  pinMargin: number;
  aggregation: 'max' | 'max+second';
  secondWeight: number;
  priorGamma: number;
  changelogFactor: number;
  denseGate: DenseGate | null;
  langWeights: Partial<Record<'tr' | 'mixed', { rrfBm25Weight: number }>> | null;
  /**
   * Rerank runs iff this is non-null AND a consented (or eval) model exists; the merge is `applyRerank`.
   * `pool` picks the candidates: 'fused-top' (default) = the first N of the fused list; 'bm25-dense-union'
   * = BM25 top N/2 ∪ dense top N/2, ordered by fused score (G1 option (a)).
   */
  rerank: { candidates: number; blendAlpha: number; pool?: 'fused-top' | 'bm25-dense-union' } | null;
}

/**
 * Today's production adaptive constants, as literals (hybrid.ts imports this module, so it cannot be
 * imported from here). The `fusion-stub-equals-production` test pins them equal to hybrid.ts's
 * ADAPTIVE_* / RRF_K and recall.ts's CHANGELOG_RANK_FACTOR.
 */
const PRODUCTION: FusionParams = {
  rawCutoff: 18,
  rrfK: 60,
  rrfBm25Weight: 0.6,
  relativeLambda: 0.1,
  pinMargin: 1.35,
  aggregation: 'max',
  secondWeight: 0,
  priorGamma: 0,
  changelogFactor: 0.85,
  denseGate: null,
  langWeights: null,
  rerank: null,
};

/** What the G1 spike measured (TS/E0): production constants, and for `cloud` rerank N=20, alpha=1.0, fused-top. Pinned by a test, never tuned. */
export const SPIKE_FUSION: Record<RecallTier, FusionParams> = {
  local: { ...PRODUCTION },
  'cloud-index': { ...PRODUCTION },
  cloud: { ...PRODUCTION, rerank: { candidates: 20, blendAlpha: 1.0, pool: 'fused-top' } },
};
export const SPIKE_RERANK_MODEL: RerankModel = 'voyageai/rerank-2.5-lite';

/**
 * T6b: train-tuned by coordinate descent (scripts/recall-tune.ts; eval/runs/*-tune-train.json). On the
 * voyage-4 index the dominant lever is the dense share in the BM25-confident zone (relativeLambda
 * 0.1 -> 0.7: worst-language train r@5 50 -> 90); every other fusion axis was flat and keeps its
 * production value. The dense gate is the most aggressive one that lost no r@5 hit in any language
 * and no r@1 hit on train + legacy.
 */
/** The longest train gold query the gate was tuned on (eval/gold-v2/train.jsonl: p50 15, max 21 distinct terms), so every tuned query is gated exactly as before. */
const REF_TERMS = 21;

const VOYAGE_CORE: FusionParams = {
  ...PRODUCTION,
  relativeLambda: 0.7,
  denseGate: { rawSure: 60, rawLead: 14, leadRatio: 2, refTerms: REF_TERMS },
};

export const FUSION_BY_TIER: Record<RecallTier, FusionParams> = {
  // Local e5: train tuning (eval/runs/2026-10-11-tune-train-local.json) found no axis or dense gate that beats
  // the adaptive constants (worst-language train r@5 stays 50; every gate lost hits), so they stay. localSearch reads this entry.
  local: { ...PRODUCTION },
  'cloud-index': { ...VOYAGE_CORE },
  // Rerank: voyage rerank-2.5-lite over the BM25-top-20 + dense-top-20 union (<= 40), blended 0.7 rerank / 0.3 fused.
  cloud: { ...VOYAGE_CORE, rerank: { candidates: 40, blendAlpha: 0.7, pool: 'bm25-dense-union' } },
};

/** The reranker `enable` defaults to. */
export const DEFAULT_RERANK_MODEL: RerankModel | null = 'voyageai/rerank-2.5-lite';
