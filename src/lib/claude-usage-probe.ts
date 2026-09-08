import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeAwarePath, findClaudeBin } from './claude-path.js';
import { accountEnvFor, assertConfinedConfigDir, listClaudeAccounts } from './claude-accounts.js';
import { ensureSandbox } from './claude-account-sandbox.js';
import { claudeAuthStatus, PROBE_TIMEOUT_MS } from './claude-auth.js';
import { readUsageLimits, USAGE_CACHE_WRITE_THROTTLE_MS, type UsageLimitsResponse } from './claude-usage.js';
import { parseUsageReport, withLockedReasons } from './claude-usage-report.js';

/**
 * Read an account's CURRENT limits WITHOUT switching to it.
 *
 * `claude -p "/usage" --output-format json` is free: measured 2026-09-07 (CLI 2.1.259) it
 * answers in ~4s with `num_turns: 0` and `total_cost_usd: 0`. Being free is what lets the
 * switch threshold sit HIGH, and a high threshold is what stops a session being moved off its
 * own account for no reason.
 *
 * ── THE ANSWER IS ON STDOUT. THE CACHE IS THE FALLBACK. ───────────────────────────────
 * This file used to define success as "`cachedUsageUtilization.fetchedAtMs` moved", and that
 * criterion is wrong most of the time. The CLI throttles that write to once per 5 minutes
 * (`Uso = 300000` in the 2.1.259 bundle, and reproduced both ways on one account minutes
 * apart — see claude-usage-report.ts for the measurement). So every account with a live
 * session, and every account probed twice in a row, answered with fresh numbers on stdout
 * while the file deliberately stood still — and the probe called that "no numbers came back".
 * Everything downstream inherited it: Settings drew "not measured", and auto-switch fell
 * through to a last-resort pick in register order while real percentages sat unread.
 *
 * So the order of belief is now:
 *   1. THE REPORT the child just printed — throttled by nothing, and stamped `now`;
 *   2. the cache, when it MOVED or is younger than the CLI's own write throttle (which is the
 *      only reason a fetch would not have rewritten it);
 *   3. nothing — escalate once to the authoritative judge to find out WHY.
 *
 * ── THE EXIT CODE IS STILL NOT THE SUCCESS CRITERION ──────────────────────────────────
 * Also measured: in a config dir with no credential the probe exits in ~772ms with code 0,
 * `is_error: false`, `subtype: "success"` and an EMPTY cost summary instead of a usage report.
 * An implementation that trusts the exit code reads a signed-out account as "healthy but
 * numberless" and the needs-relogin signal is never born — worse than a hang, because it
 * looks like success. Hence step 3, and hence no `catch` that turns silence into zero.
 *
 * ── What of the child's output is READ ────────────────────────────────────────────────
 * Only `result`, and only percentages and reset times are extracted from it. The envelope
 * also carries `session_id` and cost accounting; none of it is copied, logged, or returned.
 */

export type ProbeOutcome =
  /** A reading we trust: the live report, or a cache that is current. Never a zero-fill. */
  | { status: 'ok'; limits: UsageLimitsResponse }
  /** The directory's credential belongs to a DIFFERENT account. The reading is discarded. */
  | { status: 'stale'; reason: string }
  /** The authoritative judge says this directory holds no working credential. */
  | { status: 'needs-relogin'; reason: string }
  /**
   * Signed in, and yet neither the report nor the cache yielded a percentage.
   *
   * This used to be the COMMON outcome, because the probe demanded a cache write the CLI
   * throttles; with the report read directly it is what it always claimed to be — the genuine
   * "this account publishes no numbers" case. It stays a LAST-RESORT candidate rather than an
   * ineligible one (see `chooseAccount`): on a machine with one measurable and one
   * unmeasurable account, refusing it would make auto-switch answer "every account is at its
   * limit" and switch nowhere.
   */
  | { status: 'healthy-unmeasured'; reason: string }
  /** We genuinely could not tell. NEVER counted as zero usage. */
  | { status: 'unknown'; reason: string };

/** What one probe reads out of the sandbox's own config, before and after the spawn. */
interface CacheStamp {
  fetchedAtMs: number | null;
  accountUuid: string | null;
}

/** What a spawn reports back. `stdout` is the report; absent means nothing was captured. */
export interface ProbeRun {
  timedOut: boolean;
  error?: string;
  stdout?: string;
}

/** The probe's total budget. The judge escalation is taken OUT of this, never added to it. */
export const USAGE_PROBE_TIMEOUT_MS = 20_000;

/** The measured report is ~1.5 KB. Past this the child is not answering `/usage`, and an
 *  unbounded read of another process's stdout is not something to hold in memory. */
const PROBE_STDOUT_CAP = 256 * 1024;

export interface ProbeDeps {
  /** Injectable for tests: resolves once the child has exited. */
  runProbe?: (configDir: string, timeoutMs: number) => Promise<ProbeRun>;
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

/**
 * The usage report out of whatever the child printed.
 *
 * `--output-format json` prints one envelope whose `result` holds the report. A line-delimited
 * stream (a future default, or a CLI that ignores the flag) is handled by trying each line;
 * anything that is not JSON at all is handed over as-is, since the parser is line-based and
 * reads plain report text perfectly well. Only `result` is ever taken from the envelope.
 */
function reportText(stdout: string | undefined): string {
  if (typeof stdout !== 'string' || !stdout) return '';
  const text = stdout.slice(0, PROBE_STDOUT_CAP);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const result = asRecord(JSON.parse(trimmed))?.result;
      if (typeof result === 'string' && result) return result;
    } catch { /* not this line — try the next, then fall through to the raw text */ }
  }
  return text;
}

