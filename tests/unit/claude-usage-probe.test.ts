/**
 * `claude-usage-probe.ts` — reading an account's limits WITHOUT switching to it.
 *
 * ── Two findings are pinned here ─────────────────────────────────────────────────────
 * 1. THE ANSWER IS ON STDOUT. Measured 2026-09-07 (CLI 2.1.259), the CLI throttles the
 *    `cachedUsageUtilization` write to once per 5 minutes (`Uso = 300000` in its bundle), so
 *    an account read in the last five minutes prints a full report and leaves the file
 *    untouched. This file's earlier version defined success as "the file moved", which made
 *    every busy account unmeasurable, drew "not measured" across Settings, and left
 *    auto-switch picking by register order with the real percentages unread on disk.
 *
 * 2. THE EXIT CODE IS NOT THE SUCCESS CRITERION EITHER. Also measured: in a config dir with
 *    no credential the probe exits in ~772ms with code 0, `is_error: false`,
 *    `subtype: "success"` and an empty cost summary instead of a report. An implementation
 *    that trusts the exit code reads a signed-out account as "healthy but numberless" and
 *    the needs-relogin signal is never born — worse than a hang, because it looks like
 *    success.
 *
 * So every case below drives the probe through its INJECTED spawn, and the outcome is decided
 * by what came back on stdout, then by the cache's own age and `accountUuid`.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAccountUsage, USAGE_PROBE_TIMEOUT_MS } from '../../src/lib/claude-usage-probe.js';
import { sandboxDirFor, writeClaudeAccounts, type ClaudeAccount } from '../../src/lib/claude-accounts.js';
import { SHARED_SANDBOX_ENTRIES } from '../../src/lib/claude-account-sandbox.js';
import type { ClaudeAuthStatus } from '../../src/lib/claude-auth.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-probe-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  rmSync(HOME, { recursive: true, force: true });
});

const SANDBOX = sandboxDirFor('second-account', HOME);
const ACCOUNT_UUID = 'uuid-b';
const RESET = '2026-09-05T12:00:00+00:00';

const registered: ClaudeAccount = {
  id: 'second-account',
  accountUuid: ACCOUNT_UUID,
  email: 'b@example.com',
  organizationUuid: 'org-b',
  organizationName: 'Org B',
  tier: 'max',
  configDir: SANDBOX,
  preferred: false,
};

/** The real HOME the sandbox shares from, so `ensureSandbox` has targets to link to. */
function writeRealHome(): void {
  const realClaude = join(HOME, '.claude');
  mkdirSync(realClaude, { recursive: true });
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }), 'utf-8');
  for (const entry of SHARED_SANDBOX_ENTRIES) {
    const target = join(realClaude, entry);
    if (entry.includes('.')) writeFileSync(target, '', 'utf-8');
    else mkdirSync(target, { recursive: true });
  }
}

/** Write the sandbox's own `.claude.json` — the file the CLI would own in real life. */
function writeSandboxConfig(blob: unknown): void {
  mkdirSync(SANDBOX, { recursive: true });
  writeFileSync(join(SANDBOX, '.claude.json'), JSON.stringify(blob), 'utf-8');
}

function usageCache(over: { fetchedAtMs?: number; accountUuid?: string; percent?: number } = {}) {
  return {
    fetchedAtMs: over.fetchedAtMs ?? 1_000,
    accountUuid: over.accountUuid ?? ACCOUNT_UUID,
    utilization: {
      five_hour: { utilization: over.percent ?? 30, resets_at: RESET },
      seven_day: { utilization: 40, resets_at: RESET },
    },
  };
}

/** A judge that answers a fixed verdict and records that it was consulted. */
function judge(verdict: Partial<ClaudeAuthStatus>) {
  const calls: Array<{ dir?: string; timeoutMs?: number }> = [];
  const fn = (dir?: string, timeoutMs?: number): Promise<ClaudeAuthStatus> => {
    calls.push({ dir, timeoutMs });
    return Promise.resolve({
      loggedIn: null, supported: true, loginCommand: 'claude auth login', ...verdict,
    } as ClaudeAuthStatus);
  };
  return { fn, calls };
}

