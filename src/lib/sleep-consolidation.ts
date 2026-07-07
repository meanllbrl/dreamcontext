/**
 * sleep-consolidation — pure, side-effect-free core of the sleep/consolidation
 * lifecycle. This is a LEAF module: it imports nothing with side effects so it
 * can be unit-tested in isolation and reused by both `sleep.ts` (CLI) and
 * `hook.ts` (Stop/PreCompact handlers) without pulling in disk/process deps.
 *
 * The data types live here (moved from sleep.ts) and are re-exported from
 * sleep.ts so all existing importers keep compiling.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SessionRecord {
  session_id: string;
  transcript_path: string | null;
  stopped_at: string | null;
  last_assistant_message: string | null;
  change_count: number | null;
  tool_count: number | null;
  score: number | null;
  task_slugs: string[];
}

export interface Bookmark {
  id: string;
  message: string;
  salience: 1 | 2 | 3;
  created_at: string;
  session_id: string | null;
  task_slug: string | null;
}

export interface Trigger {
  id: string;
  when: string;
  remind: string;
  source: string | null;
  created_at: string;
  fired_count: number;
  max_fires: number;
}

export interface KnowledgeAccessRecord {
  last_accessed: string;
  count: number;
}

export interface SleepHistoryEntry {
  date: string;
  consolidated_at: string;
  summary: string;
  debt_before: number;
  debt_after: number;
  sessions_processed: number;
  bookmarks_processed: number;
  session_ids: string[];
}

export interface CompactionRecord {
  timestamp: string;
  trigger: string;
  debt_at_compaction: number;
  sessions_count: number;
  bookmarks_count: number;
}

export type FieldValue =
  | string
  | number
  | boolean
  | string[]
  | Record<string, unknown>
  | null;

export interface FieldChange {
  field: string;
  from: FieldValue;
  to: FieldValue;
}

export interface DashboardChange {
  timestamp: string;
  entity: 'task' | 'core' | 'knowledge' | 'feature' | 'sleep';
  action: 'create' | 'update' | 'delete';
  target: string;
  field?: string;
  fields?: FieldChange[];
  summary: string;
}

/**
 * Consolidation depth — gates how aggressive the sleep cycle may be with
 * knowledge ops. Destructive/expensive ops (merge-with-delete,
 * summarize-and-replace, archive/delete) are authorized ONLY at 'deep'.
 */
export type ConsolidationDepth = 'light' | 'standard' | 'deep';

export interface SleepState {
  debt: number;
  last_sleep: string | null;
  last_sleep_summary: string | null;
  sleep_started_at: string | null;
  sessions_since_last_sleep: number;
  sessions: SessionRecord[];
  bookmarks: Bookmark[];
  triggers: Trigger[];
  knowledge_access: Record<string, KnowledgeAccessRecord>;
  dashboard_changes: DashboardChange[];
  compaction_log: CompactionRecord[];
  recall_mode: 'haiku' | 'raw' | 'off';
  /**
   * Depth pinned for the in-progress consolidation cycle. Computed + persisted
   * by `sleep start` (always, even with no --deep flag, so it never holds a
   * stale prior value), reset to null by `sleep done`. Null when no cycle is in
   * progress; old `.sleep.json` files back-fill to null via freshDefaults.
   */
  consolidation_depth: ConsolidationDepth | null;
  /**
   * Summaries of 'code' migrations applied since the last session start.
   * Written by sleep start (and update) after runMigrations; cleared at
   * sleep start so the snapshot note is surfaced exactly once per cycle.
   * generateSnapshot reads this READ-ONLY — it never writes it.
   */
  pendingMigrationNotices: string[];
}

// ─── Sleepiness thresholds ───────────────────────────────────────────────────

/**
 * Debt thresholds (the ENTRY point of each level), and the rhythm reminder.
 *
 * **[2026-06-29]** Rescaled ×2 from the original 4/7/10 scale so "Must Sleep" is
 * now 20 (was 10). Per-session scoring is unchanged (a session still adds at most
 * +3 debt), so this roughly doubles the consolidation cadence. These are the
 * SINGLE SOURCE OF TRUTH — `sleepinessLevel`, `sleepinessRange`, `depthFromDebt`,
 * and every hook directive/reminder derive from them, so the scale never drifts
 * across files again. Levels: Alert 0–7 · Drowsy 8–13 · Sleepy 14–19 · Must Sleep 20+.
 */
export const DEBT_DROWSY = 8;       // ≥ this: offer to consolidate after the current task
export const DEBT_SLEEPY = 14;      // ≥ this: consolidation recommended
export const DEBT_MUST_SLEEP = 20;  // ≥ this: consolidation required (Must Sleep)
/** Sessions-since-last-sleep that trips the rhythm reminder (independent of debt points). */
export const RHYTHM_SESSIONS = 5;

