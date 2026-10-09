import { describe, it, expect } from 'vitest';
import {
  sleepinessLevel,
  consolidationDepth,
  isDestructiveAllowed,
  inspectSleepLock,
  finalizeSleepState,
  SLEEP_LOCK_STALE_MS,
  DEBT_DROWSY,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
  DEBT_DEEP_AUTHORITY,
} from '../../src/lib/sleep-consolidation.js';
import type { SleepState } from '../../src/lib/sleep-consolidation.js';

/** Minimal SleepState carrying only the field inspectSleepLock reads. */
function lockState(sleep_started_at: string | null): SleepState {
  return { sleep_started_at } as unknown as SleepState;
}

/** Full SleepState fixture (cloneState reads every array/object field, so a
 *  partial `as unknown as SleepState` would throw inside finalizeSleepState). */
function finalizeInput(over: Partial<SleepState> = {}): SleepState {
  return {
    debt: 12,
    last_sleep: null,
    last_sleep_summary: null,
    sleep_started_at: '2026-07-01T18:00:00.000Z',
    last_consolidated_at: null,
    sessions_since_last_sleep: 3,
    sessions: [],
    bookmarks: [],
    triggers: [],
    knowledge_access: {},
    dashboard_changes: [],
    compaction_log: [],
    recall_mode: 'haiku',
    consolidation_depth: 'standard',
    pendingMigrationNotices: [],
    ...over,
  };
}

/**
 * WS-DEPTH / level unit coverage (issue #9). Pure functions only — no disk.
 */

describe('sleepinessLevel — boundary-exact', () => {
  // 0-10 session scale (2026-07-29): Alert 0–11 · Drowsy 12–19 · Sleepy 20–29 ·
  // Must Sleep 30+. Derived from the constants so a future rescale updates the
  // table rather than silently testing the wrong bands.
  it.each([
    [DEBT_DROWSY - 1, 'Alert'],
    [DEBT_DROWSY, 'Drowsy'],
    [DEBT_SLEEPY - 1, 'Drowsy'],
    [DEBT_SLEEPY, 'Sleepy'],
    [DEBT_MUST_SLEEP - 1, 'Sleepy'],
    [DEBT_MUST_SLEEP, 'Must Sleep'],
  ] as const)('debt %i → %s', (debt, expected) => {
    expect(sleepinessLevel(debt)).toBe(expected);
  });
});

describe('consolidationDepth — debt base', () => {
  // light = Alert · standard = everything up to DEBT_DEEP_AUTHORITY · deep only
  // past it. Note 'deep' is NOT tied to Must Sleep (2026-07-29): being overdue
  // to consolidate must not by itself authorize destructive knowledge ops.
  it.each([
    [0, 'light'],
    [DEBT_DROWSY - 1, 'light'],
    [DEBT_DROWSY, 'standard'],
    [DEBT_MUST_SLEEP, 'standard'],
    [DEBT_DEEP_AUTHORITY - 1, 'standard'],
    [DEBT_DEEP_AUTHORITY, 'deep'],
    [DEBT_DEEP_AUTHORITY + 30, 'deep'],
  ] as const)('debt %i → %s (source debt)', (debt, depth) => {
    const d = consolidationDepth(debt);
    expect(d.depth).toBe(depth);
    expect(d.source).toBe('debt');
  });
});

describe('consolidationDepth — user override', () => {
  it('userRequestedDeep at low debt forces deep with source user', () => {
    const d = consolidationDepth(0, { userRequestedDeep: true });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('user');
  });

  it('userRequestedDeep wins over a bump', () => {
    const d = consolidationDepth(0, { userRequestedDeep: true, agentBump: 1 });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('user');
  });
});

describe('consolidationDepth — agent bump (clamped, monotonic)', () => {
  it('bump 1 raises one tier from the debt base', () => {
    const d = consolidationDepth(0, { agentBump: 1 }); // light -> standard
    expect(d.depth).toBe('standard');
    expect(d.source).toBe('agent');
  });

  it('bump 2 raises two tiers to deep', () => {
    const d = consolidationDepth(0, { agentBump: 2 }); // light -> deep
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('agent');
  });

  it('bump 5 clamps to at most two tiers (deep)', () => {
    const d = consolidationDepth(0, { agentBump: 5 }); // clamps to 2 -> deep
    expect(d.depth).toBe('deep');
  });

  it('negative bump does NOT lower; stays at the debt base', () => {
    const d = consolidationDepth(DEBT_DROWSY, { agentBump: -3 }); // base standard, neutralized
    expect(d.depth).toBe('standard');
    expect(d.source).toBe('debt');
  });

  it('never drops below the debt base even with a negative bump at high debt', () => {
    const d = consolidationDepth(DEBT_DEEP_AUTHORITY, { agentBump: -2 }); // base deep
    expect(d.depth).toBe('deep');
  });

  it('bump never exceeds deep at an already-high base', () => {
    const d = consolidationDepth(DEBT_DEEP_AUTHORITY, { agentBump: 2 }); // base deep, clamps at deep
    expect(d.depth).toBe('deep');
  });
});

