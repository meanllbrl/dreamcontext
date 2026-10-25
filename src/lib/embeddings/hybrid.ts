import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CHANGELOG_RANK_FACTOR, bm25Search, docKey, docRankPrior, type Bm25Options, type CorpusDoc, type RecallHit } from '../recall.js';
import {
  readRecallCloudConfig,
  readVaultConsent,
  recallCloudKeyInfo,
  recallCloudStatus,
  type RecallTier,
  type RerankModel,
} from '../recall-cloud-config.js';
import { VOYAGE_4_PROFILE } from './profiles.js';
import type { Chunk } from './chunker.js';
import { embedQuery, isEmbedModelDownloaded } from './embedder.js';
import { applyRerank, pickBestChunkLexical } from './egress-rules.js';
import { buildEgressPayload, effectiveTier, isUnderEvalFrozenDir, rerankScoresByKey, type EgressPayload } from './egress.js';
import { FUSION_BY_TIER, type DenseGate, type FusionParams } from './fusion-config.js';
import { isNanoDownloaded, nanoEmbedQuery } from './nano.js';
import { CloudRecallError, openRouterEmbed, openRouterRerank, type CloudCallOpts, type CloudFailureKind } from './openrouter.js';
import { refreshEmbeddings, embeddingCacheUsable, type DenseIndex } from './store.js';
import { cloudIndexReady, loadVectorIndex } from './vector-store.js';

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
export function hybridReady(root: string, mode: string, tier?: RecallTier, home?: string): boolean {
  return mode === 'hybrid' && (cloudTierReady(tier ?? 'local', root, false, home) || localReady(root));
}

/** The local e5 hybrid is usable right now: model on disk AND a usable cache. Never downloads, never indexes. */
export function localReady(root: string): boolean {
  return isEmbedModelDownloaded() && embeddingCacheUsable(root);
}

/**
 * A cloud tier can answer this prompt WITHOUT a download or an inline build: the (effective) tier is
 * not local, the vault's voyage-4 index covers enough of the eligible corpus (manifest only), and the
 * query side exists — a key for `cloud`, the nano model already on disk for `cloud-index`.
 */
export function cloudTierReady(tier: RecallTier, root: string, evalConsent?: boolean, home?: string): boolean {
  const h = home ?? homedir();
  const eff = effectiveTier(root, tier, evalConsent, h);
  if (eff === 'local' || !cloudIndexReady(root, 'voyage-4')) return false;
  return eff === 'cloud' ? recallCloudKeyInfo(h).present : isNanoDownloaded(h);
}

/** Why `hybridReady` said no, as a short code: the header and the CLI note both name it, so BM25 is never silent. */
export type HybridNotReadyReason =
  | 'spawned_session' | 'daily_cap' | 're_consent_required' | 'no_key' | 'no_index' | 'no_local_model' | 'not_warmed';

/**
 * The prerequisite a selected hybrid mode is missing. `resolved` is `resolvePromptTier`'s answer. A cloud
 * tier names its own gap (consent, key, index, the nano query model); otherwise the local e5 model or
 * cache is not warm yet. Call it only after `hybridReady` returned false.
 */