/** Human-readable sleepiness label for a debt value. */
export function sleepinessLevel(debt: number): 'Alert' | 'Drowsy' | 'Sleepy' | 'Must Sleep' {
  if (debt < DEBT_DROWSY) return 'Alert';
  if (debt < DEBT_SLEEPY) return 'Drowsy';
  if (debt < DEBT_MUST_SLEEP) return 'Sleepy';
  return 'Must Sleep';
}

/** Debt-range bucket label for a debt value (e.g. "8-13", "20+"). */
export function sleepinessRange(debt: number): string {
  if (debt < DEBT_DROWSY) return `0-${DEBT_DROWSY - 1}`;
  if (debt < DEBT_SLEEPY) return `${DEBT_DROWSY}-${DEBT_SLEEPY - 1}`;
  if (debt < DEBT_MUST_SLEEP) return `${DEBT_SLEEPY}-${DEBT_MUST_SLEEP - 1}`;
  return `${DEBT_MUST_SLEEP}+`;
}

/** Recompute total debt as the sum of session scores. */
export function recomputeDebt(sessions: SessionRecord[]): number {
  return sessions.reduce((sum, s) => sum + (s.score ?? 0), 0);
}

// ─── Consolidation depth ─────────────────────────────────────────────────────

const DEPTH_ORDER: ConsolidationDepth[] = ['light', 'standard', 'deep'];

/** Debt → base consolidation depth. Aligned to the sleepiness thresholds:
 *  Alert → light, Drowsy+Sleepy → standard, Must Sleep → deep. */
function depthFromDebt(debt: number): ConsolidationDepth {
  if (debt < DEBT_DROWSY) return 'light';
  if (debt < DEBT_MUST_SLEEP) return 'standard';
  return 'deep';
}

export interface DepthDecision {
  depth: ConsolidationDepth;
  reason: string;
  source: 'user' | 'agent' | 'debt';
}

/**
 * Resolve the consolidation depth for a cycle.
 *
 * Precedence (highest wins): userRequestedDeep → agentBump → debt base.
 * - `userRequestedDeep` forces UP to 'deep' (never lowers).
 * - `agentBump` steps the debt-base depth up by N tiers. The bump is clamped
 *   INSIDE this function to 0..2, so a negative/garbage bump can only neutralize
 *   (never lower below the debt base) and an over-large bump caps at 'deep'.
 *
 * Monotonic & bounded by construction: depth never drops below the debt base
 * and never exceeds 'deep'.
 */
export function consolidationDepth(
  debt: number,
  opts: { userRequestedDeep?: boolean; agentBump?: number } = {},
): DepthDecision {
  const base = depthFromDebt(debt);

  if (opts.userRequestedDeep) {
    return { depth: 'deep', reason: 'user requested deep consolidation', source: 'user' };
  }

  // Clamp the bump internally: negatives → 0, > 2 → 2. Never trust the caller.
  const bump = Math.max(0, Math.min(2, opts.agentBump ?? 0));
  if (bump > 0) {
    const baseIdx = DEPTH_ORDER.indexOf(base);
    const idx = Math.min(DEPTH_ORDER.length - 1, baseIdx + bump);
    return {
      depth: DEPTH_ORDER[idx],
      reason: `agent bumped depth by ${bump} tier(s) from ${base}`,
      source: 'agent',
    };
  }

  return { depth: base, reason: `debt ${debt} → ${base}`, source: 'debt' };
}

/**
 * True iff destructive/expensive knowledge ops are authorized for this depth.
 * Authorized ONLY at 'deep'. Null/undefined/any-other-value → false (safe by
 * default), so a missing depth can never accidentally unlock destructive ops.
 */
export function isDestructiveAllowed(depth: ConsolidationDepth | null | undefined): boolean {
  return depth === 'deep';
}

// ─── Consolidation (pure epoch-clear core) ───────────────────────────────────

export interface ConsolidationResult {
  state: SleepState;
  sessionsProcessed: number;
  bookmarksProcessed: number;
  processedSessionIds: string[];
}

/**
 * Pure core of the `sleep done` epoch-clear block. Operates on a CLONE — the
 * input state is NEVER mutated.
 *
 * - Epoch-truthy: survivors = sessions stopped strictly AFTER the epoch;
 *   bookmarks / dashboard_changes filtered to created/timestamp > epoch;
 *   debt recomputed from survivors.
 * - Epoch-null (backward compat): clear all sessions/bookmarks/dashboard_changes,
 *   debt → 0.
 * - Always: expire triggers whose fired_count >= max_fires.
 *
 * Deliberate behavior preserved: sessions with `stopped_at === null`
 * (active/incomplete) are DROPPED on consolidation, exactly as the original
 * inline code did. Documented as INTENTIONAL so a maintainer does not "fix" it
 * into a regression.
 *
 * Does NOT write history / set last_sleep / call the task backend / touch disk.
 */
