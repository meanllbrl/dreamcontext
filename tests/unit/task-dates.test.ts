import { describe, it, expect } from 'vitest';
import { windowDays, dueDateAfterStartMove, dateUpdatesForStatus } from '../../src/lib/task-dates.js';

/**
 * The shared date-window rules. A start that moves past its due date must
 * RESCHEDULE that due date (preserving the window's length) rather than leave
 * the task in an invalid start>due state that every later edit then rejects,
 * and reaching `completed` must record the real end of the work.
 */
describe('windowDays', () => {
  it('counts the calendar days between the two ends', () => {
    expect(windowDays('2026-08-01', '2026-08-06')).toBe(5);
    expect(windowDays('2026-08-01', '2026-08-01')).toBe(0);
  });

  it('spans a month and a DST boundary without drifting', () => {
    expect(windowDays('2026-01-15', '2026-02-15')).toBe(31);
    expect(windowDays('2026-03-01', '2026-04-01')).toBe(31);
  });

  it('is 0 for an undated or already-inverted window', () => {
    expect(windowDays(null, '2026-08-06')).toBe(0);
    expect(windowDays('2026-08-01', null)).toBe(0);
    expect(windowDays('2026-08-10', '2026-08-01')).toBe(0);
  });
});

describe('dueDateAfterStartMove', () => {
  it('leaves a due date that still holds exactly where it is', () => {
    expect(dueDateAfterStartMove('2026-08-01', '2026-08-20', '2026-08-05')).toBeNull();
    // Landing ON the due date is still a valid (zero-length) window.
    expect(dueDateAfterStartMove('2026-08-01', '2026-08-20', '2026-08-20')).toBeNull();
  });

  it('pushes a passed due date far enough to preserve the window length', () => {
    // A 5-day job that starts 9 days late is still a 5-day job.
    expect(dueDateAfterStartMove('2026-08-01', '2026-08-06', '2026-08-10')).toBe('2026-08-15');
  });

  it('collapses to the new start when there was no start to measure from', () => {
    // The auto-stamp case: nothing to preserve, so the due date lands on the
    // earliest value that is no longer invalid.
    expect(dueDateAfterStartMove(null, '2026-08-06', '2026-08-13')).toBe('2026-08-13');
  });

  it('does nothing when either end is missing or malformed', () => {
    expect(dueDateAfterStartMove('2026-08-01', null, '2026-08-10')).toBeNull();
    expect(dueDateAfterStartMove('2026-08-01', '2026-08-06', null)).toBeNull();
    expect(dueDateAfterStartMove('2026-08-01', '2026-13-40', '2026-08-10')).toBeNull();
  });
});

describe('dateUpdatesForStatus', () => {
  it('stamps the real start on the first in_progress', () => {
    expect(dateUpdatesForStatus('in_progress', { start_date: null, due_date: null }, '2026-08-13'))
      .toEqual({ start_date: '2026-08-13' });
  });

  it('reschedules a due date the stamped start would have invalidated', () => {
    // The reported bug: a task with a past due date used to land at start>due
    // and then reject every later edit.
    expect(dateUpdatesForStatus('in_progress', { start_date: null, due_date: '2026-08-10' }, '2026-08-13'))
      .toEqual({ start_date: '2026-08-13', due_date: '2026-08-13' });
  });

  it('leaves a still-valid due date alone when stamping the start', () => {
    expect(dateUpdatesForStatus('in_progress', { start_date: null, due_date: '2026-09-01' }, '2026-08-13'))
      .toEqual({ start_date: '2026-08-13' });
  });

  it('never overwrites a planned start', () => {
    expect(dateUpdatesForStatus('in_progress', { start_date: '2026-07-01', due_date: '2026-07-10' }, '2026-08-13'))
      .toEqual({});
  });

  it('stamps the real end on completed, overwriting the planned due date', () => {
    expect(dateUpdatesForStatus('completed', { start_date: '2026-08-01', due_date: '2026-09-01' }, '2026-08-13'))
      .toEqual({ due_date: '2026-08-13' });
  });

  it('gives a never-started task today at BOTH ends', () => {
    // No start on a finished task means it went not-started → done in one move.
    expect(dateUpdatesForStatus('completed', { start_date: null, due_date: null }, '2026-08-13'))
      .toEqual({ start_date: '2026-08-13', due_date: '2026-08-13' });
    // …and the start is still stamped when the due date already reads today.
    expect(dateUpdatesForStatus('completed', { start_date: null, due_date: '2026-08-13' }, '2026-08-13'))
      .toEqual({ start_date: '2026-08-13' });
  });

  it('writes nothing when the window already matches the completion date', () => {
    expect(dateUpdatesForStatus('completed', { start_date: '2026-08-13', due_date: '2026-08-13' }, '2026-08-13'))
      .toEqual({});
  });

  it('clamps the stamped end to a future planned start rather than inverting', () => {
    expect(dateUpdatesForStatus('completed', { start_date: '2026-09-01', due_date: null }, '2026-08-13'))
      .toEqual({ due_date: '2026-09-01' });
  });

  it('never emits an inverted window from any status transition', () => {
    const windows = [
      { start_date: null, due_date: null },
      { start_date: null, due_date: '2026-01-01' },
      { start_date: '2026-01-01', due_date: '2026-01-05' },
      { start_date: '2026-12-01', due_date: null },
      { start_date: '2026-12-01', due_date: '2026-12-31' },
      { start_date: '2026-05-01', due_date: '2026-01-01' }, // already-corrupt legacy row
    ];
    for (const w of windows) {
      for (const status of ['todo', 'in_progress', 'in_review', 'completed']) {
        const out = dateUpdatesForStatus(status, w, '2026-08-13');
        const start = out.start_date ?? w.start_date;
        const due = out.due_date ?? w.due_date;
        // Only assert on windows this transition actually touched — a legacy
        // start>due row it declines to rewrite stays as broken as it was.
        if (Object.keys(out).length > 0 && start && due) {
          expect(start <= due, `${status} on ${JSON.stringify(w)} → ${start}..${due}`).toBe(true);
        }
      }
    }
  });

  it('leaves todo and in_review untouched', () => {
    for (const status of ['todo', 'in_review']) {
      expect(dateUpdatesForStatus(status, { start_date: null, due_date: '2026-08-01' }, '2026-08-13')).toEqual({});
    }
  });
});
