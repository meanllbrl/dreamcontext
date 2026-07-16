import { buildCorpus, docKey, type CorpusDoc, type CorpusType } from '../recall.js';
import { chunkDoc } from './chunker.js';
import { embedPassages } from './embedder.js';
import { refreshEmbeddings, type DenseIndex } from './store.js';

/**
 * Sleep-time SEMANTIC dedup — nearest-neighbor "merge instead of duplicate".
 *
 * Second consumer of the embedding index (the first is hybrid recall). Before a
 * sleep sub-agent creates a new knowledge/feature doc, it embeds the CANDIDATE
 * and checks it against the existing knowledge+feature corpus by cosine
 * similarity. A near-duplicate (cosine ≥ the merge threshold) yields a MERGE
 * verdict naming the existing doc to fold into, instead of forking a second file
 * for the same topic. This replaces the keyword-guessing dedup gate in the
 * sleep-product prompt — the exact keyword fragility this project keeps hitting
 * (you cannot recall a doc you didn't think to search for).
 *
 * The candidate is NOT in the corpus yet, so we can't reuse `denseRank` (which
 * ranks a single query vector against the index). Instead we chunk the candidate
 * the same way indexed docs are chunked, embed those chunks as PASSAGES (same E5
 * space as the index — both sides `passage:`-prefixed), and score each existing
 * doc as the MAX cosine over all (candidate-chunk × doc-chunk) pairs. Best-passage
 * matching on BOTH sides: a candidate whose one section duplicates one section of
 * an existing doc is caught even when the rest of each doc differs.
 *
 * This module OWNS dedup only. It advises (verdict + named target + log); the
 * actual fold-in is done by the agent via `knowledge merge` / an Edit — sleep
 * specialists' writes are never silently rewritten here.
 */

export type DedupVerdict = 'merge' | 'review' | 'create';

/**
 * Lowest cosine an OPERATOR may configure as a similarity threshold. A merge bar
 * below this is not a tuning choice, it's a footgun: at 0 EVERY candidate would
 * auto-MERGE into whatever doc happened to rank first, silently folding distinct
 * docs together — the exact failure this module is built to prevent. Anything
 * under 0.5 is far outside the measured operating bands (see the calibration note
 * below: even UNRELATED docs sit at ~0.83+), so it can only be a mistake.
 */
export const DEDUP_MIN_THRESHOLD = 0.5;

/**
 * Read an env-provided threshold. Falls back on anything that isn't a finite
 * number in [{@link DEDUP_MIN_THRESHOLD}, 1] — a bad value must never silently
 * widen the merge gate. `min` is relaxed for the margin (a legitimately tiny gap).
 */
function envThreshold(name: string, fallback: number, min = DEDUP_MIN_THRESHOLD): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > 1) return fallback;
  return n;
}

// ── Thresholds — calibrated, NOT guessed ─────────────────────────────────────
// Measured on the dreamcontext knowledge+feature corpus with
// `Xenova/multilingual-e5-small` (scripts/dedup-calibrate.ts, run 2026-07-15,
// 84 docs, 39 short-candidate probes). E5 similarities compress into a NARROW
// HIGH band — nothing like the textbook 0.7–0.9 spread — and a sleep candidate at
// CREATE time is SHORT (title + description + a first section) while existing docs
// are LONG (many chunks). Because a doc's score is the MAX over chunk pairs, the
// realistic operating bands are:
//   • SAME-TOPIC (a short freshly-worded candidate → its own topic doc, proxied by
//     each doc's human description → its body): min 0.844, p25 0.911, p50 0.926,
//     p90 0.948, max 0.965.
//   • OTHER / false-positive risk (same short candidate → nearest DISTINCT doc):
//     p50 0.891, p75 0.905, p90 0.929, max 0.947.
// The two bands OVERLAP (SAME-TOPIC p25 0.911 sits inside the OTHER tail) — E5
// cannot cleanly separate same-topic from topically-adjacent for short text, and
// LONGER candidates push BOTH bands up (full-doc-vs-full-doc distinct pairs reach
// 0.982). So a single absolute cosine cannot be both safe and useful. The verdict
// therefore uses TWO signals and leans on REVIEW (agent judgment), not blind
// auto-merge — matching the task's explicit priority to AVOID FALSE MERGES (a
// missed merge only costs a duplicate the next curator pass folds in; a false
// merge silently LOSES distinct content).

