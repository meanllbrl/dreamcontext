/**
 * `claude-usage-report.ts` — reading the CLI's LIVE `/usage` answer.
 *
 * ── The finding this file exists to pin ───────────────────────────────────────────────
 * THE CACHE IS NOT THE ANSWER; THE REPORT IS. Measured 2026-09-07 on CLI 2.1.259, twice on
 * the same account minutes apart: with a 3-minute-old `cachedUsageUtilization` the command
 * printed a full report (session 2%) and left the file untouched; with `fetchedAtMs` backdated
 * six hours the identical command rewrote it. The CLI's own bundle explains it — its writer
 * returns early while the entry is younger than `Uso = 300000`, a 5-minute write throttle.
 *
 * The probe used to define success as "the file moved", so every account read in the last five
 * minutes — i.e. every account with a live session — was reported as unmeasurable. The text
 * below is the VERBATIM report from that measurement, and it is the fixture on purpose: a
 * synthetic one would have hidden the bug just as well as the old fixture did.
 */
import { describe, it, expect } from 'vitest';
import { parseUsageReport, parseResetAt, withLockedReasons } from '../../src/lib/claude-usage-report.js';
import { USAGE_CACHE_MAX_AGE_MS, type UsageLimitsResponse } from '../../src/lib/claude-usage.js';

/** Verbatim `result` from `claude -p "/usage" --output-format json`, CLI 2.1.259. */
const REPORT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 2% used · resets Sep 7 at 4:39pm (Europe/Istanbul)',
  'Current week (all models): 19% used · resets Sep 9 at 2:59am (Europe/Istanbul)',
  'Current week (Fable): 4% used · resets Sep 9 at 2:59am (Europe/Istanbul)',
  '',
  "What's contributing to your limits usage?",
  'Approximate, based on local sessions on this machine — does not include other devices or claude.ai.',
  '',
  'Last 24h · 935 requests · 26 sessions',
  '  59% of your usage was while 4+ sessions ran in parallel',
  '  49% of your usage was at >150k context',
  '  Top skills: /excalidraw 12%, /design 4%',
  '',
  'Last 7d · 9833 requests · 127 sessions',
  '  73% of your usage was at >150k context',
  '  Top subagents: sleep-tasks 1%, sleep-product 1%',
].join('\n');

const NOW = Date.parse('2026-09-07T08:45:00.000Z');

describe('the three lines that carry the numbers', () => {
  it('reads the session and weekly percentages, and stamps the reading NOW', () => {
    const res = parseUsageReport(REPORT, NOW);
    expect(res).not.toBeNull();
    expect(res!.fetchedAtMs).toBe(NOW);
    // 4:39pm in Europe/Istanbul (UTC+3) — resolved through the NAMED zone, so this expectation
    // holds whatever the host's own timezone is.
    expect(res!.limits.find((l) => l.key === 'session')).toEqual({
      key: 'session', percent: 2, resetsAt: Date.parse('2026-09-07T13:39:00.000Z'),
    });
  });

  it('ignores the behaviour tail, which is where the percentages are NOT', () => {
    // "59% of your usage was while 4+ sessions ran in parallel" is not a limit, and a
    // 2026-09-05 note in this codebase read this tail as the whole report and concluded such
    // accounts publish no percentages at all.
    const res = parseUsageReport(REPORT, NOW)!;
    expect(res.limits).toHaveLength(2);
    expect(res.limits.map((l) => l.percent)).toEqual([2, 19]);
  });

  it('draws ONE weekly bar: the all-models cap while it is the higher one', () => {
    const weekly = parseUsageReport(REPORT, NOW)!.limits.find((l) => l.key === 'weekly');
    expect(weekly).toEqual({ key: 'weekly', percent: 19, resetsAt: Date.parse('2026-09-08T23:59:00.000Z') });
  });

  it('switches the weekly bar to the SCOPED cap when that one binds, and names the model', () => {
    const text = REPORT
      .replace('Current week (all models): 19%', 'Current week (all models): 10%')
      .replace('Current week (Fable): 4%', 'Current week (Fable): 61%');
    const weekly = parseUsageReport(text, NOW)!.limits.find((l) => l.key === 'weekly');
    expect(weekly?.percent).toBe(61);
    expect(weekly?.scope).toBe('Fable');
  });

  it('takes a lone scoped week as the weekly bar', () => {
    const text = 'Current week (Fable): 44% used · resets Sep 9 at 2:59am (Europe/Istanbul)';
    expect(parseUsageReport(text, NOW)!.limits).toEqual([
      { key: 'weekly', percent: 44, resetsAt: Date.parse('2026-09-08T23:59:00.000Z'), scope: 'Fable' },
    ]);
  });
});

