/**
 * `claude-account-switch.ts` — `chooseAccount`, the pure half of auto-switch.
 *
 * Readings arrive as arguments and there is no I/O, so every rule below is a unit test
 * rather than a live-CLI experiment. The rule that matters most: an account we could NOT
 * measure is never a candidate. Counting an unreadable account as 0% is exactly how a
 * "safe" switch lands on an account that is already out of quota.
 */
import { describe, it, expect } from 'vitest';
import {
  PROBE_THRESHOLD_PERCENT,
  SWITCH_THRESHOLD_PERCENT,
  chooseAccount,
  shouldProbe,
  shouldSwitchAway,
  type AccountReading,
} from '../../src/lib/claude-account-switch.js';
import type { UsageLimitsResponse } from '../../src/lib/claude-usage.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-04T12:00:00Z');

function limits(
  session: number | null,
  weekly: number | null,
  over: { lockedReason?: string; sessionResetsAt?: number; weeklyResetsAt?: number } = {},
): UsageLimitsResponse {
  const out: UsageLimitsResponse = { limits: [], fetchedAtMs: NOW };
  if (session !== null) {
    out.limits.push({
      key: 'session', percent: session, resetsAt: over.sessionResetsAt ?? NOW + HOUR,
      ...(over.lockedReason ? { lockedReason: over.lockedReason } : {}),
    });
  }
  if (weekly !== null) {
    out.limits.push({ key: 'weekly', percent: weekly, resetsAt: over.weeklyResetsAt ?? NOW + 48 * HOUR });
  }
  return out;
}

const reading = (id: string, session: number | null, weekly: number | null, over = {}): AccountReading =>
  ({ id, limits: limits(session, weekly, over) });

const T = { threshold: SWITCH_THRESHOLD_PERCENT };

describe('the emptiest eligible account wins', () => {
  it('picks the lowest session usage', () => {
    const res = chooseAccount([reading('a', 70, 20), reading('b', 12, 30), reading('c', 40, 10)], T);
    expect(res.accountId).toBe('b');
    expect(res.sessionPercent).toBe(12);
  });

  it('weighs the WEEKLY window too — a fresh 5-hour window on an exhausted week is not eligible', () => {
    const res = chooseAccount([reading('a', 60, 40), reading('b', 2, 97)], T);
    expect(res.accountId).toBe('a');
    expect(res.rejected).toContainEqual({ id: 'b', why: 'weekly usage is at 97%' });
  });

  it('a locked window disqualifies whatever the percent says', () => {
    const res = chooseAccount([reading('a', 5, 5, { lockedReason: 'session_limit_reached' }), reading('b', 50, 50)], T);
    expect(res.accountId).toBe('b');
    expect(res.rejected).toContainEqual({ id: 'a', why: 'a usage window is already locked' });
  });

  it('on a tie the CURRENT account wins, so a session never moves for nothing', () => {
    const res = chooseAccount([reading('a', 20, 10), reading('b', 20, 10)], { ...T, currentId: 'b' });
    expect(res.accountId).toBe('b');
  });

  it('on a tie with no current account the PREFERRED one wins', () => {
    const res = chooseAccount([reading('a', 20, 10), reading('b', 20, 10)], { ...T, preferredId: 'b' });
    expect(res.accountId).toBe('b');
  });

  it('a tie with neither is broken deterministically, never by a coin flip', () => {
    const first = chooseAccount([reading('b', 20, 10), reading('a', 20, 10)], T);
    const again = chooseAccount([reading('a', 20, 10), reading('b', 20, 10)], T);
    expect(first.accountId).toBe('a');
    expect(again.accountId).toBe('a');
  });
});

describe('an unmeasurable account is NEVER a candidate', () => {
  it('`unknown` is not treated as zero usage', () => {
    const res = chooseAccount([{ id: 'a', problem: 'unknown' }, reading('b', 88, 10)], T);
    expect(res.accountId).toBe('b');
    expect(res.rejected).toContainEqual({ id: 'a', why: 'its usage could not be read' });
  });

  it('`stale` is not treated as zero usage', () => {
    const res = chooseAccount([{ id: 'a', problem: 'stale' }, reading('b', 88, 10)], T);
    expect(res.accountId).toBe('b');
  });

  it('`needs-relogin` says so by name, so the surface can offer the right button', () => {
    const res = chooseAccount([{ id: 'a', problem: 'needs-relogin' }, reading('b', 10, 10)], T);
    expect(res.accountId).toBe('b');
    expect(res.rejected).toContainEqual({ id: 'a', why: 'needs to sign in again' });
  });

  it('a reading missing one window is not a candidate either', () => {
    const res = chooseAccount([reading('a', 10, null), reading('b', 50, 50)], T);
    expect(res.accountId).toBe('b');
    expect(res.rejected).toContainEqual({ id: 'a', why: 'one of its usage windows is missing' });
  });

  it('an all-unmeasurable set yields no account rather than a guess', () => {
    const res = chooseAccount([{ id: 'a', problem: 'unknown' }, { id: 'b', problem: 'stale' }], T);
    expect(res.accountId).toBeNull();
    // Nothing was readable, so there is no honest reset time to promise.
    expect(res.earliestResetAt).toBeUndefined();
  });
});

describe('when everything is exhausted the answer says WHEN work resumes', () => {
  it('carries the EARLIEST reset across all exhausted accounts', () => {
    const soon = NOW + 1 * HOUR;
    const later = NOW + 5 * HOUR;
    const res = chooseAccount([
      reading('a', 95, 30, { sessionResetsAt: later }),
      reading('b', 99, 30, { sessionResetsAt: soon }),
    ], T);
    expect(res.accountId).toBeNull();
    expect(res.earliestResetAt).toBe(soon);
    // And it says why each one was rejected — not just that it failed.
    expect(res.rejected.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('an empty account list is not a crash', () => {
    const res = chooseAccount([], T);
    expect(res.accountId).toBeNull();
    expect(res.rejected).toEqual([]);
  });
});

describe('the two thresholds', () => {
  it('probing starts lower than switching — the probe is free, the switch is disruptive', () => {
    expect(PROBE_THRESHOLD_PERCENT).toBeLessThan(SWITCH_THRESHOLD_PERCENT);
  });

  it('shouldProbe fires at the probe threshold but shouldSwitchAway does not', () => {
    const at80 = limits(PROBE_THRESHOLD_PERCENT, 10);
    expect(shouldProbe(at80)).toBe(true);
    expect(shouldSwitchAway(at80)).toBe(false);
  });

  it('shouldSwitchAway fires at the switch threshold', () => {
    expect(shouldSwitchAway(limits(SWITCH_THRESHOLD_PERCENT, 10))).toBe(true);
    expect(shouldSwitchAway(limits(SWITCH_THRESHOLD_PERCENT - 1, 10))).toBe(false);
  });

  it('a lockedReason fires both immediately, whatever the percent beside it says', () => {
    const locked = limits(3, 3, { lockedReason: 'weekly_limit_reached' });
    expect(shouldProbe(locked)).toBe(true);
    expect(shouldSwitchAway(locked)).toBe(true);
  });

  it('the WEEKLY window can trigger a switch on its own', () => {
    expect(shouldSwitchAway(limits(5, 96))).toBe(true);
  });

  it('an empty reading triggers nothing — absence is not exhaustion', () => {
    expect(shouldProbe({ limits: [], fetchedAtMs: null })).toBe(false);
    expect(shouldSwitchAway({ limits: [], fetchedAtMs: null })).toBe(false);
  });
});
