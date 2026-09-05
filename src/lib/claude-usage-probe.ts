import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeAwarePath, findClaudeBin } from './claude-path.js';
import { accountEnvFor, assertConfinedConfigDir, listClaudeAccounts } from './claude-accounts.js';
import { ensureSandbox } from './claude-account-sandbox.js';
import { claudeAuthStatus, PROBE_TIMEOUT_MS } from './claude-auth.js';
import { readUsageLimits, type UsageLimitsResponse } from './claude-usage.js';

/**
 * Read an account's CURRENT limits WITHOUT switching to it.
 *
 * `claude -p "/usage" --output-format json` is free: measured 2026-09-04 (CLI 2.1.260) it
 * answers in under 1.2s with `num_turns: 0` and `total_cost_usd: 0`, and — the part that
 * makes this feature possible at all — it REFRESHES `<configDir>/.claude.json`'s
 * `cachedUsageUtilization`. So the answer does not have to be parsed out of prose; it is
 * read afterwards by the structured reader we already own (`readUsageLimits`). Being free is
 * what lets the switch threshold sit HIGH, and a high threshold is what stops a session being
 * moved off its account for no reason.
 *
 * ── THE EXIT CODE IS NOT THE SUCCESS CRITERION ────────────────────────────────────────
 * This was MEASURED, and it rots the obvious implementation: in a config dir with no
 * credential, the probe exits in ~772ms with code 0, `is_error: false`, `subtype: "success"`,
 * returns an EMPTY COST SUMMARY instead of a usage report, and writes NO
 * `cachedUsageUtilization` at all. An implementation that trusts the exit code therefore
 * reads a signed-out account as "healthy but numberless", and the needs-relogin signal is
 * never born. That is WORSE than a hang, because it looks like success.
 *
 * So the probe succeeded only if, after the child exits, `<configDir>/.claude.json`'s
 * `cachedUsageUtilization.fetchedAtMs` is NEWER than what was read before the spawn AND its
 * sibling `accountUuid` is the one the register holds for this account.
 */

export type ProbeOutcome =
  /** The cache refreshed and belongs to this account. `limits` is a fresh reading. */
  | { status: 'ok'; limits: UsageLimitsResponse }
  /** The cache belongs to a DIFFERENT account. The reading is discarded, never used. */
  | { status: 'stale'; reason: string }
  /** The authoritative judge says this directory holds no working credential. */
  | { status: 'needs-relogin'; reason: string }
  /**
   * Signed in, but this account publishes NO usage numbers — a narrower, more useful claim
   * than `unknown`. MEASURED 2026-09-05 on a Max account: `claude -p "/usage"` answers with
   * a prose behaviour report ("Last 24h · 4831 requests · 53 sessions…") that contains no
   * percentages at all, writes no `cachedUsageUtilization`, and exits 0 — while
   * `auth status --json` reports `loggedIn: true, subscriptionType: "max"`.
   *
   * Collapsing that into `unknown` made such an account permanently ineligible, so on a
   * machine with one measurable and one unmeasurable account auto-switch could only ever
   * answer "every account is at its limit". It is a LAST-RESORT candidate instead — see
   * `chooseAccount`.
   */
  | { status: 'healthy-unmeasured'; reason: string }
  /** We genuinely could not tell. NEVER counted as zero usage. */
  | { status: 'unknown'; reason: string };

/** What one probe reads out of the sandbox's own config, before and after the spawn. */
interface CacheStamp {
  fetchedAtMs: number | null;
  accountUuid: string | null;
}

/** The probe's total budget. The judge escalation is taken OUT of this, never added to it. */
export const USAGE_PROBE_TIMEOUT_MS = 20_000;

export interface ProbeDeps {
  /** Injectable for tests: resolves once the child has exited. */
  runProbe?: (configDir: string, timeoutMs: number) => Promise<{ timedOut: boolean; error?: string }>;
  /** Injectable for tests: the authoritative judge. */
  authStatus?: typeof claudeAuthStatus;
  home?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/**
 * Read the cache stamp. The `accountUuid` cross-check happens HERE, on the raw blob, and is
 * deliberately NOT added to `readUsageLimits`'s return: adding it there would reverse the
 * guarantee `tests/unit/claude-usage.test.ts` asserts key by key — that no account field ever
 * reaches the wire. Keeping the check server-side keeps both properties.
 */
function readCacheStamp(configDir: string): CacheStamp {
  let blob: unknown = null;
  try {
    blob = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf-8'));
  } catch {
    return { fetchedAtMs: null, accountUuid: null };
  }
  const cached = asRecord(asRecord(blob)?.cachedUsageUtilization);
  const fetched = cached?.fetchedAtMs;
  const uuid = cached?.accountUuid ?? asRecord(asRecord(blob)?.oauthAccount)?.accountUuid;
  return {
    fetchedAtMs: typeof fetched === 'number' && Number.isFinite(fetched) ? fetched : null,
    accountUuid: typeof uuid === 'string' && uuid.trim() ? uuid.trim() : null,
  };
}

/** Spawn `claude -p "/usage" --output-format json` in `configDir`. Output is not parsed. */
function defaultRunProbe(configDir: string, timeoutMs: number): Promise<{ timedOut: boolean; error?: string }> {
  return new Promise((resolveOut) => {
    const bin = findClaudeBin();
    const shell = process.env.SHELL || '/bin/zsh';
    const env = {
      ...process.env,
      PATH: claudeAwarePath(),
      ...accountEnvFor(configDir),
    } as NodeJS.ProcessEnv;

    let child: ReturnType<typeof spawn>;
    try {
      child = bin
        ? spawn(bin, ['-p', '/usage', '--output-format', 'json'], { stdio: ['ignore', 'ignore', 'ignore'], env })
        : spawn(shell, ['-ilc', 'claude -p "/usage" --output-format json'], { stdio: ['ignore', 'ignore', 'ignore'], env });
    } catch (err) {
      resolveOut({ timedOut: false, error: (err as Error)?.message ?? String(err) });
      return;
    }

    let settled = false;
    const done = (v: { timedOut: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOut(v);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ timedOut: true });
    }, timeoutMs);

    child.on('error', (e) => done({ timedOut: false, error: e.message }));
    // The exit code is read but NOT used as the criterion — see the module header.
    child.on('close', () => done({ timedOut: false }));
  });
}

