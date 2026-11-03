/**
 * Owner, 2026-11-03: the $200 plan was renamed and no longer has a 5-hour session limit. The
 * panel must (1) name the plan the account's own profile names, and (2) draw no 5-hour row and
 * run no session logic for an account whose USAGE DATA has no 5-hour window. Both are derived
 * from the data, never from a plan-name table.
 *
 * Shapes below are the ones read on the owner's machine (read-only, 2026-11-03), with the
 * identity fields replaced by fictional ones:
 *   • the account whose profile says `planDisplayName: "Ultra"` (subscriptionType still "max"):
 *     cache `five_hour: null`, `limits[]` = weekly_all + weekly_scoped only; `/usage` prints the
 *     week lines and no "Current session" line;
 *   • an idle Team account: cache `five_hour: { utilization: 0, resets_at: null }`, and `/usage`
 *     still prints "Current session: 0% used" — it HAS a window, just not running.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountPlanName, readCliUsageCache } from '../../src/lib/claude-usage.js';
import { mergeUsageReadings } from '../../src/lib/claude-usage-meter.js';
import { parseUsageReport, withLockedReasons } from '../../src/lib/claude-usage-report.js';
import { chooseAccount } from '../../src/lib/claude-account-switch.js';
import { sandboxDirFor, writeClaudeAccounts, type ClaudeAccount } from '../../src/lib/claude-accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-no-session-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  rmSync(HOME, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-03T20:00:00Z');
const WEEK_RESET = '2026-11-05T00:59:59+00:00';
const ULTRA = sandboxDirFor('ultra-account', HOME);
const TEAM = sandboxDirFor('team-account', HOME);

const ultraAccount: ClaudeAccount = {
  id: 'ultra-account', accountUuid: '', email: 'ultra@example.com', organizationUuid: '',
  organizationName: '', tier: 'max', configDir: ULTRA, preferred: true,
};
const teamAccount: ClaudeAccount = { ...ultraAccount, id: 'team-account', email: 'team@example.com', tier: 'team', configDir: TEAM, preferred: false };

function write(dir: string, blob: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(blob), 'utf-8');
}

const ultraBlob = {
  oauthAccount: { accountUuid: 'uuid-ultra', emailAddress: 'ultra@example.com', planDisplayName: 'Ultra', organizationType: 'claude_max' },
  cachedUsageUtilization: {
    fetchedAtMs: NOW, accountUuid: 'uuid-ultra',
    utilization: {
      five_hour: null,
      seven_day: { utilization: 100, resets_at: WEEK_RESET },
      limits: [
        { kind: 'weekly_all', percent: 100, resets_at: WEEK_RESET },
        { kind: 'weekly_scoped', percent: 0, resets_at: WEEK_RESET, scope: { model: { display_name: 'Fable' } } },
      ],
    },
  },
};
const idleTeamBlob = {
  oauthAccount: { accountUuid: 'uuid-team', emailAddress: 'team@example.com' },
  cachedUsageUtilization: {
    fetchedAtMs: NOW, accountUuid: 'uuid-team',
    utilization: {
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 32, resets_at: WEEK_RESET },
      limits: [{ kind: 'session', percent: 0, resets_at: null }, { kind: 'weekly_all', percent: 32, resets_at: WEEK_RESET }],
    },
  },
};

describe('the usage data decides whether an account HAS a 5-hour window', () => {
  it('cache: five_hour null and no session entry = no 5-hour window; the week is still read', () => {
    write(ULTRA, ultraBlob);
    const r = readCliUsageCache(ULTRA);
    expect(r.noSessionWindow).toBe(true);
    expect(r.limits.map((l) => l.key)).toEqual(['weekly']);
  });

  it('cache: an IDLE window (utilization 0, no reset) is a window, not "no window"', () => {
    write(TEAM, idleTeamBlob);
    expect(readCliUsageCache(TEAM).noSessionWindow).toBeUndefined();
  });

  it('cache: a five_hour key that is simply absent stays "unknown", never "no window"', () => {
    const blob = structuredClone(ultraBlob) as any;
    delete blob.cachedUsageUtilization.utilization.five_hour;
    write(ULTRA, blob);
    expect(readCliUsageCache(ULTRA).noSessionWindow).toBeUndefined();
  });

  it('live report: the week and no session line = no 5-hour window', () => {
    const ultra = [
      'You are currently using your subscription to power your Claude Code usage', '',
      'Current week (all models): 100% used · resets Nov 5 at 3:59am (Europe/Istanbul)',
      'Current week (Fable): 0% used · resets Nov 5 at 3:59am (Europe/Istanbul)', '',
      "What's contributing to your usage?", 'Approximate · sessions on this machine only · shares overlap',
      'Last 24h · 7672 requests · 81 sessions',
    ].join('\n');
    const r = parseUsageReport(ultra, NOW)!;
    expect(r.noSessionWindow).toBe(true);
    expect(r.limits.map((l) => l.key)).toEqual(['weekly']);
    // The lock merge keeps the fact.
    expect(withLockedReasons(r, { limits: [{ key: 'weekly', percent: 100, resetsAt: NOW + 1, lockedReason: 'x' }], fetchedAtMs: NOW }, NOW).noSessionWindow).toBe(true);
  });

  it('live report: "Current session: 0% used" is a window; a session line we cannot parse is unknown', () => {
    const team = 'Current session: 0% used\nCurrent week (all models): 100% used · resets Nov 4 at 2:59am (Europe/Istanbul)';
    expect(parseUsageReport(team, NOW)!.noSessionWindow).toBeUndefined();
    const odd = 'Current session: n/a\nCurrent week (all models): 40% used · resets Nov 4 at 2:59am (Europe/Istanbul)';
    expect(parseUsageReport(odd, NOW)!.noSessionWindow).toBeUndefined();
  });

  it('merge: the fact survives a newer meter without a session, and a meter WITH one ends it', () => {
    const cache = { limits: [{ key: 'weekly' as const, percent: 90, resetsAt: NOW + 3_600_000 }], fetchedAtMs: NOW - 60_000, noSessionWindow: true as const };
    const weekOnly = { limits: [{ key: 'weekly' as const, percent: 91, resetsAt: NOW + 3_600_000 }], fetchedAtMs: NOW };
    expect(mergeUsageReadings(cache, weekOnly, NOW).noSessionWindow).toBe(true);
    const withSession = { limits: [{ key: 'session' as const, percent: 5, resetsAt: NOW + 3_600_000 }, ...weekOnly.limits], fetchedAtMs: NOW };
    expect(mergeUsageReadings(cache, withSession, NOW).noSessionWindow).toBeUndefined();
  });

  it('chooser: an account with no 5-hour window is FULLY measured by its week, not a "partial" one', () => {
    const resetsAt = NOW + 3 * 24 * 3_600_000;
    const choice = chooseAccount([
      { id: 'ultra', limits: { limits: [{ key: 'weekly', percent: 20, resetsAt }], fetchedAtMs: NOW, noSessionWindow: true } },
    ], { threshold: 90, now: NOW });
    expect(choice.accountId).toBe('ultra');
    expect(choice.partial).toBeUndefined();
    // Same reading WITHOUT the fact: one window unread, so it is partial.
    const blind = chooseAccount([{ id: 'x', limits: { limits: [{ key: 'weekly', percent: 20, resetsAt }], fetchedAtMs: NOW } }], { threshold: 90, now: NOW });
    expect(blind.partial).toBe(true);
  });
});

describe('the plan badge names what the account itself reports', () => {
  it('planDisplayName from the account\'s own profile ("Ultra"), not a mapping of "max"', () => {
    writeClaudeAccounts([ultraAccount, teamAccount], HOME);
    write(ULTRA, ultraBlob);
    expect(accountPlanName(ultraAccount, HOME)).toBe('Ultra');
  });

  it('no profile name (a Team seat): null, so the badge falls back to the sign-in type', () => {
    write(TEAM, idleTeamBlob);
    expect(accountPlanName(teamAccount, HOME)).toBeNull();
  });

  it('a folder signed in as ANOTHER account never lends its plan name', () => {
    write(TEAM, { ...ultraBlob });            // the team row's folder now holds the Ultra account
    expect(accountPlanName(teamAccount, HOME)).toBeNull();
  });
});