/** Spawn `claude -p "/usage" --output-format json` in `configDir` and capture its report. */
function defaultRunProbe(configDir: string, timeoutMs: number): Promise<ProbeRun> {
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
      // stdout is PIPED now — it is where the answer is. stderr stays ignored: it carries
      // update notices and warnings, never the report.
      child = bin
        ? spawn(bin, ['-p', '/usage', '--output-format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'], env })
        : spawn(shell, ['-ilc', 'claude -p "/usage" --output-format json'], { stdio: ['ignore', 'pipe', 'ignore'], env });
    } catch (err) {
      resolveOut({ timedOut: false, error: (err as Error)?.message ?? String(err) });
      return;
    }

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      // Drained on every chunk (a full pipe buffer would deadlock the child) but bounded:
      // past the cap the bytes are dropped rather than accumulated.
      if (stdout.length < PROBE_STDOUT_CAP) stdout += chunk.toString('utf-8');
    });

    let settled = false;
    const done = (v: ProbeRun) => {
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
    // `close`, not `exit`: it waits for stdout's EOF, so the report is complete. The exit code
    // is not read at all — see the module header.
    child.on('close', () => done({ timedOut: false, stdout }));
  });
}

/**
 * Probe one account. Never throws.
 *
 * The discrimination, in the order belief is granted:
 *   • timeout / spawn failure                            → `unknown` (nothing was learnt)
 *   • the dir's credential is someone else's             → `stale` (the reading is DISCARDED)
 *   • the report printed percentages                     → `ok`
 *   • the cache moved, or is inside the write throttle   → `ok`
 *   • neither                                            → ESCALATE ONCE to the judge
 *
 * ── Why identity is checked FIRST ─────────────────────────────────────────────────────
 * A config dir signed into a different account than the register records prints a perfectly
 * parseable report — for the WRONG quota pool. Attributing it would put a switch decision on
 * another account's numbers, so the check now guards every source rather than only the cache.
 *
 * ── Why a non-answer escalates ────────────────────────────────────────────────────────
 * A missing answer cannot explain itself, and the two causes behind it look different on disk.
 * Both were MEASURED. A directory that NEVER held a credential (a sandbox deleted by hand) has
 * no `oauthAccount` and no cache. A directory whose credential BROKE (token expired, seat
 * revoked, or `claude auth logout` run inside that `CLAUDE_CONFIG_DIR`) keeps its stale
 * `oauthAccount` AND its stale `cachedUsageUtilization` verbatim, prints no report, and still
 * exits 0/success. So discriminating on "neither a cache nor an oauthAccount" alone would drop
 * the PROBABLY MORE COMMON cause into `unknown`.
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
  const expected = expectedAccountUuid(dir, home);
  if (expected !== null && after.accountUuid !== null && after.accountUuid !== expected) {
    return {
      status: 'stale',
      reason: 'That account directory is signed in as a different account — the reading was discarded.',
    };
  }

  const now = Date.now();
  const cached = readUsageLimits(dir);

  // ── 1. The live report: what the child just printed, stamped now.
  const live = parseUsageReport(reportText(run.stdout), now);
  if (live) return { status: 'ok', limits: withLockedReasons(live, cached, now) };

  // ── 2. The cache. It counts when it MOVED (the CLI fetched and wrote), or when it is inside
  //      the write throttle — in which case the throttle is the ONLY reason it did not move,
  //      so the numbers in it are at most `USAGE_CACHE_WRITE_THROTTLE_MS` old. Both are
  //      readings; an older, unmoved cache is not, and falls through to the judge.
  const moved = after.fetchedAtMs !== null
    && (before.fetchedAtMs === null || after.fetchedAtMs > before.fetchedAtMs);
  const age = after.fetchedAtMs === null ? Number.POSITIVE_INFINITY : Math.max(0, now - after.fetchedAtMs);
  if (cached.limits.length > 0 && (moved || age <= USAGE_CACHE_WRITE_THROTTLE_MS)) {
    return { status: 'ok', limits: cached };
  }

  // ── 3. No answer at all. Escalate exactly once, inside the remaining budget.
  const remaining = USAGE_PROBE_TIMEOUT_MS - (Date.now() - startedAt);
  if (remaining <= 0) {
    return { status: 'unknown', reason: 'No usage came back and there was no budget left to check why.' };
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
      reason: 'This account is signed in but reported no usage numbers, so its remaining quota is unknown.',
    };
  }
  return {
    status: 'unknown',
    reason: judged.error
      ? `No usage came back: ${judged.error}`
      : 'No usage came back, and the account still reports as signed in.',
  };
}

/** The `accountUuid` the register holds for whichever account owns `dir`, or null. */
function expectedAccountUuid(dir: string, home: string): string | null {
  const account = listClaudeAccounts(home).find(
    (a) => (a.configDir ?? home) === dir || a.configDir === dir,
  );
  return account?.accountUuid ? account.accountUuid : null;
}
