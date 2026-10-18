/**
 * `claude-limit-rejections.ts` — the memory that makes the fix STAY fixed.
 *
 * Reacting to a refusal without remembering it means the next turn re-reads the same
 * percentage that just lied, clears the walled account, and walks back into it. That is the
 * loop the 2026-09-05 screenshot captured: the user's "devam" came back byte-identical.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COOLDOWN_MS,
  claudeRejectionsFilePath,
  clearAccountRejection,
  endRefusalOnReading,
  readAccountRejections,
  readingEndsRefusal,
  recordAccountRejection,
} from '../../src/lib/claude-limit-rejections.js';
import type { LimitSignal } from '../../src/lib/claude-limit-signal.js';
import { sandboxDirFor, writeClaudeAccounts, type ClaudeAccount } from '../../src/lib/claude-accounts.js';

const NOW = Date.parse('2026-09-05T00:00:00Z');
const HOUR = 3_600_000;

let HOME: string;
beforeEach(() => { HOME = mkdtempSync(join(tmpdir(), 'dc-rejections-')); });
afterEach(() => { rmSync(HOME, { recursive: true, force: true }); });

const stated = (resetsAtMs: number): LimitSignal =>
  ({ window: 'session', resetsAtMs, via: 'quotaLimits', detail: 'group_zero_credit_limit' });
const guessed: LimitSignal = { window: 'unknown', resetsAtMs: null, via: 'syntheticText' };

describe('a refusal is written down', () => {
  it('a STATED reset becomes the exile, exactly', () => {
    const entry = recordAccountRejection('a', stated(NOW + 2 * HOUR), HOME, NOW);
    expect(entry.until).toBe(NOW + 2 * HOUR);
    expect(entry.estimated).toBeUndefined();
    expect(entry.window).toBe('session');
    expect(entry.detail).toBe('group_zero_credit_limit');
    expect(readAccountRejections(HOME, NOW).a?.until).toBe(NOW + 2 * HOUR);
  });

  it('no stated reset still records, on a bounded GUESS that says it is one', () => {
    // The text reader carries no time. Recording nothing there would make the weakest signal
    // also the most useless one — and the text reader is the one that cannot go missing.
    const entry = recordAccountRejection('a', guessed, HOME, NOW);
    expect(entry.until).toBe(NOW + DEFAULT_COOLDOWN_MS);
    expect(entry.estimated).toBe(true);
  });

  it('a reset already in the PAST falls back to the guess, never to "not rejected"', () => {
    const entry = recordAccountRejection('a', stated(NOW - HOUR), HOME, NOW);
    expect(entry.until).toBe(NOW + DEFAULT_COOLDOWN_MS);
    expect(entry.estimated).toBe(true);
  });

  it('an absurd reset is capped — one frame must not exile an account for a month', () => {
    const entry = recordAccountRejection('a', stated(NOW + 400 * 86_400_000), HOME, NOW);
    expect(entry.until).toBeLessThanOrEqual(NOW + 8 * 86_400_000);
  });
});

describe('it expires on its own', () => {
  it('an elapsed rejection is not returned', () => {
    recordAccountRejection('a', stated(NOW + HOUR), HOME, NOW);
    expect(readAccountRejections(HOME, NOW + 30 * 60_000).a).toBeDefined();
    expect(readAccountRejections(HOME, NOW + 2 * HOUR).a).toBeUndefined();
  });

  it('a probe that proves the window reopened can clear it early', () => {
    recordAccountRejection('a', stated(NOW + HOUR), HOME, NOW);
    clearAccountRejection('a', HOME, NOW);
    expect(readAccountRejections(HOME, NOW).a).toBeUndefined();
  });
});

describe('two panes share one quota', () => {
  it('the LONGER exile wins, so a guess cannot shorten a known reset', () => {
    // Pane 1 learned a real `resetsAt` two hours out. Pane 2 hit the same wall a second later
    // but only got the text reader, whose guess is 20 minutes. Letting the guess win would
    // send both panes back into the wall 100 minutes early.
    recordAccountRejection('a', stated(NOW + 2 * HOUR), HOME, NOW);
    const merged = recordAccountRejection('a', guessed, HOME, NOW + 1000);
    expect(merged.until).toBe(NOW + 2 * HOUR);
    expect(merged.estimated).toBeUndefined();
  });

  it('but a LATER stated reset does extend it', () => {
    recordAccountRejection('a', guessed, HOME, NOW);
    const merged = recordAccountRejection('a', stated(NOW + 3 * HOUR), HOME, NOW + 1000);
    expect(merged.until).toBe(NOW + 3 * HOUR);
    expect(merged.estimated).toBeUndefined();
  });

  it('accounts do not contaminate each other', () => {
    recordAccountRejection('a', stated(NOW + HOUR), HOME, NOW);
    recordAccountRejection('b', stated(NOW + 2 * HOUR), HOME, NOW);
    const all = readAccountRejections(HOME, NOW);
    expect(all.a!.until).toBe(NOW + HOUR);
    expect(all.b!.until).toBe(NOW + 2 * HOUR);
  });
});

describe('totality — a bad file degrades to the old behaviour, never to a crash', () => {
  it('a missing file reads as "nothing is rejected"', () => {
    expect(readAccountRejections(HOME, NOW)).toEqual({});
  });

  it('malformed JSON reads as "nothing is rejected"', () => {
    mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
    writeFileSync(claudeRejectionsFilePath(HOME), '{not json', 'utf-8');
    expect(readAccountRejections(HOME, NOW)).toEqual({});
  });

  it('entries with an unusable `until` are dropped, not defaulted', () => {
    mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
    writeFileSync(claudeRejectionsFilePath(HOME), JSON.stringify({
      rejected: { a: { until: 'soon' }, b: {}, c: { until: NOW + HOUR } },
    }), 'utf-8');
    expect(Object.keys(readAccountRejections(HOME, NOW))).toEqual(['c']);
  });

  it('an unrecognised window reads as `unknown`, so the surface never claims a wrong cap', () => {
    mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
    writeFileSync(claudeRejectionsFilePath(HOME), JSON.stringify({
      rejected: { a: { until: NOW + HOUR, window: 'fortnightly' } },
    }), 'utf-8');
    expect(readAccountRejections(HOME, NOW).a!.window).toBe('unknown');
  });
});

// ── 2026-10-18 ────────────────────────────────────────────────────────────────────────
// The preferred account was refused at 15:49 on its weekly limit ("resets Oct 20 at 7am"). By
// 16:48 its own cache read weekly 0%, session 3%, with the SAME Oct 20 reset: the week had been
// reset early. Nothing could see it — a refused account is never chosen, so it never served the
// turn whose meter would have cleared it — and every message was moved off it until Tuesday.
describe('a later reading of the account can end its refusal early', () => {
  const MIN = 60_000;
  const WEEK_RESET = NOW + 37 * HOUR;
  const SESSION_RESET = NOW + 4 * HOUR;
  const weekly: LimitSignal = { window: 'weekly', resetsAtMs: WEEK_RESET, via: 'quotaLimits' };

  const primary: ClaudeAccount = {
    id: 'primary', accountUuid: '', email: 'Owner@Example.com', organizationUuid: 'org-a',
    organizationName: 'org-a', tier: 'max', configDir: null, preferred: true,
  };

  /** A `.claude.json` the CLI would write: who is signed in, and what it last measured. */
  function writeConfig(dir: string, o: {
    uuid?: string; email?: string; org?: string; cacheUuid?: string | null;
    fetchedAtMs: number; session?: [number, number]; week?: [number, number]; lockedWeek?: boolean;
  }): void {
    mkdirSync(dir, { recursive: true });
    const iso = (ms: number) => new Date(ms + 237).toISOString(); // the CLI's own sub-second stamps
    const [sp, sr] = o.session ?? [3, SESSION_RESET];
    const [wp, wr] = o.week ?? [0, WEEK_RESET];
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({
      oauthAccount: { accountUuid: o.uuid ?? 'uuid-a', emailAddress: o.email ?? 'owner@example.com', organizationUuid: o.org ?? 'org-a' },
      cachedUsageUtilization: {
        fetchedAtMs: o.fetchedAtMs,
        ...(o.cacheUuid === null ? {} : { accountUuid: o.cacheUuid ?? o.uuid ?? 'uuid-a' }),
        utilization: {
          five_hour: { utilization: sp, resets_at: iso(sr) },
          seven_day: { utilization: wp, resets_at: iso(wr), ...(o.lockedWeek ? { locked_reason: 'weekly_limit_reached' } : {}) },
        },
      },
    }));
  }

  const onDisk = (): Record<string, unknown> =>
    (JSON.parse(readFileSync(claudeRejectionsFilePath(HOME), 'utf-8')) as { rejected: Record<string, unknown> }).rejected;

  beforeEach(() => { writeClaudeAccounts([primary], HOME); });

  it('THE INCIDENT: the account\'s own cache reads the same week with room, so the weekly refusal is over', () => {
    recordAccountRejection('primary', weekly, HOME, NOW);
    writeConfig(HOME, { fetchedAtMs: NOW + 59 * MIN });
    expect(readAccountRejections(HOME, NOW + HOUR).primary).toBeUndefined();
    // Cleared on disk too, not only hidden from this read.
    expect(onDisk()).not.toHaveProperty('primary');
  });

  it('before the refusal settles, a reading proves nothing', () => {
    recordAccountRejection('primary', weekly, HOME, NOW);
    writeConfig(HOME, { fetchedAtMs: NOW + MIN });
    expect(readAccountRejections(HOME, NOW + HOUR).primary).toBeDefined();
  });

  it('a week that resets at another time is another window, and leaves the refusal', () => {
    // A per-model cap, or another account's numbers: either way not the window that refused.
    recordAccountRejection('primary', weekly, HOME, NOW);
    writeConfig(HOME, { fetchedAtMs: NOW + 59 * MIN, week: [0, WEEK_RESET + 3 * HOUR] });
    expect(readAccountRejections(HOME, NOW + HOUR).primary).toBeDefined();
  });

  it('a week still near full, or locked, leaves it', () => {
    recordAccountRejection('primary', weekly, HOME, NOW);
    writeConfig(HOME, { fetchedAtMs: NOW + 59 * MIN, week: [95, WEEK_RESET] });
    expect(readAccountRejections(HOME, NOW + HOUR).primary).toBeDefined();
    writeConfig(HOME, { fetchedAtMs: NOW + 59 * MIN, lockedWeek: true });
    expect(readAccountRejections(HOME, NOW + HOUR).primary).toBeDefined();
  });

  it('a reading that cannot be proven to be THIS account never ends it', () => {
    recordAccountRejection('primary', weekly, HOME, NOW);
    const at = NOW + 59 * MIN;
    for (const other of [
      { email: 'someone-else@example.com' },     // the directory is signed in as someone else
      { org: 'org-b' },                          // same email, another organization's seat
      { cacheUuid: 'uuid-z' },                   // the cache measured another credential
      { cacheUuid: null },                       // the cache names no account at all
    ]) {
      writeConfig(HOME, { fetchedAtMs: at, ...other });
      expect(readAccountRejections(HOME, NOW + HOUR).primary, JSON.stringify(other)).toBeDefined();
    }
    // A register that knows the uuid checks the uuid, whatever the email says.
    writeClaudeAccounts([{ ...primary, accountUuid: 'uuid-registered' }], HOME);
    writeConfig(HOME, { fetchedAtMs: at });
    expect(readAccountRejections(HOME, NOW + HOUR).primary).toBeDefined();
  });

  it('an account missing from the register keeps its refusal', () => {
    recordAccountRejection('gone', weekly, HOME, NOW);
    writeConfig(HOME, { fetchedAtMs: NOW + 59 * MIN });
    expect(readAccountRejections(HOME, NOW + HOUR).gone).toBeDefined();
  });

  it('a sandbox account is judged from its OWN directory', () => {
    const sandbox: ClaudeAccount = {
      ...primary, id: 'second', email: 'b@example.com', accountUuid: 'uuid-b',
      configDir: sandboxDirFor('second', HOME), preferred: false,
    };
    writeClaudeAccounts([primary, sandbox], HOME);
    recordAccountRejection('second', weekly, HOME, NOW);
    // The real HOME's cache with room says nothing about the sandbox account.
    writeConfig(HOME, { fetchedAtMs: NOW + 59 * MIN });
    expect(readAccountRejections(HOME, NOW + HOUR).second).toBeDefined();
    writeConfig(sandbox.configDir!, { uuid: 'uuid-b', email: 'b@example.com', fetchedAtMs: NOW + 59 * MIN });
    expect(readAccountRejections(HOME, NOW + HOUR).second).toBeUndefined();
  });

  it('a guessed refusal has no reset to match: room in its window is enough', () => {
    recordAccountRejection('primary', { window: 'session', resetsAtMs: null, via: 'syntheticText' }, HOME, NOW);
    writeConfig(HOME, { fetchedAtMs: NOW + 5 * MIN });
    expect(readAccountRejections(HOME, NOW + 6 * MIN).primary).toBeUndefined();
  });

  it('a refusal that never named its window needs room in both', () => {
    recordAccountRejection('primary', guessed, HOME, NOW);
    writeConfig(HOME, { fetchedAtMs: NOW + 5 * MIN, week: [95, WEEK_RESET] });
    expect(readAccountRejections(HOME, NOW + 6 * MIN).primary).toBeDefined();
    writeConfig(HOME, { fetchedAtMs: NOW + 5 * MIN });
    expect(readAccountRejections(HOME, NOW + 6 * MIN).primary).toBeUndefined();
  });

  it('a refusal recorded after one proven over starts fresh, not on the old one\'s longer exile', () => {
    recordAccountRejection('primary', weekly, HOME, NOW);
    writeConfig(HOME, { fetchedAtMs: NOW + 59 * MIN, session: [100, SESSION_RESET] });
    // The session fills an hour later. Merged with the week that is already over, it would be
    // exiled until the old weekly reset instead of its own.
    const entry = recordAccountRejection('primary', stated(SESSION_RESET), HOME, NOW + HOUR);
    expect(entry.until).toBe(SESSION_RESET);
  });

  it('a live reading the cache does not hold yet ends it the same way', () => {
    recordAccountRejection('primary', weekly, HOME, NOW);
    const live = (at: number, percent: number) => ({
      limits: [{ key: 'weekly' as const, percent, resetsAt: WEEK_RESET }], fetchedAtMs: at,
    });
    expect(endRefusalOnReading('primary', live(NOW + MIN, 0), HOME, NOW + MIN)).toBe(false);
    expect(endRefusalOnReading('primary', live(NOW + 5 * MIN, 92), HOME, NOW + 5 * MIN)).toBe(false);
    expect(endRefusalOnReading('primary', live(NOW + 5 * MIN, 0), HOME, NOW + 5 * MIN)).toBe(true);
    expect(onDisk()).not.toHaveProperty('primary');
  });

  it('the rule itself: a stated reset must name the refused window, a window already past proves nothing', () => {
    const refusal = { until: WEEK_RESET, window: 'weekly' as const, at: NOW };
    const reading = (resetsAt: number) => ({ limits: [{ key: 'weekly' as const, percent: 0, resetsAt }], fetchedAtMs: NOW + 5 * MIN });
    expect(readingEndsRefusal(refusal, reading(WEEK_RESET + 90_000), NOW + 6 * MIN)).toBe(true); // a report's minute precision
    expect(readingEndsRefusal(refusal, reading(WEEK_RESET + 3 * MIN), NOW + 6 * MIN)).toBe(false);
    // With no stated reset to match, a window that has already rolled over still proves nothing.
    const guess = { ...refusal, estimated: true };
    expect(readingEndsRefusal(guess, reading(NOW + HOUR), NOW + 6 * MIN)).toBe(true);
    expect(readingEndsRefusal(guess, reading(NOW + 5 * MIN), NOW + 6 * MIN)).toBe(false);
    // Only the refused window counts: room in the session says nothing about the week.
    expect(readingEndsRefusal(refusal, {
      limits: [{ key: 'session', percent: 0, resetsAt: WEEK_RESET }], fetchedAtMs: NOW + 5 * MIN,
    }, NOW + 6 * MIN)).toBe(false);
  });
});
