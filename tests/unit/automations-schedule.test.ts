import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSchedule, mostRecentFire, nextFire, isDue, formatSchedule, type DueVerdict } from '../../src/lib/automations/schedule.js';
import type { Schedule } from '../../src/lib/automations/types.js';

/** Wed 2026-07-08 10:00 local. Fixed, injected — never Date.now() in assertions. */
const NOW = new Date(2026, 6, 8, 10, 0, 0, 0);

describe('parseSchedule', () => {
  it('accepts daily + HH:MM', () => {
    expect(parseSchedule({ days: 'daily', at: '18:00' })).toEqual({ days: 'daily', at: '18:00' });
  });

  it('accepts an explicit weekday array', () => {
    expect(parseSchedule({ days: ['mon', 'wed'], at: '09:00' })).toEqual({ days: ['mon', 'wed'], at: '09:00' });
  });

  it('accepts a comma-separated day string ("mon,wed")', () => {
    expect(parseSchedule({ days: 'mon,wed', at: '09:00' })).toEqual({ days: ['mon', 'wed'], at: '09:00' });
  });

  it('accepts a single-day array', () => {
    expect(parseSchedule({ days: ['fri'], at: '17:00' })).toEqual({ days: ['fri'], at: '17:00' });
  });

  it('normalizes a single-digit hour to zero-padded HH:MM', () => {
    expect(parseSchedule({ days: 'daily', at: '9:00' })).toEqual({ days: 'daily', at: '09:00' });
  });

  it('normalizes a dot separator', () => {
    expect(parseSchedule({ days: 'daily', at: '18.00' })).toEqual({ days: 'daily', at: '18:00' });
  });

  it('is case-insensitive and trims whitespace on day names', () => {
    expect(parseSchedule({ days: [' MON ', 'Wed'], at: '09:00' })).toEqual({ days: ['mon', 'wed'], at: '09:00' });
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
    const schedule: Schedule = { days: 'daily', at: '08:00' };
    const fire = mostRecentFire(schedule, NOW); // NOW is 10:00, 08:00 already passed
    expect(fire).toEqual(new Date(2026, 6, 8, 8, 0, 0, 0));
  });

  it('falls back to yesterday when today\'s time has not yet arrived', () => {
    const schedule: Schedule = { days: 'daily', at: '18:00' };
    const fire = mostRecentFire(schedule, NOW); // NOW is 10:00, 18:00 hasn't happened yet today
    expect(fire).toEqual(new Date(2026, 6, 7, 18, 0, 0, 0));
  });

  it('midnight wrap: a near-midnight schedule looks back to yesterday, not forward to today', () => {
    const schedule: Schedule = { days: 'daily', at: '23:59' };
    const now = new Date(2026, 6, 8, 0, 1, 0, 0); // just after midnight
    const fire = mostRecentFire(schedule, now);
    expect(fire).toEqual(new Date(2026, 6, 7, 23, 59, 0, 0));
  });

  it('midnight wrap: a midnight schedule does not over-wrap when today\'s slot already passed', () => {
    const schedule: Schedule = { days: 'daily', at: '00:00' };
    const now = new Date(2026, 6, 8, 23, 55, 0, 0); // just before next midnight
    const fire = mostRecentFire(schedule, now);
    expect(fire).toEqual(new Date(2026, 6, 8, 0, 0, 0, 0));
  });

  it('week wrap: a single weekday earlier in the week resolves within a few days back', () => {
    const schedule: Schedule = { days: ['mon'], at: '09:00' };
    const fire = mostRecentFire(schedule, NOW); // NOW is Wed 2026-07-08
    expect(fire).toEqual(new Date(2026, 6, 6, 9, 0, 0, 0)); // Mon 2026-07-06
  });

  it('week wrap: today\'s own weekday whose time has not yet passed wraps a full 7 days back', () => {
    const schedule: Schedule = { days: ['wed'], at: '18:00' }; // today is Wed, 18:00 hasn't happened
    const fire = mostRecentFire(schedule, NOW);
    expect(fire).toEqual(new Date(2026, 6, 1, 18, 0, 0, 0)); // 2026-07-01, exactly 7 days back
  });

  it('matches a multi-day array against the current day directly', () => {
    const schedule: Schedule = { days: ['mon', 'wed'], at: '09:00' };
    const fire = mostRecentFire(schedule, NOW); // Wed 10:00 — today's 09:00 already passed
    expect(fire).toEqual(new Date(2026, 6, 8, 9, 0, 0, 0));
  });

  it('returns null when the schedule has no valid day (empty array)', () => {
    const schedule: Schedule = { days: [], at: '09:00' };
    expect(mostRecentFire(schedule, NOW)).toBeNull();
  });

  it('returns null for an unparseable "at" on a hand-built schedule', () => {
    const schedule = { days: 'daily', at: 'garbage' } as unknown as Schedule;
    expect(mostRecentFire(schedule, NOW)).toBeNull();
  });
});

