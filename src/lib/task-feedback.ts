import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEDUP_REVIEW_THRESHOLD } from './embeddings/dedup.js';
import { foldAscii } from './fold-ascii.js';
import { generateId } from './id.js';
import { safeResolveInside } from './safe-resolve.js';

/**
 * task-feedback — the owner's verdict on every task sleep filed or proposed.
 *
 * `state/.task-feedback.json` is the one place sleep learns its filing rules
 * from: each reject carries a one-tap reason, an optional note, and — on a keep
 * — the owner's edit of the name or Why as a diff. Three things read it:
 *
 *   1. the task-filing-rules pattern (every rule cites the reject ids it rests on);
 *   2. the deterministic settings below (an "already exists" reject tightens the
 *      neighbour threshold; three rejects of the same kind of candidate block it);
 *   3. the Proposals section on the Tasks screen (the weekly acceptance trend).
 *
 * THE SCHEMA IS SHARED with the sleep-eval test set (`tmp/sleep-eval/labels.json`
 * stores the same {@link TaskFeedbackEntry}); the eval keeps its own copy so the
 * test set can never leak into what sleep learns from. Change both together.
 *
 * Machine-local unless the brain repo syncs it: the generated brain ignore does
 * not list it (like `.task-declined.json`), and a brain that ignores all of
 * `state/` keeps it on this machine.
 */

export const FEEDBACK_REL_PATH = 'state/.task-feedback.json';

/** Newest-first cap. A verdict 1,000 verdicts ago no longer describes this owner. */
export const MAX_FEEDBACK = 1000;

/** The one-tap reasons a filed or proposed task is rejected for. */
export const FEEDBACK_REASONS = [
  'already-exists',   // zaten var / başka görevin parçası
  'abandoned',        // konuşuldu ama vazgeçildi
  'too-small',        // çok küçük
  'badly-written',    // kötü yazılmış
  'wrong-project',    // yanlış proje
  'not-work',         // iş değil (bir soru, bir yorum, zaten bitmiş)
] as const;
export type FeedbackReason = typeof FEEDBACK_REASONS[number];

/** What sleep SHOULD have done with the thing judged (the eval deck's question). */
export const FEEDBACK_OUTCOMES = ['new-task', 'add-to-task', 'nothing'] as const;
export type FeedbackOutcome = typeof FEEDBACK_OUTCOMES[number];

/** What the filing was based on. */
export type FeedbackBasis = 'ask' | 'defect' | 'discussion' | 'unknown';

export interface TaskFeedbackEntry {
  /** Stable id of the thing judged (an eval label item id, a proposal id, or `fb_…`). */
  id: string;
  /** ISO time of the verdict. */
  at: string;
  source: 'sleep-eval' | 'proposal' | 'sleep-filed';
  verdict: 'keep' | 'reject';
  /** What sleep should have done (absent on a yes/no card). */
  outcome?: FeedbackOutcome | null;
  /** The proposal as it was shown (öneri metni). */
  proposal: { name: string; why: string; parent?: string | null };
  /** temel */
  basis: FeedbackBasis;
  /** alıntı: the session line it came from. */
  quote: string;
  /** sebep: required on a reject, absent on a keep. */
  reason?: FeedbackReason | null;
  /** not */
  note?: string;
  /** fark: the owner's edit of name/why before keeping. */
  diff?: { name?: { from: string; to: string }; why?: { from: string; to: string } } | null;
}

const REASON_LABELS: Record<FeedbackReason, string> = {
  'already-exists': 'already exists / part of another task',
  abandoned: 'discussed, then dropped',
  'too-small': 'too small for a task of its own',
  'badly-written': 'badly written',
  'wrong-project': 'belongs to another project',
  'not-work': 'not work (a question, a comment, or already done)',
};

/** The reason in words, for refusals, the declined store and the rules pattern. */
export function reasonLabel(reason: FeedbackReason): string {
  return REASON_LABELS[reason];
}