/**
 * Probe one account. Never throws.
 *
 * The four-way discrimination:
 *   • cache refreshed + uuid matches                 → `ok`
 *   • cache refreshed + uuid is someone else's       → `stale` (the reading is DISCARDED)
 *   • cache did not move (or has never existed)      → ESCALATE ONCE to the judge
 *   • timeout / spawn failure                        → `unknown`
 *
 * ── Why a non-refresh escalates ───────────────────────────────────────────────────────
 * A non-refresh cannot explain itself, and the two causes behind it look different on disk.
 * Both were MEASURED. A directory that NEVER held a credential (a sandbox deleted by hand) has
 * no `oauthAccount` and no cache. A directory whose credential BROKE (token expired, seat
 * revoked, or `claude auth logout` run inside that `CLAUDE_CONFIG_DIR`) keeps its stale
 * `oauthAccount` AND its stale `cachedUsageUtilization` verbatim, moves no `fetchedAtMs`, and
 * still exits 0/success. So discriminating on "neither a cache nor an oauthAccount" alone
 * would drop the PROBABLY MORE COMMON cause into `unknown`.
 *
 * `claude auth status --json` separates them cleanly — measured in that same broken directory,
 * it ignores the stale mirror and answers `loggedIn: false`. This is deliberately the
 * cheap-trigger / authoritative-judge split `claude-auth-watch.ts` already documents, and it
 * removes any need for an "N unknowns in a row" heuristic.
 *
 * The escalation is BOUNDED BY THIS PROBE'S OWN BUDGET, not added on top of it: the judge has
 * its own 10s internal ceiling, and stacking them would make the unhappy path feel frozen. It
 * takes whatever is left; if nothing is left the answer is `unknown`, which is the safe answer
 * anyway.
 */
export async function probeAccountUsage(
  configDir: string,
  deps: ProbeDeps = {},
): Promise<ProbeOutcome> {
  const home = deps.home ?? homedir();
  const runProbe = deps.runProbe ?? defaultRunProbe;
  const authStatus = deps.authStatus ?? claudeAuthStatus;

  let dir: string;
  try {
    dir = assertConfinedConfigDir(configDir, home);
    // Not only at creation time: a symlink broken since then would otherwise never be
    // repaired, and the CLI would open a REAL `projects/` at that path.
    ensureSandbox(dir, home);
  } catch (err) {
    return { status: 'unknown', reason: (err as Error)?.message ?? String(err) };
  }

  const before = readCacheStamp(dir);
  const startedAt = Date.now();

  const run = await runProbe(dir, USAGE_PROBE_TIMEOUT_MS);
  if (run.timedOut) return { status: 'unknown', reason: 'The usage probe timed out.' };
  if (run.error) return { status: 'unknown', reason: run.error.slice(0, 400) };

  const after = readCacheStamp(dir);
  const refreshed = after.fetchedAtMs !== null
    && (before.fetchedAtMs === null || after.fetchedAtMs > before.fetchedAtMs);

  if (refreshed) {
    const expected = expectedAccountUuid(dir, home);
    if (expected !== null && after.accountUuid !== null && after.accountUuid !== expected) {
      return {
        status: 'stale',
        reason: 'The refreshed usage cache belongs to a different account — the reading was discarded.',
      };
    }
    return { status: 'ok', limits: readUsageLimits(dir) };
  }

  // ── The cache did not move. Escalate exactly once, inside the remaining budget.
  const spent = Date.now() - startedAt;
  const remaining = USAGE_PROBE_TIMEOUT_MS - spent;
  if (remaining <= 0) {
    return { status: 'unknown', reason: 'The usage cache did not refresh and there was no budget left to check why.' };
  }
  const judged = await authStatus(dir, Math.min(remaining, PROBE_TIMEOUT_MS));
  if (judged.loggedIn === false) {
    return { status: 'needs-relogin', reason: 'This account is signed out — it needs to sign in again.' };
  }
  // The judge ANSWERED, and it answered "signed in". That is a positive fact about the
  // account, not an absence of one, and it is the whole difference between a fallback we can
  // use and one we cannot — see `healthy-unmeasured` above. A judge that errored out told us
  // nothing, so that stays `unknown`.
  if (judged.loggedIn === true && !judged.error) {
    return {
      status: 'healthy-unmeasured',
      reason: 'This account is signed in but reports no usage numbers, so its remaining quota is unknown.',
    };
  }
  return {
    status: 'unknown',
    reason: judged.error
      ? `The usage cache did not refresh: ${judged.error}`
      : 'The usage cache did not refresh, and the account still reports as signed in.',
  };
}

/** The `accountUuid` the register holds for whichever account owns `dir`, or null. */
function expectedAccountUuid(dir: string, home: string): string | null {
  const account = listClaudeAccounts(home).find(
    (a) => (a.configDir ?? home) === dir || a.configDir === dir,
  );
  return account?.accountUuid ? account.accountUuid : null;
}
