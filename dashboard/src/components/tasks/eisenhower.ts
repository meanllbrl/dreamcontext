import type { Task } from '../../hooks/useTasks';

/**
 * Pure Eisenhower-matrix logic — quadrant definitions + the drop→update mapping.
 *
 * Kept free of React/CSS imports so it can be unit-tested directly from the
 * node test suite (the root vitest config excludes `dashboard` from test
 * collection, but a test under tests/ can still import this module).
 */

/** Priority/urgency values that count as the "high" half of an axis. */
export const HIGH_VALUES: readonly string[] = ['critical', 'high'];

export function isHigh(value: string): boolean {
  return HIGH_VALUES.includes(value);
}

export type QuadrantKey = 'do' | 'schedule' | 'delegate' | 'eliminate';

export interface Quadrant {
  key: QuadrantKey;
  label: string;
  subtitle: string;
  colorVar: string;
  /** Quadrant requires a high-priority task. */
  priorityHigh: boolean;
  /** Quadrant requires a high-urgency task. */
  urgencyHigh: boolean;
}

export const QUADRANTS: Quadrant[] = [
  {
    key: 'do',
    label: 'Do First',
    subtitle: 'Important & Urgent',
    colorVar: '--color-quadrant-do',
    priorityHigh: true,
    urgencyHigh: true,
  },
  {
    key: 'schedule',
    label: 'Schedule',
    subtitle: 'Important & Not Urgent',
    colorVar: '--color-quadrant-schedule',
    priorityHigh: true,
    urgencyHigh: false,
  },
  {
    key: 'delegate',
    label: 'Delegate',
    subtitle: 'Less Important & Urgent',
    colorVar: '--color-quadrant-delegate',
    priorityHigh: false,
    urgencyHigh: true,
  },
  {
    key: 'eliminate',
    label: "Don't Do",
    subtitle: 'Less Important & Not Urgent',
    colorVar: '--color-quadrant-eliminate',
    priorityHigh: false,
    urgencyHigh: false,
  },
];

/** Which quadrant a task currently lives in, based on its priority + urgency. */
export function quadrantOf(task: Pick<Task, 'priority' | 'urgency'>): QuadrantKey {
  const p = isHigh(task.priority);
  const u = isHigh(task.urgency);
  if (p && u) return 'do';
  if (p && !u) return 'schedule';
  if (!p && u) return 'delegate';
  return 'eliminate';
}

/**
 * The minimal change to land `current` in the target half of an axis.
 *
 * Preserves granularity within a bucket: a task already `critical` stays
 * `critical` when dropped into a high bucket; a `low` task stays `low` in a
 * low bucket. Promotion into the high bucket lands on `high`; demotion into
 * the low bucket lands on `medium`. Returns `null` when no change is needed.
 */
export function bucketValue(targetHigh: boolean, current: string): Task['priority'] | null {
  if (targetHigh && !isHigh(current)) return 'high';
  if (!targetHigh && isHigh(current)) return 'medium';
  return null;
}

export type TaskMove = Partial<Pick<Task, 'priority' | 'urgency'>>;

/**
 * Compute the minimal priority/urgency update to move `task` into `quadrantKey`.
 * Returns an empty object when the task is already in that quadrant (no-op drop).
 */
export function computeMove(
  task: Pick<Task, 'priority' | 'urgency'>,
  quadrantKey: QuadrantKey,
): TaskMove {
  const q = QUADRANTS.find((x) => x.key === quadrantKey);
  if (!q) return {};
  const move: TaskMove = {};
  const priority = bucketValue(q.priorityHigh, task.priority);
  const urgency = bucketValue(q.urgencyHigh, task.urgency);
  if (priority) move.priority = priority;
  if (urgency) move.urgency = urgency as Task['urgency'];
  return move;
}

/** Whether a drop would actually change anything. */
export function isNoOpMove(move: TaskMove): boolean {
  return !move.priority && !move.urgency;
}

/**
 * Human-readable summary of a move's field changes, e.g.
 * `priority → high · urgency → high`. Empty string for a no-op move.
 */
export function summarizeMove(move: TaskMove): string {
  const parts: string[] = [];
  if (move.priority) parts.push(`priority → ${move.priority}`);
  if (move.urgency) parts.push(`urgency → ${move.urgency}`);
  return parts.join(' · ');
}