/**
 * Absolute cosine floor for an auto-MERGE verdict. 0.97 — high on purpose: it
 * fires only on a NEAR-VERBATIM single-twin restatement (a re-documented decision/
 * feature lands at 0.99+; the calibration probe's copied text hit 0.997). The
 * lower 0.95 first tried let SIBLING docs in one product family false-merge —
 * `feature/sleep-consolidation` content grazed `feature/sleepy-notch-capture` at
 * 0.963 once its true twin was excluded. Auto-MERGE must be a HIGH-PRECISION
 * signal (avoiding false merges is the task's priority); the 0.91–0.97 middle —
 * same-topic but freshly worded — is REVIEW, where the agent decides. Combined
 * with {@link DEDUP_MERGE_MARGIN}. Override: `DREAMCONTEXT_DEDUP_MERGE` (0–1);
 * re-run the calibration if the model changes — these numbers are model-specific.
 */
export const DEDUP_MERGE_THRESHOLD = envThreshold('DREAMCONTEXT_DEDUP_MERGE', 0.97);

/**
 * A MERGE also requires the top neighbor to beat the 2nd-nearest doc by at least
 * this cosine margin. The margin is LENGTH-ROBUST where the absolute floor is not:
 * a genuine duplicate SPIKES on its one twin, while a long novel doc is roughly
 * equidistant to a neighborhood of adjacent docs (so top1−top2 is small even when
 * top1 is high). Requiring the margin strictly REDUCES false merges — a long novel
 * doc that grazes 0.95 against several neighbors gets REVIEW, not MERGE.
 * Override: `DREAMCONTEXT_DEDUP_MERGE_MARGIN` (0–1) — floor 0 (unlike the cosine
 * thresholds, a legitimately tiny gap is meaningful, and 0 merely disables the
 * secondary gate rather than widening the primary one).
 */
export const DEDUP_MERGE_MARGIN = envThreshold('DREAMCONTEXT_DEDUP_MERGE_MARGIN', 0.02, 0);

/**
 * Cosine at/above which the nearest doc is SURFACED for the agent to judge
 * (REVIEW) even below the auto-merge bar. 0.91 ≈ the empirical crossover of the
 * two bands (SAME-TOPIC p25 / OTHER ~p78): it catches ~three-quarters of genuine
 * same-topic candidates while flagging only the closer ~quarter of novel ones.
 * Between REVIEW and MERGE the agent decides create-vs-extend with the named
 * neighbor in hand — a semantic ASSIST over the old keyword-guessing gate, not an
 * automatic action. Leans toward RECALL: a REVIEW false positive costs a glance;
 * a miss costs a duplicate. Override: `DREAMCONTEXT_DEDUP_REVIEW` (0–1).
 */
export const DEDUP_REVIEW_THRESHOLD = envThreshold('DREAMCONTEXT_DEDUP_REVIEW', 0.91);

export interface DedupCandidate {
  title: string;
  description?: string;
  body: string;
}

export interface DedupNeighbor {
  /** `type/slug` identity (e.g. `knowledge/recall-engine-v2`). */
  docKey: string;
  type: string;
  slug: string;
  title: string;
  relPath: string;
  /** Max cosine over candidate-chunk × doc-chunk pairs (L2-normalized → dot). */
  sim: number;
}

export interface DedupResult {
  verdict: DedupVerdict;
  /** Highest-similarity existing doc, or null when the corpus is empty. */
  top: DedupNeighbor | null;
  /** Top-K neighbors, similarity-descending. */
  neighbors: DedupNeighbor[];
  /** top1 − top2 cosine (the margin gate for MERGE); null when < 2 neighbors. */
  margin: number | null;
  mergeThreshold: number;
  mergeMargin: number;
  reviewThreshold: number;
  candidateChunks: number;
  corpusDocs: number;
}

export interface DedupOptions {
  /** Corpus types to check the candidate against. Default: knowledge + feature. */
  types?: CorpusType[];
  /** How many nearest neighbors to return. Default 5. */
  topK?: number;
  mergeThreshold?: number;
  mergeMargin?: number;
  reviewThreshold?: number;
  /**
   * A `type/slug` to exclude from neighbors — set when re-checking an EXISTING
   * doc (an update) so the doc never matches itself and forces a spurious MERGE.
   */
  excludeDocKey?: string;
  /**
   * Injectable passage embedder (defaults to the real model). Tests pass a
   * deterministic fake; production leaves it unset. MUST be the same embedder
   * used to build the index it's compared against.
   */
  embed?: (texts: string[], onProgress?: (done: number, total: number) => void) => Promise<Float32Array[] | null>;
  /** Passed through to the index refresh (re-chunk every doc). */
  force?: boolean;
}