export function isFeedbackReason(v: unknown): v is FeedbackReason {
  return typeof v === 'string' && (FEEDBACK_REASONS as readonly string[]).includes(v);
}

function isEntry(v: unknown): v is TaskFeedbackEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  const p = e.proposal as Record<string, unknown> | undefined;
  return typeof e.id === 'string'
    && typeof e.at === 'string'
    && (e.verdict === 'keep' || e.verdict === 'reject')
    && !!p && typeof p.name === 'string' && typeof p.why === 'string';
}

function feedbackPath(contextRoot: string): string {
  return safeResolveInside(contextRoot, FEEDBACK_REL_PATH);
}

/**
 * A machine store that exists but cannot be read (a bad merge, a hand edit). Every
 * write refuses rather than replace it with what little could be read: the history
 * in it is what the brake, the kind blocks and the rules' citations rest on.
 */
export class CorruptStoreError extends Error {
  constructor(public readonly file: string) {
    super(`${file} cannot be read (not valid JSON of the expected shape), so nothing was written to it `
      + 'and sleep may not file or propose until it is fixed. Repair it, or move it aside to start it fresh.');
    this.name = 'CorruptStoreError';
  }
}

/**
 * Newest first. Missing = no verdicts yet; a file that exists but cannot be read
 * throws {@link CorruptStoreError}. What every write and every gate reads.
 */
export function readFeedbackStrict(contextRoot: string): TaskFeedbackEntry[] {
  const path = feedbackPath(contextRoot);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new CorruptStoreError(FEEDBACK_REL_PATH);
  }
  if (!Array.isArray(parsed)) throw new CorruptStoreError(FEEDBACK_REL_PATH);
  return parsed.filter(isEntry);
}

/** Newest first, for display. Never throws: an unreadable file reads as "no verdicts yet". */
export function readFeedback(contextRoot: string): TaskFeedbackEntry[] {
  try {
    return readFeedbackStrict(contextRoot);
  } catch {
    return [];
  }
}

