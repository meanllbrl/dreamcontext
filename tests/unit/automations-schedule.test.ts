import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseSchedule,
  parseScheduleDetailed,
  parseSlotSpec,
  serializeSchedule,
  slotSpec,
  mostRecentFire,
  nextFire,
  isDue,
  formatSchedule,
  fireSlotLabel,
  parseCron,
  type DueVerdict,
} from '../../src/lib/automations/schedule.js';
import type { Schedule, ScheduleSlot, Weekday } from '../../src/lib/automations/types.js';

/** A one-slot weekly schedule — exactly what a legacy `{ days, at }` manifest parses to. */
function L(days: 'daily' | Weekday[], at: string): Schedule {
  return { slots: [{ kind: 'weekly', days, at }] };
}
function S(...slots: ScheduleSlot[]): Schedule {
  return { slots };
}

/** Wed 2026-07-08 10:00 local. Fixed, injected — never Date.now() in assertions. */
const NOW = new Date(2026, 6, 8, 10, 0, 0, 0);

describe('parseSchedule', () => {
  it('accepts daily + HH:MM', () => {
    expect(parseSchedule({ days: 'daily', at: '18:00' })).toEqual(L('daily', '18:00'));
  });

  it('accepts an explicit weekday array', () => {
    expect(parseSchedule({ days: ['mon', 'wed'], at: '09:00' })).toEqual(L(['mon', 'wed'], '09:00'));
  });

  it('accepts a comma-separated day string ("mon,wed")', () => {
    expect(parseSchedule({ days: 'mon,wed', at: '09:00' })).toEqual(L(['mon', 'wed'], '09:00'));
  });

  it('accepts a single-day array', () => {
    expect(parseSchedule({ days: ['fri'], at: '17:00' })).toEqual(L(['fri'], '17:00'));
  });

  it('normalizes a single-digit hour to zero-padded HH:MM', () => {
    expect(parseSchedule({ days: 'daily', at: '9:00' })).toEqual(L('daily', '09:00'));
  });

  it('normalizes a dot separator', () => {
    expect(parseSchedule({ days: 'daily', at: '18.00' })).toEqual(L('daily', '18:00'));
  });

  it('is case-insensitive and trims whitespace on day names', () => {
    expect(parseSchedule({ days: [' MON ', 'Wed'], at: '09:00' })).toEqual(L(['mon', 'wed'], '09:00'));
  });

  it.each([
    ['null', null],
    ['a bare string (not an object)', 'daily'],
    ['a bare array', []],
    ['missing at', { days: 'daily' }],
    ['missing days', { at: '18:00' }],
    ['an unknown day name mixed with valid ones', { days: ['mon', 'tues'], at: '09:00' }],
    ['an empty days array', { days: [], at: '09:00' }],
    ['an empty days string', { days: '', at: '09:00' }],
    ['a non-time at string', { days: 'daily', at: 'not-a-time' }],
    ['an out-of-range hour', { days: 'daily', at: '25:00' }],
    ['an out-of-range minute', { days: 'daily', at: '12:75' }],
  ])('rejects %s → null', (_label, input) => {
    expect(parseSchedule(input)).toBeNull();
  });
});