/** A judge that must never be reached. */
const noJudge = () => {
  throw new Error('the authoritative judge was consulted when it should not have been');
};

beforeEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  rmSync(join(HOME, '.claude'), { recursive: true, force: true });
  writeRealHome();
  writeClaudeAccounts([registered], HOME);
});

/** The verbatim envelope `claude -p "/usage" --output-format json` prints: the report lives
 *  in `result`, alongside cost accounting and a session id that this codebase never reads. */
function envelope(report: string): string {
  return JSON.stringify({
    is_error: false, num_turns: 0, total_cost_usd: 0, subtype: 'success',
    session_id: '538c6ae3-fffa-434c-a86b-f09eb46d0788', result: report,
  });
}

const LIVE_REPORT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 44% used · resets Sep 5 at 3:00pm (UTC)',
  'Current week (all models): 51% used · resets Sep 9 at 2:59am (UTC)',
].join('\n');

describe('ok — the LIVE REPORT is believed first, whatever the cache did', () => {
  it('reads the report even though the cache never moved (the 5-minute write throttle)', () => {
    // THE REGRESSION. Cache present, recent-looking, and deliberately NOT rewritten by the
    // child — exactly what the CLI does when it was written less than 5 minutes ago. The old
    // criterion called this `healthy-unmeasured`; there are two percentages right here.
    writeSandboxConfig({
      oauthAccount: { accountUuid: ACCOUNT_UUID },
      cachedUsageUtilization: usageCache({ fetchedAtMs: Date.now() - 60_000, percent: 3 }),
    });

    return probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => ({ timedOut: false, stdout: envelope(LIVE_REPORT) }),
    }).then((res) => {
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      // The REPORT's numbers, not the cache's 3%.
      expect(res.limits.limits.map((l) => l.percent)).toEqual([44, 51]);
      expect(res.limits.fetchedAtMs).toBeGreaterThan(Date.now() - 5_000);
    });
  });

  it('reads a bare report too, for a CLI that ignores --output-format', async () => {
    writeSandboxConfig({ oauthAccount: { accountUuid: ACCOUNT_UUID } });
    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => ({ timedOut: false, stdout: LIVE_REPORT }),
    });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.limits.limits[0]!.percent).toBe(44);
  });

  it('carries a LOCK from the cache onto the live reading — the one fact the report omits', async () => {
    const cache = usageCache({ fetchedAtMs: Date.now() - 60_000 }) as unknown as
      { utilization: Record<string, Record<string, unknown>> };
    cache.utilization.five_hour!.locked_reason = 'weekly_limit_reached';
    writeSandboxConfig({ oauthAccount: { accountUuid: ACCOUNT_UUID }, cachedUsageUtilization: cache });

    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => ({ timedOut: false, stdout: envelope(LIVE_REPORT) }),
    });
    expect(res.status).toBe('ok');
    // A locked window is never an auto-switch candidate whatever the percent beside it says,
    // so losing the lock on the way to a fresher percent would be a downgrade.
    if (res.status === 'ok') {
      expect(res.limits.limits.find((l) => l.key === 'session')?.lockedReason).toBe('weekly_limit_reached');
    }
  });
});

describe('ok — the cache, when it moved or is inside the write throttle', () => {
  it('a cache younger than the throttle IS a reading, even with no report at all', async () => {
    // The throttle is the ONLY reason a fetch would not have rewritten it, so its numbers are
    // at most five minutes old. Calling that "unmeasured" is what broke the feature.
    writeSandboxConfig({
      oauthAccount: { accountUuid: ACCOUNT_UUID },
      cachedUsageUtilization: usageCache({ fetchedAtMs: Date.now() - 60_000, percent: 12 }),
    });

    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => ({ timedOut: false }),
    });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.limits.limits.find((l) => l.key === 'session')?.percent).toBe(12);
  });

  it('a cache OLDER than the throttle that did not move is not a reading — it escalates', async () => {
    // Past the throttle the CLI would have rewritten the file had it fetched anything. It
    // did not, so nothing here was measured now, and the honest next step is to ask the
    // judge why rather than to serve an old number as a fresh one.
    writeSandboxConfig({
      oauthAccount: { accountUuid: ACCOUNT_UUID },
      cachedUsageUtilization: usageCache({ fetchedAtMs: Date.now() - 20 * 60_000 }),
    });

    const j = judge({ loggedIn: true, email: 'b@example.com' });
    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: j.fn as never,
      runProbe: async () => ({ timedOut: false }),
    });
    expect(res.status).toBe('healthy-unmeasured');
    expect(j.calls).toHaveLength(1);
  });
});