describe('nothing is invented from a report that does not carry it', () => {
  it('a report with no percentage line at all is null, NOT an empty account', () => {
    // The caller must fall back to the cache. A zero-filled reading here would make an
    // unmeasurable account look like the emptiest one on the machine.
    expect(parseUsageReport('Last 24h · 935 requests · 26 sessions', NOW)).toBeNull();
    expect(parseUsageReport('', NOW)).toBeNull();
    expect(parseUsageReport(undefined as never, NOW)).toBeNull();
  });

  it('a percent outside 0-100 DROPS its window rather than clamping', () => {
    // A clamped "100%" would tell the user they are out of quota when what actually happened
    // is that the format changed under us.
    const text = 'Current session: 140% used · resets Sep 7 at 4:39pm (Europe/Istanbul)';
    expect(parseUsageReport(text, NOW)).toBeNull();
  });

  it('keeps a MEASURED percent whose reset line did not parse', () => {
    // Dropping a real number because a DATE failed is how an account becomes unmeasurable —
    // the exact class of bug this module exists to end. `resetsAt: 0` reads as "no reset to
    // show" downstream and the bar survives.
    const res = parseUsageReport('Current session: 37% used · resets whenever', NOW)!;
    expect(res.limits).toEqual([{ key: 'session', percent: 37, resetsAt: 0 }]);
  });

  it('is tolerant about case, spacing and decimals — the numbers are what matter', () => {
    // Deliberately loose: a cosmetic change to the CLI's own formatting must not blind the
    // reader, because the failure mode of blindness here is a switch decision made without
    // numbers. The percent and the reset are the only things read strictly.
    expect(parseUsageReport('current session :  7.5 % used', NOW)!.limits[0]!.percent).toBe(7.5);
    expect(parseUsageReport('Current session: 7.5% used', NOW)!.limits[0]!.percent).toBe(7.5);
    expect(parseUsageReport('CURRENT WEEK (ALL MODELS): 12% used', NOW)!.limits[0]).toEqual(
      { key: 'weekly', percent: 12, resetsAt: 0 },
    );
  });
});

