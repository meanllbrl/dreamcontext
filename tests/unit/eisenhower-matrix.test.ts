import { describe, it, expect } from 'vitest';
import {
  isHigh,
  quadrantOf,
  bucketValue,
  computeMove,
  isNoOpMove,
  summarizeMove,
  QUADRANTS,
  type QuadrantKey,
} from '../../dashboard/src/components/tasks/eisenhower';

/**
 * Contract for the Eisenhower-matrix drag & drop (issue #7).
 *
 * Dragging a task onto a quadrant sets the *minimal* priority/urgency change
 * needed to land it in that quadrant's (high / not-high) bucket, while
 * preserving the task's granularity within a bucket — a `critical` task dropped
 * into a high bucket stays `critical`, not demoted to `high`.
 */

type PU = { priority: string; urgency: string };

describe('eisenhower: axis bucketing', () => {
  it('treats critical and high as the high half of an axis', () => {
    expect(isHigh('critical')).toBe(true);
    expect(isHigh('high')).toBe(true);
    expect(isHigh('medium')).toBe(false);
    expect(isHigh('low')).toBe(false);
  });
});

describe('eisenhower: quadrantOf', () => {
  const cases: Array<[PU, QuadrantKey]> = [
    [{ priority: 'critical', urgency: 'high' }, 'do'],
    [{ priority: 'high', urgency: 'medium' }, 'schedule'],
    [{ priority: 'low', urgency: 'critical' }, 'delegate'],
    [{ priority: 'medium', urgency: 'low' }, 'eliminate'],
  ];
  it.each(cases)('places %o in the %s quadrant', (task, expected) => {
    expect(quadrantOf(task)).toBe(expected);
  });

  it('has exactly four quadrants covering every bucket combination', () => {
    const combos = new Set(QUADRANTS.map(q => `${q.priorityHigh}/${q.urgencyHigh}`));
    expect(QUADRANTS).toHaveLength(4);
    expect(combos.size).toBe(4);
  });
});

describe('eisenhower: bucketValue (minimal axis change)', () => {
  it('promotes a low value into the high bucket as "high"', () => {
    expect(bucketValue(true, 'low')).toBe('high');
    expect(bucketValue(true, 'medium')).toBe('high');
  });

  it('demotes a high value into the low bucket as "medium"', () => {
    expect(bucketValue(false, 'critical')).toBe('medium');
    expect(bucketValue(false, 'high')).toBe('medium');
  });

  it('returns null when the value is already in the target bucket', () => {
    expect(bucketValue(true, 'critical')).toBeNull();
    expect(bucketValue(true, 'high')).toBeNull();
    expect(bucketValue(false, 'medium')).toBeNull();
    expect(bucketValue(false, 'low')).toBeNull();
  });
});

describe('eisenhower: computeMove (drop → task update)', () => {
  it('promotes both axes when moving a low/low task to "do"', () => {
    expect(computeMove({ priority: 'low', urgency: 'low' }, 'do')).toEqual({
      priority: 'high',
      urgency: 'high',
    });
  });

  it('preserves critical granularity when dropped into a high bucket', () => {
    // critical priority stays critical; only urgency is promoted to high.
    expect(computeMove({ priority: 'critical', urgency: 'low' }, 'do')).toEqual({
      urgency: 'high',
    });
  });

  it('demotes only the axis that needs it for "schedule" (high priority, low urgency)', () => {
    expect(computeMove({ priority: 'high', urgency: 'critical' }, 'schedule')).toEqual({
      urgency: 'medium',
    });
  });

  it('demotes priority but keeps low urgency for "eliminate"', () => {
    expect(computeMove({ priority: 'high', urgency: 'low' }, 'eliminate')).toEqual({
      priority: 'medium',
    });
  });

  it('is a no-op when the task already lives in the target quadrant', () => {
    expect(computeMove({ priority: 'critical', urgency: 'high' }, 'do')).toEqual({});
    expect(computeMove({ priority: 'low', urgency: 'low' }, 'eliminate')).toEqual({});
  });

  it('moves a do-task to delegate by demoting only priority', () => {
    expect(computeMove({ priority: 'high', urgency: 'high' }, 'delegate')).toEqual({
      priority: 'medium',
    });
  });
});

describe('eisenhower: drop-preview helpers', () => {
  it('isNoOpMove distinguishes an empty move from a real one', () => {
    expect(isNoOpMove({})).toBe(true);
    expect(isNoOpMove({ priority: 'high' })).toBe(false);
    expect(isNoOpMove({ urgency: 'medium' })).toBe(false);
  });

  it('summarizeMove renders only the fields that change', () => {
    expect(summarizeMove({ priority: 'high', urgency: 'high' })).toBe('priority → high · urgency → high');
    expect(summarizeMove({ urgency: 'medium' })).toBe('urgency → medium');
    expect(summarizeMove({})).toBe('');
  });

  it('previews the exact change for a low/low task dropped into "do"', () => {
    const move = computeMove({ priority: 'low', urgency: 'low' }, 'do');
    expect(isNoOpMove(move)).toBe(false);
    expect(summarizeMove(move)).toBe('priority → high · urgency → high');
  });
});