export function applyConsolidation(state: SleepState, epoch: string | null): ConsolidationResult {
  const next = cloneState(state);
  let sessionsProcessed = 0;
  let bookmarksProcessed = 0;
  let processedSessionIds: string[] = [];

  if (epoch) {
    const processedSessions = next.sessions.filter(s => !s.stopped_at || s.stopped_at <= epoch);
    sessionsProcessed = processedSessions.length;
    processedSessionIds = processedSessions.map(s => s.session_id);
    bookmarksProcessed = next.bookmarks.filter(b => b.created_at <= epoch).length;

    // Survivors: only sessions with a stopped_at strictly after the epoch.
    // Active sessions (stopped_at === null) are intentionally dropped (see docstring).
    next.sessions = next.sessions.filter(s => {
      if (!s.stopped_at) return false;
      return s.stopped_at > epoch;
    });
    next.bookmarks = next.bookmarks.filter(b => b.created_at > epoch);
    next.dashboard_changes = next.dashboard_changes.filter(c => c.timestamp > epoch);
    next.debt = recomputeDebt(next.sessions);
  } else {
    sessionsProcessed = next.sessions.length;
    processedSessionIds = next.sessions.map(s => s.session_id);
    bookmarksProcessed = next.bookmarks.length;
    next.sessions = [];
    next.bookmarks = [];
    next.dashboard_changes = [];
    next.debt = 0;
  }

  // Expire triggers past their fire budget.
  next.triggers = next.triggers.filter(t => t.fired_count < t.max_fires);

  return { state: next, sessionsProcessed, bookmarksProcessed, processedSessionIds };
}

// ─── Stop-hook re-stop dedupe (pure) ─────────────────────────────────────────

export interface StopUpsertInput {
  session_id: string;
  transcript_path: string | null;
  stopped_at: string;
  last_assistant_message: string | null;
  /** null = analysis pending: the transcript wasn't on disk at Stop time (Claude Code
   *  ≥2.1.x flushes it only on exit/rotation). The SessionStart catch-up finalizes. */
  change_count: number | null;
  tool_count: number | null;
  score: number | null;
  task_slugs: string[];
}

/**
 * Pure equivalent of the Stop-hook session upsert (re-stop dedupe).
 *
 * - If a session with the same session_id exists: subtract its old score
 *   (debt = max(0, debt - oldScore)), overwrite fields, merge task_slugs, then
 *   add the new score. Does NOT bump sessions_since_last_sleep (a re-stop is not
 *   a new session).
 * - Else: unshift the new session, debt += score, bump sessions_since_last_sleep.
 *
 * Returns a CLONE; the input state is not mutated.
 */
export function upsertSessionOnStop(state: SleepState, input: StopUpsertInput): SleepState {
  const next = cloneState(state);
  const existing = next.sessions.findIndex(s => s.session_id === input.session_id);

  if (existing >= 0) {
    const oldScore = next.sessions[existing].score ?? 0;
    next.debt = Math.max(0, next.debt - oldScore);
    const existingSlugs = next.sessions[existing].task_slugs ?? [];
    next.sessions[existing] = {
      ...next.sessions[existing],
      transcript_path: input.transcript_path,
      stopped_at: input.stopped_at,
      last_assistant_message: input.last_assistant_message,
      change_count: input.change_count,
      tool_count: input.tool_count,
      score: input.score,
      task_slugs: [...new Set([...existingSlugs, ...input.task_slugs])],
    };
    next.debt += input.score ?? 0;
  } else {
    next.sessions.unshift({
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      stopped_at: input.stopped_at,
      last_assistant_message: input.last_assistant_message,
      change_count: input.change_count,
      tool_count: input.tool_count,
      score: input.score,
      task_slugs: input.task_slugs,
    });
    next.debt += input.score ?? 0;
    next.sessions_since_last_sleep = (next.sessions_since_last_sleep || 0) + 1;
  }

  return next;
}

// ─── Compaction record (pure, LIFO cap 20) ───────────────────────────────────

const COMPACTION_LOG_CAP = 20;

/** Prepend a compaction record (LIFO), capping the log at 20 entries. Returns a clone. */
export function appendCompactionRecord(state: SleepState, record: CompactionRecord): SleepState {
  const next = cloneState(state);
  next.compaction_log.unshift(record);
  if (next.compaction_log.length > COMPACTION_LOG_CAP) {
    next.compaction_log = next.compaction_log.slice(0, COMPACTION_LOG_CAP);
  }
  return next;
}