export function hybridNotReadyReason(
  root: string,
  resolved: { tier: RecallTier; downgraded: null | 'spawned_session' | 'daily_cap' | 'env_override' },
  home?: string,
): HybridNotReadyReason {
  if (resolved.downgraded === 'spawned_session' || resolved.downgraded === 'daily_cap') return resolved.downgraded;
  // DREAMCONTEXT_RECALL_TIER=local: the cloud is out of the picture, so only the local warm-up can be missing.
  if (resolved.downgraded === 'env_override') return 'not_warmed';
  const status = recallCloudStatus(root, home);
  if (status.consent === 're-consent-required') return 're_consent_required';
  if (status.consent === 'valid' && !status.key) return 'no_key';
  if (resolved.tier !== 'local' && !cloudIndexReady(root, 'voyage-4')) return 'no_index';
  if (resolved.tier === 'cloud-index' && !isNanoDownloaded(home)) return 'no_local_model';
  return 'not_warmed';
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

// ── fusion v3: parameterised, shared by the legacy adaptive path and the tiers ──

/**
 * Dense ranking with a choice of doc aggregation: 'max' is `denseRank`; 'max+second' adds
 * `secondWeight` × the doc's second-best chunk similarity (a doc with two relevant sections beats
 * one with a single lucky chunk).
 */
export function denseRankAgg(
  queryVec: Float32Array,
  index: DenseIndex,
  topK: number,
  agg: FusionParams['aggregation'],
  secondWeight: number,
): DenseHit[] {
  if (agg === 'max' || secondWeight === 0) return denseRank(queryVec, index, topK);
  const best = new Map<string, [number, number]>();
  for (const chunk of index.chunks) {
    const v = chunk.vector;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * queryVec[i];
    const cur = best.get(chunk.docKey);
    if (cur === undefined) best.set(chunk.docKey, [dot, -Infinity]);
    else if (dot > cur[0]) { cur[1] = cur[0]; cur[0] = dot; }
    else if (dot > cur[1]) cur[1] = dot;
  }
  return Array.from(best.entries())
    .map(([key, [first, second]]) => ({ docKey: key, sim: Number.isFinite(second) ? first + secondWeight * second : first }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topK);
}

/**
 * Skip the dense channel (and everything that costs a network call) when BM25 is already sure:
 * top raw ≥ rawSure, or ≥ rawLead with a top1/top2 rankScore lead ≥ leadRatio.
 */
export function shouldSkipDense(bm25: RecallHit[], gate: DenseGate | null): boolean {
  if (gate === null || bm25.length === 0) return false;
  const topRaw = Math.max(0, ...bm25.map((h) => h.score));
  if (topRaw >= gate.rawSure) return true;
  if (topRaw < gate.rawLead || bm25.length < 2 || bm25[1].rankScore <= 0) return false;
  return bm25[0].rankScore / bm25[1].rankScore >= gate.leadRatio;
}

/**
 * Fuse BM25 and dense candidates under `p`. The BM25 confidence picks the fusion type exactly as the
 * adaptive default does (rank fusion + pin guard below the cutoff, score fusion above it); the
 * extras are the dense prior, language weights and the changelog factor. Returns every fused key,
 * best first. Keys whose doc is not in `ctx.byKey` (a stale index entry) are dropped.
 */
export function fuseCandidates(
  bm25: RecallHit[],
  dense: DenseHit[],
  p: FusionParams,
  ctx: { byKey: Map<string, CorpusDoc>; now: Date; queryLang?: 'tr' | 'en' | 'mixed' },
): Array<{ key: string; fused: number }> {
  const sims = dense.map((h) => {
    const doc = ctx.byKey.get(h.docKey);
    const prior = p.priorGamma !== 0 && doc ? p.priorGamma * Math.log(Math.max(docRankPrior(doc, ctx.now), 1e-6)) : 0;
    return { key: h.docKey, sim: h.sim + prior };
  });
  if (p.priorGamma !== 0) sims.sort((a, b) => b.sim - a.sim);

  const topRaw = Math.max(0, ...bm25.map((h) => h.score));
  let fused: Map<string, number>;
  let pinKey: string | null = null;
  if (topRaw < p.rawCutoff) {
    const lang = ctx.queryLang;
    const langWeight = lang === 'tr' || lang === 'mixed' ? p.langWeights?.[lang]?.rrfBm25Weight : undefined;
    const w = langWeight ?? p.rrfBm25Weight;
    fused = rrfFuse([bm25.map((h) => docKey(h.doc)), sims.map((h) => h.key)], p.rrfK, [w, 1 - w]);
    if (p.pinMargin > 0 && bm25.length >= 2 && bm25[1].rankScore > 0 && bm25[0].rankScore / bm25[1].rankScore >= p.pinMargin) {
      pinKey = docKey(bm25[0].doc);
    }
  } else {
    fused = relativeFuse(
      new Map(bm25.map((h) => [docKey(h.doc), h.rankScore])),
      new Map(sims.map((h) => [h.key, h.sim])),
      p.relativeLambda,
    );
  }

  // BM25's own rankScore already carries CHANGELOG_RANK_FACTOR; a tuned factor scales by the ratio,
  // so the stub value (== CHANGELOG_RANK_FACTOR) is a no-op.
  const changelogRatio = p.changelogFactor / CHANGELOG_RANK_FACTOR;
  const out: Array<{ key: string; fused: number }> = [];
  for (const [key, score] of fused) {
    const doc = ctx.byKey.get(key);
    if (!doc) continue;
    out.push({ key, fused: doc.type === 'changelog' && changelogRatio !== 1 ? score * changelogRatio : score });
  }
  out.sort((a, b) => b.fused - a.fused);
  if (pinKey !== null) {
    const i = out.findIndex((e) => e.key === pinKey);
    if (i > 0) out.unshift(...out.splice(i, 1));
  }
  return out;
}

// ── cloud tiers ──────────────────────────────────────────────────────────────

export const CLOUD_QUERY_TIMEOUT_MS = 1500;
export const RERANK_TIMEOUT_MS = 1800;
export const CLOUD_STAGE_BUDGET_MS = 3500;
export const BREAKER_PAUSE_MS = 300_000;
export const HOOK_MAX_INLINE_EMBED = 8;

/** Env override of the cloud call timeouts. Honoured ONLY for an eval run on a frozen root; production stays fixed. */
export const EVAL_CLOUD_TIMEOUT_ENV = 'DREAMCONTEXT_EVAL_CLOUD_TIMEOUT_MS';
export const EVAL_CLOUD_TIMEOUT_MIN_MS = 1500;
export const EVAL_CLOUD_TIMEOUT_MAX_MS = 20_000;

interface CloudBudget { queryMs: number; rerankMs: number; stageMs: number }

/** The cloud call budgets: fixed constants, unless an eval-minted call carries a valid env override (integer ms, clamped). */
function cloudBudget(evalMinted: boolean): CloudBudget {
  const fixed: CloudBudget = { queryMs: CLOUD_QUERY_TIMEOUT_MS, rerankMs: RERANK_TIMEOUT_MS, stageMs: CLOUD_STAGE_BUDGET_MS };
  if (!evalMinted) return fixed;
  const raw = process.env[EVAL_CLOUD_TIMEOUT_ENV];
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fixed;
  const ms = Math.min(EVAL_CLOUD_TIMEOUT_MAX_MS, Math.max(EVAL_CLOUD_TIMEOUT_MIN_MS, Number(raw.trim())));
  return { queryMs: ms, rerankMs: ms, stageMs: 2 * ms };
}

export type FallbackReason =
  | CloudFailureKind
  | 'none' | 'breaker_open' | 'withheld' | 'not_consented' | 'spawned_session'
  | 'daily_cap' | 'no_index' | 'no_local_model' | 'rerank_not_consented'
  // The dense gate: BM25 was already sure, so the dense channel (and any network call) was skipped.
  | 'bm25_confident';

export interface RecallTiming {
  /** The EFFECTIVE tier (never above what the vault consented to). */
  tier: RecallTier;
  querySource: 'api' | 'nano' | 'e5' | 'none';
  fallback: FallbackReason;
  corpusMs?: number;
  bm25Ms?: number;
  indexMs?: number;
  queryMs?: number;
  rerankMs?: number;
}

// Circuit breaker: `~/.dreamcontext/recall-cloud-health.json` (0600) = { until, kind, keyFp }.
// A cloud failure pauses cloud calls for BREAKER_PAUSE_MS. An auth failure pauses until the stored
// key changes. `keyFp` is a sha256 prefix of the key's set-time marker (this module may not read the
// key itself; only openrouter.ts does), so it changes when `key set` runs.

interface BreakerFile { until: number; kind: CloudFailureKind; keyFp: string }

function breakerPath(home: string): string {
  return join(home, '.dreamcontext', 'recall-cloud-health.json');
}

function keyMarker(home: string): string {
  const info = recallCloudKeyInfo(home);
  const mark = info.source === 'file' ? `file:${readRecallCloudConfig(home).keySetAt ?? ''}` : `env:${info.present}`;
  return createHash('sha256').update(mark).digest('hex').slice(0, 12);
}

function readBreaker(home: string): BreakerFile | null {
  try {
    const b = JSON.parse(readFileSync(breakerPath(home), 'utf-8')) as Partial<BreakerFile>;
    return typeof b.until === 'number' && typeof b.kind === 'string' && typeof b.keyFp === 'string' ? (b as BreakerFile) : null;
  } catch {
    return null;
  }
}

/** True while cloud calls are paused for this machine. */
export function breakerOpen(home: string = homedir(), now: number = Date.now()): boolean {
  const b = readBreaker(home);
  if (b === null || b.until <= now) return false;
  return b.kind === 'auth' ? b.keyFp === keyMarker(home) : true;
}

/** Pause cloud calls after a failure. Caller bugs and spend ceilings (`forged_payload`, `eval_cap`, `no_key`) never trip it. */
export function tripBreaker(kind: CloudFailureKind, home: string = homedir(), now: number = Date.now()): void {
  if (kind === 'forged_payload' || kind === 'eval_cap' || kind === 'no_key') return;
  const body: BreakerFile = { until: kind === 'auth' ? Number.MAX_SAFE_INTEGER : now + BREAKER_PAUSE_MS, kind, keyFp: keyMarker(home) };
  try {
    const path = breakerPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch {
    // A breaker that cannot be written degrades to "try again next prompt"; recall must not fail on it.
  }
}

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
  /** Requested tier ceiling. Undefined ⇒ 'local'. The effective tier is `effectiveTier(root, tier, evalConsent, home)`. */
  tier?: RecallTier;
  /** Honoured only when `isUnderEvalFrozenDir(root, home)`. */
  evalConsent?: boolean;
  /** Injectable home (consent, key, usage, breaker). */
  home?: string;
  /** Honoured ONLY with evalConsent under the frozen dir; real roots use the vault's consented model. */
  rerankModel?: RerankModel;
  /** Fusion parameters. Default: FUSION_BY_TIER[tier] (local: the adaptive constants). */
  fusionParams?: FusionParams;
  /** A precomputed query vector (eval); skips the query-side embedding. */
  queryVec?: Float32Array;
  /** Injectable reranker (tests, eval caches). Default `openRouterRerank`. */
  rerankImpl?: (p: EgressPayload<'rerank'>, o: CloudCallOpts) => Promise<{ scores: Array<{ index: number; relevance: number }>; costUsd: number }>;
  /**
   * Cap on chunks the local refresh embeds inline. Default HOOK_MAX_INLINE_EMBED, so a search never
   * pays for a cold or partial e5 build (a cloud fallback onto a partial cache once took 56 minutes).
   * A full build is the explicit `refreshEmbeddings` / `embed refresh` job, not a search's.
   */
  maxInlineEmbed?: number;
  /** Filled in with what this search did. */
  timing?: RecallTiming;
  /** The query's language, for `langWeights` (ranking feature; never a gold label). */
  queryLang?: 'tr' | 'en' | 'mixed';
}

function fallbackFor(rule: string): FallbackReason {
  if (rule === 'spawned_session' || rule === 'daily_cap' || rule === 'not_consented') return rule;
  return 'withheld';
}

function buildHits(
  order: string[],
  scores: number[],
  bm25ByKey: Map<string, RecallHit>,
  byKey: Map<string, CorpusDoc>,
): RecallHit[] {
  const out: RecallHit[] = [];
  order.forEach((key, i) => {
    const bm25Hit = bm25ByKey.get(key);
    if (bm25Hit) {
      // Raw `score` carried over verbatim (decoupling invariant); only the ordering signal changes.
      out.push({ ...bm25Hit, rankScore: scores[i] });
      return;
    }
    const doc = byKey.get(key);
    if (doc) out.push({ doc, score: 0, rankScore: scores[i], snippet: fallbackSnippet(doc) });
  });
  return out;
}

/** The chunk of `doc` the query matches best: by similarity when the doc has indexed vectors, else lexically. */
function bestChunkFor(doc: CorpusDoc, qv: Float32Array, indexed: IndexedChunkLike[] | undefined, query: string): Chunk | null {
  const chunks = VOYAGE_4_PROFILE.chunk(doc);
  if (indexed && indexed.length > 0) {
    let best: IndexedChunkLike | null = null;
    let bestDot = -Infinity;
    for (const c of indexed) {
      let dot = 0;
      for (let i = 0; i < c.vector.length; i++) dot += c.vector[i] * qv[i];
      if (dot > bestDot || (dot === bestDot && best !== null && c.seq < best.seq)) { best = c; bestDot = dot; }
    }
    const chunk = best ? chunks[best.seq] : undefined;
    if (best && chunk && chunk.hash === best.hash) return chunk;
  }
  return pickBestChunkLexical(chunks, query);
}
interface IndexedChunkLike { seq: number; hash: string; vector: Float32Array }

/** The candidate window rerank looks at, as keys of the fused list in fused order. */
function rerankWindow(
  fused: Array<{ key: string; fused: number }>,
  bm25: RecallHit[],
  dense: DenseHit[],
  rr: NonNullable<FusionParams['rerank']>,
): Array<{ key: string; fused: number }> {
  if ((rr.pool ?? 'fused-top') === 'fused-top') return fused.slice(0, rr.candidates);
  const half = Math.max(1, Math.floor(rr.candidates / 2));
  const pick = new Set<string>([
    ...bm25.slice(0, half).map((h) => docKey(h.doc)),
    ...dense.slice(0, half).map((h) => h.docKey),
  ]);
  return fused.filter((e) => pick.has(e.key));
}

/**
 * The cloud paths. Returns hits, or null when this prompt must fall back (timing.fallback says why).
 * Order of events: breaker → index → query vector (API for `cloud`, nano for `cloud-index`) →
 * dense + fusion → (cloud only) rerank. A rerank failure keeps the fused order; it never discards it.
 */
async function cloudSearch(
  query: string,
  corpus: CorpusDoc[],
  contextRoot: string,
  topK: number,
  eff: RecallTier,
  bm25Hits: RecallHit[],
  opts: HybridOptions,
  timing: RecallTiming,
  home: string,
): Promise<RecallHit[] | null> {
  const evalMinted = opts.evalConsent === true && isUnderEvalFrozenDir(contextRoot, home);
  const params = opts.fusionParams ?? FUSION_BY_TIER[eff];
  const budget = cloudBudget(evalMinted);
  if (shouldSkipDense(bm25Hits, params.denseGate)) {
    timing.fallback = 'bm25_confident';
    return bm25Hits.slice(0, topK);
  }
  if (eff === 'cloud' && !evalMinted && breakerOpen(home)) { timing.fallback = 'breaker_open'; return null; }

  const tIndex = performance.now();
  const index = loadVectorIndex(contextRoot, 'voyage-4');
  timing.indexMs = Math.round(performance.now() - tIndex);
  if (index === null || index.chunks.length === 0) { timing.fallback = 'no_index'; return null; }

  const stageStart = performance.now();
  let qv: Float32Array | null = opts.queryVec ?? null;
  if (qv !== null) {
    timing.querySource = eff === 'cloud' ? 'api' : 'nano';
  } else if (eff === 'cloud') {
    const minted = buildEgressPayload({ kind: 'query', contextRoot, tier: 'cloud', evalConsent: opts.evalConsent, home, query });
    if (minted.payload === null) { timing.fallback = fallbackFor(minted.withheld[0]?.rule ?? 'empty'); return null; }
    try {
      const res = await openRouterEmbed(minted.payload, { timeoutMs: budget.queryMs });
      qv = res.vectors[0] ?? null;
      timing.querySource = 'api';
    } catch (err) {
      const kind = err instanceof CloudRecallError ? err.kind : 'network';
      if (!evalMinted) tripBreaker(kind, home);
      timing.fallback = kind;
      return null;
    }
  } else {
    qv = await nanoEmbedQuery(query, { home });
    if (qv === null) { timing.fallback = 'no_local_model'; return null; }
    timing.querySource = 'nano';
  }
  timing.queryMs = Math.round(performance.now() - stageStart);
  if (qv === null || qv.length !== index.dims) { timing.fallback = 'no_index'; return null; }

  const dense = denseRankAgg(
    qv,
    denseEligible(index, opts.denseExcludedTypes ?? DENSE_EXCLUDED_TYPES),
    POOL,
    params.aggregation,
    params.secondWeight,
  );
  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const bm25ByKey = new Map(bm25Hits.map((h) => [docKey(h.doc), h]));
  const fused = fuseCandidates(bm25Hits, dense, params, { byKey, now: opts.now ?? new Date(), queryLang: opts.queryLang });
  timing.fallback = 'none';

  let order = fused.map((e) => e.key);
  const rr = params.rerank;
  if (rr !== null && eff === 'cloud') {
    const model = evalMinted ? opts.rerankModel ?? null : readVaultConsent(contextRoot, home)?.rerankModel ?? null;
    if (model === null) {
      timing.fallback = 'rerank_not_consented';
    } else {
      const remaining = budget.stageMs - (performance.now() - stageStart);
      const window = rerankWindow(fused, bm25Hits, dense, rr);
      if (remaining > 0 && window.length > 0) {
        order = await rerankOrder({ query, qv, index, window, fused, model, rr, byKey, contextRoot, evalMinted, home, opts, timing, timeoutMs: Math.min(budget.rerankMs, remaining) }) ?? order;
      }
    }
  }
  // Keep rankScore monotone with the final order: the fused scores, re-dealt best-first.
  const sorted = fused.map((e) => e.fused).sort((a, b) => b - a);
  return buildHits(order, sorted, bm25ByKey, byKey).slice(0, topK);
}

interface RerankArgs {
  query: string; qv: Float32Array; index: DenseIndex;
  window: Array<{ key: string; fused: number }>; fused: Array<{ key: string; fused: number }>;
  model: RerankModel; rr: NonNullable<FusionParams['rerank']>; byKey: Map<string, CorpusDoc>;
  contextRoot: string; evalMinted: boolean; home: string; opts: HybridOptions; timing: RecallTiming; timeoutMs: number;
}

/** The reranked key order, or null when rerank could not run (the caller keeps the fused order). */
async function rerankOrder(a: RerankArgs): Promise<string[] | null> {
  const indexedByDoc = new Map<string, IndexedChunkLike[]>();
  const wanted = new Set(a.window.map((e) => e.key));
  for (const c of a.index.chunks) {
    if (!wanted.has(c.docKey)) continue;
    const list = indexedByDoc.get(c.docKey) ?? [];
    list.push(c);
    indexedByDoc.set(c.docKey, list);
  }
  const candidates = a.window.flatMap((e) => {
    const doc = a.byKey.get(e.key);
    return doc ? [{ doc, bestChunk: bestChunkFor(doc, a.qv, indexedByDoc.get(e.key), a.query) }] : [];
  });
  const minted = buildEgressPayload({
    kind: 'rerank', contextRoot: a.contextRoot, tier: 'cloud', evalConsent: a.opts.evalConsent, home: a.home,
    model: a.model, query: a.query, candidates,
  });
  if (minted.payload === null) {
    a.timing.fallback = minted.withheld.some((w) => w.rule === 'rerank_not_consented') ? 'rerank_not_consented' : fallbackFor(minted.withheld[0]?.rule ?? 'empty');
    return null;
  }
  const t0 = performance.now();
  try {
    const call = a.opts.rerankImpl ?? openRouterRerank;
    const res = await call(minted.payload, { timeoutMs: a.timeoutMs });
    a.timing.rerankMs = Math.round(performance.now() - t0);
    const scores = rerankScoresByKey(minted.payload, res.scores);
    if ((a.rr.pool ?? 'fused-top') === 'fused-top') {
      return applyRerank(a.fused, scores, a.rr.blendAlpha, a.rr.candidates);
    }
    // Union pool: the union is reordered as one window; everything else follows in fused order.
    const reranked = applyRerank(a.window, scores, a.rr.blendAlpha, a.window.length);
    const inUnion = new Set(reranked);
    return [...reranked, ...a.fused.map((e) => e.key).filter((k) => !inUnion.has(k))];
  } catch (err) {
    const kind = err instanceof CloudRecallError ? err.kind : 'network';
    if (!a.evalMinted) tripBreaker(kind, a.home);
    a.timing.fallback = kind;
    return null;
  }
}

/**
 * Hybrid BM25+dense search over a corpus. Same signature semantics as bm25Search, plus
 * `contextRoot` for the embedding cache. The tier is decided HERE, from the vault itself:
 * effective = min(opts.tier ?? 'local', the vault's consented tier). 'local' runs the e5 hybrid
 * exactly as before; the cloud tiers use the voyage-4 index and fall back (cloud → e5 if ready →
 * BM25) on any failure. Falls back to plain bm25Search when no dense channel is available —
 * enabling hybrid mode on a machine without a model must never break recall.
 *
 * The local cache refresh runs lazily here: with nothing changed it is an mtime scan
 * (near-instant); after edits it embeds only the changed chunks (capped by `maxInlineEmbed`).
 */
export async function hybridSearch(
  query: string,
  corpus: CorpusDoc[],
  contextRoot: string,
  topK = 10,
  opts: HybridOptions = {},
): Promise<RecallHit[]> {
  const home = opts.home ?? homedir();
  const eff = effectiveTier(contextRoot, opts.tier, opts.evalConsent, home);
  const timing: RecallTiming = opts.timing ?? { tier: eff, querySource: 'none', fallback: 'none' };
  timing.tier = eff;
  timing.querySource = 'none';
  timing.fallback = 'none';

  const t0 = performance.now();
  const bm25Hits = bm25Search(query, corpus, POOL, opts);
  timing.bm25Ms = Math.round(performance.now() - t0);

  if (eff !== 'local') {
    const cloud = await cloudSearch(query, corpus, contextRoot, topK, eff, bm25Hits, opts, timing, home);
    if (cloud !== null) return cloud;
    // Cloud could not answer: e5 only when it is READY (a fallback never downloads or indexes).
    if (!localReady(contextRoot)) return bm25Hits.slice(0, topK);
  }
  return localSearch(query, corpus, contextRoot, topK, bm25Hits, opts, timing);
}

async function localSearch(
  query: string,
  corpus: CorpusDoc[],
  contextRoot: string,
  topK: number,
  bm25Hits: RecallHit[],
  opts: HybridOptions,
  timing: RecallTiming,
): Promise<RecallHit[]> {
  const cloudFallback = timing.fallback;
  const [refreshed, queryVec] = await Promise.all([
    // ADD-ONLY: `corpus` may be type-scoped (e.g. the dashboard Knowledge search
    // asks only for knowledge+feature). Never evict out-of-scope vectors here, or
    // the next full-corpus query would re-embed the whole corpus inline. Pruning
    // is the explicit refreshers' job. NEVER waits on the vault's cache lock: this
    // runs in front of a prompt, so a held lock means search what is loaded.
    refreshEmbeddings(contextRoot, corpus, undefined, { additive: true, waitForLock: false, maxInlineEmbed: opts.maxInlineEmbed ?? HOOK_MAX_INLINE_EMBED }),
    embedQuery(query),
  ]);
  if (refreshed === null || queryVec === null) {
    timing.fallback = cloudFallback === 'none' ? 'no_local_model' : cloudFallback;
    return bm25Hits.slice(0, topK);
  }
  timing.querySource = 'e5';

  const denseHits = denseRank(
    queryVec,
    denseEligible(refreshed.index, opts.denseExcludedTypes ?? DENSE_EXCLUDED_TYPES),
    POOL,
  );
  const byKey = new Map(corpus.map((d) => [docKey(d), d]));
  const bm25ByKey = new Map(bm25Hits.map((h) => [docKey(h.doc), h]));

  let fused: Array<{ key: string; fused: number }>;
  if (opts.fusion === 'rrf') {
    const w = opts.bm25Weight ?? BM25_RRF_WEIGHT;
    fused = sortFused(rrfFuse(
      [bm25Hits.map((h) => docKey(h.doc)), denseHits.map((h) => h.docKey)],
      RRF_K,
      [w, 1 - w],
    ), byKey);
  } else if (opts.fusion === 'relative') {
    fused = sortFused(relativeFuse(
      new Map(bm25Hits.map((h) => [docKey(h.doc), h.rankScore])),
      new Map(denseHits.map((h) => [h.docKey, h.sim])),
      opts.denseWeight,
    ), byKey);
  } else {
    // Adaptive (default): the shipped local-tier constants (FUSION_BY_TIER.local), unless the caller supplies parameters.
    const local = FUSION_BY_TIER.local;
    const params = opts.fusionParams ?? { ...local, pinMargin: opts.pinMargin ?? local.pinMargin };
    if (shouldSkipDense(bm25Hits, params.denseGate)) {
      timing.querySource = 'none';
      timing.fallback = cloudFallback === 'none' ? 'bm25_confident' : cloudFallback;
      return bm25Hits.slice(0, topK);
    }
    fused = fuseCandidates(bm25Hits, denseHits, params, { byKey, now: opts.now ?? new Date(), queryLang: opts.queryLang });
  }
  return buildHits(fused.map((e) => e.key), fused.map((e) => e.fused), bm25ByKey, byKey).slice(0, topK);
}

function sortFused(fused: Map<string, number>, byKey: Map<string, CorpusDoc>): Array<{ key: string; fused: number }> {
  return Array.from(fused, ([key, score]) => ({ key, fused: score }))
    .filter((e) => byKey.has(e.key))
    .sort((a, b) => b.fused - a.fused);
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