/** Atomic (temp + rename); throws on an unsafe path or a failed write. */
export function writeFeedback(contextRoot: string, entries: TaskFeedbackEntry[]): void {
  const path = feedbackPath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries.slice(0, MAX_FEEDBACK), null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/** Record one verdict (newest first). Returns the stored entry. Refuses an unreadable store. */
export function appendFeedback(
  contextRoot: string,
  entry: Omit<TaskFeedbackEntry, 'at'> & { at?: string },
): TaskFeedbackEntry {
  const stored: TaskFeedbackEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
  writeFeedback(contextRoot, [stored, ...readFeedbackStrict(contextRoot)]);
  return stored;
}

export function newFeedbackId(): string {
  return generateId('fb');
}

/** The verdicts that teach sleep: live proposals and sleep-filed tasks, never the eval set. */
export function liveVerdicts(entries: TaskFeedbackEntry[]): TaskFeedbackEntry[] {
  return entries.filter((e) => e.source === 'proposal' || e.source === 'sleep-filed');
}

// ─── "The same kind of candidate" ────────────────────────────────────────────

/**
 * Word stems of a candidate: ASCII-folded, lowercased, words of 3+ characters cut
 * to their first 6 letters. The cut is what lets Turkish suffixes match
 * ("görevler", "görevi" → "gorev") without a stemmer; Jaccard over the stems is
 * the similarity. Deterministic and model-free on purpose: the gate it feeds must
 * give the same answer on every machine, embedding model or not.
 */
function stems(text: string): Set<string> {
  return new Set(
    foldAscii(text.toLowerCase())
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
      .map((w) => w.slice(0, 6)),
  );
}

export function candidateSimilarity(a: string, b: string): number {
  const wa = stems(a);
  const wb = stems(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

function candidateText(c: { name: string; why: string }): string {
  return `${c.name}\n${c.why}`;
}

/** Stem overlap at which a candidate counts as the same kind as a rejected one. */
export const KIND_SIMILARITY = 0.45;

/** Rejects of one kind after which sleep stops filing or proposing that kind. */
export const KIND_REJECTS = 3;

export interface KindBlock {
  /** The reason most of the matching rejects carry (newest wins a tie). */
  reason: FeedbackReason;
  /** The rejects this candidate resembles, newest first. */
  matches: TaskFeedbackEntry[];
}

/**
 * Has the owner rejected this kind of candidate {@link KIND_REJECTS} times?
 *
 * "Kind" is resemblance, not a label: a candidate is the same kind as a reject
 * when their name + Why share at least {@link KIND_SIMILARITY} of their stems.
 * Only live verdicts count; a reject the owner later contradicted with a keep of
 * the same text is still a reject (the rules pattern, not this gate, weighs that).
 */
export function kindBlock(
  entries: TaskFeedbackEntry[],
  candidate: { name: string; why: string },
): KindBlock | null {
  const text = candidateText(candidate);
  const matches = liveVerdicts(entries).filter((e) =>
    e.verdict === 'reject' && candidateSimilarity(text, candidateText(e.proposal)) >= KIND_SIMILARITY);
  if (matches.length < KIND_REJECTS) return null;
  const counts = new Map<FeedbackReason, number>();
  for (const m of matches) {
    const r = isFeedbackReason(m.reason) ? m.reason : 'not-work';
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best: FeedbackReason = isFeedbackReason(matches[0].reason) ? matches[0].reason : 'not-work';
  for (const [r, n] of counts) if (n > (counts.get(best) ?? 0)) best = r;
  return { reason: best, matches };
}

// ─── "Already exists" tightens the neighbour gate ────────────────────────────

/** How much one "already exists" reject lowers the review threshold. */
export const DUPLICATE_STEP = 0.01;
/** The most the threshold is ever lowered, however many rejects pile up. */
export const DUPLICATE_MAX_TIGHTENING = 0.05;

/**
 * The neighbour gate's review threshold for THIS project: the shipped one minus
 * {@link DUPLICATE_STEP} per "already exists" reject, at most
 * {@link DUPLICATE_MAX_TIGHTENING} lower. Lower = a looser match already counts
 * as "you may be re-filing X", i.e. the bar is stricter about duplicates.
 * Derived on every call, so a reverted verdict un-tightens it.
 */
export function tightenedReviewThreshold(
  entries: TaskFeedbackEntry[],
  base: number = DEDUP_REVIEW_THRESHOLD,
): { threshold: number; rejects: number } {
  const rejects = liveVerdicts(entries).filter((e) => e.verdict === 'reject' && e.reason === 'already-exists').length;
  const drop = Math.min(DUPLICATE_MAX_TIGHTENING, rejects * DUPLICATE_STEP);
  return { threshold: Number((base - drop).toFixed(4)), rejects };
}

// ─── Weekly acceptance trend (the Proposals section) ─────────────────────────

export interface WeekTrend {
  /** Monday of the ISO week, `YYYY-MM-DD`. */
  week: string;
  kept: number;
  rejected: number;
  /** kept / (kept + rejected), or null in a week with no verdicts. */
  rate: number | null;
}

function mondayOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** The last `weeks` ISO weeks (oldest first), each with its keep/reject counts. */
export function weeklyAcceptance(
  entries: TaskFeedbackEntry[],
  weeks = 8,
  now: Date = new Date(),
): WeekTrend[] {
  const thisMonday = mondayOf(now.toISOString());
  const out: WeekTrend[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(`${thisMonday}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push({ week: d.toISOString().slice(0, 10), kept: 0, rejected: 0, rate: null });
  }
  const byWeek = new Map(out.map((w) => [w.week, w]));
  for (const e of liveVerdicts(entries)) {
    const w = byWeek.get(mondayOf(e.at));
    if (!w) continue;
    if (e.verdict === 'keep') w.kept++;
    else w.rejected++;
  }
  for (const w of out) {
    const n = w.kept + w.rejected;
    w.rate = n > 0 ? Number((w.kept / n).toFixed(3)) : null;
  }
  return out;
}