describe('nextFire', () => {
  it('returns later today when the time has not yet passed', () => {
    const schedule: Schedule = { days: 'daily', at: '18:00' };
    expect(nextFire(schedule, NOW)).toEqual(new Date(2026, 6, 8, 18, 0, 0, 0));
  });

  it('rolls to tomorrow when today\'s time has already passed', () => {
    const schedule: Schedule = { days: 'daily', at: '08:00' };
    expect(nextFire(schedule, NOW)).toEqual(new Date(2026, 6, 9, 8, 0, 0, 0));
  });

  it('week wrap forward: the next matching weekday several days ahead', () => {
    const schedule: Schedule = { days: ['mon'], at: '09:00' };
    expect(nextFire(schedule, NOW)).toEqual(new Date(2026, 6, 13, 9, 0, 0, 0)); // next Mon 2026-07-13
  });

  it('returns null when the schedule has no valid day (empty array)', () => {
    const schedule: Schedule = { days: [], at: '09:00' };
    expect(nextFire(schedule, NOW)).toBeNull();
  });
});

describe('isDue — every DueVerdict.reason variant', () => {
  it('reason "no-schedule" when schedule is null', () => {
    const v = isDue(null, null, NOW, 6);
    expect(v).toEqual({ due: false, fireAt: null, reason: 'no-schedule' });
  });

  it('reason "no-schedule" when schedule has no valid day (mostRecentFire is null)', () => {
    const v = isDue({ days: [], at: '09:00' }, null, NOW, 6);
    expect(v).toEqual({ due: false, fireAt: null, reason: 'no-schedule' });
  });

  it('reason "due" when never run and inside the catch-up window', () => {
    const schedule: Schedule = { days: 'daily', at: '08:00' }; // fire = today 08:00, NOW = today 10:00 (2h ago)
    const v = isDue(schedule, null, NOW, 6);
    expect(v.due).toBe(true);
    expect(v.reason).toBe('due');
    expect(v.fireAt).toEqual(new Date(2026, 6, 8, 8, 0, 0, 0));
  });

  it('reason "due" at the exact catch-up boundary (inclusive)', () => {
    const schedule: Schedule = { days: 'daily', at: '08:00' };
    const now = new Date(2026, 6, 8, 14, 0, 0, 0); // exactly 6h after the 08:00 fire
    const v = isDue(schedule, null, now, 6);
    expect(v.due).toBe(true);
    expect(v.reason).toBe('due');
  });

  it('reason "already-ran" when the most recent fire is TODAY and already recorded', () => {
    const schedule: Schedule = { days: 'daily', at: '08:00' };
    const lastFireAt = new Date(2026, 6, 8, 8, 0, 0, 0).toISOString();
    const v = isDue(schedule, lastFireAt, NOW, 6);
    expect(v.due).toBe(false);
    expect(v.reason).toBe('already-ran');
    expect(v.fireAt).toEqual(new Date(2026, 6, 8, 8, 0, 0, 0));
  });

  it('reason "not-yet" when the most recent fire was an earlier calendar day and already recorded', () => {
    const schedule: Schedule = { days: 'daily', at: '18:00' };
    const now = new Date(2026, 6, 9, 10, 0, 0, 0); // tomorrow morning, before tomorrow's 18:00
    const lastFireAt = new Date(2026, 6, 8, 18, 0, 0, 0).toISOString(); // yesterday's fire, recorded
    const v = isDue(schedule, lastFireAt, now, 6);
    expect(v.due).toBe(false);
    expect(v.reason).toBe('not-yet');
    expect(v.fireAt).toEqual(new Date(2026, 6, 8, 18, 0, 0, 0));
  });

  it('reason "outside-catchup" when the missed fire is older than the catch-up window', () => {
    const schedule: Schedule = { days: 'daily', at: '08:00' };
    const now = new Date(2026, 6, 8, 20, 0, 0, 0); // 12h after the 08:00 fire
    const v = isDue(schedule, null, now, 6); // 6h catch-up window
    expect(v.due).toBe(false);
    expect(v.reason).toBe('outside-catchup');
    expect(v.fireAt).toEqual(new Date(2026, 6, 8, 8, 0, 0, 0));
  });

  it('treats a malformed lastFireAt leniently, as if never run', () => {
    const schedule: Schedule = { days: 'daily', at: '08:00' };
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
    expect(formatSchedule({ days: 'daily', at: '18:00' })).toBe('every day at 18:00');
  });

  it('renders a single day', () => {
    expect(formatSchedule({ days: ['fri'], at: '17:00' })).toBe('fri at 17:00');
  });

  it('renders multiple days', () => {
    expect(formatSchedule({ days: ['mon', 'wed'], at: '09:00' })).toBe('mon, wed at 09:00');
  });

  it('renders an empty days array as "no schedule"', () => {
    expect(formatSchedule({ days: [], at: '09:00' })).toBe('no schedule');
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
    const schedule: Schedule = { days: 'daily', at: '02:30' };
    const now = new Date(2026, 2, 8, 12, 0, 0, 0); // later the same day
    const fire = mostRecentFire(schedule, now);
    expect(fire).not.toBeNull();
    expect(fire!.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(fire!.getHours()).toBe(3);
    expect(fire!.getDate()).toBe(8);
  });

  it('fall-back: an ambiguous wall time (01:30 on 2026-11-01, which occurs twice) resolves to the FIRST occurrence', () => {
    const schedule: Schedule = { days: 'daily', at: '01:30' };
    const now = new Date(2026, 10, 1, 12, 0, 0, 0); // later the same day, after both occurrences
    const fire = mostRecentFire(schedule, now);
    expect(fire).not.toBeNull();
    expect(fire!.toISOString()).toBe('2026-11-01T05:30:00.000Z'); // the pre-transition (EDT) instant
    expect(fire!.getHours()).toBe(1);
    expect(fire!.getDate()).toBe(1);
  });
});
