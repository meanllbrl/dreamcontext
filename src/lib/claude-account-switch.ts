import type { UsageLimitsResponse } from './claude-usage.js';

/**
 * Which account should serve the next turn — the PURE half of auto-switch.
 *
 * Usage readings come in as ARGUMENTS. There is no I/O here at all, which is what makes
 * every case below a unit test rather than a live-CLI experiment.
 */

/** One account's reading, as the chooser sees it. */
export interface AccountReading {
  id: string;
  /** Present only for a reading we actually trust. */
  limits?: UsageLimitsResponse;
  /**
   * Why this account cannot be believed, if it cannot. `unknown` and `stale` are NEVER
   * counted as zero usage — an account we cannot measure is not a safe place to send a turn.
   *
   * `healthy-unmeasured` is the one exception, and it is a NARROWER claim than `unknown`:
   * the authoritative judge said this account is signed in, and the CLI simply publishes no
   * usage numbers for it. See `LAST RESORT` below.
   */
  problem?: 'unknown' | 'stale' | 'needs-relogin' | 'healthy-unmeasured';
}

export interface ChooseOptions {
  /** A window at or above this percent disqualifies the account. */
  threshold: number;
  /** The account currently serving, if any. Preferred on a tie so a session does not move for nothing. */
  currentId?: string | null;
  /** Preferred account, preferred on a tie after `currentId`. */
  preferredId?: string | null;
  /**
   * Accounts the API has actually REFUSED, and the epoch ms until which each stays refused
   * (`claude-limit-rejections.ts`). An entry here OVERRULES the account's own percentages.
   *
   * That precedence is the whole point: on 2026-09-05 an account that had just been refused
   * with "You've hit your session limit" measured 6% three minutes later. A chooser that
   * trusts the forecast over the refusal sends the next turn straight back into the wall,
   * which is precisely what the user saw when their "devam" came back identical.
   */
  rejectedUntil?: Record<string, { until: number; window?: string }>;
  /** Clock seam, so an expiring rejection is a unit test rather than a wait. */
  now?: number;
}

export interface ChooseResult {
  /** The account to use, or `null` when every account is exhausted. */
  accountId: string | null;
  /** The chosen account's session percent, for the message that names the switch. */
  sessionPercent?: number;
  /**
   * True when the winner is a LAST-RESORT pick: signed in, but its usage could not be read,
   * so there is no percent behind it. The surface must SAY so rather than imply a measured
   * choice — the billed account never changes on a silent guess.
   */
  unmeasured?: boolean;
  /**
   * When `accountId` is null: the EARLIEST reset across every exhausted account. This is what
   * turns "it just failed" into "work resumes at <time>".
   */
  earliestResetAt?: number;
  /** Every account and why it was or wasn't eligible — what the surface shows the user. */
  rejected: Array<{ id: string; why: string }>;
}

/** The window percentages of a reading, with `null` for a window that is not readable. */
function windows(limits: UsageLimitsResponse): {
  session: number | null;
  weekly: number | null;
  locked: boolean;
  resets: number[];
} {
  const session = limits.limits.find((l) => l.key === 'session');
  const weekly = limits.limits.find((l) => l.key === 'weekly');
  const resets = limits.limits.map((l) => l.resetsAt).filter((r) => Number.isFinite(r));
  return {
    session: session ? session.percent : null,
    weekly: weekly ? weekly.percent : null,
    locked: Boolean(session?.lockedReason || weekly?.lockedReason),
    resets,
  };
}

/**
 * Pick the account with the LOWEST session usage whose session AND weekly windows are both
 * below `threshold` and whose `lockedReason` is empty.
 *
 * Both windows are weighed together on purpose: an account with a fresh 5-hour window but an
 * exhausted week is not a place to send work.
 *
 * A reading that is `unknown` or `stale` is NOT A CANDIDATE — never silently treated as 0%.
 * A `needs-relogin` account is not a candidate either, and says so.
 *
 * ── OBSERVATION BEATS FORECAST ────────────────────────────────────────────────────────
 * `opts.rejectedUntil` is consulted FIRST, before any percentage. An account the API has
 * actually refused stays out until its window reopens even if its own cache reports 0%.
 *
 * ── LAST RESORT: signed in, but unmeasurable ──────────────────────────────────────────
 * Some accounts publish no usage numbers at all. Measured 2026-09-05 on a Max account:
 * `claude -p "/usage"` returns a prose behaviour report with NO percentages and writes no
 * `cachedUsageUtilization`, while `auth status --json` answers `loggedIn: true`. Under the
 * old rule that account could never be a fallback, so a machine with one measurable and one
 * unmeasurable account had auto-switch that could only ever answer "every account is at its
 * limit" — the feature was dead on exactly the setup it shipped for.
 *
 * Such an account is now a candidate of LAST RESORT: it is picked only when no measured
 * account qualifies, never in preference to one, and the result says `unmeasured` so the
 * surface can admit there is no number behind the choice. The original guarantee is intact
 * where it was actually earned — an account we could not measure AND cannot vouch for
 * (`unknown`, `stale`) is still never a candidate.
 *
 * When nothing qualifies, `accountId` is null and `earliestResetAt` carries the soonest reset
 * across all of them, so the surface can say WHEN work resumes instead of only that it failed.
 */