describe('mostRecentFire', () => {
  it('returns today\'s fire when its time has already passed today', () => {
    const schedule = L('daily', '08:00');
    const fire = mostRecentFire(schedule, NOW); // NOW is 10:00, 08:00 already passed
    expect(fire).toEqual(new Date(2026, 6, 8, 8, 0, 0, 0));
  });

  it('falls back to yesterday when today\'s time has not yet arrived', () => {
    const schedule = L('daily', '18:00');
    const fire = mostRecentFire(schedule, NOW); // NOW is 10:00, 18:00 hasn't happened yet today
    expect(fire).toEqual(new Date(2026, 6, 7, 18, 0, 0, 0));
  });

  it('midnight wrap: a near-midnight schedule looks back to yesterday, not forward to today', () => {
    const schedule = L('daily', '23:59');
    const now = new Date(2026, 6, 8, 0, 1, 0, 0); // just after midnight
    const fire = mostRecentFire(schedule, now);
    expect(fire).toEqual(new Date(2026, 6, 7, 23, 59, 0, 0));
  });

  it('midnight wrap: a midnight schedule does not over-wrap when today\'s slot already passed', () => {
    const schedule = L('daily', '00:00');
    const now = new Date(2026, 6, 8, 23, 55, 0, 0); // just before next midnight
    const fire = mostRecentFire(schedule, now);
    expect(fire).toEqual(new Date(2026, 6, 8, 0, 0, 0, 0));
  });

  it('week wrap: a single weekday earlier in the week resolves within a few days back', () => {
    const schedule = L(['mon'], '09:00');
    const fire = mostRecentFire(schedule, NOW); // NOW is Wed 2026-07-08
    expect(fire).toEqual(new Date(2026, 6, 6, 9, 0, 0, 0)); // Mon 2026-07-06
  });

  it('week wrap: today\'s own weekday whose time has not yet passed wraps a full 7 days back', () => {
    const schedule = L(['wed'], '18:00'); // today is Wed, 18:00 hasn't happened
    const fire = mostRecentFire(schedule, NOW);
    expect(fire).toEqual(new Date(2026, 6, 1, 18, 0, 0, 0)); // 2026-07-01, exactly 7 days back
  });

  it('matches a multi-day array against the current day directly', () => {
    const schedule = L(['mon', 'wed'], '09:00');
    const fire = mostRecentFire(schedule, NOW); // Wed 10:00 — today's 09:00 already passed
    expect(fire).toEqual(new Date(2026, 6, 8, 9, 0, 0, 0));
  });

  it('returns null when the schedule has no valid day (empty array)', () => {
    const schedule = L([], '09:00');
    expect(mostRecentFire(schedule, NOW)).toBeNull();
  });

  it('returns null for an unparseable "at" on a hand-built schedule', () => {
    const schedule = L('daily', 'garbage');
    expect(mostRecentFire(schedule, NOW)).toBeNull();
  });
});

describe('nextFire', () => {
  it('returns later today when the time has not yet passed', () => {
    const schedule = L('daily', '18:00');
    expect(nextFire(schedule, NOW)).toEqual(new Date(2026, 6, 8, 18, 0, 0, 0));
  });

  it('rolls to tomorrow when today\'s time has already passed', () => {
    const schedule = L('daily', '08:00');
    expect(nextFire(schedule, NOW)).toEqual(new Date(2026, 6, 9, 8, 0, 0, 0));
  });

  it('week wrap forward: the next matching weekday several days ahead', () => {
    const schedule = L(['mon'], '09:00');
    expect(nextFire(schedule, NOW)).toEqual(new Date(2026, 6, 13, 9, 0, 0, 0)); // next Mon 2026-07-13
  });

  it('returns null when the schedule has no valid day (empty array)', () => {
    const schedule = L([], '09:00');
    expect(nextFire(schedule, NOW)).toBeNull();
  });
});

