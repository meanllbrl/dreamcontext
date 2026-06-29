import { describe, it, expect } from 'vitest';
import {
  sleepinessLevel,
  consolidationDepth,
  isDestructiveAllowed,
  inspectSleepLock,
  SLEEP_LOCK_STALE_MS,
} from '../../src/lib/sleep-consolidation.js';
import type { SleepState } from '../../src/lib/sleep-consolidation.js';

/** Minimal SleepState carrying only the field inspectSleepLock reads. */
function lockState(sleep_started_at: string | null): SleepState {
  return { sleep_started_at } as unknown as SleepState;
}

/**
 * WS-DEPTH / level unit coverage (issue #9). Pure functions only — no disk.
 */

describe('sleepinessLevel — boundary-exact', () => {
  // ×2 scale (2026-06-29): Alert 0–7 · Drowsy 8–13 · Sleepy 14–19 · Must Sleep 20+.
  it.each([
    [7, 'Alert'],
    [8, 'Drowsy'],
    [13, 'Drowsy'],
    [14, 'Sleepy'],
    [19, 'Sleepy'],
    [20, 'Must Sleep'],
  ] as const)('debt %i → %s', (debt, expected) => {
    expect(sleepinessLevel(debt)).toBe(expected);
  });
});

describe('consolidationDepth — debt base', () => {
  // light = Alert (0–7) · standard = Drowsy+Sleepy (8–19) · deep = Must Sleep (20+).
  it.each([
    [0, 'light'],
    [7, 'light'],
    [8, 'standard'],
    [19, 'standard'],
    [20, 'deep'],
    [50, 'deep'],
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
    const d = consolidationDepth(8, { agentBump: -3 }); // base standard, neutralized
    expect(d.depth).toBe('standard');
    expect(d.source).toBe('debt');
  });

  it('never drops below the debt base even with a negative bump at high debt', () => {
    const d = consolidationDepth(20, { agentBump: -2 }); // base deep
    expect(d.depth).toBe('deep');
  });

  it('bump never exceeds deep at an already-high base', () => {
    const d = consolidationDepth(20, { agentBump: 2 }); // base deep, clamps at deep
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
