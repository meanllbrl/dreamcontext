/**
 * Embedding model profiles — everything that differs between one embedding model and
 * the next, in one table: which weights to fetch, which prompt markers the model was
 * trained with, how a vector comes out of the network, and the string the on-disk index
 * is keyed by.
 *
 * Pure data and string logic — no transformers.js, no I/O — so the vector store can ask
 * "which index belongs to the active model?" without loading (or mocking) the embedder.
 *
 * Default: EmbeddingGemma-300m (q8). It beat multilingual-e5-small on both measured
 * corpora (dense-only train MRR dc .719 → .845, h-f .698 → .807, Turkish r@3 +29 / +11
 * points; eval/runs/2026-10-07-models.json) at the price of a bigger download, a slower
 * cold load and 2× the index size — the hook pays for that only on the queries BM25 is
 * unsure about (see `denseGate` in hybrid.ts). e5-small stays in the table: it is the
 * control the experiment ran against and a fallback for small machines
 * (`DREAMCONTEXT_EMBED_MODEL=e5-small`).
 */

/** How a text turns into one vector. */
export type EmbedPooling =
  /** transformers.js feature-extraction pipeline, masked mean over the token states. */
  | 'mean'
  /** The ONNX graph's own `sentence_embedding` output (EmbeddingGemma ships its pooling + dense head). */
  | 'sentence_embedding';

export interface EmbedModelProfile {
  /** Registry id — what `DREAMCONTEXT_EMBED_MODEL` may name. */
  id: string;
  /** Hugging Face repo id; also the directory under the model cache dir. */
  model: string;
  dtype: 'q8' | 'q4';
  dims: number;
  /** Prompt markers the model was trained with — retrieval quality drops without them. */
  queryPrefix: string;
  passagePrefix: string;
  pooling: EmbedPooling;
  /** Token cap per text; longer chunks are truncated, never rejected. */
  maxTokens: number;
  /**
   * Files (relative to the model dir) whose presence means "the model is downloaded":
   * the ONNX graph plus the two small metadata files transformers.js writes beside it.
   */
  files: readonly string[];
  /**
   * ONNX external-data files. The graph file is small and lands first; a download cut
   * short leaves the graph without its weights. Not part of {@link files} (the
   * "downloaded" gate stays the three-file contract), but a load with any of them
   * missing re-opens the fetch so the next explicit load heals the model.
   */
  dataFiles: readonly string[];
  /** The string the on-disk index is keyed by — see {@link embedCacheModelKey}. */
  cacheKey: string;
  /**
   * Cosine gates of the semantic near-duplicate checks. Cosine SCALES are model-specific
   * (e5 compresses everything into 0.83–1.0, Gemma spreads over 0.25–1.0), so a threshold
   * calibrated on one model is meaningless on another: every model carries its own, measured
   * (see the calibration note in dedup.ts). Env overrides (`DREAMCONTEXT_DEDUP_*`,
   * `DREAMCONTEXT_DECLINED_MATCH`) still win over these.
   */
  /** Cosine ≥ this (and the margin below) → an auto-MERGE verdict. */
  dedupMerge: number;
  /** A MERGE also needs top-1 to beat the runner-up by this much. */
  dedupMergeMargin: number;
  /** Cosine ≥ this (below merge) → REVIEW: surface the neighbor for the agent to judge. */
  dedupReview: number;
  /**
   * Hybrid fusion, tuned per model: how strong the dense channel is decides how much of the fused
   * score it may carry. `adaptiveCutoff`: BM25 top raw score below which weak-lexical queries use rank
   * fusion (RRF), at/above which score fusion. `adaptiveLambda`: the dense share in the score-fusion zone.
   */
  adaptiveCutoff: number;
  adaptiveLambda: number;
  /**
   * The dense gate (hybrid.ts `bm25Confident`): skip the dense channel when BM25 is already sure
   * (raw score ≥ `raw`, or a top-1 lead ≥ `margin` past the cutoff). `null` = never skip — the
   * model's cost never justified the gate, so every query runs both channels as before.
   */
  denseGate: { raw: number; margin: number } | null;
  /** Short-vs-short cosine floor of the declined-idea gate ("this looks like an idea you dropped"). */
  declinedMatch: number;
}