describe('isDue — every DueVerdict.reason variant', () => {
  it('reason "no-schedule" when schedule is null', () => {
    const v = isDue(null, null, NOW, 6);
    expect(v).toEqual({ due: false, fireAt: null, reason: 'no-schedule' });
  });

  it('reason "no-schedule" when schedule has no valid day (mostRecentFire is null)', () => {
    const v = isDue(L([], '09:00'), null, NOW, 6);
    expect(v).toEqual({ due: false, fireAt: null, reason: 'no-schedule' });
  });

  it('reason "due" when never run and inside the catch-up window', () => {
    const schedule = L('daily', '08:00'); // fire = today 08:00, NOW = today 10:00 (2h ago)
    const v = isDue(schedule, null, NOW, 6);
    expect(v.due).toBe(true);
    expect(v.reason).toBe('due');
    expect(v.fireAt).toEqual(new Date(2026, 6, 8, 8, 0, 0, 0));
  });

  it('reason "due" at the exact catch-up boundary (inclusive)', () => {
    const schedule = L('daily', '08:00');
    const now = new Date(2026, 6, 8, 14, 0, 0, 0); // exactly 6h after the 08:00 fire
    const v = isDue(schedule, null, now, 6);
    expect(v.due).toBe(true);
    expect(v.reason).toBe('due');
  });

  it('reason "already-ran" when the most recent fire is TODAY and already recorded', () => {
    const schedule = L('daily', '08:00');
    const lastFireAt = new Date(2026, 6, 8, 8, 0, 0, 0).toISOString();
    const v = isDue(schedule, lastFireAt, NOW, 6);
    expect(v.due).toBe(false);
    expect(v.reason).toBe('already-ran');
    expect(v.fireAt).toEqual(new Date(2026, 6, 8, 8, 0, 0, 0));
  });

  it('reason "not-yet" when the most recent fire was an earlier calendar day and already recorded', () => {
    const schedule = L('daily', '18:00');
    const now = new Date(2026, 6, 9, 10, 0, 0, 0); // tomorrow morning, before tomorrow's 18:00
    const lastFireAt = new Date(2026, 6, 8, 18, 0, 0, 0).toISOString(); // yesterday's fire, recorded
    const v = isDue(schedule, lastFireAt, now, 6);
    expect(v.due).toBe(false);
    expect(v.reason).toBe('not-yet');
    expect(v.fireAt).toEqual(new Date(2026, 6, 8, 18, 0, 0, 0));
  });

  it('reason "outside-catchup" when the missed fire is older than the catch-up window', () => {
    const schedule = L('daily', '08:00');
    const now = new Date(2026, 6, 8, 20, 0, 0, 0); // 12h after the 08:00 fire
    const v = isDue(schedule, null, now, 6); // 6h catch-up window
    expect(v.due).toBe(false);
    expect(v.reason).toBe('outside-catchup');
    expect(v.fireAt).toEqual(new Date(2026, 6, 8, 8, 0, 0, 0));
  });

  it('treats a malformed lastFireAt leniently, as if never run', () => {
    const schedule = L('daily', '08:00');
    const v = isDue(schedule, 'not-a-real-date', NOW, 6);
    expect(v.due).toBe(true);
    expect(v.reason).toBe('due');
  });

  it('the DueVerdict.reason type accepts "disabled" for SlugVerdict compatibility — isDue itself never returns it (no `enabled` input; the tick layer decides that one level up before ever calling isDue)', () => {
    const literal: DueVerdict['reason'] = 'disabled'; // compiles — proves the union member exists
    expect(literal).toBe('disabled');
  });
});

describe('formatSchedule', () => {
  it('renders null as "no schedule"', () => {
    expect(formatSchedule(null)).toBe('no schedule');
  });

  it('renders daily', () => {
    expect(formatSchedule(L('daily', '18:00'))).toBe('daily 18:00');
  });

  it('renders a single day', () => {
    expect(formatSchedule(L(['fri'], '17:00'))).toBe('fri 17:00');
  });

  it('renders multiple days', () => {
    expect(formatSchedule(L(['mon', 'wed'], '09:00'))).toBe('mon, wed 09:00');
  });

  it('renders an empty days array as "no schedule"', () => {
    expect(formatSchedule(L([], '09:00'))).toBe('no schedule');
  });

  it('joins slots with " · " and compresses a weekday run into a range', () => {
    expect(formatSchedule(S(
      { kind: 'weekly', days: ['mon'], at: '09:30' },
      { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '16:30' },
    ))).toBe('mon 09:30 · mon–fri 16:30');
  });

  it('renders the calendar cadences', () => {
    expect(formatSchedule(S({ kind: 'weekly', days: ['mon'], at: '10:00', everyWeeks: 2, anchor: '2026-09-28' })))
      .toBe('every 2 weeks mon 10:00');
    expect(formatSchedule(S({ kind: 'monthdays', monthdays: [1, 15, -1], at: '09:00' }))).toBe('monthly 1, 15, last 09:00');
    expect(formatSchedule(S({ kind: 'nth', nth: [{ weekday: 'mon', n: 1 }], at: '09:30' }))).toBe('monthly 1st mon 09:30');
    expect(formatSchedule(S({ kind: 'nth', nth: [{ weekday: 'fri', n: -1 }], at: '17:00' }))).toBe('monthly last fri 17:00');
    expect(formatSchedule(S({ kind: 'cron', cron: '30 9 * * 1' }))).toBe('cron 30 9 * * 1');
  });

  it('still reads a legacy flat { days, at } object handed straight in (runtime tolerance)', () => {
    const legacy = { days: ['mon', 'wed'], at: '09:00' } as unknown as Schedule;
    expect(formatSchedule(legacy)).toBe('mon, wed 09:00');
    expect(mostRecentFire(legacy, NOW)).toEqual(new Date(2026, 6, 8, 9, 0, 0, 0));
  });
});

