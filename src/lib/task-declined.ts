import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { embedPassages } from './embeddings/embedder.js';

/**
 * task-declined — a durable marker that an idea was deliberately DROPPED by a
 * human before it ever became a task.
 *
 * THE GAP THIS CLOSES. `task-tombstones.ts` records that an EXISTING task was
 * retired, so a sleep cycle cannot re-file it. But the failure the owner
 * reported is one step earlier: work discussed in one session and cancelled in
 * the next leaves NO trace at all — no task, so no tombstone — and the next
 * cycle reads only "this was discussed" and files it. `tasks decline` is that
 * missing trace. Declined is ONLY for ideas that never became a task; a
 * cancelled status or a delete already tombstones (see `task-backend/local.ts`).
 *
 * BRAIN CONTENT, NOT MACHINE STATE. The file syncs to teammates exactly like
 * `.task-tombstones.json` — a teammate's cycle must not re-file what you
 * declined. `git-sync/brain-repo.ts` is a deny-list, so this path syncs by
 * being ABSENT from it; that absence is deliberate and commented there.
 *
 * READS NEVER THROW. A corrupt ledger degrades to "nothing was declined" —
 * exactly today's behaviour — rather than breaking every `tasks create` that
 * consults it. `appendDeclined` is best-effort for the same reason the tombstone
 * appender is: the decision it records already happened in conversation, and
 * losing the marker must never fail the command the user actually ran. The one
 * deliberate asymmetry is {@link removeDeclined}: `tasks undecline` exists ONLY
 * to mutate this file, so a write failure there is reported, not swallowed.
 */

export const DECLINED_REL_PATH = 'state/.task-declined.json';

/** Newest-first cap. An idea declined 500 entries ago is no longer something a
 *  sleep cycle would think to re-file. */
export const MAX_DECLINED = 500;

/** Floor for `tasks decline --reason`. A declined idea is only useful to a later
 *  cycle if it says WHY it was dropped; "no" is not a reason anyone can act on. */
export const MIN_DECLINE_REASON_CHARS = 20;

/** How many of the NEWEST entries the semantic check embeds. The exact-key match
 *  still covers all {@link MAX_DECLINED}; this bounds the one embed call that
 *  runs inline inside `tasks create` (500 short texts would cost ~1-2 s per filed
 *  task, most of it for ideas nobody is about to re-propose). */
export const DECLINED_SEMANTIC_LIMIT = 100;

/**
 * Short-vs-short cosine floor for "this LOOKS like an idea the user dropped —
 * go read it". NOT a decision boundary: measured on 14 real tasks of this brain
 * (`Xenova/multilingual-e5-small` q8, `passage:` on both sides, candidate
 * `name\ndescription` vs declined `name\nreason`) same-idea min = 0.8256 while
 * distinct-pair max = 0.8984, so the bands OVERLAP. A hit is therefore a REVIEW
 * ask (`--declined-checked <key>` lifts it), never an unconditional refusal;
 * only the exact-key match is unconditional.
 *
 * 0.82 sits just under the measured same-idea minimum on purpose: misses are
 * rarer than false alarms, and a false alarm costs the specialist one flag after
 * reading the reason, never a lost task.
 *
 * Override with `DREAMCONTEXT_DECLINED_MATCH` (0.5–1; anything else falls back).
 * Read at CALL time via {@link declinedMatchThreshold}, never captured at import.
 */
export const DECLINED_MATCH_THRESHOLD = 0.82;

/** Lowest cosine an operator may configure. Below this every candidate would
 *  "match" the nearest declined idea, which is the opposite of a signal. */
const DECLINED_MIN_THRESHOLD = 0.5;

/**
 * The effective match threshold for THIS call.
 *
 * Deliberately a local reader rather than an import of `embeddings/dedup.ts`'s
 * `envThreshold`: the declined store must not depend on the dedup module (they
 * are independent units), and this is the only knob it reads.
 */
export function declinedMatchThreshold(): number {
  const raw = process.env.DREAMCONTEXT_DECLINED_MATCH;
  if (raw === undefined) return DECLINED_MATCH_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < DECLINED_MIN_THRESHOLD || n > 1) return DECLINED_MATCH_THRESHOLD;
  return n;
}

export interface DeclinedIdea {
  /** `slugify(topic)` — the stable identity `tasks undecline <key>` takes. */
  key: string;
  /** The one-sentence idea, as the user framed it. */
  topic: string;
  /** ISO timestamp of the decline. */
  declinedAt: string;
  /** WHY it was dropped — what a later cycle needs in order not to re-propose it. */
  reason: string;
  /** The session the decision was made in, when known. */
  session?: string;
}

function declinedPath(brainRoot: string): string {
  return join(brainRoot, DECLINED_REL_PATH);
}

function isDeclinedIdea(value: unknown): value is DeclinedIdea {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === 'string' &&
    typeof v.topic === 'string' &&
    typeof v.declinedAt === 'string' &&
    typeof v.reason === 'string'
  );
}

/** Read the ledger. NEVER throws — a corrupt file degrades to "nothing declined",
 *  which is exactly today's behaviour, rather than breaking every task create. */
