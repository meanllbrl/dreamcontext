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
  /** True when this session's score was finalized in BULK by a SessionStart
   *  catch-up, not at Stop time. Absent on pre-v0.19.0 records → falsy, so
   *  `catchupDebtSplit` treats legacy history as 100% organic (no cap). */
  catchup_finalized?: boolean;
  /** NOVEL tokens the session consumed — `output + cache_creation + input`,
   *  summed over the main transcript AND its sub-agents. Deliberately EXCLUDES
   *  `cache_read_input_tokens` (see `novelTokensFromUsage` in hook.ts).
   *  Absent on records scored before the weighted scorer landed. */
  novel_tokens?: number;
  /** Scoring generation that produced `score`. Absent/1 = the legacy 0–3
   *  `max(change, tool, substance)` scale; 2 = the weighted 0–10 scorer. Read by
   *  the rescale migration so it can never double-apply. */
  scoring_version?: number;
}

/** Current scoring generation stamped onto every newly-scored session. */
export const SCORING_VERSION = 2;

export interface Bookmark {
  id: string;
  message: string;
  salience: 1 | 2 | 3;
  created_at: string;
  session_id: string | null;
  task_slug: string | null;
  /** Marks an auto-captured bookmark (structural salience detector) as opposed
   *  to an explicit user bookmark. Absent/false = explicit. */
  capture?: true;
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
  /**
   * ISO timestamp of the last successfully completed consolidation. The
   * consumption boundary for automation outputs (see
   * `src/lib/automations/consumption.ts`'s `pendingOutputsSince`) — the ONLY
   * field on this state that survives a cycle at millisecond granularity:
   * `sleep_started_at` is a LOCK cleared back to null by `finalizeSleepState`
   * at the end of every cycle, and `last_sleep` is a bare `YYYY-MM-DD` date,
   * too coarse to bound an incremental read (a second sleep on the same day
   * would re-surface the whole day's outputs). `null` means no cycle has ever
   * completed, which means consume nothing — the first completed `sleep done`
   * stamps this and every cycle after is exact; no output is lost
   * permanently, since everything written after that first stamp is consumed
   * normally. Old `.sleep.json` files back-fill to null via freshDefaults,
   * same convention as `consolidation_depth` above.
   */
  last_consolidated_at: string | null;
  sessions_since_last_sleep: number;
  sessions: SessionRecord[];
  bookmarks: Bookmark[];
  triggers: Trigger[];
  knowledge_access: Record<string, KnowledgeAccessRecord>;
  dashboard_changes: DashboardChange[];
  compaction_log: CompactionRecord[];
  recall_mode: 'haiku' | 'raw' | 'hybrid' | 'off';
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
 * Maximum debt ONE session can contribute (`scoreSession`, `hook.ts`).
 *
 * **[2026-07-29]** Raised 3 → 10 alongside the weighted-sum rescoring. The old
 * ceiling was the scale's defining defect: measured over 395 real transcripts,
 * **77% of sessions scored exactly 3** — the median session sat AT the ceiling,
 * so a 42-edit/155-tool session and a 13-edit/103-tool one were indistinguishable
 * and debt degenerated into `3 × session count`. At 10, with log-compressed
 * weighted components, the same corpus spreads p10=1 · p50=5 · p90=9 and only
 * 1.5% reach the ceiling.
 *
 * Scores are INTEGERS (`scoreSession` rounds): debt stays integral everywhere,
 * so no float drift in `recomputeDebt` and no display/JSON churn.
 */
export const SESSION_SCORE_MAX = 10;

/**
 * Debt thresholds (the ENTRY point of each level), and the rhythm reminder.
 *
 * **[2026-07-29]** Calibrated against DAILY WORK VOLUME, not per-session cadence.
 *
 * The first pass of this rescale set Must Sleep so the number of sessions
 * between sleeps matched the observed history — which silently preserved the
 * real problem, because that history was already consolidating far too often
 * (2–3 sleeps a day, sometimes within the same hour). Measured over 30 real days
 * of this project under the weighted scorer, DAILY accrued debt is
 * p25 12 · p50 42 · p75 107 · p90 168 · max 185. At a Must Sleep of 30 the
 * busiest day would have demanded **six** consolidations.
 *
 * Must Sleep = 60 is picked directly off that distribution:
 *
 *   median day (42)  → 0 required sleeps (Sleepy advisory only — the user decides)
 *   p75 day   (107)  → 1
 *   p90 day   (168)  → 2
 *   busiest   (185)  → 3   ← the intended ceiling
 *
 * Drowsy and Sleepy hold the same 0.4 / 0.67 proportions they had, so the ladder
 * still reads as one scale. A threshold alone cannot bound the INTERVAL between
 * sleeps (a burst can stack three in an afternoon), so `SLEEP_COOLDOWN_MS`
 * enforces the time floor — the two together are what cap consolidation at ~3/day.
 *
 * These are the SINGLE SOURCE OF TRUTH — `sleepinessLevel`, `sleepinessRange`,
 * `depthFromDebt`, and every hook directive/reminder derive from them, so the
 * scale never drifts across files again.
 * Levels: Alert 0–23 · Drowsy 24–39 · Sleepy 40–59 · Must Sleep 60+.
 */
export const DEBT_DROWSY = 24;      // ≥ this: offer to consolidate after the current task
export const DEBT_SLEEPY = 40;      // ≥ this: consolidation recommended
export const DEBT_MUST_SLEEP = 60;  // ≥ this: consolidation required (Must Sleep)

/**
 * Debt at which `depthFromDebt` authorizes 'deep' — and with it DESTRUCTIVE
 * knowledge ops (merge-with-delete, summarize-and-replace, archive/delete; see
 * `isDestructiveAllowed`).
 *
 * **[2026-07-29]** Split OFF the level boundary. It used to BE `DEBT_MUST_SLEEP`,
 * which made the cycle carrying the MOST unconsolidated material automatically
 * receive the MOST destructive authority — 16/89 cycles started at Must Sleep and
 * the three sleeps before this change (32/21/21) were all auto-deep. AC4's
 * catch-up cap treated one symptom (bulk-arrived debt) but left the root coupling
 * intact. Deliberately 1.5 × Must Sleep: "consolidation is overdue" (30 ≈ 6
 * typical sessions) and "you may delete things" (45 ≈ 9) are different claims and
 * now need different amounts of evidence. A user `--deep` still overrides.
 */
export const DEBT_DEEP_AUTHORITY = 90;

/**
 * Sessions-since-last-sleep that trips the rhythm reminder (independent of debt).
 *
 * **[2026-07-29]** 5 → 12. Rhythm exists to catch the "lots of tiny sessions"
 * case that a saturating scorer under-weighted — but real active days here run
 * 24–40 sessions, so at 5 it fired half a dozen times a day and was a large part
 * of the nagging. The weighted scorer already prices small sessions honestly
 * (12 light sessions ≈ 24 debt = Drowsy on its own), so rhythm can be a genuine
 * backstop instead of the primary nag.
 */
export const RHYTHM_SESSIONS = 12;

// ─── Post-consolidation cooldown ─────────────────────────────────────────────

/**
 * Minimum wall-clock gap between one COMPLETED consolidation and the next time
 * the hooks are allowed to demand another.
 *
 * Thresholds bound how much work a sleep is worth; they cannot bound how close
 * together two sleeps land. A heavy afternoon can cross Must Sleep three times
 * in three hours, which is the "every 30 minutes" failure mode — the debt
 * arithmetic is right and the experience is still wrong. This is the time floor:
 * three hours after `last_consolidated_at`, no directive asks again.
 *
 * Three hours is chosen so a full active day admits at most ~3 consolidations,
 * matching what the debt thresholds independently target — the two mechanisms
 * agree on the ceiling rather than one quietly overriding the other.
 *
 * Deliberately keyed to `last_consolidated_at` (millisecond ISO, stamped by
 * `finalizeSleepState`) and NOT to `last_sleep` (a bare `YYYY-MM-DD`, far too
 * coarse) or `sleep_started_at` (a LOCK, cleared at the end of every cycle).
 */
export const SLEEP_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * Debt at which the cooldown is bypassed — an escape hatch, not a normal path.
 *
 * A cooldown that can never be overridden is a cooldown that can lose work: a
 * genuinely enormous burst would sit unconsolidated for the full window. At 2×
 * Must Sleep this needs ~120 debt inside three hours; the busiest day ever
 * measured here accrued 185 across a whole working day (≈18/hour, so ≈55 in
 * three hours), which is why this should essentially never fire in practice.
 * That is the point — if it does fire, something truly exceptional happened.
 */
export const DEBT_COOLDOWN_OVERRIDE = DEBT_MUST_SLEEP * 2;

export interface SleepCooldownStatus {
  /** A completed consolidation is recent enough that directives must stay quiet. */
  active: boolean;
  /** ms remaining until the window expires (0 when there is no live window). */
  remainingMs: number;
  /** Inside the window, but debt reached DEBT_COOLDOWN_OVERRIDE — directives fire. */
  overridden: boolean;
}

/**
 * Inspect the post-consolidation cooldown. Pure; `nowMs` and `debt` are injected
 * so callers (hook, CLI, tests) stay deterministic.
 *
 * Never active when: no cycle has ever completed (`last_consolidated_at` null,
 * e.g. a fresh brain or one that predates the field), the stamp is unparseable,
 * or the stamp is in the FUTURE (clock skew / an edited state file). Every one of
 * those degrades to "no cooldown", so a bad timestamp can only ever make the
 * brain nag as it did before — never silence it indefinitely.
 */
export function inspectSleepCooldown(
  state: Pick<SleepState, 'last_consolidated_at'>,
  nowMs: number,
  debt: number,
): SleepCooldownStatus {
  const stamp = state.last_consolidated_at;
  if (!stamp) return { active: false, remainingMs: 0, overridden: false };
  const doneMs = Date.parse(stamp);
  if (!Number.isFinite(doneMs)) return { active: false, remainingMs: 0, overridden: false };

  const elapsed = nowMs - doneMs;
  if (elapsed < 0 || elapsed >= SLEEP_COOLDOWN_MS) {
    return { active: false, remainingMs: 0, overridden: false };
  }

  const remainingMs = SLEEP_COOLDOWN_MS - elapsed;
  if (debt >= DEBT_COOLDOWN_OVERRIDE) return { active: false, remainingMs, overridden: true };
  return { active: true, remainingMs, overridden: false };
}

/** `remainingMs` → a short human duration for directive text ("2h 5m", "18m"). */
export function formatCooldownRemaining(remainingMs: number): string {
  const totalMin = Math.max(1, Math.ceil(remainingMs / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Pending-session provisional debt (AC1) ──────────────────────────────────
// Claude Code's lazy transcript flush leaves un-analyzed sessions (`score ===
// null`) sitting at ZERO debt for hours — real work the ledger doesn't see yet.
// Provisional debt estimates that gap for DIRECTIVE/DISPLAY purposes only; it
// is NEVER written into `state.debt` (that stays the exact sum of finalized
// scores). Tuned BELOW the observed mean finalized score/session so the estimate
// under-reads reality rather than inflating it.

/**
 * Provisional debt credited per un-analyzed (score === null) session.
 *
 * **[2026-07-29]** 2 → 4, re-derived for `SESSION_SCORE_MAX = 10`. The old value
 * held the same ratio against the old scale (2 vs. a 2.9 mean ≈ 69%); the mean
 * session score measured over 395 real transcripts under the weighted scorer is
 * 5.38, and 69% of that is ≈ 3.7 → 4. Keeps the deliberate under-read.
 */
export const PENDING_SESSION_PROVISIONAL = 4;

/**
 * Hard cap on TOTAL provisional debt. 28 is deliberate: DEBT_DROWSY + 4 (the
 * same relationship it has always held to DEBT_DROWSY), and strictly below
 * DEBT_MUST_SLEEP — provisional debt ALONE can never produce a "CONSOLIDATION
 * REQUIRED" directive. Only real, finalized debt does that.
 */
export const PENDING_PROVISIONAL_CAP = 28;

/** Count sessions still awaiting analysis (score === null — pending finalization). */
export function countPendingSessions(sessions: SessionRecord[]): number {
  return sessions.reduce((count, s) => count + (s.score === null ? 1 : 0), 0);
}

export interface EffectiveDebt {
  /** state.debt, verbatim — NEVER mutated by this module. */
  persisted: number;
  /** Sessions with score === null. */
  pendingCount: number;
  /** min(PENDING_PROVISIONAL_CAP, PENDING_SESSION_PROVISIONAL * pendingCount). */
  provisional: number;
  /** persisted + provisional — what directives/reminders should threshold on. */
  effective: number;
}

/** Compute effective (persisted + provisional) debt for directive/display use. */
export function effectiveDebt(state: SleepState): EffectiveDebt {
  const persisted = state.debt;
  const pendingCount = countPendingSessions(state.sessions);
  const provisional = Math.min(PENDING_PROVISIONAL_CAP, PENDING_SESSION_PROVISIONAL * pendingCount);
  return { persisted, pendingCount, provisional, effective: persisted + provisional };
}

/**
 * Rhythm counter FLOOR: pending sessions always count toward "sessions since
 * last sleep", even before their score finalizes. `upsertSessionOnStop` already
 * bumps `sessions_since_last_sleep` for every new session regardless of score,
 * so this is a max() floor — it can raise the effective count, never lower it
 * below the persisted counter.
 */
export function effectiveRhythm(state: SleepState): number {
  return Math.max(state.sessions_since_last_sleep, countPendingSessions(state.sessions));
}

// ─── Transcript-less finalization floor (AC2) ────────────────────────────────

/** After this long, a never-flushed session is assumed lost (hard-killed tab,
 *  hand-cleaned ~/.claude) and finalized rather than left pending forever. */
export const NEVER_FLUSHED_FINALIZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Floor score for a session finalized WITHOUT ever seeing its transcript.
 *
 * **[2026-07-29]** 1 → 2, rescaled with `SESSION_SCORE_MAX` (3 → 10). Kept
 * deliberately far below the 5.38 mean: this is the "we know real work happened
 * but can prove nothing about its size" floor, so it should under-read.
 */
export const NEVER_FLUSHED_FLOOR_SCORE = 2;

/**
 * Score a session finalized at the 7-day mark with no transcript ever having
 * appeared. A non-empty `last_assistant_message` proves real work happened —
 * floor to NEVER_FLUSHED_FLOOR_SCORE (not 0) so that work isn't silently
 * dropped from the debt ledger. No message at all → genuinely nothing to score.
 */
export function floorScoreForNeverFlushed(message: string | null | undefined): number {
  return message && message.trim().length > 0 ? NEVER_FLUSHED_FLOOR_SCORE : 0;
}

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

/**
 * Debt → base consolidation depth. Alert → light; everything from Drowsy up to
 * `DEBT_DEEP_AUTHORITY` → standard; only past that → deep.
 *
 * **[2026-07-29]** The 'deep' boundary is `DEBT_DEEP_AUTHORITY` (45), NOT
 * `DEBT_MUST_SLEEP` (30) — see that constant for why the two were split.
 * "Consolidation is overdue" no longer implies "destructive ops are authorized".
 */
function depthFromDebt(debt: number): ConsolidationDepth {
  if (debt < DEBT_DROWSY) return 'light';
  if (debt < DEBT_DEEP_AUTHORITY) return 'standard';
  return 'deep';
}

/** The greater of two depths by DEPTH_ORDER position. Used by the catch-up cap
 *  to floor at 'standard' — never below what non-catch-up debt alone gives. */
function maxDepth(a: ConsolidationDepth, b: ConsolidationDepth): ConsolidationDepth {
  return DEPTH_ORDER[Math.max(DEPTH_ORDER.indexOf(a), DEPTH_ORDER.indexOf(b))];
}

// ─── Catch-up debt split (AC4) ────────────────────────────────────────────────

/** Share of current debt that must have arrived via catch-up before the
 *  auto-deep cap engages. Boundary is INCLUSIVE (ratio >= 0.5 caps). */
export const CATCHUP_DEEP_CAP_RATIO = 0.5;

export interface CatchupDebtSplit {
  /** Sum of all session scores (== recomputeDebt(sessions), scores only, no floor). */
  total: number;
  /** Sum of scores over sessions with catchup_finalized === true. */
  catchup: number;
  /** total - catchup. */
  organic: number;
  /** total > 0 ? catchup / total : 0 — never NaN. */
  ratio: number;
}

/** Split current session debt into catch-up-finalized vs. organic (Stop-time
 *  scored) portions. Legacy sessions (no `catchup_finalized` field) count as
 *  organic — pre-v0.19.0 history never triggers the cap. */
export function catchupDebtSplit(sessions: SessionRecord[]): CatchupDebtSplit {
  let total = 0;
  let catchup = 0;
  for (const s of sessions) {
    const score = s.score ?? 0;
    total += score;
    if (s.catchup_finalized) catchup += score;
  }
  const organic = total - catchup;
  const ratio = total > 0 ? catchup / total : 0;
  return { total, catchup, organic, ratio };
}

export interface DepthDecision {
  depth: ConsolidationDepth;
  reason: string;
  source: 'user' | 'agent' | 'debt';
  /** Present (true) only when the AC4 catch-up cap actually lowered the
   *  debt-derived base this cycle. Absent otherwise (never `false`). */
  cappedByCatchup?: true;
}

/**
 * Resolve the consolidation depth for a cycle.
 *
 * Precedence (highest wins): userRequestedDeep → [AC4 catch-up cap on the debt
 * base] → agentBump → debt base.
 * - `userRequestedDeep` forces UP to 'deep' (never lowers) — checked FIRST, so
 *   it always wins over the catch-up cap (existing precedence, unchanged).
 * - AC4 catch-up cap: when the debt base is 'deep' AND at least
 *   CATCHUP_DEEP_CAP_RATIO of current debt arrived via a single catch-up batch
 *   (`opts.catchup`), the base is floored down to
 *   max('standard', depthFromDebt(organic debt)). One-way: it can only PREVENT
 *   an auto-deep, never grant one, and never lowers below what non-catch-up
 *   debt alone would give (the max() floor). Absent `opts.catchup` (or debt 0,
 *   or base below 'deep', or ratio < threshold) → no-op, byte-identical to the
 *   pre-AC4 behavior.
 * - `agentBump` steps the (possibly capped) base up by N tiers. The bump is
 *   clamped INSIDE this function to 0..2, so a negative/garbage bump can only
 *   neutralize (never lower below the base) and an over-large bump caps at
 *   'deep'. Agent authority is independent of the catch-up cap: an agent can
 *   still bump a capped 'standard' back up to 'deep' (source stays 'agent').
 *
 * Monotonic & bounded by construction: depth never drops below the debt base
 * unless AC4's cap applies (and even then never below the organic-debt floor),
 * and never exceeds 'deep'.
 */
export function consolidationDepth(
  debt: number,
  opts: { userRequestedDeep?: boolean; agentBump?: number; catchup?: CatchupDebtSplit } = {},
): DepthDecision {
  const debtBase = depthFromDebt(debt);

  if (opts.userRequestedDeep) {
    return { depth: 'deep', reason: 'user requested deep consolidation', source: 'user' };
  }

  // AC4 — one-way cap. Only ever lowers a 'deep' debt base, and only down to
  // the organic-debt floor (never below it, never below 'standard').
  let base = debtBase;
  let cappedByCatchup = false;
  let capReason = '';
  const catchup = opts.catchup;
  if (catchup && debt > 0 && debtBase === 'deep' && catchup.ratio >= CATCHUP_DEEP_CAP_RATIO) {
    const organicBase = depthFromDebt(catchup.organic);
    const floor = maxDepth('standard', organicBase);
    if (floor !== base) {
      base = floor;
      cappedByCatchup = true;
      const pct = Math.round(catchup.ratio * 100);
      capReason = `, capped to ${base} (${pct}% of debt arrived via catch-up; non-catch-up debt ${catchup.organic} → ${organicBase})`;
    }
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
      ...(cappedByCatchup ? { cappedByCatchup: true as const } : {}),
    };
  }

  return {
    depth: base,
    reason: cappedByCatchup ? `debt ${debt} → deep${capReason}` : `debt ${debt} → ${base}`,
    source: 'debt',
    ...(cappedByCatchup ? { cappedByCatchup: true as const } : {}),
  };
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
  /** Absent when the transcript wasn't on disk (score pending) — the catch-up
   *  fills both once it finalizes. */
  novel_tokens?: number;
  scoring_version?: number;
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
      ...(input.novel_tokens !== undefined ? { novel_tokens: input.novel_tokens } : {}),
      ...(input.scoring_version !== undefined ? { scoring_version: input.scoring_version } : {}),
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
      ...(input.novel_tokens !== undefined ? { novel_tokens: input.novel_tokens } : {}),
      ...(input.scoring_version !== undefined ? { scoring_version: input.scoring_version } : {}),
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

/** Validate `sleep add <score> <description>` inputs. Score must be
 *  1..SESSION_SCORE_MAX (widened from 1..3 with the 2026-07-29 rescale so manual
 *  debt can express the same range the automatic scorer can), desc non-empty. */
export function validateSleepAdd(scoreStr: string, desc: string): ValidationResult {
  const score = parseInt(scoreStr, 10);
  if (isNaN(score) || score < 1 || score > SESSION_SCORE_MAX) {
    return { ok: false, error: `Score must be an integer from 1 to ${SESSION_SCORE_MAX}.` };
  }
  if (!desc.trim()) {
    return { ok: false, error: 'Description is required.' };
  }
  return { ok: true };
}

// ─── Legacy score rescale (0–3 → 0–10 migration) ─────────────────────────────

/**
 * Multiplier applied to legacy (0–3) session scores when migrating to the 0–10
 * scale. 3 maps the old ceiling (3) to 9 — just under the new ceiling, which is
 * honest: a legacy 3 means "at least 9 changes OR at least 41 tools", real work,
 * but the old scorer threw away everything above that so we cannot claim a 10.
 */
export const LEGACY_SCORE_RESCALE = 3;

export interface RescaleResult {
  state: SleepState;
  /** Number of session records whose score was multiplied. */
  rescaled: number;
  debtBefore: number;
  debtAfter: number;
}

/**
 * Migrate a `.sleep.json` written under the legacy 0–3 scale onto the 0–10 one.
 *
 * Without this, the rescale is a SILENT REGRESSION in the dangerous direction:
 * the thresholds move up (Must Sleep 20 → 30) while the stored scores stay
 * small, so an accumulated debt of 19 — "Sleepy, consolidate soon" the day
 * before — would read as "Drowsy" and defer a consolidation that is already due.
 *
 * Idempotent by construction: a session is rescaled only when its
 * `scoring_version` is absent (legacy). Every touched record is stamped
 * `SCORING_VERSION`, so re-running is a no-op. Sessions already scored by the
 * weighted scorer are left exactly as they are. Debt is RECOMPUTED from the
 * resulting scores rather than scaled independently, so it can't drift from the
 * ledger it is supposed to summarize. Returns a clone; input is not mutated.
 */
export function rescaleLegacySessions(state: SleepState): RescaleResult {
  const next = cloneState(state);
  const debtBefore = next.debt;
  const { sessions, rescaled } = rescaleLegacySessionRecords(next.sessions);
  next.sessions = sessions;
  next.debt = recomputeDebt(next.sessions);
  return { state: next, rescaled, debtBefore, debtAfter: next.debt };
}

/**
 * The rescale itself, over the session ARRAY alone.
 *
 * Split out from `rescaleLegacySessions` so the 0.23.0 migration can call it on
 * a raw parsed `.sleep.json` without importing `cli/commands/sleep.ts` — that
 * module transitively imports the migration registry, and closing that cycle
 * throws `Cannot access 'migration0230' before initialization` at load time.
 * Operating on the parsed object also means the migration rewrites ONLY
 * `sessions` and `debt`, leaving every other field byte-identical instead of
 * passing them through the state normalizer.
 *
 * Returns a new array; the input is not mutated.
 */
export function rescaleLegacySessionRecords(
  sessions: SessionRecord[],
): { sessions: SessionRecord[]; rescaled: number } {
  let rescaled = 0;
  const out = sessions.map(s => {
    if (s.scoring_version !== undefined) return s;          // already on the new scale
    if (s.score === null || s.score === undefined) {
      // Pending (never finalized) — nothing to rescale, and it must stay pending
      // so the catch-up sweep scores it with the NEW scorer from its transcript.
      return s;
    }
    rescaled++;
    return {
      ...s,
      score: Math.min(SESSION_SCORE_MAX, s.score * LEGACY_SCORE_RESCALE),
      scoring_version: SCORING_VERSION,
    };
  });
  return { sessions: out, rescaled };
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
 * Finalize the post-consolidation state: stamp last_sleep / last_sleep_summary
 * / last_consolidated_at, clear the epoch, reset the rhythm counter, and reset
 * consolidation_depth to null (no stale-depth bleed into the next cycle).
 * Returns a clone.
 *
 * `nowISO` is REQUIRED and must be injected by the caller — this function
 * never reads the wall clock itself, so it stays deterministic under test and
 * so no future caller can silently pick up non-injected time.
 */
export function finalizeSleepState(state: SleepState, summary: string, today: string, nowISO: string): SleepState {
  const next = cloneState(state);
  next.last_sleep = today;
  next.last_sleep_summary = summary.trim();
  next.sleep_started_at = null;
  next.last_consolidated_at = nowISO;
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
