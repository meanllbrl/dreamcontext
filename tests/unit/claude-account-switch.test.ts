/**
 * `claude-account-switch.ts` — `chooseAccount`, the pure half of auto-switch.
 *
 * Readings arrive as arguments and there is no I/O, so every rule below is a unit test
 * rather than a live-CLI experiment. The rule that matters most: an account we could not
 * VOUCH for is never counted as 0%. Treating an unreadable account as empty is exactly how
 * a "safe" switch lands on an account that is already out of quota.
 *
 * Two later rules qualify that without weakening it, and each has its own block below: an
 * account the API has actually REFUSED is out however good its numbers look, and an account
 * that is provably signed in but publishes no numbers is a candidate of LAST RESORT.
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

describe('an account we cannot vouch for is NEVER counted as empty', () => {
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

  it('a reading missing one window LOSES to any measured account, however busy', () => {
    // 'a' looks better on the one number it has (10% vs 50%) and still must not win: half a
    // reading is not a reading. It is a LAST-RESORT candidate now (see the `unmeasured`
    // block below), which changes what happens when nothing else qualifies — never what
    // happens when something does.
    const res = chooseAccount([reading('a', 10, null), reading('b', 50, 50)], T);
    expect(res.accountId).toBe('b');
    expect(res.unmeasured).toBeUndefined();
    expect(res.rejected).toContainEqual({ id: 'a', why: 'its usage could not be read' });
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

/**
 * ── The 2026-09-05 failure, as rules ───────────────────────────────────────────────────
 * Three separate breaks put the same message on screen twice. The two the chooser owns are
 * pinned here; the third (nothing reacting after a refusal) lives in the route and its
 * verify scenario.
 */
describe('an account the API actually REFUSED outranks its own percentages', () => {
  const refused = (until: number, window?: string) => ({
    ...T,
    now: NOW,
    rejectedUntil: { a: { until, ...(window ? { window } : {}) } },
  });

  it('a refused account is not a candidate even while its cache reports 0%', () => {
    // THE MEASURED CASE. The CLI refused a turn with "You've hit your session limit"; three
    // minutes later that same account's `/usage` probe answered 6%. A chooser that trusts
    // the forecast over the refusal sends the very next turn back into the wall — which is
    // exactly what the user saw when their "devam" came back byte-identical.
    const res = chooseAccount([reading('a', 0, 0), reading('b', 60, 20)], refused(NOW + HOUR, 'session'));
    expect(res.accountId).toBe('b');
    expect(res.rejected).toContainEqual({ id: 'a', why: 'the API refused its last turn on the session limit' });
  });

  it('the refusal expires on its own — an account is never exiled past its window', () => {
    const res = chooseAccount([reading('a', 0, 0), reading('b', 60, 20)], refused(NOW - 1, 'session'));
    expect(res.accountId).toBe('a');
  });

  it('a refusal with no stated window still disqualifies, without inventing one', () => {
    const res = chooseAccount([reading('a', 0, 0), reading('b', 60, 20)], refused(NOW + HOUR));
    expect(res.accountId).toBe('b');
    expect(res.rejected).toContainEqual({ id: 'a', why: 'the API refused its last turn' });
  });

  it('a refusal feeds the "when does work resume" answer when everything is out', () => {
    const res = chooseAccount([reading('a', 0, 0)], refused(NOW + 3 * HOUR, 'session'));
    expect(res.accountId).toBeNull();
    expect(res.earliestResetAt).toBe(NOW + 3 * HOUR);
  });
});