/**
 * Guard the two assumptions the cosine math silently depends on: every vector has
 * the SAME dimensionality, and every vector is L2-normalized (dot ≡ cosine ONLY
 * when ‖v‖ = 1). Violating either yields a plausible-but-wrong similarity — and a
 * wrong similarity here means a FALSE MERGE, the one failure mode this module
 * exists to prevent. Unreachable via the shipped path (both sides always use
 * `embedPassages`, and the cache invalidates on a model change), so this fails
 * LOUD rather than degrading: it can only mean a caller wired the `embed`
 * extension point to an incompatible embedder.
 */
const NORM_TOLERANCE = 1e-3;
function assertComparable(candidateVecs: Float32Array[], index: DenseIndex): void {
  const indexDims = index.chunks[0]?.vector.length;
  for (const cv of candidateVecs) {
    if (indexDims !== undefined && cv.length !== indexDims) {
      throw new Error(
        `[dedup] embedding dimension mismatch: candidate ${cv.length}d vs index ${indexDims}d. ` +
        'The candidate and the index must come from the SAME embedding model.',
      );
    }
    let norm = 0;
    for (let i = 0; i < cv.length; i++) norm += cv[i] * cv[i];
    if (Math.abs(Math.sqrt(norm) - 1) > NORM_TOLERANCE) {
      throw new Error(
        `[dedup] candidate vector is not L2-normalized (‖v‖=${Math.sqrt(norm).toFixed(4)}). ` +
        'Cosine thresholds are meaningless on unnormalized vectors.',
      );
    }
  }
}

/** Score each indexed doc by its MAX cosine to any candidate chunk vector. */
function maxSimByDoc(candidateVecs: Float32Array[], index: DenseIndex): Map<string, number> {
  const best = new Map<string, number>();
  for (const chunk of index.chunks) {
    const v = chunk.vector;
    let docBest = best.get(chunk.docKey) ?? -Infinity;
    for (const cv of candidateVecs) {
      let dot = 0;
      // Dims are asserted equal upstream (assertComparable) — no truncation here,
      // which would silently compare a PREFIX of two different spaces.
      for (let i = 0; i < v.length; i++) dot += v[i] * cv[i];
      if (dot > docBest) docBest = dot;
    }
    best.set(chunk.docKey, docBest);
  }
  return best;
}

/**
 * Nearest-neighbor dedup check for a candidate doc.
 *
 * Returns null when the embedding layer can't produce an answer — the model is
 * unavailable OR an embed call failed — so the caller can fall back to keyword
 * dedup. An empty corpus yields a `create` verdict with no neighbors.
 *
 * Throws ONLY on programmer error (a blank candidate, or an `embed` extension
 * point wired to an incompatible model) — never on the operational
 * missing-model/failed-embed path, which is what the sleep pipeline runs into.
 */
