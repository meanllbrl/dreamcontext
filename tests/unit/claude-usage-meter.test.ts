import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  meterEndsRefusal, meterFrameAllowed, meterShowsRoomSince, mergeUsageReadings, readUsageMeter, readUsageMeterFrame, recordUsageMeter, usageMeterFilePath,
} from '../../src/lib/claude-usage-meter.js';
import { readUsageLimits, type UsageLimitsResponse } from '../../src/lib/claude-usage.js';

/**
 * EVERY TURN'S OWN USAGE READING IS KEPT. Owner, 2026-10-16: the account panel was "almost
 * always wrong, always stale" — two accounts at 100%, the top one still labelled as where new
 * sessions start. The CLI's cache is rewritten at most every five minutes and only on demand,
 * while each turn emits the frame below with both windows exactly.
 */

/** VERBATIM from a healthy `claude -p` turn on claude 2.1.301, 2026-10-16 (ids shortened). */
const LIVE_FRAME = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', resetsAt: 1792183800, rateLimitType: 'five_hour', overageStatus: 'rejected',
    overageDisabledReason: 'group_zero_credit_limit', isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.09, resetsAt: 1792183800 },
      seven_day: { utilization: 0.16, resetsAt: 1792440000 },
    },
  },
  uuid: '04b98237', session_id: '1bcaa800',
};
const AT = 1792166000000;

describe('reading the per-turn frame', () => {
  it('a captured frame reads as both windows, in percent and epoch ms', () => {
    expect(readUsageMeterFrame(LIVE_FRAME, AT)).toEqual({
      limits: [
        { key: 'session', percent: 9, resetsAt: 1792183800000 },
        { key: 'weekly', percent: 16, resetsAt: 1792440000000 },
      ],
      fetchedAtMs: AT,
    });
    expect(meterFrameAllowed(LIVE_FRAME)).toBe(true);
  });

  it('anything else is null, never a guess', () => {
    expect(readUsageMeterFrame({ type: 'assistant' })).toBeNull();
    expect(readUsageMeterFrame({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBeNull();
    expect(readUsageMeterFrame({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 'x' } } } })).toBeNull();
    // A window with no reset cannot be labelled; the other one still counts.
    const one = readUsageMeterFrame({
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5 }, seven_day: { utilization: 0.2, resetsAt: 1792440000 } } },
    }, AT);
    expect(one?.limits.map((l) => l.key)).toEqual(['weekly']);
  });

  it('a refused frame is not "allowed"', () => {
    expect(meterFrameAllowed({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })).toBe(false);
    expect(meterFrameAllowed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })).toBe(true);
  });
});

describe('merging the CLI cache with the meter', () => {
  const cache = (fetchedAtMs: number, session: number, weekly: number, extra: Partial<{ scope: string; lockedReason: string }> = {}): UsageLimitsResponse => ({
    limits: [
      { key: 'session', percent: session, resetsAt: AT + 3_600_000, ...(extra.lockedReason ? { lockedReason: extra.lockedReason } : {}) },
      { key: 'weekly', percent: weekly, resetsAt: AT + 86_400_000, ...(extra.scope ? { scope: extra.scope } : {}) },
    ],
    fetchedAtMs,
  });

  it('the newer source wins each window', () => {
    const merged = mergeUsageReadings(cache(AT - 3_600_000, 40, 10), cache(AT, 95, 12), AT);
    expect(merged.limits.map((l) => l.percent)).toEqual([95, 12]);
    expect(merged.fetchedAtMs).toBe(AT);
    // An older meter loses to a newer cache.
    expect(mergeUsageReadings(cache(AT, 40, 10), cache(AT - 60_000, 95, 12), AT).limits.map((l) => l.percent)).toEqual([40, 10]);
  });

  it('no meter, the cache alone', () => {
    const c = cache(AT, 40, 10);
    expect(mergeUsageReadings(c, null, AT)).toBe(c);
  });

  it('a scoped weekly cap that still binds is kept even when older — usage only climbs in a window', () => {
    const merged = mergeUsageReadings(cache(AT - 3_600_000, 40, 80, { scope: 'Fable' }), cache(AT, 45, 30), AT);
    expect(merged.limits.find((l) => l.key === 'weekly')).toMatchObject({ percent: 80, scope: 'Fable' });
  });

  it('a lock from an older cache does not survive a newer served turn', () => {
    const merged = mergeUsageReadings(cache(AT - 3_600_000, 100, 10, { lockedReason: 'five_hour' }), cache(AT, 3, 10), AT);
    expect(merged.limits.find((l) => l.key === 'session')?.lockedReason).toBeUndefined();
  });
});