describe('ok — the cache refreshed AND belongs to this account', () => {
  it('returns the fresh reading', async () => {
    writeSandboxConfig({ oauthAccount: { accountUuid: ACCOUNT_UUID }, cachedUsageUtilization: usageCache({ fetchedAtMs: 1_000 }) });

    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => {
        // What the CLI does: it rewrites the cache with a NEWER fetchedAtMs.
        writeSandboxConfig({
          oauthAccount: { accountUuid: ACCOUNT_UUID },
          cachedUsageUtilization: usageCache({ fetchedAtMs: 2_000, percent: 55 }),
        });
        return { timedOut: false };
      },
    });

    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.limits.limits.find((l) => l.key === 'session')).toEqual({
      key: 'session', percent: 55, resetsAt: Date.parse(RESET),
    });
    expect(res.limits.fetchedAtMs).toBe(2_000);
  });

  it('a first-ever cache (no prior fetchedAtMs) counts as a refresh', async () => {
    writeSandboxConfig({ oauthAccount: { accountUuid: ACCOUNT_UUID } });

    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => {
        writeSandboxConfig({ oauthAccount: { accountUuid: ACCOUNT_UUID }, cachedUsageUtilization: usageCache() });
        return { timedOut: false };
      },
    });

    expect(res.status).toBe('ok');
  });
});

describe('stale — the refreshed cache belongs to a DIFFERENT account', () => {
  it('discards the reading instead of using it', async () => {
    writeSandboxConfig({ cachedUsageUtilization: usageCache({ fetchedAtMs: 1_000 }) });

    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => {
        // Refreshed, but under someone else's uuid — a reading we must not attribute.
        writeSandboxConfig({
          cachedUsageUtilization: usageCache({ fetchedAtMs: 2_000, accountUuid: 'uuid-somebody-else', percent: 2 }),
        });
        return { timedOut: false };
      },
    });

    expect(res.status).toBe('stale');
    // The dangerous failure would be reporting 2% and picking this account as the emptiest.
    expect(JSON.stringify(res)).not.toContain('"percent"');
  });

  it('discards a perfectly readable REPORT too — identity outranks every source', async () => {
    // A directory signed in as someone else prints a valid report for the WRONG quota pool.
    // The check has to guard the report as well as the cache, or the fix to one reopens the
    // hole in the other.
    writeSandboxConfig({
      oauthAccount: { accountUuid: 'uuid-somebody-else' },
      cachedUsageUtilization: usageCache({ fetchedAtMs: Date.now() - 60_000, accountUuid: 'uuid-somebody-else' }),
    });

    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => ({ timedOut: false, stdout: envelope(LIVE_REPORT) }),
    });
    expect(res.status).toBe('stale');
    expect(JSON.stringify(res)).not.toContain('"percent"');
  });
});

describe('needs-relogin — a non-refresh escalates ONCE to the authoritative judge', () => {
  it('the sandbox NEVER had a credential (deleted by hand)', async () => {
    // No sandbox config at all — the shape `ensureSandbox` recreates but cannot re-authenticate.
    const j = judge({ loggedIn: false });
    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: j.fn as never,
      runProbe: async () => ({ timedOut: false }), // exits 0, writes nothing — the measured shape
    });

    expect(res.status).toBe('needs-relogin');
    expect(j.calls).toHaveLength(1);
    expect(j.calls[0]!.dir).toBe(SANDBOX);
  });

  it('the credential BROKE — stale oauthAccount AND stale cache survive, fetchedAtMs does not move', async () => {
    // The measured revoked/expired shape: everything looks present, nothing refreshes, exit 0.
    // Discriminating on "neither a cache nor an oauthAccount" would drop THIS — probably the
    // more common cause — into `unknown`.
    writeSandboxConfig({
      oauthAccount: { accountUuid: ACCOUNT_UUID, emailAddress: 'b@example.com' },
      cachedUsageUtilization: usageCache({ fetchedAtMs: 1_000 }),
    });

    const j = judge({ loggedIn: false });
    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: j.fn as never,
      runProbe: async () => ({ timedOut: false }), // 0 / success / no cache write
    });

    expect(res.status).toBe('needs-relogin');
    expect(j.calls).toHaveLength(1);
  });

  it('escalates with what is LEFT of the probe budget, never a second budget on top', async () => {
    const j = judge({ loggedIn: false });
    await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: j.fn as never,
      runProbe: async () => ({ timedOut: false }),
    });
    const handed = j.calls[0]!.timeoutMs!;
    expect(handed).toBeGreaterThan(0);
    expect(handed).toBeLessThanOrEqual(USAGE_PROBE_TIMEOUT_MS);
  });
});