export function chooseAccount(readings: AccountReading[], opts: ChooseOptions): ChooseResult {
  const now = opts.now ?? Date.now();
  const rejected: Array<{ id: string; why: string }> = [];
  const candidates: Array<{ id: string; session: number }> = [];
  /** Signed in, no numbers. Only ever consulted when `candidates` comes up empty. */
  const lastResort: string[] = [];
  const resets: number[] = [];

  for (const reading of readings) {
    // The API's own refusal outranks everything below it, including a cache that says 0%.
    const refusal = opts.rejectedUntil?.[reading.id];
    if (refusal && refusal.until > now) {
      resets.push(refusal.until);
      const what = refusal.window === 'weekly' ? 'weekly' : refusal.window === 'session' ? 'session' : '';
      rejected.push({
        id: reading.id,
        why: `the API refused its last turn${what ? ` on the ${what} limit` : ''}`,
      });
      continue;
    }
    if (reading.problem === 'needs-relogin') {
      rejected.push({ id: reading.id, why: 'needs to sign in again' });
      continue;
    }
    if (reading.problem === 'healthy-unmeasured') {
      lastResort.push(reading.id);
      continue;
    }
    if (reading.problem || !reading.limits) {
      // An unmeasurable account we cannot VOUCH for is not a fallback. Counting it as empty
      // is how a "safe" switch lands on an account that is already out of quota.
      rejected.push({ id: reading.id, why: 'its usage could not be read' });
      continue;
    }
    const w = windows(reading.limits);
    resets.push(...w.resets);
    if (w.locked) {
      rejected.push({ id: reading.id, why: 'a usage window is already locked' });
      continue;
    }
    if (w.session === null || w.weekly === null) {
      // A signed-in account whose windows do not parse is the SAME situation as one that
      // publishes none — see LAST RESORT. It reaches here rather than through the probe
      // because the cache existed and refreshed; it just carried nothing usable.
      lastResort.push(reading.id);
      continue;
    }
    if (w.session >= opts.threshold) {
      rejected.push({ id: reading.id, why: `session usage is at ${Math.round(w.session)}%` });
      continue;
    }
    if (w.weekly >= opts.threshold) {
      rejected.push({ id: reading.id, why: `weekly usage is at ${Math.round(w.weekly)}%` });
      continue;
    }
    candidates.push({ id: reading.id, session: w.session });
  }

  if (candidates.length === 0 && lastResort.length > 0) {
    // Same tie-break as below, minus the percent nobody has: stay put if we can, else the
    // preferred account, else the lowest id. Deterministic, never a coin flip.
    const rank = (id: string) => (id === opts.currentId ? 0 : id === opts.preferredId ? 1 : 2);
    lastResort.sort((a, b) => (rank(a) - rank(b)) || a.localeCompare(b));
    const pick = lastResort[0]!;
    for (const id of lastResort.slice(1)) {
      rejected.push({ id, why: 'its usage could not be read either' });
    }
    return { accountId: pick, unmeasured: true, rejected };
  }

  if (candidates.length === 0) {
    const earliest = resets.length > 0 ? Math.min(...resets) : undefined;
    return { accountId: null, rejected, ...(earliest === undefined ? {} : { earliestResetAt: earliest }) };
  }

  // A last-resort account that lost to a measured one is still worth naming: the user asked
  // why a switch went where it went, and "we could not read it" is part of that answer.
  for (const id of lastResort) rejected.push({ id, why: 'its usage could not be read' });

  // Lowest session usage wins. On a tie, the account already serving wins, then the preferred
  // one, then the id — so a tie never moves a session for nothing, and never coin-flips.
  candidates.sort((a, b) => {
    if (a.session !== b.session) return a.session - b.session;
    const rank = (id: string) => (id === opts.currentId ? 0 : id === opts.preferredId ? 1 : 2);
    const byRank = rank(a.id) - rank(b.id);
    return byRank !== 0 ? byRank : a.id.localeCompare(b.id);
  });

  const winner = candidates[0]!;
  return { accountId: winner.id, sessionPercent: winner.session, rejected };
}

/** Session usage at or above this: probe (it is free). */
export const PROBE_THRESHOLD_PERCENT = 80;
/** Session usage at or above this, or any `lockedReason`: switch. */
export const SWITCH_THRESHOLD_PERCENT = 90;

/**
 * Does the ACTIVE account's reading warrant a switch right now?
 *
 * A `lockedReason` triggers immediately regardless of percent — a locked window is not going
 * to serve the turn whatever the number beside it says.
 */
export function shouldSwitchAway(limits: UsageLimitsResponse, threshold: number = SWITCH_THRESHOLD_PERCENT): boolean {
  const w = windows(limits);
  if (w.locked) return true;
  return (w.session !== null && w.session >= threshold) || (w.weekly !== null && w.weekly >= threshold);
}

/** Is it worth spending a (free) probe on the active account? */
export function shouldProbe(limits: UsageLimitsResponse, threshold: number = PROBE_THRESHOLD_PERCENT): boolean {
  const w = windows(limits);
  if (w.locked) return true;
  return (w.session !== null && w.session >= threshold) || (w.weekly !== null && w.weekly >= threshold);
}
