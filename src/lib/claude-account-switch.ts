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
   */
  problem?: 'unknown' | 'stale' | 'needs-relogin';
}

export interface ChooseOptions {
  /** A window at or above this percent disqualifies the account. */
  threshold: number;
  /** The account currently serving, if any. Preferred on a tie so a session does not move for nothing. */
  currentId?: string | null;
  /** Preferred account, preferred on a tie after `currentId`. */
  preferredId?: string | null;
}

export interface ChooseResult {
  /** The account to use, or `null` when every account is exhausted. */
  accountId: string | null;
  /** The chosen account's session percent, for the message that names the switch. */
  sessionPercent?: number;
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
 * When nothing qualifies, `accountId` is null and `earliestResetAt` carries the soonest reset
 * across all of them, so the surface can say WHEN work resumes instead of only that it failed.
 */
export function chooseAccount(readings: AccountReading[], opts: ChooseOptions): ChooseResult {
  const rejected: Array<{ id: string; why: string }> = [];
  const candidates: Array<{ id: string; session: number }> = [];
  const resets: number[] = [];

  for (const reading of readings) {
    if (reading.problem === 'needs-relogin') {
      rejected.push({ id: reading.id, why: 'needs to sign in again' });
      continue;
    }
    if (reading.problem || !reading.limits) {
      // An unmeasurable account is not a fallback. Counting it as empty is how a
      // "safe" switch lands on an account that is already out of quota.
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
      rejected.push({ id: reading.id, why: 'one of its usage windows is missing' });
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

  if (candidates.length === 0) {
    const earliest = resets.length > 0 ? Math.min(...resets) : undefined;
    return { accountId: null, rejected, ...(earliest === undefined ? {} : { earliestResetAt: earliest }) };
  }

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