const E5_SMALL: EmbedModelProfile = {
  id: 'e5-small',
  model: 'Xenova/multilingual-e5-small',
  dtype: 'q8',
  dims: 384,
  queryPrefix: 'query: ',
  passagePrefix: 'passage: ',
  pooling: 'mean',
  maxTokens: 512,
  files: ['onnx/model_quantized.onnx', 'config.json', 'tokenizer.json'],
  dataFiles: [],
  // The key every e5 index was written under before profiles existed — unchanged, so
  // an existing e5 index stays valid for anyone who keeps e5.
  cacheKey: 'Xenova/multilingual-e5-small',
  // The values the dedup / declined gates were calibrated with on e5 (2026-07) — unchanged.
  dedupMerge: 0.97,
  dedupMergeMargin: 0.02,
  dedupReview: 0.91,
  declinedMatch: 0.82,
  // Fusion exactly as it shipped for e5 (pre-2026-10): its dense ranking is weak, so it tolerates
  // only a small share (λ 0.1) and rank fusion up to raw 18; no dense gate.
  adaptiveCutoff: 18,
  adaptiveLambda: 0.1,
  denseGate: null,
};

const GEMMA_REPO = 'onnx-community/embeddinggemma-300m-ONNX';

// q8 is the measured quantization: it clears every latency gate and the train-quality gates
// (eval/RESULTS.md "T10"), so the 187 MB q4 variant — a faster query embed, slower index build,
// quality never measured — is not shipped. Adding it back is one more entry here; its cache key
// and graph file name differ (`#q4`, `onnx/model_q4.onnx`), so nothing else would have to change.
const GEMMA_Q8: EmbedModelProfile = {
  id: 'embeddinggemma-q8',
  model: GEMMA_REPO,
  dims: 768,
  // Prompt format from the model card (query / document tasks of the retrieval prompt set).
  queryPrefix: 'task: search result | query: ',
  passagePrefix: 'title: none | text: ',
  pooling: 'sentence_embedding',
  maxTokens: 512,
  dtype: 'q8',
  files: ['onnx/model_quantized.onnx', 'config.json', 'tokenizer.json'],
  dataFiles: ['onnx/model_quantized.onnx_data'],
  cacheKey: `${GEMMA_REPO}#q8`,
  // Measured on Gemma q8 (2026-10-07, frozen dc corpus, h-f sample) — bands in dedup.ts.
  dedupMerge: 0.93,
  dedupMergeMargin: 0.05,
  dedupReview: 0.78,
  declinedMatch: 0.68,
  // Fusion + gate frozen by T10 on the three train sets (eval/RESULTS.md "T10"): Gemma's dense
  // ranking is strong enough for λ 0.7, and BM25 answers alone when sure (raw ≥ 24, or ≥ 12 with a
  // ≥ 1.25 lead) — which is what keeps the hook's median prompt off the ~1.2 s model load.
  adaptiveCutoff: 12,
  adaptiveLambda: 0.7,
  denseGate: { raw: 24, margin: 1.25 },
};

export const EMBED_PROFILES: readonly EmbedModelProfile[] = [GEMMA_Q8, E5_SMALL];

export const DEFAULT_EMBED_PROFILE_ID = GEMMA_Q8.id;

/**
 * Resolve a `DREAMCONTEXT_EMBED_MODEL` value to a profile. Accepts a profile id, a cache
 * key, or a bare repo id (the pre-profile spelling — first match wins, so the Gemma repo id
 * means the default dtype). Anything unrecognised — including unset — is the default: an
 * unknown model has no known prompt format or pooling, and silently embedding with the wrong
 * ones would quietly wreck recall.
 */
export function selectEmbedProfile(selector: string | undefined): EmbedModelProfile {
  const wanted = selector?.trim();
  const fallback = EMBED_PROFILES.find((p) => p.id === DEFAULT_EMBED_PROFILE_ID) ?? GEMMA_Q8;
  if (!wanted) return fallback;
  return EMBED_PROFILES.find((p) => p.id === wanted || p.cacheKey === wanted || p.model === wanted) ?? fallback;
}

/** The profile this process embeds with. */
export const EMBED_PROFILE: EmbedModelProfile = selectEmbedProfile(process.env.DREAMCONTEXT_EMBED_MODEL);

/**
 * The string a vault's `.embeddings/cache.json` is stamped with. A cache whose stamp differs
 * from the active profile's is discarded wholesale — vectors from two models (or two
 * quantizations of one) live in different spaces and must never share an index. The dtype is
 * part of the key for that reason; e5's key is the bare repo id it always was.
 */
export function embedCacheModelKey(profile: EmbedModelProfile = EMBED_PROFILE): string {
  return profile.cacheKey;
}