describe('parseResetAt — the year is not printed, so it is inferred', () => {
  it('resolves a named zone through the real offset at that instant', () => {
    expect(parseResetAt('resets Sep 7 at 4:39pm (Europe/Istanbul)', NOW))
      .toBe(Date.parse('2026-09-07T13:39:00.000Z'));
  });

  it('reads a reset ON THE HOUR, where the CLI omits the minutes', () => {
    // MEASURED on three accounts in the same minute: `2:30pm` for one window, but `11pm` and
    // `3am` for others — the CLI drops `:00`. Demanding `H:MM` lost the reset on exactly the
    // windows whose reset is a round hour, which is most weekly windows.
    expect(parseResetAt('resets Sep 7 at 11pm (Europe/Istanbul)', NOW))
      .toBe(Date.parse('2026-09-07T20:00:00.000Z'));
    expect(parseResetAt('resets Sep 9 at 3am (Europe/Istanbul)', NOW))
      .toBe(Date.parse('2026-09-09T00:00:00.000Z'));
    expect(parseResetAt('resets Sep 7 at 12am (UTC)', NOW)).toBe(Date.parse('2026-09-07T00:00:00.000Z'));
    expect(parseResetAt('resets Sep 7 at 12pm (UTC)', NOW)).toBe(Date.parse('2026-09-07T12:00:00.000Z'));
  });

  it('reads a 24-hour clock, for a locale that prints no am/pm', () => {
    expect(parseResetAt('resets Sep 7 at 15:00 (UTC)', NOW)).toBe(Date.parse('2026-09-07T15:00:00.000Z'));
    expect(parseResetAt('resets Sep 7 at 23 (UTC)', NOW)).toBe(Date.parse('2026-09-07T23:00:00.000Z'));
    // 24 is not an hour, with or without minutes.
    expect(parseResetAt('resets Sep 7 at 24:00 (UTC)', NOW)).toBeNull();
  });

  it('falls back to the HOST zone when no zone is named', () => {
    expect(parseResetAt('resets Sep 7 at 4:39pm', NOW))
      .toBe(new Date(2026, 8, 7, 16, 39, 0, 0).getTime());
  });

  it('falls back to the HOST zone when the named zone is not a real one', () => {
    expect(parseResetAt('resets Sep 7 at 4:39pm (Mars/Olympus_Mons)', NOW))
      .toBe(new Date(2026, 8, 7, 16, 39, 0, 0).getTime());
  });

  it('crosses the new year to the NEAREST candidate, not to the printed year', () => {
    const newYearsEve = Date.parse('2026-12-31T21:00:00.000Z');
    // "Jan 1" printed on Dec 31 means NEXT year, and the naive `thisYear` would land 12
    // months in the past.
    expect(parseResetAt('resets Jan 1 at 2:00am (UTC)', newYearsEve))
      .toBe(Date.parse('2027-01-01T02:00:00.000Z'));
    // And the mirror image: "Dec 31" printed on Jan 1 belongs to the year just gone.
    expect(parseResetAt('resets Dec 31 at 11:00pm (UTC)', Date.parse('2027-01-01T01:00:00.000Z')))
      .toBe(Date.parse('2026-12-31T23:00:00.000Z'));
  });

  it('honours an explicitly printed year', () => {
    expect(parseResetAt('resets Sep 7, 2028 at 4:39pm (UTC)', NOW)).toBeNull();  // beyond sanity
    expect(parseResetAt('resets Sep 9, 2026 at 2:00am (UTC)', NOW))
      .toBe(Date.parse('2026-09-09T02:00:00.000Z'));
  });

  it('refuses a date too far from now to be a reset of a 5-hour or 7-day window', () => {
    expect(parseResetAt('resets Feb 3 at 1:00am (UTC)', NOW)).toBeNull();
  });

  it('refuses an impossible clock or an unknown month', () => {
    expect(parseResetAt('resets Sep 7 at 13:39pm (UTC)', NOW)).toBeNull();
    expect(parseResetAt('resets Smarch 7 at 4:39pm (UTC)', NOW)).toBeNull();
    expect(parseResetAt('resets soon', NOW)).toBeNull();
  });
});

describe('withLockedReasons — the one fact only the cache carries', () => {
  const live: UsageLimitsResponse = {
    fetchedAtMs: NOW,
    limits: [{ key: 'session', percent: 3, resetsAt: NOW + 3_600_000 }],
  };
  const cachedWith = (fetchedAtMs: number): UsageLimitsResponse => ({
    fetchedAtMs,
    limits: [{ key: 'session', percent: 99, resetsAt: NOW, lockedReason: 'weekly_limit_reached' }],
  });

  it('carries a lock onto the live reading, and NOTHING else', () => {
    const merged = withLockedReasons(live, cachedWith(NOW - 60_000), NOW);
    expect(merged.limits[0]).toEqual({
      key: 'session', percent: 3, resetsAt: NOW + 3_600_000, lockedReason: 'weekly_limit_reached',
    });
    // The cache's percent and stamp stay where they are — a lock is borrowed, a number is not.
    expect(merged.fetchedAtMs).toBe(NOW);
  });

  it('refuses a lock from a cache Claude Code itself would discard', () => {
    const tooOld = withLockedReasons(live, cachedWith(NOW - USAGE_CACHE_MAX_AGE_MS - 1), NOW);
    expect(tooOld.limits[0]!.lockedReason).toBeUndefined();
    expect(withLockedReasons(live, { limits: [], fetchedAtMs: null }, NOW)).toBe(live);
  });
});
