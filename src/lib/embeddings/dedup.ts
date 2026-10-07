import { buildCorpus, docKey, type CorpusDoc, type CorpusType } from '../recall.js';
import { chunkDoc } from './chunker.js';
import { embedPassages } from './embedder.js';
import { EMBED_PROFILE } from './profiles.js';
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
 *
 * NOT EVERY CORPUS IS CURATED DOCS ONLY. The `task` corpus folds SESSION DIGESTS
 * in (`recall.ts` buildCorpus → `loadDigestDocs`, slug `digest#<sessionId>`,
 * `capture: true`), and a task candidate written FROM a session near-matches its
 * own digest — a "duplicate" that nothing can be folded into. A caller checking
 * that corpus must pass {@link DedupOptions.excludeCapture}.
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

// ── Per-model defaults ───────────────────────────────────────────────────────
// Cosine SCALES are model-specific, so each embedding profile (profiles.ts) carries its own
// merge / margin / review gates; the exports below read the ACTIVE profile's. The numbers above
// and in the three doc blocks below are e5-small's (0.97 / 0.02 / 0.91 — unchanged).
//
// EmbeddingGemma-300m q8 (the default since 2026-10-07) spreads over 0.25–1.0 instead of e5's
// 0.83–1.0, so e5's gates would NEVER fire on it (same-topic max 0.908 < 0.91; a 30%-reworded twin
// ~0.95 < 0.97). Measured the same way (short candidates = title + description; scoring =
// maxSimByDoc below), on the frozen dc brain (186 knowledge+feature docs, 138 probes) and a
// deterministic 24-probe sample of the h-f brain (430 docs, Turkish-heavy):
//
//   band (max cosine over chunk pairs)                        dc  min/p25/p50/p90/max      h-f p50/p90/max
//   SAME-TOPIC  short cand → own body                         .553/.787/.822/.880/.908     .832/.875/.905
//   OTHER       short cand → nearest other doc                .506/.597/.659/.761/.835     .747/.854/.905
//   TWIN-10%    whole doc, 10% of words dropped               .917/.984/.991/1.00/1.00     .943/.972/.978
//   TWIN-30%    whole doc, 30% of words dropped               .850/.927/.955/.978/1.00     .924/.942/.947
//   TWIN-SECT   one 120-word section, 30% dropped             .795/.884/.916/.950/.969     .927/.952/.955
//   DISTINCT    a doc's own chunks → nearest OTHER doc        .522/.718/.789/.853/.888     .833/.919/1.00*
//   UNRELATED   random doc pairs                              .249/.481/.535/.640/.855     .521/.638/.716
//   margins top1−top2: twins p10 .12–.14 (dc) / .05–.07 (h-f); distinct docs p50 .03, p90 .10–.15.
//   (* h-f holds true duplicate docs: 8% of docs have a neighbor ≥ 0.97.)
//
// Gates, set with the same rules as e5's: MERGE sits ~0.025 above the highest NOT-a-twin pair
// measured on EITHER corpus (h-f's OTHER max .905 → 0.93; dc's was .835–.888), so auto-merge stays
// a high-precision signal (0% false merges on both corpora at 0.93; it still catches ~99% / ~50% of
// 10%-dropped twins on dc / h-f) — a missed merge costs a duplicate the next curator pass folds in, a
// false merge loses content. MARGIN 0.05: Gemma's spread is ~3× e5's, so e5's 0.02 scales to ≈0.05;
// 91–100% of twins clear it while only ~29% of distinct neighborhoods do. REVIEW 0.78 is the e5 rule
// (catch ~¾ of same-topic candidates, flag only the closer novel ones): dc catches 78% / flags 6%
// of novel, h-f 71% / 29% — Gemma's same-topic and other bands overlap far less than e5's did.
// The declined-idea gate (task-declined.ts) is the same story: same-idea p10 .74/.63, distinct
// max .664 on both corpora → 0.68 (e5: 0.82).
//
// RE-CALIBRATE when the model changes: scripts/dedup-calibrate.ts measures SAME-TOPIC / OTHER for the
// active model; twin bands = the doc restated with words dropped, scored against the same index.

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
export const DEDUP_MERGE_THRESHOLD = envThreshold('DREAMCONTEXT_DEDUP_MERGE', EMBED_PROFILE.dedupMerge);

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
export const DEDUP_MERGE_MARGIN = envThreshold('DREAMCONTEXT_DEDUP_MERGE_MARGIN', EMBED_PROFILE.dedupMergeMargin, 0);

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
export const DEDUP_REVIEW_THRESHOLD = envThreshold('DREAMCONTEXT_DEDUP_REVIEW', EMBED_PROFILE.dedupReview);

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
   * Drop CAPTURE docs — session digests, auto-bookmarks — from the neighbor set
   * BEFORE the verdict is computed, so `top`, `margin` and `verdict` are all
   * derived from foldable docs only. Set it whenever the corpus can contain
   * them: the `task` corpus indexes session digests (see the module note), and
   * a candidate distilled from a session scores near-1.0 against its OWN digest,
   * which would refuse the create naming a doc nobody can fold work into.
   * `corpusDocs` still reports the WHOLE corpus size — this filters neighbors,
   * it does not shrink the corpus that was searched.
   */
  excludeCapture?: boolean;
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
      // Bounded wait on the vault's cache lock; a timeout throws into the catch below.
      refreshEmbeddings(contextRoot, corpus, embed, { additive: true, force: opts.force, waitForLock: true }),
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
    // Capture docs are dropped HERE, not after the sort: `top`, `margin` and the
    // verdict are all computed from `neighbors` below, so filtering later would
    // still let a session digest decide the verdict and then vanish from the list.
    if (opts.excludeCapture && doc.capture === true) continue;
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