describe('unknown — never counted as zero usage', () => {
  it('a healthy account that publishes no numbers is `healthy-unmeasured`, not `unknown`', async () => {
    writeSandboxConfig({
      oauthAccount: { accountUuid: ACCOUNT_UUID },
      cachedUsageUtilization: usageCache({ fetchedAtMs: 1_000 }),
    });

    const j = judge({ loggedIn: true, email: 'b@example.com' });
    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: j.fn as never,
      runProbe: async () => ({ timedOut: false }),
    });

    // The judge ANSWERED, and it answered "signed in". That is a positive fact, and it is a
    // real shape: measured 2026-09-05, a Max account's `/usage` returns a prose behaviour
    // report with no percentages and writes no cache at all, while `auth status` reports
    // `loggedIn: true`. Calling that `unknown` made such an account permanently ineligible,
    // so a machine with one measurable and one unmeasurable account had an auto-switch that
    // could only ever answer "every account is at its limit".
    //
    // It is still NOT counted as zero usage — `chooseAccount` takes it only as a last resort
    // and flags the choice `unmeasured`. See claude-account-switch.test.ts.
    expect(res.status).toBe('healthy-unmeasured');
    expect(j.calls).toHaveLength(1);
  });

  it('a judge that cannot tell either (old CLI, Bedrock, failed probe) is `unknown`, not signed-out', async () => {
    const j = judge({ loggedIn: null, error: 'no `claude auth status` command' });
    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: j.fn as never,
      runProbe: async () => ({ timedOut: false }),
    });
    expect(res.status).toBe('unknown');
  });

  it('a timeout is `unknown` and never reaches the judge', async () => {
    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => ({ timedOut: true }),
    });
    expect(res.status).toBe('unknown');
    if (res.status === 'unknown') expect(res.reason).toMatch(/timed out/);
  });

  it('a spawn failure is `unknown` and never reaches the judge', async () => {
    const res = await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => ({ timedOut: false, error: 'ENOENT: claude not found' }),
    });
    expect(res.status).toBe('unknown');
    if (res.status === 'unknown') expect(res.reason).toContain('ENOENT');
  });

  it('a config dir outside the sandbox root is refused as `unknown`, and nothing is spawned', async () => {
    const res = await probeAccountUsage('/tmp/not-a-sandbox', {
      home: HOME,
      authStatus: noJudge as never,
      runProbe: async () => { throw new Error('a spawn happened for an unconfined directory'); },
    });
    expect(res.status).toBe('unknown');
    if (res.status === 'unknown') expect(res.reason).toMatch(/outside the account sandbox root/);
  });
});

describe('the probe repairs the sandbox before spawning', () => {
  it('lays the shared symlinks even when the sandbox was wiped since the last call', async () => {
    rmSync(SANDBOX, { recursive: true, force: true });
    await probeAccountUsage(SANDBOX, {
      home: HOME,
      authStatus: judge({ loggedIn: false }).fn as never,
      runProbe: async () => ({ timedOut: false }),
    });
    // Had ensureSandbox only run at creation time, the CLI would have opened a REAL projects/.
    const { lstatSync } = await import('node:fs');
    expect(lstatSync(join(SANDBOX, 'projects')).isSymbolicLink()).toBe(true);
  });
});