describe('DST transitions (forced America/New_York, verified 2026 transition dates)', () => {
  let originalTZ: string | undefined;

  beforeEach(() => {
    originalTZ = process.env.TZ;
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  it('spring-forward: a nonexistent wall time (02:30 on 2026-03-08) normalizes FORWARD to 03:30', () => {
    const schedule = L('daily', '02:30');
    const now = new Date(2026, 2, 8, 12, 0, 0, 0); // later the same day
    const fire = mostRecentFire(schedule, now);
    expect(fire).not.toBeNull();
    expect(fire!.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(fire!.getHours()).toBe(3);
    expect(fire!.getDate()).toBe(8);
  });

  it('fall-back: an ambiguous wall time (01:30 on 2026-11-01, which occurs twice) resolves to the FIRST occurrence', () => {
    const schedule = L('daily', '01:30');
    const now = new Date(2026, 10, 1, 12, 0, 0, 0); // later the same day, after both occurrences
    const fire = mostRecentFire(schedule, now);
    expect(fire).not.toBeNull();
    expect(fire!.toISOString()).toBe('2026-11-01T05:30:00.000Z'); // the pre-transition (EDT) instant
    expect(fire!.getHours()).toBe(1);
    expect(fire!.getDate()).toBe(1);
  });
});

// ─── Multiple slots + calendar cadences ─────────────────────────────────────
//
// Fixed dates: Mon 2026-09-28 is the week the h-f funnel agents collapse into
// one agent with `mon 09:30` + `mon–fri 16:30`.

const at = (y: number, m: number, d: number, hh: number, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0);
const FUNNEL = S(
  { kind: 'weekly', days: ['mon'], at: '09:30' },
  { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '16:30' },
);

describe('multi-slot union', () => {
  it('mostRecentFire is the latest across slots, nextFire the earliest', () => {
    expect(mostRecentFire(FUNNEL, at(2026, 9, 28, 10))).toEqual(at(2026, 9, 28, 9, 30));
    expect(nextFire(FUNNEL, at(2026, 9, 28, 10))).toEqual(at(2026, 9, 28, 16, 30));
    expect(nextFire(FUNNEL, at(2026, 9, 28, 17))).toEqual(at(2026, 9, 29, 16, 30));
    // Friday evening → Monday's FIRST slot, not Monday's 16:30.
    expect(nextFire(FUNNEL, at(2026, 10, 2, 17))).toEqual(at(2026, 10, 5, 9, 30));
  });

  it('two slots on the same day both fire — "already-ran" does not swallow the second', () => {
    const ran0930 = at(2026, 9, 28, 9, 30).toISOString();
    expect(isDue(FUNNEL, null, at(2026, 9, 28, 9, 31), 6)).toMatchObject({ due: true, reason: 'due', fireAt: at(2026, 9, 28, 9, 30) });
    expect(isDue(FUNNEL, ran0930, at(2026, 9, 28, 12), 6)).toMatchObject({ due: false, reason: 'already-ran' });
    expect(isDue(FUNNEL, ran0930, at(2026, 9, 28, 16, 31), 6)).toMatchObject({ due: true, reason: 'due', fireAt: at(2026, 9, 28, 16, 30) });
  });

  it('the next day waits for its own slot, then fires once', () => {
    const ranMon1630 = at(2026, 9, 28, 16, 30).toISOString();
    expect(isDue(FUNNEL, ranMon1630, at(2026, 9, 29, 10), 6)).toMatchObject({ due: false, reason: 'not-yet' });
    expect(isDue(FUNNEL, ranMon1630, at(2026, 9, 29, 16, 40), 6)).toMatchObject({ due: true, fireAt: at(2026, 9, 29, 16, 30) });
  });

  it('catch-up collapse: both of a day\'s slots missed → only the most recent fires, and the earlier is behind the watermark', () => {
    const lastFri = at(2026, 9, 25, 16, 30).toISOString();
    const v = isDue(FUNNEL, lastFri, at(2026, 9, 28, 17), 6);
    expect(v).toMatchObject({ due: true, fireAt: at(2026, 9, 28, 16, 30) });
    // Once that one fire records its watermark, the missed 09:30 is never owed.
    const after = isDue(FUNNEL, at(2026, 9, 28, 16, 30).toISOString(), at(2026, 9, 28, 17, 5), 6);
    expect(after).toMatchObject({ due: false, reason: 'already-ran' });
  });

  it('fireSlotLabel names the slot from the fire moment, even for a late catch-up', () => {
    expect(fireSlotLabel(FUNNEL, at(2026, 9, 28, 9, 30))).toBe('mon 09:30');
    expect(fireSlotLabel(FUNNEL, at(2026, 9, 29, 16, 30))).toBe('mon–fri 16:30');
    expect(fireSlotLabel(FUNNEL, new Date(2026, 8, 28, 10, 2, 13))).toBeNull(); // a manual run
    expect(fireSlotLabel(null, at(2026, 9, 28, 9, 30))).toBeNull();
    const overlap = S({ kind: 'weekly', days: ['mon'], at: '09:30' }, { kind: 'weekly', days: 'daily', at: '09:30' });
    expect(fireSlotLabel(overlap, at(2026, 9, 28, 9, 30))).toBe('mon 09:30 + daily 09:30');
  });
});

describe('every N weeks (anchor parity)', () => {
  const BI = S({ kind: 'weekly', days: ['mon'], at: '10:00', everyWeeks: 2, anchor: '2026-09-28' });

  it('fires in the anchor week and every second week after it', () => {
    expect(nextFire(BI, at(2026, 9, 27, 12))).toEqual(at(2026, 9, 28, 10));
    expect(nextFire(BI, at(2026, 9, 28, 11))).toEqual(at(2026, 10, 12, 10));
    expect(mostRecentFire(BI, at(2026, 10, 7, 12))).toEqual(at(2026, 9, 28, 10));
    expect(mostRecentFire(BI, at(2026, 10, 12, 10))).toEqual(at(2026, 10, 12, 10));
  });

  it('parity holds before the anchor too', () => {
    expect(mostRecentFire(BI, at(2026, 9, 27, 12))).toEqual(at(2026, 9, 14, 10));
  });

  it('a mid-week anchor fixes the WEEK, not the day', () => {
    const thuAnchor = S({ kind: 'weekly', days: ['mon'], at: '10:00', everyWeeks: 2, anchor: '2026-10-01' });
    expect(nextFire(thuAnchor, at(2026, 9, 27, 12))).toEqual(at(2026, 9, 28, 10));
  });

  it('several days in a fire week all fire, the off week is skipped', () => {
    const monThu = S({ kind: 'weekly', days: ['mon', 'thu'], at: '10:00', everyWeeks: 2, anchor: '2026-09-28' });
    expect(nextFire(monThu, at(2026, 9, 28, 11))).toEqual(at(2026, 10, 1, 10));
    expect(nextFire(monThu, at(2026, 10, 1, 11))).toEqual(at(2026, 10, 12, 10));
  });

  it('every_weeks without an anchor is refused, and a YAML date anchor is read as its calendar date', () => {
    expect(parseScheduleDetailed({ days: ['mon'], at: '10:00', every_weeks: 2 }).error).toMatch(/needs an anchor/);
    expect(parseSchedule({ days: ['mon'], at: '10:00', every_weeks: 2, anchor: new Date(Date.UTC(2026, 8, 28)) }))
      .toEqual(S({ kind: 'weekly', days: ['mon'], at: '10:00', everyWeeks: 2, anchor: '2026-09-28' }));
    // every_weeks: 1 is just weekly.
    expect(parseSchedule({ days: ['mon'], at: '10:00', every_weeks: 1 })).toEqual(L(['mon'], '10:00'));
  });
});

describe('days of the month', () => {
  const LAST = S({ kind: 'monthdays', monthdays: [-1], at: '09:00' });

  it('-1 is the last day: Feb 28 in a common year, Feb 29 in a leap year, the 30th in a 30-day month', () => {
    expect(nextFire(LAST, at(2026, 2, 10, 12))).toEqual(at(2026, 2, 28, 9));
    expect(nextFire(LAST, at(2028, 2, 10, 12))).toEqual(at(2028, 2, 29, 9));
    expect(nextFire(LAST, at(2026, 4, 5, 12))).toEqual(at(2026, 4, 30, 9));
    expect(nextFire(LAST, at(2026, 1, 31, 9, 1))).toEqual(at(2026, 2, 28, 9));
  });

  it('-2 is the second to last day', () => {
    expect(nextFire(S({ kind: 'monthdays', monthdays: [-2], at: '09:00' }), at(2026, 2, 1, 12))).toEqual(at(2026, 2, 27, 9));
  });

  it('a day a month lacks does not fire that month (31 skips April)', () => {
    expect(nextFire(S({ kind: 'monthdays', monthdays: [31], at: '09:00' }), at(2026, 4, 1, 12))).toEqual(at(2026, 5, 31, 9));
  });

  it('several days: most recent and next pick the right neighbours', () => {
    const m = S({ kind: 'monthdays', monthdays: [1, 15, -1], at: '09:00' });
    expect(mostRecentFire(m, at(2026, 9, 20, 12))).toEqual(at(2026, 9, 15, 9));
    expect(nextFire(m, at(2026, 9, 20, 12))).toEqual(at(2026, 9, 30, 9));
    expect(nextFire(m, at(2026, 9, 30, 10))).toEqual(at(2026, 10, 1, 9));
  });
});

describe('nth weekday of the month', () => {
  it('1st mon of Oct 2026 is the 5th (the 1st is a Thursday)', () => {
    expect(nextFire(S({ kind: 'nth', nth: [{ weekday: 'mon', n: 1 }], at: '09:30' }), at(2026, 9, 29, 12))).toEqual(at(2026, 10, 5, 9, 30));
  });

  it('last fri (-1) of Oct 2026 is the 30th', () => {
    expect(nextFire(S({ kind: 'nth', nth: [{ weekday: 'fri', n: -1 }], at: '17:00' }), at(2026, 10, 1, 12))).toEqual(at(2026, 10, 30, 17));
  });

  it('last mon of Sep 2026 is the 28th, and a 5th mon skips months that have only four', () => {
    expect(mostRecentFire(S({ kind: 'nth', nth: [{ weekday: 'mon', n: -1 }], at: '09:00' }), at(2026, 9, 30, 12))).toEqual(at(2026, 9, 28, 9));
    expect(nextFire(S({ kind: 'nth', nth: [{ weekday: 'mon', n: 5 }], at: '09:00' }), at(2026, 9, 1, 12))).toEqual(at(2026, 11, 30, 9));
  });
});

describe('cron slots (5-field, local time)', () => {
  const C = (cron: string) => S({ kind: 'cron', cron });

  it('matches the equivalent structured slot', () => {
    expect(nextFire(C('30 9 * * 1'), at(2026, 9, 29, 12))).toEqual(at(2026, 10, 5, 9, 30));
  });

  it('lists, ranges, steps, names and 7-for-Sunday', () => {
    expect(mostRecentFire(C('0 9,17 * * 1-5'), at(2026, 9, 28, 18))).toEqual(at(2026, 9, 28, 17));
    expect(nextFire(C('*/15 * * * *'), at(2026, 9, 28, 10, 7))).toEqual(at(2026, 9, 28, 10, 15));
    expect(nextFire(C('0 9 * * 7'), at(2026, 9, 28, 12))).toEqual(at(2026, 10, 4, 9));
    expect(nextFire(C('0 9 * oct mon'), at(2026, 9, 1, 12))).toEqual(at(2026, 10, 5, 9));
  });

  it('day-of-month and weekday both restricted → either one matches (Vixie cron)', () => {
    expect(nextFire(C('0 9 1 * 1'), at(2026, 9, 29, 12))).toEqual(at(2026, 10, 1, 9));
  });

  it('a once-per-leap-year cron is still found', () => {
    expect(nextFire(C('0 9 29 2 *'), at(2026, 3, 1, 12))).toEqual(at(2028, 2, 29, 9));
  });

  it('refuses malformed expressions with the field named', () => {
    expect(parseCron('61 * * * *')).toMatchObject({ error: expect.stringMatching(/minute/) });
    expect(parseCron('* * *')).toMatchObject({ error: expect.stringMatching(/5 fields/) });
    expect(parseScheduleDetailed({ cron: '0 25 * * *' }).error).toMatch(/cron .*hour/);
  });
});

describe('parse errors name the broken slot', () => {
  it.each([
    [{ slots: [{ days: ['mon'], at: '09:30' }, { monthdays: [0], at: '09:00' }] }, /^slot 2: monthdays/],
    [{ slots: [{ days: ['mon'], monthdays: [1], at: '09:30' }] }, /^slot 1: .*one cadence per slot/],
    [{ slots: [{ days: ['mon'], at: '09:30', every_week: 2 }] }, /^slot 1: unknown key every_week/],
    [{ slots: [{ cron: '30 9 * * 1', at: '09:30' }] }, /^slot 1: a cron slot carries its own time/],
    [{ slots: [{ nth: [{ weekday: 'mon', n: 6 }], at: '09:30' }] }, /^slot 1: nth/],
    [{ slots: [] }, /non-empty/],
    [{ slots: [{ days: ['mon'], at: '09:30' }], days: 'daily' }, /both slots and days/],
    [{ monthdays: [1], at: '09:00', anchor: '2026-09-28' }, /anchor only applies/],
  ])('%j', (input, re) => {
    const r = parseScheduleDetailed(input);
    expect(r.schedule).toBeNull();
    expect(r.error).toMatch(re);
  });

  it('no schedule at all is not an error', () => {
    expect(parseScheduleDetailed(null)).toEqual({ schedule: null, error: null });
    expect(parseScheduleDetailed(undefined)).toEqual({ schedule: null, error: null });
  });
});

describe('serialization — the legacy shape is unchanged', () => {
  it('one weekly slot writes the exact legacy { days, at }', () => {
    expect(serializeSchedule(parseSchedule({ days: 'daily', at: '18:00' }))).toEqual({ days: 'daily', at: '18:00' });
    expect(serializeSchedule(parseSchedule({ days: ['mon', 'wed'], at: '09:00' }))).toEqual({ days: ['mon', 'wed'], at: '09:00' });
  });

  it('several slots write { slots } and every cadence round-trips through YAML', async () => {
    const { default: matter } = await import('gray-matter');
    const all = S(
      { kind: 'weekly', days: ['mon'], at: '09:30' },
      { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '16:30' },
      { kind: 'weekly', days: ['mon'], at: '10:00', everyWeeks: 2, anchor: '2026-09-28' },
      { kind: 'monthdays', monthdays: [1, 15, -1], at: '09:00' },
      { kind: 'nth', nth: [{ weekday: 'mon', n: 1 }, { weekday: 'fri', n: -1 }], at: '09:30' },
      { kind: 'cron', cron: '30 9 * * 1' },
    );
    const yaml = matter.stringify('body', { schedule: serializeSchedule(all) });
    expect(parseSchedule(matter(yaml).data.schedule)).toEqual(all);
  });

  it('a hand-written YAML slot list (unquoted anchor date, day range string) parses', async () => {
    const { default: matter } = await import('gray-matter');
    const yaml = [
      '---',
      'schedule:',
      '  slots:',
      "    - { days: [mon], at: '09:30' }",
      "    - { days: mon-fri, at: '16:30' }",
      "    - { days: [mon], at: '10:00', every_weeks: 2, anchor: 2026-09-28 }",
      "    - { monthdays: [1, 15, last], at: '09:00' }",
      "    - { nth: [1st-mon, { weekday: fri, n: -1 }], at: '09:30' }",
      '---',
      '',
    ].join('\n');
    const r = parseScheduleDetailed(matter(yaml).data.schedule);
    expect(r.error).toBeNull();
    expect(formatSchedule(r.schedule)).toBe(
      'mon 09:30 · mon–fri 16:30 · every 2 weeks mon 10:00 · monthly 1, 15, last 09:00 · monthly 1st mon, last fri 09:30',
    );
  });
});

describe('the --slot string grammar', () => {
  const TODAY = at(2026, 9, 28, 8);

  it.each([
    ['mon@09:30', { kind: 'weekly', days: ['mon'], at: '09:30' }],
    ['mon-fri@16:30', { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '16:30' }],
    ['mon–fri 16:30', { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '16:30' }],
    ['daily@7:05', { kind: 'weekly', days: 'daily', at: '07:05' }],
    ['2w:mon@10:00', { kind: 'weekly', days: ['mon'], at: '10:00', everyWeeks: 2, anchor: '2026-09-28' }],
    ['2w/2026-10-05:mon,thu@10:00', { kind: 'weekly', days: ['mon', 'thu'], at: '10:00', everyWeeks: 2, anchor: '2026-10-05' }],
    ['month:1,15,last@09:00', { kind: 'monthdays', monthdays: [1, 15, -1], at: '09:00' }],
    ['month:1st-mon@09:30', { kind: 'nth', nth: [{ weekday: 'mon', n: 1 }], at: '09:30' }],
    ['month:last-fri,2nd-tue@17:00', { kind: 'nth', nth: [{ weekday: 'fri', n: -1 }, { weekday: 'tue', n: 2 }], at: '17:00' }],
    ['cron:30 9 * * 1', { kind: 'cron', cron: '30 9 * * 1' }],
  ])('%s', (spec, slot) => {
    const r = parseSlotSpec(spec, TODAY);
    expect(r).toEqual({ slot });
    // …and slotSpec prints something that reads back to the same slot.
    expect(parseSlotSpec(slotSpec(slot as ScheduleSlot), TODAY)).toEqual({ slot });
  });

  it.each([
    ['garbage', /expected/],
    ['month:1,1st-mon@09:00', /two --slot/],
    ['mon@25:00', /expected|not a 24h/],
    ['2w:mon@10:00x', /expected/],
    ['0w:mon@10:00', /every_weeks/],
  ])('refuses %s', (spec, re) => {
    const r = parseSlotSpec(spec, TODAY);
    expect('error' in r && r.error).toMatch(re);
  });
});

describe('calendar cadences across DST (forced America/New_York)', () => {
  let originalTZ: string | undefined;
  beforeEach(() => { originalTZ = process.env.TZ; process.env.TZ = 'America/New_York'; });
  afterEach(() => { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; });

  it('biweekly parity survives the spring-forward week (weeks counted in whole days)', () => {
    const bi = S({ kind: 'weekly', days: ['mon'], at: '09:00', everyWeeks: 2, anchor: '2026-03-02' });
    const next = nextFire(bi, new Date(2026, 2, 3, 12));
    expect(next).toEqual(new Date(2026, 2, 16, 9));
    expect(next!.toISOString()).toBe('2026-03-16T13:00:00.000Z'); // EDT
  });

  it('a biweekly fire on the fall-back day resolves to the first 01:30', () => {
    const bi = S({ kind: 'weekly', days: ['sun'], at: '01:30', everyWeeks: 2, anchor: '2026-10-18' });
    expect(mostRecentFire(bi, new Date(2026, 10, 1, 12))!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('a month-day slot on the spring-forward day normalizes forward, same date', () => {
    const md = S({ kind: 'monthdays', monthdays: [8], at: '02:30' });
    const fire = mostRecentFire(md, new Date(2026, 2, 8, 12));
    expect(fire!.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(fire!.getDate()).toBe(8);
  });

  it('the two-slot union is still due once per slot across the DST boundary', () => {
    // Mon 2026-11-02, the day after fall-back.
    const ran0930 = new Date(2026, 10, 2, 9, 30).toISOString();
    expect(isDue(FUNNEL, ran0930, new Date(2026, 10, 2, 16, 45), 6)).toMatchObject({ due: true, fireAt: new Date(2026, 10, 2, 16, 30) });
  });
});
