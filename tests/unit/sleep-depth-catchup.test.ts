import { describe, it, expect } from 'vitest';
import {
  consolidationDepth,
  catchupDebtSplit,
  CATCHUP_DEEP_CAP_RATIO,
} from '../../src/lib/sleep-consolidation.js';
import type { SessionRecord } from '../../src/lib/sleep-consolidation.js';

/**
 * AC4 (catch-up debt spike never auto-authorizes deep) unit coverage
 * (improve-sleep-quality, T1). Pure functions only — no disk.
 */

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session_id: 's-1',
    transcript_path: null,
    stopped_at: null,
    last_assistant_message: null,
    change_count: null,
    tool_count: null,
    score: null,
    task_slugs: [],
    ...overrides,
  };
}

describe('catchupDebtSplit', () => {
  it('no sessions → all zero, ratio 0 (no divide-by-zero)', () => {
    expect(catchupDebtSplit([])).toEqual({ total: 0, catchup: 0, organic: 0, ratio: 0 });
  });

  it('splits scores by catchup_finalized', () => {
    const sessions = [
      session({ score: 12, catchup_finalized: true }),
      session({ score: 12, catchup_finalized: true }),
      session({ score: 12, catchup_finalized: false }),
      session({ score: 12 }),
    ];
    const split = catchupDebtSplit(sessions);
    expect(split.total).toBe(48);
    expect(split.catchup).toBe(24);
    expect(split.organic).toBe(24);
    expect(split.ratio).toBe(0.5);
  });

  it('legacy sessions (no catchup_finalized field) count as organic', () => {
    const sessions = [session({ score: 10 }), session({ score: 10 })];
    const split = catchupDebtSplit(sessions);
    expect(split.catchup).toBe(0);
    expect(split.organic).toBe(20);
    expect(split.ratio).toBe(0);
  });

  it('null scores contribute 0', () => {
    const sessions = [session({ score: null, catchup_finalized: true }), session({ score: 5 })];
    const split = catchupDebtSplit(sessions);
    expect(split.total).toBe(5);
    expect(split.catchup).toBe(0);
  });

  it('CATCHUP_DEEP_CAP_RATIO is 0.5 (inclusive threshold)', () => {
    expect(CATCHUP_DEEP_CAP_RATIO).toBe(0.5);
  });
});

