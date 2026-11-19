/**
 * Hackathon criterion 6: the limit is time plus a weekly share. Share used survives a weekly reset;
 * at the ceiling no new round starts; at the session guard no new turn starts and the strip says
 * why; Devam (guardOverride) resumes; no reading means "yalnız süre".
 */
import { describe, expect, it } from 'vitest';
import { judgeLimit, readingLabel, readingOf, shareUsed, ONLY_TIME } from '../../src/lib/hackathon/limit.js';
import type { UsageReading } from '../../src/lib/hackathon/run-store.js';

const H = 3600_000;
const reading = (weekly: number | null, session: number | null, weeklyResetsAt = 10 * H, extra: Partial<UsageReading> = {}): UsageReading =>
  ({ weeklyPercent: weekly, weeklyResetsAt, sessionPercent: session, sessionResetsAt: 2 * H, at: 0, ...extra });
const limit = { endsAt: new Date(100 * H).toISOString(), weeklyShareCeiling: 15, sessionGuard: 80 };

describe('shareUsed', () => {
  it('is the climb inside one weekly window', () => {
    expect(shareUsed(reading(40, 0), reading(49, 0))).toBe(9);
  });
  it('adds the climb before a reset to the new window', () => {
    // started at 90, last seen 96 before the reset, now 4 in the new window: 6 + 4.
    expect(shareUsed(reading(90, 0, 10 * H), reading(4, 0, 178 * H), 96)).toBe(10);
  });
  it('is null without a reading', () => {
    expect(shareUsed(null, reading(10, 0))).toBeNull();
    expect(shareUsed(reading(null, 0), reading(10, 0))).toBeNull();
  });
});

describe('judgeLimit', () => {
  it('stops new rounds at the ceiling', () => {
    const v = judgeLimit({ limit, start: reading(40, 10), now: reading(55, 10), at: 0 });
    expect(v.newRound).toBe(false);
    expect(v.newTurn).toBe(true);
    expect(v.reason).toMatch(/%15/);
  });
  it('pauses new turns at 81% of the 5-hour window and says why', () => {
    const v = judgeLimit({ limit, start: reading(40, 10), now: reading(42, 81), at: 0 });
    expect(v.newTurn).toBe(false);
    expect(v.reason).toMatch(/5 saatlik pencere %81/);
  });
  it('Devam resumes past the guard', () => {
    const v = judgeLimit({ limit, start: reading(40, 10), now: reading(42, 81), at: 0, guardOverride: true });
    expect(v.newTurn).toBe(true);
    expect(v.reason).toBeNull();
  });
  it('no new round past the end time', () => {
    const v = judgeLimit({ limit, start: null, now: null, at: 101 * H });
    expect(v.newRound).toBe(false);
  });
  it('with no reading the strip says yalnız süre', () => {
    const v = judgeLimit({ limit, start: null, now: null, at: 0 });
    expect(v.reading).toBe('no-reading');
    expect(readingLabel(v, 15)).toContain(ONLY_TIME);
  });
  it('a reading with no session window is labelled', () => {
    const v = judgeLimit({ limit, start: reading(40, null), now: reading(42, null, 10 * H, { noSessionWindow: true }), at: 0 });
    expect(readingLabel(v, 15)).toMatch(/pencere yok/);
  });
});

describe('readingOf', () => {
  it('returns null when the account has no limits', () => {
    expect(readingOf({ limits: [] } as never)).toBeNull();
  });
});
