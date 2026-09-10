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
  DEFAULT_SWITCH_WEIGHTS,
  PROBE_THRESHOLD_PERCENT,
  SWITCH_THRESHOLD_PERCENT,
  chooseAccount,
  sanitizeSwitchWeights,
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
  it('picks the lowest SCORE, which is both windows together and not the session alone', () => {
    // a: 70 + 2·20 = 110   b: 12 + 2·30 = 72   c: 40 + 2·10 = 60  (no order given, so the
    // order term is identical for all three and cannot decide it)
    const res = chooseAccount([reading('a', 70, 20), reading('b', 12, 30), reading('c', 40, 10)], T);
    expect(res.accountId).toBe('c');
    expect(res.sessionPercent).toBe(40);
    expect(res.weeklyPercent).toBe(10);
  });

  it('the 2026-09-10 regression: a spent WEEK does not win on a fresh 5-hour window', () => {
    // Exactly what the owner screenshotted. Under the old "lowest session" rule ouromedia
    // won on 1% while three quarters of its week was already gone.
    const res = chooseAccount(
      [reading('ottoapps', 26, 6), reading('ouromedia', 1, 75), reading('gmail', 4, 27)],
      { ...T, orderedIds: ['nativeminds', 'ottoapps', 'ouromedia', 'gmail'] },
    );
    // ottoapps 26 + 12 + 5·1 = 43   ouromedia 1 + 150 + 5·2 = 161   gmail 4 + 54 + 5·3 = 73
    expect(res.accountId).toBe('ottoapps');
    expect(res.score).toBe(43);
  });

  it('the order is a real term, not only a tie-break: near-equal accounts follow the list', () => {
    // gmail is barely freer on paper (4/27 vs 26/6 is 58 vs 38 once the week is weighed),
    // and even without that the list decides between accounts in similar shape.
    const res = chooseAccount(
      [reading('second', 20, 10), reading('third', 18, 12)],
      { ...T, orderedIds: ['second', 'third'] },
    );
    expect(res.accountId).toBe('second');
  });

  it('a weight of 0 switches its term off — {session:0, weekly:0, order:1} is strict priority', () => {
    const res = chooseAccount(
      [reading('a', 80, 80), reading('z', 1, 1)],
      { ...T, orderedIds: ['a', 'z'], weights: { session: 0, weekly: 0, order: 1 } },
    );
    expect(res.accountId).toBe('a');
  });

  it('an account the caller gave no order for does not have its score swamped by the order term', () => {
    // `position` answers MAX_SAFE_INTEGER for an unknown id, which is right for a tie-break
    // and catastrophic inside a sum. The score term is bounded instead.
    const res = chooseAccount(
      [reading('known', 60, 40), reading('stranger', 1, 1)],
      { ...T, orderedIds: ['known'] },
    );
    expect(res.accountId).toBe('stranger');
    expect(Number.isFinite(res.score)).toBe(true);
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

  it('order does not outrank a big gap in the numbers — a much busier top account still loses', () => {
    const res = chooseAccount([reading('a', 10, 5), reading('z', 80, 5)], { ...T, orderedIds: ['z', 'a'] });
    expect(res.accountId).toBe('a');
  });

  it('the account already serving still wins a true tie, whatever the order says', () => {
    // With the order WEIGHED, two accounts at the same percentages are no longer tied — the
    // list separates them. A genuine tie needs the order term switched off, and that is the
    // case this rule is actually about: never move a session for nothing.
    const res = chooseAccount(
      [reading('a', 20, 5), reading('z', 20, 5)],
      { ...T, orderedIds: ['z', 'a'], currentId: 'a', weights: { session: 1, weekly: 2, order: 0 } },
    );
    expect(res.accountId).toBe('a');
  });

  it('with the order weighed, identical accounts follow the list rather than the id', () => {
    const res = chooseAccount(
      [reading('a', 20, 5), reading('z', 20, 5)],
      { ...T, orderedIds: ['z', 'a'] },
    );
    expect(res.accountId).toBe('z');
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

describe('what the `order` weight actually costs as the list grows', () => {
  it('the spread is order x (N-1), so the default suits a SHORT list', () => {
    // Eight accounts, default weights. The bottom row carries 5*7 = 35 points before a single
    // percent is counted, so the top row can win while being genuinely freer-looking numbers
    // behind it. This is the intended shape of a weighted order term, not a bug — but it is
    // the reason `order` wants LOWERING on a long list, and it is asserted rather than left
    // to a comment nobody re-derives.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const res = chooseAccount(
      [reading('a', 20, 10), reading('h', 5, 5)],   // a: 40 + 0   h: 15 + 35 = 50
      { ...T, orderedIds: ids },
    );
    expect(res.accountId).toBe('a');

    // The same machine with `order: 1` — one step is worth a single point — answers the way
    // a user with eight accounts would expect.
    const tuned = chooseAccount(
      [reading('a', 20, 10), reading('h', 5, 5)],
      { ...T, orderedIds: ids, weights: { session: 1, weekly: 2, order: 1 } },
    );
    expect(tuned.accountId).toBe('h');
  });

  it('a big enough gap still beats the order term at any list length', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const res = chooseAccount([reading('a', 70, 60), reading('h', 1, 1)], { ...T, orderedIds: ids });
    expect(res.accountId).toBe('h');
  });
});

describe('fractional weights do not defeat the tie-break through float error', () => {
  // These two readings are the real thing, found by search rather than assumed: under weights
  // {0.1, 0.2, 0} they are mathematically tied and differ by 2.22e-16 as doubles.
  //   current(session 0, weekly 6) -> 0.1*0 + 0.2*6 = 1.2000000000000002
  //   other  (session 2, weekly 5) -> 0.1*2 + 0.2*5 = 1.2
  const W = { session: 0.1, weekly: 0.2, order: 0 };

  it('THE CANARY: the raw sums really are unequal, so this suite tests something', () => {
    // An earlier version of this test used inputs that turned out to be BIT-IDENTICAL, so it
    // passed with the pre-fix `!==` comparator too and pinned nothing. This assertion fails
    // loudly if the inputs ever stop demonstrating the bug they were chosen for.
    //
    // `raw` mirrors the production sum TERM FOR TERM, including the order term, so it cannot
    // quietly drift from the formula it is guarding — leaving that term out would make the
    // canary accidentally correct only while `W.order` happens to be 0.
    const raw = (session: number, weekly: number, place: number) =>
      W.session * session + W.weekly * weekly + W.order * place;
    expect(raw(0, 6, 1)).not.toBe(raw(2, 5, 0));
    expect(Math.abs(raw(0, 6, 1) - raw(2, 5, 0))).toBeLessThan(1e-12);
  });

  it('two mathematically tied scores stay tied, so the serving account does not move', () => {
    const res = chooseAccount(
      [reading('current', 0, 6), reading('other', 2, 5)],
      { ...T, orderedIds: ['other', 'current'], currentId: 'current', weights: W },
    );
    expect(res.accountId).toBe('current');
  });

  it('and a real difference still decides', () => {
    const res = chooseAccount(
      [reading('current', 30, 10), reading('other', 1, 2)],
      { ...T, orderedIds: ['other', 'current'], currentId: 'current', weights: W },
    );
    expect(res.accountId).toBe('other');
  });

  it('the comparator is CONSISTENT — a rounded score is an equivalence relation, a tolerance is not', () => {
    // THE ACTUAL HAZARD, not a decorative large number. These weights put the scores at
    //   a = 1_000_000_000     b = 1_000_000_000.9     c = 1_000_000_001.8
    // where a relative tolerance of 1e-9·|score| is ≈1.0, so it calls a≈b and b≈c while a<c —
    // a non-transitive comparator, which makes `Array.prototype.sort`'s answer
    // implementation-defined. (An earlier version of this test used scores 1e9/2e9/3e9, which
    // a tolerance separates just as cleanly; it demonstrated nothing.)
    //
    // Rounding cannot produce that shape at any magnitude, so the three stay distinct and the
    // lowest wins deterministically.
    const weights = { session: 1e9, weekly: 0.9, order: 0 };
    const res = chooseAccount(
      [reading('a', 1, 0), reading('b', 1, 1), reading('c', 1, 2)],
      { ...T, orderedIds: ['a', 'b', 'c'], weights },
    );
    expect(res.accountId).toBe('a');
    expect(res.score).toBe(1_000_000_000);
  });
});

describe('the `sequential` strategy — drain the list in order, move only on a real refusal', () => {
  const S = { ...T, strategy: 'sequential' as const, orderedIds: ['first', 'second', 'third'] };

  it('the top account serves even when it is nearly spent and a freer one is below it', () => {
    // The whole point of the mode. Under `score` this would move; here 88% is not a reason.
    const res = chooseAccount([reading('first', 88, 46), reading('second', 2, 3)], S);
    expect(res.accountId).toBe('first');
    expect(res.sessionPercent).toBe(88);
    expect(res.weeklyPercent).toBe(46);
  });

  it('a percentage PAST the threshold is still not a reason to move — only a refusal is', () => {
    const res = chooseAccount([reading('first', 99, 99), reading('second', 2, 3)], S);
    expect(res.accountId).toBe('first');
  });

  it('an actual refusal hands the turn to the NEXT account in the list, not the freest', () => {
    const res = chooseAccount(
      [reading('first', 99, 99), reading('second', 40, 40), reading('third', 1, 1)],
      { ...S, rejectedUntil: { first: { until: NOW + HOUR, window: 'session' } }, now: NOW },
    );
    expect(res.accountId).toBe('second');
    expect(res.rejected).toContainEqual({
      id: 'first', why: 'the API refused its last turn on the session limit',
    });
  });

  it('walks down the list as each account is refused in turn', () => {
    const res = chooseAccount(
      [reading('first', 99, 99), reading('second', 40, 40), reading('third', 90, 90)],
      {
        ...S,
        rejectedUntil: {
          first: { until: NOW + HOUR, window: 'session' },
          second: { until: NOW + HOUR, window: 'weekly' },
        },
        now: NOW,
      },
    );
    expect(res.accountId).toBe('third');
  });

  it('a rejection expires AT `until`, not after it — the boundary, pinned', () => {
    // `refusal.until > now`, so the instant the clock reaches the stated reset the account is
    // eligible again. Consistent with how `resetsAt` is read everywhere else, and now locked:
    // flipping this to `>=` would exile an account for one extra evaluation.
    const res = chooseAccount(
      [reading('first', 5, 5), reading('second', 1, 1)],
      { ...S, rejectedUntil: { first: { until: NOW, window: 'session' } }, now: NOW },
    );
    expect(res.accountId).toBe('first');
  });

  it('returns to the top the moment its window reopens', () => {
    const res = chooseAccount(
      [reading('first', 5, 40), reading('second', 1, 1)],
      { ...S, currentId: 'second', rejectedUntil: { first: { until: NOW - 1, window: 'session' } }, now: NOW },
    );
    expect(res.accountId).toBe('first');
  });

  it('does NOT prefer the account already serving over a higher-priority one', () => {
    // `score` keeps a session put on a tie; draining in order must not, or a session stays
    // stranded below the top of the list forever after one refusal expires.
    const res = chooseAccount([reading('first', 50, 50), reading('second', 1, 1)], { ...S, currentId: 'second' });
    expect(res.accountId).toBe('first');
  });

  it('an unreadable or stale reading is NOT a disqualification here — no percentage is consulted', () => {
    const res = chooseAccount(
      [{ id: 'first', problem: 'unknown' }, reading('second', 1, 1)],
      S,
    );
    expect(res.accountId).toBe('first');
    expect(res.unmeasured).toBe(true);
    expect(res.sessionPercent).toBeUndefined();
  });

  it('but a locked window is, because that is the API stating a fact rather than a forecast', () => {
    const res = chooseAccount(
      [reading('first', 10, 10, { lockedReason: 'weekly_limit' }), reading('second', 80, 80)],
      S,
    );
    expect(res.accountId).toBe('second');
    expect(res.rejected).toContainEqual({ id: 'first', why: 'a usage window is already locked' });
  });

  it('and so is an identity that needs signing in again', () => {
    const res = chooseAccount([{ id: 'first', problem: 'needs-relogin' }, reading('second', 80, 80)], S);
    expect(res.accountId).toBe('second');
    expect(res.rejected).toContainEqual({ id: 'first', why: 'needs to sign in again' });
  });

  it('every account refused: null, with the earliest reset so the surface can say WHEN', () => {
    const res = chooseAccount(
      [reading('first', 10, 10), reading('second', 10, 10)],
      {
        ...S,
        rejectedUntil: {
          first: { until: NOW + 3 * HOUR, window: 'session' },
          second: { until: NOW + HOUR, window: 'session' },
        },
        now: NOW,
      },
    );
    expect(res.accountId).toBeNull();
    expect(res.earliestResetAt).toBe(NOW + HOUR);
  });

  it('never reports a `score` — nothing was weighed', () => {
    const res = chooseAccount([reading('first', 10, 10)], S);
    expect(res.score).toBeUndefined();
  });
});

describe('sanitizeSwitchWeights', () => {
  it('keeps usable numbers, including 0', () => {
    expect(sanitizeSwitchWeights({ session: 0, weekly: 3.5, order: 12 }))
      .toEqual({ session: 0, weekly: 3.5, order: 12 });
  });

  it('falls back per FIELD, so one bad number does not reset the other two', () => {
    expect(sanitizeSwitchWeights({ session: 4, weekly: -1, order: 'x' }))
      .toEqual({ session: 4, weekly: DEFAULT_SWITCH_WEIGHTS.weekly, order: DEFAULT_SWITCH_WEIGHTS.order });
  });

  it('a non-finite weight would make every score identical, so it is refused', () => {
    expect(sanitizeSwitchWeights({ session: Infinity, weekly: NaN, order: 5 }))
      .toEqual({ ...DEFAULT_SWITCH_WEIGHTS, order: 5 });
  });

  it('junk of any shape reads as the defaults', () => {
    for (const junk of [null, undefined, 'weights', 42, []]) {
      expect(sanitizeSwitchWeights(junk)).toEqual(DEFAULT_SWITCH_WEIGHTS);
    }
  });
});

describe('the strategy is opt-in — every caller written before it behaves exactly as it did', () => {
  it('an omitted strategy scores', () => {
    const bare = chooseAccount([reading('a', 88, 5), reading('b', 4, 5)], T);
    const explicit = chooseAccount([reading('a', 88, 5), reading('b', 4, 5)], { ...T, strategy: 'score' });
    expect(bare.accountId).toBe('b');
    expect(explicit.accountId).toBe(bare.accountId);
  });
});
