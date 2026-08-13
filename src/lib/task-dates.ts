/**
 * Task date-range arithmetic — the ONE place that decides how a task's
 * `start_date` → `due_date` window reacts when one end moves or a status
 * transition records real-world timing.
 *
 * Every surface that can move a date (CLI `tasks start` / `tasks status` /
 * `tasks complete`, the dashboard PATCH route, and therefore the Gantt drag and
 * the detail-panel pickers) routes through here, so the rules can't drift
 * between clients and a remote backend never receives an invalid range.
 *
 * The rules:
 *
 *  1. Moving the START never rewrites a due date that still holds. The due date
 *     only moves when the new start would land AFTER it — and then it is pushed
 *     just far enough to preserve the window's original length. This is what
 *     turns the old "start_date cannot be after due_date" rejection into a
 *     silent, correct reschedule.
 *  2. Entering `in_progress` stamps the real start (first time only — a planned
 *     start is never overwritten), and rule 1 applies to that stamp.
 *  3. Reaching `completed` stamps the real end: `due_date` becomes the
 *     completion date, so the timeline shows what actually happened rather than
 *     what was planned.
 */

/** True for a real calendar date in YYYY-MM-DD form (rejects e.g. 2026-13-40). */
export function isCalendarDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** UTC midnight for a YYYY-MM-DD — parsing at UTC keeps arithmetic DST-proof. */
function toUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

const MS_PER_DAY = 86_400_000;

/** `date` shifted by `days`, back as YYYY-MM-DD. */
function addDays(date: string, days: number): string {
  return new Date(toUtcMs(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Length of a start→due window in days. Undated or inverted (already-corrupt)
 * windows count as 0 so a repair can never widen a broken range.
 */
export function windowDays(start: unknown, due: unknown): number {
  if (!isCalendarDate(start) || !isCalendarDate(due)) return 0;
  return Math.max(0, Math.round((toUtcMs(due) - toUtcMs(start)) / MS_PER_DAY));
}

/**
 * The due date implied by moving a task's start to `nextStart`, or `null` when
 * the due date must stay where it is.
 *
 * Returns a date ONLY on collision — i.e. when the new start would sit after
 * the current due — and then preserves the original window length, so a task
 * planned as a 5-day job stays a 5-day job when it starts late. A task that had
 * no start yet has no window to preserve, so its due date lands on the new
 * start (the earliest date that is no longer invalid).
 */
export function dueDateAfterStartMove(
  prevStart: unknown,
  prevDue: unknown,
  nextStart: unknown,
): string | null {
  if (!isCalendarDate(nextStart) || !isCalendarDate(prevDue)) return null;
  if (nextStart <= prevDue) return null;
  return addDays(nextStart, windowDays(prevStart, prevDue));
}

/** The subset of a task this module needs to reason about its date window. */
export interface TaskDateWindow {
  start_date?: string | null;
  due_date?: string | null;
}

/** Date fields a transition wants written. Empty when nothing should change. */
export interface TaskDateUpdates {
  start_date?: string;
  due_date?: string;
}

/**
 * Whether moving a task to `newStatus` should auto-stamp its actual start date.
 * Rule: the FIRST time a task enters `in_progress` with no `start_date` yet, we
 * record today as the real start. An already-set (explicitly planned) start is
 * never overwritten, and no other transition stamps anything — so this only ever
 * captures a previously-unrecorded start.
 */
export function shouldStampStartDate(newStatus: string, currentStart: string | null | undefined): boolean {
  return newStatus === 'in_progress' && !currentStart;
}

/**
 * The date-field writes a status transition implies — the single helper the CLI
 * and the dashboard route both call so `in_progress` and `completed` behave
 * identically whichever surface drove the change.
 *
 * `in_progress` stamps the real start and reschedules a now-impossible due date;
 * `completed` stamps the real end. Completing a task whose start is still in the
 * future clamps the end to that start rather than writing an inverted window.
 */
export function dateUpdatesForStatus(
  newStatus: string,
  current: TaskDateWindow | null | undefined,
  now: string,
): TaskDateUpdates {
  const start = current?.start_date ?? null;
  const due = current?.due_date ?? null;

  if (shouldStampStartDate(newStatus, start)) {
    const shifted = dueDateAfterStartMove(start, due, now);
    return { start_date: now, ...(shifted ? { due_date: shifted } : {}) };
  }

  if (newStatus === 'completed') {
    const end = isCalendarDate(start) && start > now ? start : now;
    return end === due ? {} : { due_date: end };
  }

  return {};
}