describe('the store', () => {
  let home: string;
  let sandbox: string;
  const realHome = process.env.HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-usage-meter-'));
    sandbox = join(home, '.dreamcontext', 'claude-accounts', 'second');
    mkdirSync(sandbox, { recursive: true });
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('records and reads back per config dir; the file is private', () => {
    const r = readUsageMeterFrame(LIVE_FRAME, AT)!;
    recordUsageMeter(sandbox, r, home);
    expect(readUsageMeter(sandbox, home)).toEqual(r);
    expect(readUsageMeter(join(home, 'other'), home)).toBeNull();
    expect(statSync(usageMeterFilePath(home)).mode & 0o777).toBe(0o600);
  });

  it('an unchanged reading inside 30s is not rewritten; a changed one is', () => {
    const r = readUsageMeterFrame(LIVE_FRAME, AT)!;
    recordUsageMeter(sandbox, r, home);
    recordUsageMeter(sandbox, { ...r, fetchedAtMs: AT + 5_000 }, home);
    expect(readUsageMeter(sandbox, home)?.fetchedAtMs).toBe(AT);
    const changed = { limits: [{ ...r.limits[0]!, percent: 10 }, r.limits[1]!], fetchedAtMs: AT + 6_000 };
    recordUsageMeter(sandbox, changed, home);
    expect(readUsageMeter(sandbox, home)).toEqual(changed);
  });

  // Multi-review, 2026-10-17: several processes share this file and the last rename wins, so a
  // late writer holding an older, lower number used to overwrite a fuller account's reading.
  it('inside one window usage only climbs: a later, lower reading keeps the higher percent', () => {
    const resetsAt = AT + 3_600_000;
    recordUsageMeter(sandbox, { limits: [{ key: 'session', percent: 95, resetsAt }], fetchedAtMs: AT }, home);
    recordUsageMeter(sandbox, { limits: [{ key: 'session', percent: 88, resetsAt: resetsAt + 1_000 }], fetchedAtMs: AT + 60_000 }, home);
    expect(readUsageMeter(sandbox, home)?.limits[0]?.percent).toBe(95);
    expect(readUsageMeter(sandbox, home)?.fetchedAtMs).toBe(AT + 60_000);
    // A new window (another reset) starts over.
    recordUsageMeter(sandbox, { limits: [{ key: 'session', percent: 4, resetsAt: resetsAt + 5 * 3_600_000 }], fetchedAtMs: AT + 120_000 }, home);
    expect(readUsageMeter(sandbox, home)?.limits[0]?.percent).toBe(4);
  });

  it('a corrupt file is no reading, and the next record replaces it', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(usageMeterFilePath(home), '{not json');
    expect(readUsageMeter(sandbox, home)).toBeNull();
    recordUsageMeter(sandbox, readUsageMeterFrame(LIVE_FRAME, AT)!, home);
    expect(readUsageMeter(sandbox, home)?.limits).toHaveLength(2);
  });

  // The point of the whole change: every reader of account usage sees the turn's reading
  // without being told the meter exists.
  it('readUsageLimits returns the fresher per-turn reading over an hour-old CLI cache', () => {
    process.env.HOME = home;
    writeFileSync(join(sandbox, '.claude.json'), JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: AT - 3_600_000,
        utilization: {
          five_hour: { utilization: 40, resets_at: new Date(1792183800000).toISOString() },
          seven_day: { utilization: 10, resets_at: new Date(1792440000000).toISOString() },
        },
      },
    }));
    expect(readUsageLimits(sandbox).limits.map((l) => l.percent)).toEqual([40, 10]);
    recordUsageMeter(sandbox, readUsageMeterFrame(LIVE_FRAME, AT)!, home);
    const fresh = readUsageLimits(sandbox);
    expect(fresh.limits.map((l) => l.percent)).toEqual([9, 16]);
    expect(fresh.fetchedAtMs).toBe(AT);
  });
});

