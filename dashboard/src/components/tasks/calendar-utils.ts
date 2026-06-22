import type { Task } from '../../hooks/useTasks';

/** Status → CSS color var, shared across the time-axis task views. */
export const STATUS_COLOR_VAR: Record<Task['status'], string> = {
  todo: '--color-status-todo',
  in_progress: '--color-status-in-progress',
  in_review: '--color-status-in-review',
  completed: '--color-status-completed',
};

export const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Mon-first weekday labels (matches MiniCalendar). */
export const WEEKDAY_SHORT = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-time ISO date (YYYY-MM-DD) for a Date — never UTC-shifts the day. */
export function formatISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(): string {
  return formatISO(new Date());
}

/** Parse a YYYY-MM-DD (or longer ISO) string into a local-midnight Date. */
export function parseISO(s: string): Date {
  return new Date(s.slice(0, 10) + 'T00:00:00');
}

/** Date-part of any frontmatter timestamp (created_at/updated_at may carry time). */
export function dateOf(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const slice = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slice)) return null;
  // The regex only checks digit shape, not calendar validity — reject things
  // like "2026-13-45" so they can't become phantom keys that inflate stats.
  return Number.isNaN(new Date(slice + 'T00:00:00').getTime()) ? null : slice;
}

export function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

/** Whole days from a → b (b - a). Both treated as local midnight. */
export function diffDays(aISO: string, bISO: string): number {
  return Math.round((parseISO(bISO).getTime() - parseISO(aISO).getTime()) / 86_400_000);
}

/** Monday-first index (Mon=0 … Sun=6) for a JS getDay(). */
export function isoWeekday(d: Date): number {
  const day = d.getDay();
  return day === 0 ? 6 : day - 1;
}

/**
 * The [start, end] span a task occupies on the timeline.
 *
 * The task model carries a single `due_date` (no explicit start yet — that is a
 * separate in-progress feature). Until a real `start_date` lands, we derive the
 * span from what we have: the bar runs from the creation day up to the due day.
 * When a `start_date` field is added to the model, prefer it here in one place.
 *
 * Returns null for unscheduled tasks (no due date) — callers tray them off.
 */
export function taskSpan(task: Task): { start: string; end: string; overdue: boolean } | null {
  const due = dateOf(task.due_date);
  if (!due) return null;
  // Defensive: pick up a future `start_date` field if the model gains one.
  const explicitStart = dateOf((task as { start_date?: string | null }).start_date);
  const created = dateOf(task.created_at);
  const candidate = explicitStart ?? created ?? due;
  // Start can never be after the due date — clamp to a single-day marker.
  const start = candidate <= due ? candidate : due;
  const overdue = task.status !== 'completed' && due < todayISO();
  return { start, end: due, overdue };
}
