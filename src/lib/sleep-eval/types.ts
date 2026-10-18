import { join } from 'node:path';

/**
 * sleep-eval — a fixed test set cut from this brain's own past sleep rounds, so a change to
 * how sleep files tasks is measured before and after instead of judged by feel.
 *
 * Everything lives under `<contextRoot>/tmp/sleep-eval/` (gitignored, local only, never
 * published): it holds copies of real transcripts.
 *
 *   set.json                       the frozen manifest: which rounds, which thresholds
 *   board/<slug>.md                the task files as they stood when the set was frozen
 *   fixtures/<round>/round.json    one past sleep round: its sessions, its board cut, what it opened
 *   fixtures/<round>/sessions/     copies of that round's transcripts
 *   labels.json                    the owner's verdicts (the .task-feedback.json schema)
 *   runs/<run>/                    one `sleep eval run`: per-round outputs, load, guard, report
 */

export const SLEEP_EVAL_REL = join('tmp', 'sleep-eval');
export const SLEEP_EVAL_SET_VERSION = 1;

export function sleepEvalRoot(contextRoot: string): string {
  return join(contextRoot, SLEEP_EVAL_REL);
}

// ─── Feedback schema (shared with state/.task-feedback.json) ─────────────────

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

/**
 * What sleep SHOULD have done with the thing on the card — the question the deck asks
 * (owner 2026-10-16: "ask what sleep should have done, not whether a model's label is right").
 *   new-task     open a task for it
 *   add-to-task  put it into the existing task the card names (a criterion or a sub-task)
 *   nothing      do nothing (a reason says why)
 */
export const FEEDBACK_OUTCOMES = ['new-task', 'add-to-task', 'nothing'] as const;
export type FeedbackOutcome = typeof FEEDBACK_OUTCOMES[number];

/** What the filing was based on. */
export type FeedbackBasis = 'ask' | 'defect' | 'discussion' | 'unknown';

/**
 * One owner verdict on one task proposal. The same shape `state/.task-feedback.json` stores
 * for live proposals; the eval keeps its own copy in `tmp/sleep-eval/labels.json` so the test
 * set can never leak into what sleep learns its filing rules from.
 */
export interface TaskFeedbackEntry {
  /** Stable id of the thing judged (an eval label item id, or a proposal id). */
  id: string;
  /** ISO time of the verdict. */
  at: string;
  source: 'sleep-eval' | 'proposal' | 'sleep-filed';
  verdict: 'keep' | 'reject';
  /** What sleep should have done (absent on a yes/no card such as a repeated correction). */
  outcome?: FeedbackOutcome | null;
  /** The proposal as it was shown (öneri metni). */
  proposal: { name: string; why: string; parent?: string | null };
  /** temel */
  basis: FeedbackBasis;
  /** alıntı: the session line it came from. */
  quote: string;
  /** sebep: required on a reject from the deck, absent on a keep. */
  reason?: FeedbackReason | null;
  /** not */
  note?: string;
  /** fark: the owner's edit of name/why before keeping. */
  diff?: { name?: { from: string; to: string }; why?: { from: string; to: string } } | null;
}

// ─── Test set ────────────────────────────────────────────────────────────────

/**
 * What a label item asserts once the owner keeps it:
 *   opened            a task the real sleep opened (keep = the owner would keep it)
 *   explicit-ask      the owner asked for this work in the session → should be opened
 *   sub-detail        a detail of an existing task → belongs under `parent`
 *   abandoned         discussed, then dropped → must not be opened
 *   other-project     another project's work → must not be opened here
 *   style-correction  a correction the owner keeps repeating → should become a pattern
 */
export const LABEL_CATEGORIES = [
  'opened',
  'explicit-ask',
  'sub-detail',
  'abandoned',
  'other-project',
  'style-correction',
] as const;
export type LabelCategory = typeof LABEL_CATEGORIES[number];

export interface LabelItem {
  /** `<round>:<category>:<n>` — stable across rebuilds of the same round. */
  id: string;
  round: string;
  category: LabelCategory;
  name: string;
  why: string;
  quote: string;
  session?: string | null;
  /** opened: its real parent_task. sub-detail: the task it belongs under. */
  parent?: string | null;
  /** opened: the slug the real sleep filed. */
  slug?: string | null;
  basis: FeedbackBasis;
}

export interface FixtureSession {
  session_id: string;
  /** Path of the copy, relative to the round's fixture dir. */
  file: string;
  stopped_at: string;
  last_assistant_message: string;
  /** Sub-agent transcript copies, relative to the round dir. */
  subagents: string[];
}

export interface FixtureRound {
  id: string;
  /** Set when the round was cut from another brain on this machine (`build --add-source`). */
  source?: { name: string; ctx: string };
  /** The real round's consolidation time. */
  consolidatedAt: string;
  /** The previous round's consolidation time: everything opened after it belongs to this round. */
  previousAt: string | null;
  summary: string;
  sessions: FixtureSession[];
  /** Board slugs that existed before this round (the board the real sleep saw, approximately). */
  board: string[];
  /** Tasks the real sleep opened in this round. */
  opened: LabelItem[];
  /** Model-proposed label candidates (owner confirms each on the Tasks screen). */
  candidates: LabelItem[];
  /** Candidates set aside by the owner's choice (2026-10-16: 11 opened + ~20 strongest); not
   *  labelled, not scored, kept so they can be brought back. */
  parked?: LabelItem[];
}

export interface SleepEvalSet {
  version: number;
  createdAt: string;
  /** The brain the set was cut from (absolute context root at build time). */
  source: string;
  rounds: string[];
  /** Fixed scoring knobs, frozen with the set so every run is scored alike. */
  scoring: SleepEvalScoring;
}

export interface SleepEvalScoring {
  /** Cosine at or above which a run's output and a label item are the same work. */
  matchThreshold: number;
  /** Cosine at or above which a new task duplicates a board task. */
  duplicateThreshold: number;
  /** A child task may close when its composite is at least baseline minus this. */
  gateTolerance: number;
}

export const DEFAULT_SCORING: SleepEvalScoring = {
  matchThreshold: 0.86,
  duplicateThreshold: 0.92,
  gateTolerance: 0.05,
};