/** Reviewer, 2026-10-16: any `allowed` frame used to end a refusal — including a per-model weekly
 *  cap refused while another model kept serving, seconds after it was written. */
describe('when a served turn ends a remembered refusal', () => {
  const NOW = AT + 10 * 60_000;
  const frame = (five: number, seven: number, status = 'allowed') => ({
    type: 'rate_limit_event',
    rate_limit_info: { status, unifiedWindows: { five_hour: { utilization: five, resetsAt: 1 }, seven_day: { utilization: seven, resetsAt: 1 } } },
  });
  const old = NOW - 5 * 60_000;

  it('a session refusal ends when the five-hour window shows room', () => {
    expect(meterEndsRefusal(frame(0.3, 0.5), { window: 'session', at: old }, NOW)).toBe(true);
    expect(meterEndsRefusal(frame(1, 0.5), { window: 'session', at: old }, NOW)).toBe(false);
  });
  it('a weekly refusal is never ended here — it may be a per-model cap', () => {
    expect(meterEndsRefusal(frame(0.1, 0.1), { window: 'weekly', at: old }, NOW)).toBe(false);
  });
  it('an unknown window needs room in both', () => {
    expect(meterEndsRefusal(frame(0.1, 0.1), { window: 'unknown', at: old }, NOW)).toBe(true);
    expect(meterEndsRefusal(frame(0.1, 1), { window: 'unknown', at: old }, NOW)).toBe(false);
  });
  it('a fresh refusal, a refused frame, or one with no time stands', () => {
    expect(meterEndsRefusal(frame(0.1, 0.1), { window: 'session', at: NOW - 10_000 }, NOW)).toBe(false);
    expect(meterEndsRefusal(frame(0.1, 0.1, 'rejected'), { window: 'session', at: old }, NOW)).toBe(false);
    expect(meterEndsRefusal(frame(0.1, 0.1), { window: 'session' }, NOW)).toBe(false);
  });
});

/** Multi-review, 2026-10-17: the guard against going straight back onto an account just forced
 *  off was lifted by ANY later reading — the forced pane's own finishing turn, or 89.6% where the
 *  probe that forced the move read 90%. */
describe('room to go back to an account a pane was forced off', () => {
  const NOW = AT + 10 * 60_000;
  const at = (percent: number, fetchedAtMs = NOW, resetsAt = NOW + 3_600_000): UsageLimitsResponse =>
    ({ limits: [{ key: 'session', percent, resetsAt }], fetchedAtMs });
  const since = NOW - 60_000;

  it('a reading after the move with clear room says yes', () => {
    expect(meterShowsRoomSince(at(20), since, 90, 2, NOW)).toBe(true);
  });
  it('just under the threshold is not room', () => {
    expect(meterShowsRoomSince(at(89.6), since, 90, 2, NOW)).toBe(false);
    expect(meterShowsRoomSince(at(88), since, 90, 2, NOW)).toBe(false);
    expect(meterShowsRoomSince(at(87.9), since, 90, 2, NOW)).toBe(true);
  });
  it('a reading from before the move, none, or only closed windows says nothing', () => {
    expect(meterShowsRoomSince(at(20, since), since, 90, 2, NOW)).toBe(false);
    expect(meterShowsRoomSince(null, since, 90, 2, NOW)).toBe(false);
    expect(meterShowsRoomSince(at(20, NOW, NOW - 1), since, 90, 2, NOW)).toBe(false);
  });
  it('every open window must have room', () => {
    const both: UsageLimitsResponse = {
      limits: [{ key: 'session', percent: 20, resetsAt: NOW + 3_600_000 }, { key: 'weekly', percent: 95, resetsAt: NOW + 86_400_000 }],
      fetchedAtMs: NOW,
    };
    expect(meterShowsRoomSince(both, since, 90, 2, NOW)).toBe(false);
  });
});