describe('signed in but unmeasurable — the LAST-RESORT candidate', () => {
  it('is never preferred over a measured account', () => {
    const res = chooseAccount([{ id: 'a', problem: 'healthy-unmeasured' }, reading('b', 88, 10)], T);
    expect(res.accountId).toBe('b');
    expect(res.unmeasured).toBeUndefined();
    expect(res.rejected).toContainEqual({ id: 'a', why: 'its usage could not be read' });
  });

  it('IS chosen when no measured account qualifies, and says there is no number behind it', () => {
    // The shape this machine actually has: one team account (measurable, and now walled) and
    // one Max account whose `/usage` publishes no percentages at all. Under the old rule this
    // answered "every account is at its limit" — auto-switch was dead on the setup it shipped
    // for. It must move, and it must ADMIT the pick is unmeasured rather than imply otherwise.
    const res = chooseAccount(
      [reading('a', 97, 10), { id: 'b', problem: 'healthy-unmeasured' }],
      { ...T, currentId: 'a' },
    );
    expect(res.accountId).toBe('b');
    expect(res.unmeasured).toBe(true);
    expect(res.sessionPercent).toBeUndefined();
  });

  it('still loses to a REFUSAL — last resort is not "any port in a storm"', () => {
    const res = chooseAccount(
      [reading('a', 97, 10), { id: 'b', problem: 'healthy-unmeasured' }],
      { ...T, now: NOW, rejectedUntil: { b: { until: NOW + HOUR, window: 'session' } } },
    );
    expect(res.accountId).toBeNull();
    expect(res.rejected).toContainEqual({ id: 'b', why: 'the API refused its last turn on the session limit' });
  });

  it('an account we cannot VOUCH for is still never a candidate', () => {
    // The original guarantee, unchanged where it was earned: `unknown` and `stale` mean we
    // learned nothing, and nothing is not a fallback. Only a judge saying "signed in" earns
    // last-resort standing.
    const res = chooseAccount([reading('a', 97, 10), { id: 'b', problem: 'unknown' }], T);
    expect(res.accountId).toBeNull();
  });

  it('two unmeasurable accounts pick deterministically and name the loser', () => {
    const res = chooseAccount(
      [{ id: 'z', problem: 'healthy-unmeasured' }, { id: 'b', problem: 'healthy-unmeasured' }],
      { ...T, preferredId: 'z' },
    );
    expect(res.accountId).toBe('z');
    expect(res.rejected).toContainEqual({ id: 'b', why: 'its usage could not be read either' });
  });
});

describe('the register order is the tie-break — the priority the user dragged into place', () => {
  it('an equal tie goes to whichever account the user put higher', () => {
    // Same session percent, no current, no preferred: alphabetical order used to decide this
    // silently. Now the user's own order does.
    const res = chooseAccount([reading('a', 20, 5), reading('z', 20, 5)], { ...T, orderedIds: ['z', 'a'] });
    expect(res.accountId).toBe('z');
  });

  it('order NEVER outranks the numbers — a busier top account still loses', () => {
    const res = chooseAccount([reading('a', 10, 5), reading('z', 80, 5)], { ...T, orderedIds: ['z', 'a'] });
    expect(res.accountId).toBe('a');
  });

  it('the account already serving still wins a tie, whatever the order says', () => {
    const res = chooseAccount(
      [reading('a', 20, 5), reading('z', 20, 5)],
      { ...T, orderedIds: ['z', 'a'], currentId: 'a' },
    );
    expect(res.accountId).toBe('a');
  });

  it('falls back to the id when no order is given — the old behaviour, unchanged', () => {
    const res = chooseAccount([reading('z', 20, 5), reading('a', 20, 5)], T);
    expect(res.accountId).toBe('a');
  });

  it('an id missing from the order sorts last rather than first', () => {
    const res = chooseAccount([reading('a', 20, 5), reading('z', 20, 5)], { ...T, orderedIds: ['z'] });
    expect(res.accountId).toBe('z');
  });

  it('applies to the last-resort pick too, where there are no numbers at all', () => {
    const res = chooseAccount(
      [{ id: 'a', problem: 'healthy-unmeasured' }, { id: 'z', problem: 'healthy-unmeasured' }],
      { ...T, orderedIds: ['z', 'a'] },
    );
    expect(res.accountId).toBe('z');
    expect(res.unmeasured).toBe(true);
  });
});