export async function dedupCandidate(
  contextRoot: string,
  candidate: DedupCandidate,
  opts: DedupOptions = {},
): Promise<DedupResult | null> {
  const mergeThreshold = opts.mergeThreshold ?? DEDUP_MERGE_THRESHOLD;
  const mergeMargin = opts.mergeMargin ?? DEDUP_MERGE_MARGIN;
  // Coherence: the bands are [review, merge) and [merge, 1]. An inverted pair
  // (review > merge) would silently ERASE the review band — a same-topic
  // candidate would fall through to `create` with no signal, defeating the gate.
  // Clamp instead of trusting the caller: review can never exceed merge.
  const reviewThreshold = Math.min(
    opts.reviewThreshold ?? DEDUP_REVIEW_THRESHOLD,
    mergeThreshold,
  );
  // topK only ever trims the REPORTED neighbor list. Clamp to ≥1 so it can never
  // empty the list and drop `top` to null — which would silently return `create`
  // for a candidate whose twin is sitting right there at cosine 1.0.
  const topK = Math.max(1, Math.floor(opts.topK ?? 5));
  const embed = opts.embed ?? embedPassages;
  const types = opts.types ?? ['knowledge', 'feature'];

  // A candidate with no embeddable text at all can only produce a meaningless
  // verdict from a degenerate `"passage: "` vector. That's a caller bug, not an
  // operational condition — fail loud rather than emit a confident-looking verdict.
  if (`${candidate.title ?? ''}${candidate.description ?? ''}${candidate.body ?? ''}`.trim() === '') {
    throw new TypeError('[dedup] candidate is blank — title, description and body are all empty.');
  }

  const corpus = buildCorpus(contextRoot, { types });
  const byKey = new Map<string, CorpusDoc>(corpus.map((d) => [docKey(d), d]));

  // Chunk + embed the candidate exactly as the index chunks its docs (title
  // prepended to every chunk — see chunkDoc), so the two live in one space.
  const candidateChunks = chunkDoc(candidate.title, candidate.body, candidate.description ?? '');
  const candidateTexts =
    candidateChunks.length > 0
      ? candidateChunks.map((c) => c.text)
      // Body chunked to nothing (e.g. headings-only) — fall back to the identity
      // text. Guaranteed non-blank by the blank-candidate guard above.
      : [[candidate.title, candidate.description].filter(Boolean).join('\n').trim()];

  // ADD-ONLY refresh: the corpus is type-scoped (knowledge+feature), so pruning
  // would evict every task/memory/changelog vector from the shared cache and
  // force a full inline re-embed on the next recall. Only add.
  //
  // An embed call that THROWS (OOM, a WASM crash, a transient model fault) is an
  // operational failure, not a programmer error: this runs unattended inside sleep,
  // where a stack trace would abort the specialist. Degrade to the documented null
  // contract so the caller falls back to keyword recall. Missing-model already
  // returns null; this closes the throw path to the same place.
  let refreshed: Awaited<ReturnType<typeof refreshEmbeddings>>;
  let candidateVecs: Float32Array[] | null;
  try {
    [refreshed, candidateVecs] = await Promise.all([
      refreshEmbeddings(contextRoot, corpus, embed, { additive: true, force: opts.force }),
      embed(candidateTexts),
    ]);
  } catch (err) {
    if (process.env.DREAMCONTEXT_DEBUG) {
      console.error(`[dedup] embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
  if (refreshed === null || candidateVecs === null) return null;
  // An embedder that returns FEWER vectors than texts would leave holes; treat a
  // short/empty return as an embed failure rather than scoring against undefined.
  if (candidateVecs.length !== candidateTexts.length) return null;

  assertComparable(candidateVecs, refreshed.index);

  const sims = maxSimByDoc(candidateVecs, refreshed.index);
  const neighbors: DedupNeighbor[] = [];
  for (const [key, sim] of sims) {
    if (opts.excludeDocKey && key === opts.excludeDocKey) continue;
    const doc = byKey.get(key);
    if (!doc) continue; // index entry for a doc filtered out of this corpus
    neighbors.push({
      docKey: key,
      type: doc.type,
      slug: doc.slug,
      title: doc.title,
      relPath: doc.relPath,
      sim,
    });
  }
  neighbors.sort((a, b) => b.sim - a.sim);
  const trimmed = neighbors.slice(0, topK);
  const top = trimmed[0] ?? null;
  // Margin over the 2nd-nearest doc — computed over ALL neighbors, not just the
  // top-K slice, so a small topK never inflates the gap.
  const margin = neighbors.length >= 2 ? neighbors[0].sim - neighbors[1].sim : null;

  let verdict: DedupVerdict = 'create';
  if (top && top.sim >= mergeThreshold && (margin === null || margin >= mergeMargin)) {
    // Auto-MERGE: close in absolute terms AND decisively closer to THIS doc than
    // to the runner-up. The margin gate is what keeps a long novel doc —
    // high-but-flat against a neighborhood — out of MERGE.
    //
    // `margin === null` (exactly ONE candidate neighbor — a single-doc corpus, or
    // `excludeDocKey` narrowing a two-doc one) DELIBERATELY bypasses the gate:
    // with no runner-up there is no ambiguity about WHICH doc a near-verbatim
    // twin belongs to, and the absolute floor still has to clear 0.97. Requiring
    // a margin there would make merge structurally impossible on a small corpus.
    verdict = 'merge';
  } else if (top && top.sim >= reviewThreshold) {
    verdict = 'review';
  }

  return {
    verdict,
    top,
    neighbors: trimmed,
    margin,
    mergeThreshold,
    mergeMargin,
    reviewThreshold,
    candidateChunks: candidateTexts.length,
    corpusDocs: corpus.length,
  };
}
