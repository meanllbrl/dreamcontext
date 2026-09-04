/**
 * `claude-usage-probe.ts` — reading an account's limits WITHOUT switching to it.
 *
 * ── The finding this file exists to pin ───────────────────────────────────────────────
 * THE EXIT CODE IS NOT THE SUCCESS CRITERION. Measured on a real CLI (2.1.260): in a config
 * dir with no credential, `claude -p "/usage" --output-format json` exits in ~772ms with
 * code 0, `is_error: false`, `subtype: "success"`, returns an empty cost summary instead of a
 * usage report, and writes NO `cachedUsageUtilization`. An implementation that trusts the
 * exit code reads a signed-out account as "healthy but numberless" and the needs-relogin
 * signal is never born — worse than a hang, because it looks like success.
 *
 * So every case below drives the probe through its INJECTED spawn, and what decides the
 * outcome is what happened to the cache on disk: `fetchedAtMs` advancing, and `accountUuid`
 * matching the register.
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
  it('NEGATIVE CONTROL: a healthy account that simply did not refresh stays `unknown`', async () => {
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

    // The judge says the credential is fine, so this is NOT needs-relogin — it is genuinely
    // "we could not tell", which is the answer that keeps the account out of the candidate set.
    expect(res.status).toBe('unknown');
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