describe('consolidationDepth — AC4 catch-up cap, boundary-exact', () => {
  it('debt 24, catchup 12/organic 12 (ratio exactly 0.5) → capped to standard', () => {
    const d = consolidationDepth(24, { catchup: { total: 24, catchup: 12, organic: 12, ratio: 0.5 } });
    expect(d.depth).toBe('standard');
    expect(d.source).toBe('debt');
    expect(d.cappedByCatchup).toBe(true);
  });

  it('debt 24, ratio 11/24 ≈ 0.458 (just below threshold) → no cap, stays deep', () => {
    const ratio = 11 / 24;
    const d = consolidationDepth(24, { catchup: { total: 24, catchup: 11, organic: 13, ratio } });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('debt');
    expect(d.cappedByCatchup).toBeUndefined();
  });

  it('debt 40, catchup 20/organic 20 (ratio 0.5) → organic alone is deep, so NEVER lowered', () => {
    const d = consolidationDepth(40, { catchup: { total: 40, catchup: 20, organic: 20, ratio: 0.5 } });
    expect(d.depth).toBe('deep');
    expect(d.cappedByCatchup).toBeUndefined();
  });

  it('debt 32, catchup 32/organic 0 (ratio 1.0) → floors at standard, NOT light', () => {
    const d = consolidationDepth(32, { catchup: { total: 32, catchup: 32, organic: 0, ratio: 1 } });
    expect(d.depth).toBe('standard');
    expect(d.cappedByCatchup).toBe(true);
  });

  it('--deep (userRequestedDeep) always wins over the cap', () => {
    const d = consolidationDepth(24, {
      userRequestedDeep: true,
      catchup: { total: 24, catchup: 12, organic: 12, ratio: 0.5 },
    });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('user');
  });

  it('debt 19 (base standard) with ratio 1.0 → cap is a no-op, stays standard', () => {
    const d = consolidationDepth(19, { catchup: { total: 19, catchup: 19, organic: 0, ratio: 1 } });
    expect(d.depth).toBe('standard');
    expect(d.cappedByCatchup).toBeUndefined();
  });

  it('debt 5 (base light) with ratio 1.0 → cap never applies to a light base', () => {
    const d = consolidationDepth(5, { catchup: { total: 5, catchup: 5, organic: 0, ratio: 1 } });
    expect(d.depth).toBe('light');
    expect(d.cappedByCatchup).toBeUndefined();
  });

  it('debt 0 with an all-zero catchup split → light, guarded against divide-by-zero', () => {
    const d = consolidationDepth(0, { catchup: { total: 0, catchup: 0, organic: 0, ratio: 0 } });
    expect(d.depth).toBe('light');
    expect(d.cappedByCatchup).toBeUndefined();
  });

  it('opts.catchup omitted → identical to pre-AC4 behavior across all debt levels (frozen-eval guard)', () => {
    for (const debt of [0, 7, 8, 13, 14, 19, 20, 32]) {
      const d = consolidationDepth(debt);
      expect(d.cappedByCatchup).toBeUndefined();
      expect(d.source).toBe('debt');
    }
    expect(consolidationDepth(0).depth).toBe('light');
    expect(consolidationDepth(8).depth).toBe('standard');
    expect(consolidationDepth(19).depth).toBe('standard');
    expect(consolidationDepth(20).depth).toBe('deep');
    expect(consolidationDepth(32).depth).toBe('deep');
  });

  it('all sessions lack catchup_finalized (legacy 89-cycle state) → ratio 0 → no cap', () => {
    const sessions: SessionRecord[] = [session({ score: 12 }), session({ score: 12 })];
    const split = catchupDebtSplit(sessions);
    const d = consolidationDepth(24, { catchup: split });
    expect(d.depth).toBe('deep');
    expect(d.cappedByCatchup).toBeUndefined();
  });

  it('agentBump 2 on a capped standard → deep, source "agent" (agent authority independent of the cap)', () => {
    const d = consolidationDepth(24, {
      agentBump: 2,
      catchup: { total: 24, catchup: 12, organic: 12, ratio: 0.5 },
    });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('agent');
  });

  it('decision.reason names the ratio and the organic base when capped', () => {
    const d = consolidationDepth(24, { catchup: { total: 24, catchup: 12, organic: 12, ratio: 0.5 } });
    expect(d.reason).toContain('50%');
    expect(d.reason).toContain('12');
    expect(d.reason).toContain('standard');
  });
});

describe('consolidationDepth — end-to-end via catchupDebtSplit(sessions)', () => {
  it('bulk catch-up scenario: 60% of debt arrived via catch-up (organic alone is standard) → capped to standard', () => {
    const sessions: SessionRecord[] = [
      session({ score: 12, catchup_finalized: true }),
      session({ score: 12, catchup_finalized: true }),
      session({ score: 12 }),
      session({ score: 4 }),
    ];
    const split = catchupDebtSplit(sessions);
    expect(split).toEqual({ total: 40, catchup: 24, organic: 16, ratio: 0.6 });

    const d = consolidationDepth(split.total, { catchup: split });
    expect(d.depth).toBe('standard');
    expect(d.cappedByCatchup).toBe(true);
  });

  it('bulk catch-up scenario: organic debt alone already deep → cap is a no-op', () => {
    const sessions: SessionRecord[] = [
      session({ score: 12, catchup_finalized: true }),
      session({ score: 12, catchup_finalized: true }),
      session({ score: 12 }),
      session({ score: 12 }),
    ];
    const split = catchupDebtSplit(sessions);
    expect(split).toEqual({ total: 48, catchup: 24, organic: 24, ratio: 0.5 });

    const d = consolidationDepth(split.total, { catchup: split });
    expect(d.depth).toBe('deep');
    expect(d.cappedByCatchup).toBeUndefined();
  });
});