export function readDeclined(brainRoot: string): DeclinedIdea[] {
  const path = declinedPath(brainRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDeclinedIdea);
  } catch {
    return [];
  }
}

export function writeDeclined(brainRoot: string, declined: DeclinedIdea[]): void {
  const path = declinedPath(brainRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(declined.slice(0, MAX_DECLINED), null, 2) + '\n', 'utf-8');
}

/**
 * Record that an idea was declined. Newest first; a key recorded again REPLACES
 * its older entry (an idea dropped, revived and dropped again has one truth, and
 * the newest reason is the only one that still explains anything).
 *
 * Best-effort by design: the user's decision already happened, and losing the
 * marker must never fail the command they ran.
 */
export function appendDeclined(brainRoot: string, idea: DeclinedIdea): void {
  try {
    const existing = readDeclined(brainRoot).filter((d) => d.key !== idea.key);
    writeDeclined(brainRoot, [idea, ...existing]);
  } catch {
    /* the decision was made in conversation; a missing marker is today's behaviour */
  }
}

export function findDeclined(brainRoot: string, key: string): DeclinedIdea | null {
  return readDeclined(brainRoot).find((d) => d.key === key) ?? null;
}

/**
 * Lift a decline (`tasks undecline <key>`). Returns false when the key was not on
 * the ledger — the caller reports that rather than claiming a no-op worked.
 *
 * Unlike {@link appendDeclined} this does NOT swallow a write failure: this
 * command exists only to mutate the ledger, so "I could not write it" is the one
 * thing the user must hear.
 */
export function removeDeclined(brainRoot: string, key: string): boolean {
  const existing = readDeclined(brainRoot);
  const remaining = existing.filter((d) => d.key !== key);
  if (remaining.length === existing.length) return false;
  writeDeclined(brainRoot, remaining);
  return true;
}

/** Cosine of two L2-normalized vectors — a plain dot product. Both sides come
 *  from ONE `embedPassages` call, so they share a model, a space and a norm. */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Nearest declined idea to a candidate task, by cosine similarity.
 *
 * ONE embed call, no index, no corpus, no second keyword pass: the candidate and
 * the newest {@link DECLINED_SEMANTIC_LIMIT} declined entries go into a single
 * `embedPassages` batch (`passage:`-prefixed and L2-normalized on both sides, so
 * cosine IS the dot product) and the best entry at/above the threshold wins.
 *
 * Returns null — never throws — whenever the embedding layer cannot answer: the
 * store is empty, the model is unavailable, or an embed call failed. The caller
 * then has only the exact-key match and must SAY so, rather than let silence
 * read as a clean check. This runs unattended inside a sleep cycle's
 * `tasks create`, where a stack trace would abort the specialist.
 */
export async function matchDeclinedSemantically(
  brainRoot: string,
  candidate: { title: string; why: string },
  opts: {
    /** Injectable embedder (tests pass a deterministic fake; production leaves it
     *  unset). MUST `passage:`-prefix and L2-normalize, like `embedPassages`. */
    embed?: (texts: string[]) => Promise<Float32Array[] | null>;
    threshold?: number;
  } = {},
): Promise<{ idea: DeclinedIdea; sim: number } | null> {
  const entries = readDeclined(brainRoot).slice(0, DECLINED_SEMANTIC_LIMIT);
  if (entries.length === 0) return null;   // nothing to compare — never load a model for it

  const candidateText = `${candidate.title ?? ''}\n${candidate.why ?? ''}`.trim();
  // A blank candidate can only produce a meaningless verdict from a degenerate
  // vector. Unreachable through the filing bar (the why floor runs first), so
  // treat it as "no answer" rather than a confident-looking one.
  if (candidateText === '') return null;

  const texts = [candidateText, ...entries.map((d) => `${d.topic}\n${d.reason}`)];
  const embed = opts.embed ?? embedPassages;

  let vectors: Float32Array[] | null;
  try {
    vectors = await embed(texts);
  } catch (err) {
    // An embed that THROWS (OOM, a WASM fault) is an operational failure, not a
    // programmer error — degrade to the documented null contract, and say why
    // under DREAMCONTEXT_DEBUG rather than into the void.
    if (process.env.DREAMCONTEXT_DEBUG) {
      console.error(`[task-declined] embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
  if (vectors === null) return null;                  // model unavailable
  if (vectors.length !== texts.length) return null;   // short return → holes, not scores
  const dims = vectors[0].length;
  // Mixed dimensionality can only come from an incompatible injected embedder.
  // Comparing a PREFIX of two different spaces yields a plausible-but-wrong
  // similarity, so refuse to score at all rather than guess.
  if (vectors.some((v) => v.length !== dims)) return null;

  const threshold = opts.threshold ?? declinedMatchThreshold();
  let best: { idea: DeclinedIdea; sim: number } | null = null;
  for (let i = 0; i < entries.length; i++) {
    const sim = dot(vectors[0], vectors[i + 1]);
    if (sim >= threshold && (best === null || sim > best.sim)) {
      best = { idea: entries[i], sim };
    }
  }
  return best;
}