describe('isDestructiveAllowed', () => {
  it('false for null/undefined/light/standard', () => {
    expect(isDestructiveAllowed(null)).toBe(false);
    expect(isDestructiveAllowed(undefined)).toBe(false);
    expect(isDestructiveAllowed('light')).toBe(false);
    expect(isDestructiveAllowed('standard')).toBe(false);
  });

  it('true only for deep', () => {
    expect(isDestructiveAllowed('deep')).toBe(true);
  });
});

describe('inspectSleepLock — the consolidation mutex', () => {
  const T0 = Date.parse('2026-06-29T12:00:00.000Z');

  it('reports unlocked when no epoch is pinned', () => {
    const lock = inspectSleepLock(lockState(null), T0);
    expect(lock).toEqual({ locked: false, startedAt: null, ageMs: 0, stale: false });
  });

  it('reports a fresh lock as locked but NOT stale', () => {
    const startedAt = new Date(T0 - 60_000).toISOString(); // 1m ago
    const lock = inspectSleepLock(lockState(startedAt), T0);
    expect(lock.locked).toBe(true);
    expect(lock.startedAt).toBe(startedAt);
    expect(lock.ageMs).toBe(60_000);
    expect(lock.stale).toBe(false);
  });

  it('is NOT stale exactly 1ms before the TTL boundary', () => {
    const startedAt = new Date(T0 - (SLEEP_LOCK_STALE_MS - 1)).toISOString();
    expect(inspectSleepLock(lockState(startedAt), T0).stale).toBe(false);
  });

  it('IS stale exactly at the TTL boundary (>=)', () => {
    const startedAt = new Date(T0 - SLEEP_LOCK_STALE_MS).toISOString();
    const lock = inspectSleepLock(lockState(startedAt), T0);
    expect(lock.locked).toBe(true);
    expect(lock.stale).toBe(true);
    expect(lock.ageMs).toBe(SLEEP_LOCK_STALE_MS);
  });

  it('clamps a future epoch to ageMs 0 (never negative, never stale)', () => {
    const startedAt = new Date(T0 + 5_000).toISOString(); // clock skew: lock "in the future"
    const lock = inspectSleepLock(lockState(startedAt), T0);
    expect(lock.ageMs).toBe(0);
    expect(lock.stale).toBe(false);
  });

  it('treats an unparseable epoch as infinitely old → stale (reclaimable, never wedged)', () => {
    const lock = inspectSleepLock(lockState('not-a-date'), T0);
    expect(lock.locked).toBe(true);
    expect(lock.ageMs).toBe(Infinity);
    expect(lock.stale).toBe(true);
  });
});

describe('finalizeSleepState — last_consolidated_at', () => {
  it('stamps last_consolidated_at from the injected nowISO, verbatim', () => {
    const finalized = finalizeSleepState(finalizeInput(), 'did stuff', '2026-07-01', '2026-07-01T18:05:00.000Z');
    expect(finalized.last_consolidated_at).toBe('2026-07-01T18:05:00.000Z');
  });

  it('still clears sleep_started_at (the lock) in the same call', () => {
    const finalized = finalizeSleepState(finalizeInput(), 'did stuff', '2026-07-01', '2026-07-01T18:05:00.000Z');
    expect(finalized.sleep_started_at).toBeNull();
  });

  it('overwrites a prior last_consolidated_at — each completed cycle re-stamps the boundary', () => {
    const input = finalizeInput({ last_consolidated_at: '2026-06-01T00:00:00.000Z' });
    const finalized = finalizeSleepState(input, 'did stuff', '2026-07-01', '2026-07-01T18:05:00.000Z');
    expect(finalized.last_consolidated_at).toBe('2026-07-01T18:05:00.000Z');
  });

  it('leaves the input state untouched (operates on a clone, like every other field it sets)', () => {
    const input = finalizeInput();
    finalizeSleepState(input, 'did stuff', '2026-07-01', '2026-07-01T18:05:00.000Z');
    expect(input.last_consolidated_at).toBeNull();
    expect(input.sleep_started_at).toBe('2026-07-01T18:00:00.000Z');
  });
});