// ─── sleep add validation (pure) ─────────────────────────────────────────────

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** Validate `sleep add <score> <description>` inputs. Score must be 1..3, desc non-empty. */
export function validateSleepAdd(scoreStr: string, desc: string): ValidationResult {
  const score = parseInt(scoreStr, 10);
  if (isNaN(score) || score < 1 || score > 3) {
    return { ok: false, error: 'Score must be 1, 2, or 3.' };
  }
  if (!desc.trim()) {
    return { ok: false, error: 'Description is required.' };
  }
  return { ok: true };
}

// ─── Lifecycle helpers (pure) ────────────────────────────────────────────────

/** Stamp the consolidation epoch. Returns a clone with sleep_started_at set. */
export function markSleepStarted(state: SleepState, nowISO: string): SleepState {
  const next = cloneState(state);
  next.sleep_started_at = nowISO;
  return next;
}

/**
 * After this long, an in-progress consolidation lock is treated as STALE — the
 * owning session almost certainly crashed or was killed before reaching
 * `sleep done` (which clears the epoch). A stale lock may be reclaimed by a new
 * `sleep start` without `--force`, so a single crashed sleep can never wedge the
 * brain permanently. Real consolidations finish in well under this window.
 */
export const SLEEP_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Stale TTL for the short-lived `sleep start` STAMP lock — the cross-process
 * mutex held only while one `sleep start` reads state, runs migrations, and
 * stamps the epoch (normally well under a second; released on exit). It exists
 * solely to close the check-then-stamp race between two simultaneous starts, so
 * its TTL is small: if a `sleep start` crashes mid-stamp, the next one reclaims
 * the stamp lock after this window rather than the 30m consolidation window.
 */
export const SLEEP_START_LOCK_STALE_MS = 60 * 1000; // 60 seconds

export interface SleepLockStatus {
  /** A consolidation epoch is pinned — a sleep is (or claims to be) in progress. */
  locked: boolean;
  /** ISO timestamp the lock was taken, or null when not locked. */
  startedAt: string | null;
  /** Age of the lock in ms (0 when not locked; Infinity when the stamp is unparseable). */
  ageMs: number;
  /** Locked but older than SLEEP_LOCK_STALE_MS — safe to reclaim. */
  stale: boolean;
}

/**
 * Inspect the consolidation lock held in a SleepState. `sleep_started_at` IS the
 * lock: `sleep start` stamps it, `sleep done` clears it back to null. Pure;
 * `nowMs` is injected so callers (CLI, server) and tests stay deterministic.
 */
export function inspectSleepLock(state: SleepState, nowMs: number): SleepLockStatus {
  const startedAt = state.sleep_started_at;
  if (!startedAt) return { locked: false, startedAt: null, ageMs: 0, stale: false };
  const startedMs = Date.parse(startedAt);
  const ageMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : Infinity;
  return { locked: true, startedAt, ageMs, stale: ageMs >= SLEEP_LOCK_STALE_MS };
}

/** Build a sleep-history entry from the consolidation result and summary. */
export function buildHistoryEntry(
  prevDebt: number,
  result: ConsolidationResult,
  summary: string,
  today: string,
): SleepHistoryEntry {
  return {
    date: today,
    consolidated_at: new Date().toISOString(),
    summary: summary.trim(),
    debt_before: prevDebt,
    debt_after: result.state.debt,
    sessions_processed: result.sessionsProcessed,
    bookmarks_processed: result.bookmarksProcessed,
    session_ids: result.processedSessionIds,
  };
}

/**
 * Finalize the post-consolidation state: stamp last_sleep / last_sleep_summary,
 * clear the epoch, reset the rhythm counter, and reset consolidation_depth to
 * null (no stale-depth bleed into the next cycle). Returns a clone.
 */
export function finalizeSleepState(state: SleepState, summary: string, today: string): SleepState {
  const next = cloneState(state);
  next.last_sleep = today;
  next.last_sleep_summary = summary.trim();
  next.sleep_started_at = null;
  next.sessions_since_last_sleep = 0;
  next.consolidation_depth = null;
  return next;
}

// ─── internal ────────────────────────────────────────────────────────────────

/** Deep-enough clone so mutations on the result never alias the input. */
function cloneState(state: SleepState): SleepState {
  return {
    ...state,
    sessions: state.sessions.map(s => ({ ...s, task_slugs: [...(s.task_slugs ?? [])] })),
    bookmarks: state.bookmarks.map(b => ({ ...b })),
    triggers: state.triggers.map(t => ({ ...t })),
    knowledge_access: { ...state.knowledge_access },
    dashboard_changes: state.dashboard_changes.map(c => ({ ...c })),
    compaction_log: state.compaction_log.map(c => ({ ...c })),
    pendingMigrationNotices: [...state.pendingMigrationNotices],
  };
}
