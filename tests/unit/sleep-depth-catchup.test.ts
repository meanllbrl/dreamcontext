import { describe, it, expect } from 'vitest';
import {
  consolidationDepth,
  catchupDebtSplit,
  CATCHUP_DEEP_CAP_RATIO,
  DEBT_DROWSY,
  DEBT_MUST_SLEEP,
  DEBT_DEEP_AUTHORITY,
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

// Fixture algebra, expressed through the constants so a rescale updates it.
const DEEP_TOTAL = DEBT_MUST_SLEEP * 2;   // base depth 'deep'
const STANDARD_HALF = DEBT_MUST_SLEEP;    // alone, only 'standard'

describe('consolidationDepth — AC4 catch-up cap, boundary-exact', () => {
  it('fixture premise: the numbers below still land in the intended depth bands', () => {
    // If a future rescale breaks this, every case below fails for a REASON
    // rather than mysteriously testing the wrong bands.
    expect(consolidationDepth(DEEP_TOTAL).depth).toBe('deep');
    expect(consolidationDepth(STANDARD_HALF).depth).toBe('standard');
    expect(consolidationDepth(0).depth).toBe('light');
  });

  it('deep base, catchup/organic split exactly 0.5 → capped to standard', () => {
    const d = consolidationDepth(DEEP_TOTAL, {
      catchup: { total: DEEP_TOTAL, catchup: STANDARD_HALF, organic: STANDARD_HALF, ratio: 0.5 },
    });
    expect(d.depth).toBe('standard');
    expect(d.source).toBe('debt');
    expect(d.cappedByCatchup).toBe(true);
  });

  it('ratio just below the threshold → no cap, stays deep', () => {
    const catchup = Math.floor(DEEP_TOTAL * (CATCHUP_DEEP_CAP_RATIO - 0.05));
    const organic = DEEP_TOTAL - catchup;
    const ratio = catchup / DEEP_TOTAL;
    expect(ratio).toBeLessThan(CATCHUP_DEEP_CAP_RATIO);
    const d = consolidationDepth(DEEP_TOTAL, { catchup: { total: DEEP_TOTAL, catchup, organic, ratio } });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('debt');
    expect(d.cappedByCatchup).toBeUndefined();
  });

  it('organic half alone is ALSO deep (ratio 0.5) → never lowered', () => {
    const total = DEBT_DEEP_AUTHORITY * 2;
    const half = DEBT_DEEP_AUTHORITY;
    expect(consolidationDepth(half).depth).toBe('deep');
    const d = consolidationDepth(total, { catchup: { total, catchup: half, organic: half, ratio: 0.5 } });
    expect(d.depth).toBe('deep');
    expect(d.cappedByCatchup).toBeUndefined();
  });

  it('all debt from catch-up (ratio 1.0, organic 0) → floors at standard, NOT light', () => {
    const d = consolidationDepth(DEEP_TOTAL, {
      catchup: { total: DEEP_TOTAL, catchup: DEEP_TOTAL, organic: 0, ratio: 1 },
    });
    expect(d.depth).toBe('standard');
    expect(d.cappedByCatchup).toBe(true);
  });

  it('--deep (userRequestedDeep) always wins over the cap', () => {
    const d = consolidationDepth(DEEP_TOTAL, {
      userRequestedDeep: true,
      catchup: { total: DEEP_TOTAL, catchup: STANDARD_HALF, organic: STANDARD_HALF, ratio: 0.5 },
    });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('user');
  });

  it('a standard base with ratio 1.0 → cap is a no-op, stays standard', () => {
    const t = STANDARD_HALF;
    const d = consolidationDepth(t, { catchup: { total: t, catchup: t, organic: 0, ratio: 1 } });
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
    for (const debt of [0, DEBT_DROWSY - 1, DEBT_DROWSY, DEBT_MUST_SLEEP, DEBT_DEEP_AUTHORITY, 100]) {
      const d = consolidationDepth(debt);
      expect(d.cappedByCatchup).toBeUndefined();
      expect(d.source).toBe('debt');
    }
    expect(consolidationDepth(0).depth).toBe('light');
    expect(consolidationDepth(DEBT_DROWSY).depth).toBe('standard');
    // Overdue to consolidate, but NOT authorized to destroy (2026-07-29 split).
    expect(consolidationDepth(DEBT_MUST_SLEEP).depth).toBe('standard');
    expect(consolidationDepth(DEBT_DEEP_AUTHORITY).depth).toBe('deep');
  });

  it('all sessions lack catchup_finalized (legacy 89-cycle state) → ratio 0 → no cap', () => {
    const sessions: SessionRecord[] = [session({ score: STANDARD_HALF }), session({ score: STANDARD_HALF })];
    const split = catchupDebtSplit(sessions);
    expect(split.total).toBe(DEEP_TOTAL);
    const d = consolidationDepth(DEEP_TOTAL, { catchup: split });
    expect(d.depth).toBe('deep');
    expect(d.cappedByCatchup).toBeUndefined();
  });

  it('agentBump 2 on a capped standard → deep, source "agent" (agent authority independent of the cap)', () => {
    const d = consolidationDepth(DEEP_TOTAL, {
      agentBump: 2,
      catchup: { total: DEEP_TOTAL, catchup: STANDARD_HALF, organic: STANDARD_HALF, ratio: 0.5 },
    });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('agent');
  });

  it('decision.reason names the ratio and the organic base when capped', () => {
    const d = consolidationDepth(DEEP_TOTAL, {
      catchup: { total: DEEP_TOTAL, catchup: STANDARD_HALF, organic: STANDARD_HALF, ratio: 0.5 },
    });
    expect(d.reason).toContain('50%');
    expect(d.reason).toContain(String(STANDARD_HALF));
    expect(d.reason).toContain('standard');
  });
});

describe('consolidationDepth — end-to-end via catchupDebtSplit(sessions)', () => {
  it('bulk catch-up scenario: 60% of debt arrived via catch-up (organic alone is standard) → capped to standard', () => {
    const sessions: SessionRecord[] = [
      session({ score: 30, catchup_finalized: true }),
      session({ score: 30, catchup_finalized: true }),
      session({ score: 30 }),
      session({ score: 10 }),
    ];
    const split = catchupDebtSplit(sessions);
    expect(split).toEqual({ total: 100, catchup: 60, organic: 40, ratio: 0.6 });
    // Premise: the total is deep, the organic remainder alone is only standard.
    expect(consolidationDepth(split.total).depth).toBe('deep');
    expect(consolidationDepth(split.organic).depth).toBe('standard');

    const d = consolidationDepth(split.total, { catchup: split });
    expect(d.depth).toBe('standard');
    expect(d.cappedByCatchup).toBe(true);
  });

  it('bulk catch-up scenario: organic debt alone already deep → cap is a no-op', () => {
    const sessions: SessionRecord[] = [
      session({ score: 45, catchup_finalized: true }),
      session({ score: 45, catchup_finalized: true }),
      session({ score: 45 }),
      session({ score: 45 }),
    ];
    const split = catchupDebtSplit(sessions);
    expect(split).toEqual({ total: 180, catchup: 90, organic: 90, ratio: 0.5 });
    // Premise: the organic remainder alone is ALREADY deep, so nothing to lower.
    expect(consolidationDepth(split.organic).depth).toBe('deep');

    const d = consolidationDepth(split.total, { catchup: split });
    expect(d.depth).toBe('deep');
    expect(d.cappedByCatchup).toBeUndefined();
  });
});
