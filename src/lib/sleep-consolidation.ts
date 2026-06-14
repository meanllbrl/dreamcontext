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

// ─── Sleepiness levels (verbatim from former private helpers) ────────────────

/** Human-readable sleepiness label for a debt value. */
export function sleepinessLevel(debt: number): 'Alert' | 'Drowsy' | 'Sleepy' | 'Must Sleep' {
  if (debt <= 3) return 'Alert';
  if (debt <= 6) return 'Drowsy';
  if (debt <= 9) return 'Sleepy';
  return 'Must Sleep';
}

/** Debt-range bucket label for a debt value. */
export function sleepinessRange(debt: number): '0-3' | '4-6' | '7-9' | '10+' {
  if (debt <= 3) return '0-3';
  if (debt <= 6) return '4-6';
  if (debt <= 9) return '7-9';
  return '10+';
}

/** Recompute total debt as the sum of session scores. */
export function recomputeDebt(sessions: SessionRecord[]): number {
  return sessions.reduce((sum, s) => sum + (s.score ?? 0), 0);
}

// ─── Consolidation depth ─────────────────────────────────────────────────────

const DEPTH_ORDER: ConsolidationDepth[] = ['light', 'standard', 'deep'];

/** Debt → base consolidation depth. Aligned to existing sleepiness thresholds. */
function depthFromDebt(debt: number): ConsolidationDepth {
  if (debt <= 3) return 'light';
  if (debt <= 9) return 'standard';
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
  change_count: number;
  tool_count: number;
  score: number;
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
    next.debt += input.score;
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
    next.debt += input.score;
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
