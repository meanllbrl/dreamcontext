import { describe, it, expect } from 'vitest';
import { shouldStampStartDate } from '../../src/cli/commands/tasks.js';

/**
 * Auto-stamping the real start date: the first time a task enters `in_progress`
 * with no start_date yet, the status command records today as the actual start.
 * An explicitly-planned start is never overwritten, and no other transition
 * stamps anything.
 */
describe('shouldStampStartDate', () => {
  it('stamps on first in_progress when start_date is unset', () => {
    expect(shouldStampStartDate('in_progress', null)).toBe(true);
    expect(shouldStampStartDate('in_progress', undefined)).toBe(true);
    expect(shouldStampStartDate('in_progress', '')).toBe(true);
  });

  it('never overwrites an already-set (planned) start_date', () => {
    expect(shouldStampStartDate('in_progress', '2026-01-01')).toBe(false);
  });

  it('does not stamp on any non-in_progress transition', () => {
    for (const status of ['todo', 'in_review', 'completed']) {
      expect(shouldStampStartDate(status, null)).toBe(false);
      expect(shouldStampStartDate(status, '2026-01-01')).toBe(false);
    }
  });
});
