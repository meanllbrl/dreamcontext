import type { UsageLimitsResponse, UsageLimitWire } from './claude-usage.js';

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

/**
 * How the winner is picked among the accounts that CAN serve.
 *
 * These are two different answers to "what is a multi-account setup for", and the owner's
 * answer differs by week, so it is a setting rather than a constant:
 *
 * - `score`      spread the work — keep every account healthy, never burn a scarce week for
 *                a cheap 5-hour window.
 * - `sequential` drain in order — the top account serves until the API itself refuses it,
 *                then the next one does. No forecast, no percentages, no early moves.
 */
export type SwitchStrategy = 'score' | 'sequential';

/**
 * The coefficients of the `score` strategy. Every eligible account gets ONE number
 *
 *   score = session·sessionUsage%·sessionLife + weekly·weeklyUsage%·weeklyLife
 *         + order·positionInTheList
 *
 * and the LOWEST score serves the turn. `…Life` is the fraction of that window still ahead of
 * its reset — see `WindowReading` and the discount note in `chooseAccount`. The weights are
 * unchanged in meaning: they still say what a percent of each window is worth, they are just
 * no longer applied to a percent whose window is about to be forgiven.
 *
 * ── Why one number instead of a sort key ──────────────────────────────────────────────
 * The original rule sorted on the session window alone and used the weekly window only as a
 * pass/fail gate at the threshold. Observed 2026-09-10: an account whose week was 75% spent
 * beat an account at 6% because its 5-hour window happened to be fresh (1% vs 26%) — the
 * scarcest quota on the machine was spent for the most abundant reason, and the user's own
 * priority order never got a say because it was only ever an exact-tie break.
 *
 * A weighted sum fixes both at once: the weekly window is WEIGHED rather than merely gated,
 * and the list position is a real term instead of a tie-break that almost never fires.
 *
 * ── Why these defaults ────────────────────────────────────────────────────────────────
 * `weekly: 2` — a week costs days to get back, a 5-hour window costs hours. Spending a
 * weekly percent is worth about twice what spending a session percent is worth.
 * `order: 5` — one step down the user's list is worth 5 score points, i.e. about 5 points of
 * session usage or 2.5 points of weekly usage.
 *
 * READ THE SCALING BEFORE CHANGING IT: the term is LINEAR in the position, so across a list
 * of N accounts the spread between the top row and the bottom row is `order·(N - 1)` — 15
 * points on a four-account machine, 35 on an eight-account one. That is the intended shape
 * (the user asked for their own order to count), but it means the default suits a handful of
 * accounts and wants LOWERING as the list grows: at `order: 5` with eight accounts, the top
 * row can beat a bottom row that is genuinely ~17 weekly points freer. Anyone running a long
 * list should set `order` to 1 or 2, and `0` removes the term entirely.
 *
 * A weight of `0` switches its term off entirely, which is the honest way to say "I do not
 * care about this one" — `{session: 0, weekly: 0, order: 1}` is strict priority order among
 * accounts under the threshold.
 */
export interface SwitchWeights {
  session: number;
  weekly: number;
  order: number;
}

export const DEFAULT_SWITCH_STRATEGY: SwitchStrategy = 'score';
export const DEFAULT_SWITCH_WEIGHTS: SwitchWeights = { session: 1, weekly: 2, order: 5 };

/** A strategy name off disk or off the wire, or `null` when it is not one of ours. */
export function asSwitchStrategy(value: unknown): SwitchStrategy | null {
  return value === 'score' || value === 'sequential' ? value : null;
}

/**
 * Weights off disk or off the wire, each falling back to its default on its own.
 *
 * A weight must be finite and non-negative: a negative one would mean "prefer the account
 * that is MORE used", which is never what anybody typed on purpose, and an infinite or NaN
 * one would make every score identical and hand the decision to the tie-break.
 */
export function sanitizeSwitchWeights(value: unknown): SwitchWeights {
  const rec = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const one = (key: keyof SwitchWeights): number => {
    const n = rec[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_SWITCH_WEIGHTS[key];
  };
  return { session: one('session'), weekly: one('weekly'), order: one('order') };
}

export interface ChooseOptions {
  /** A window at or above this percent disqualifies the account. */
  threshold: number;
  /** The account currently serving, if any. Preferred on a tie so a session does not move for nothing. */
  currentId?: string | null;
  /** Preferred account, preferred on a tie after `currentId`. */
  preferredId?: string | null;
  /**
   * The register's order, top first — the priority the user dragged into place in
   * Settings → Agents.
   *
   * This is the LAST tie-break, and it replaces what used to be `a.id.localeCompare(b.id)`.
   * Alphabetical order was only ever a way to be deterministic, and it quietly decided which
   * account got the work whenever two were equally free. Now the user's own ordering decides
   * that, which is what "set the priority" has to mean to be worth offering.
   *
   * Omit it and the tie-break falls back to the id, exactly as before — so a caller that has
   * no register order (or a test that does not care) is unaffected.
   */
  orderedIds?: string[];
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
  /**
   * How to pick among the eligible. Omitted = `score`, which is what every caller written
   * before the setting existed gets — and what the tests written against it still assert.
   */
  strategy?: SwitchStrategy;
  /** Coefficients for the `score` strategy. Ignored by `sequential`, which weighs nothing. */
  weights?: SwitchWeights;
  /** Clock seam, so an expiring rejection is a unit test rather than a wait. */
  now?: number;
}

export interface ChooseResult {
  /** The account to use, or `null` when every account is exhausted. */
  accountId: string | null;
  /** The chosen account's session percent, for the message that names the switch. */
  sessionPercent?: number;
  /**
   * The chosen account's weekly percent, when it has one.
   *
   * Carried for the SAME reason the bug that produced `score` existed: a banner that names
   * only the 5-hour window told the user "its 5-hour window is at 1%" about an account whose
   * week was 75% gone. The window that is nearly spent is the one the user needed to see.
   */
  weeklyPercent?: number;
  /** The winning score under the `score` strategy — what makes a surprising pick explicable. */
  score?: number;
  /**
   * True when the winner is a LAST-RESORT pick: signed in, but its usage could not be read,
   * so there is no percent behind it. The surface must SAY so rather than imply a measured
   * choice — the billed account never changes on a silent guess.
   */
  unmeasured?: boolean;
  /**
   * True when the winner had exactly ONE readable window. Distinct from `unmeasured`, which
   * means none: here a real number was weighed, and the other window is simply an unknown
   * rather than a zero. Such an account is never preferred to a fully measured one that has
   * room — see the sort in `chooseAccount`.
   */
  partial?: boolean;
  /**
   * When `accountId` is null: the EARLIEST reset across every exhausted account. This is what
   * turns "it just failed" into "work resumes at <time>".
   */
  earliestResetAt?: number;
  /** Every account and why it was or wasn't eligible — what the surface shows the user. */
  rejected: Array<{ id: string; why: string }>;
}

/**
 * How long each window lasts, end to end.
 *
 * The CLI states a reset TIME and never a duration, so the length is the product's own
 * contract — a five-hour session window and a seven-day week. It is used for exactly one
 * thing: turning "resets at 05:40" into "two thirds of this window is still ahead of us",
 * which is the only way a percentage can be compared across two windows of different size.
 */
export const SESSION_WINDOW_MS = 5 * 60 * 60_000;
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * One window of a reading, after the ROLLOVER correction and with its remaining life measured.
 *
 * ── `raw` vs `measured`: an inference is never reported as a reading ──────────────────
 * A reading whose `resetsAt` has already passed describes a window that NO LONGER EXISTS.
 * That is not staleness in the "old file" sense — the file can be seconds old — it is
 * arithmetic: the counter restarted at the reset, so the old percent cannot still be true.
 * Observed 2026-09-13: a panel drew "52% · resets 01:10" at 02:18, i.e. a number for a window
 * that had reopened an hour earlier, and the chooser scored that same 52.
 *
 * So a rolled-over window scores as `raw: 0` — the new window did start empty — while
 * `measured` goes null, because how much has been spent SINCE the reset is genuinely unknown
 * and a banner that announces "moved to X (session 0%)" would be stating an inference as a
 * measurement. The gate and the score get the useful half; the surface gets only the honest
 * half.
 *
 * (The composer's account menu drops such a window from the display entirely — same fact,
 * different job. It must not SHOW a number it cannot vouch for; the chooser must not STRAND
 * an account whose window it knows has reopened.)
 */
interface WindowReading {
  /** What the eligibility gate and the score use. 0 for a window that has already reset. */
  raw: number;
  /** What may be REPORTED — null when the number describes a window that no longer exists. */
  measured: number | null;
  /** 1 = the whole window is still ahead; 0 = it resets now. 1 when no reset was parsed. */
  life: number;
  /** The reset, when it is still in the future. 0 otherwise — a past reset is not a wait. */
  resetsAt: number;
}

function readWindow(limit: UsageLimitWire | undefined, lengthMs: number, now: number): WindowReading | null {
  if (!limit || !Number.isFinite(limit.percent)) return null;
  const resetsAt = Number.isFinite(limit.resetsAt) ? limit.resetsAt : 0;
  // Already reset: the window ahead of us is a FRESH one, so its life is whole and its
  // spend is zero-plus-whatever-happened-since, which nobody here can know.
  if (resetsAt > 0 && resetsAt <= now) return { raw: 0, measured: null, life: 1, resetsAt: 0 };
  // No parseable reset is NOT a reason to discount: claiming a window is nearly over because
  // we could not read when it ends would spend it on a guess. An unknown reset means full price.
  const life = resetsAt > 0 ? Math.min(1, Math.max(0, (resetsAt - now) / lengthMs)) : 1;
  return { raw: limit.percent, measured: limit.percent, life, resetsAt };
}

/** The windows of a reading, with `null` for a window that is not readable at all. */
function windows(limits: UsageLimitsResponse, now: number): {
  session: WindowReading | null;
  weekly: WindowReading | null;
  locked: boolean;
  resets: number[];
} {
  const sessionLimit = limits.limits.find((l) => l.key === 'session');
  const weeklyLimit = limits.limits.find((l) => l.key === 'weekly');
  const session = readWindow(sessionLimit, SESSION_WINDOW_MS, now);
  const weekly = readWindow(weeklyLimit, WEEKLY_WINDOW_MS, now);
  return {
    session,
    weekly,
    locked: Boolean(sessionLimit?.lockedReason || weeklyLimit?.lockedReason),
    // FUTURE resets only. `earliestResetAt` answers "when does work resume", and a reset that
    // has already happened answers it with a time in the past.
    resets: [session?.resetsAt ?? 0, weekly?.resetsAt ?? 0].filter((r) => r > now),
  };
}

/**
 * Pick the account that should serve the next turn, under one of two strategies.
 *
 * `sequential` is a different function entirely (`chooseSequential`, above): it ignores
 * percentages and drains the list in order. Everything below describes `score`, the default.
 *
 * ── `score` ───────────────────────────────────────────────────────────────────────────
 * An account is ELIGIBLE when every window it publishes is below `threshold` (on the RAW
 * percent) and its `lockedReason` is empty. Among the eligible, the lowest
 *
 *   session·sessionUsage%·sessionLife + weekly·weeklyUsage%·weeklyLife + order·positionInTheList
 *
 * serves the turn (see `SwitchWeights` for what the coefficients mean and why), after two
 * capacity sorts that come first — see the sort comment at the end of this function.
 *
 * Both windows are weighed together on purpose: an account with a fresh 5-hour window but an
 * exhausted week is not a place to send work. Gating the weekly window at the threshold and
 * then sorting on the session window alone was the 2026-09-10 bug — it let a 75%-spent week
 * win on a 1% five-hour window against an account with 6% of its week gone.
 *
 * ── TIME IS PART OF THE PRICE (2026-09-13) ────────────────────────────────────────────
 * A percentage alone cannot rank two accounts, because a window is worth only what is still
 * ahead of it. Owner, looking at four connected accounts: a 97% five-hour window that reopens
 * in three hours and a 91% week that stays shut for two days scored as the same kind of full,
 * while a five-hour window that had ALREADY reset an hour earlier was still being scored at
 * the 52% it held before the reset. The 2026-09-10 report was the same fact from the other
 * side: a second account's five-hour window was 15 minutes from resetting with 80% of it
 * unspent, and that capacity simply evaporated because nothing in the score knew the window
 * was about to burn.
 *
 * So each window's usage enters the score multiplied by the fraction of it still to run. A
 * percent about to be forgiven costs nearly nothing; a percent of a week with six days left
 * costs full price. The ELIGIBILITY GATE DOES NOT MOVE: it reads the raw percent, so the
 * discount can make an account cheaper but never make an exhausted one usable.
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
/**
 * A score, ROUNDED once at the moment it is computed.
 *
 * ── Why rounding and not a tolerance ──────────────────────────────────────────────────
 * The obvious way to absorb binary float error is a tolerance inside the comparator —
 * "treat these as equal if they are within epsilon". That is a trap: a tolerance is not an
 * equivalence relation, so the comparator becomes NON-TRANSITIVE (a≈b and b≈c while a<c),
 * and `Array.prototype.sort` with an inconsistent comparator produces an
 * implementation-defined order. With a relative tolerance the danger zone also moves with
 * the score's magnitude, so nothing in the code could tell you where it starts.
 *
 * Rounding has neither problem: equality of rounded values IS an equivalence relation, so
 * the comparator is consistent by construction and does not care how large the weights get.
 * Six decimals is far finer than any real reading (percentages arrive as whole numbers) and
 * far coarser than the ~1e-16 error that fractional weights introduce.
 *
 * ── The two limits, stated rather than discovered later ───────────────────────────────
 * A score difference below 5e-7 rounds away. Reaching one takes a coefficient around 1e-8,
 * which no UI path produces (the fields step by 0.5) and no sane caller sends; a weight that
 * small means "ignore this window" anyway, which `0` says properly.
 * Above a score of ~9e9, `value * 1e6` passes 2^53 and the multiply itself stops being
 * exact, so the rounding absorbs less than it claims. The comparator stays CONSISTENT there
 * — the same double always rounds to the same double — so the outcome is still deterministic;
 * only the float-error absorption degrades. Reaching it takes a coefficient near 1e8.
 */
function roundScore(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * `sequential` — drain the list in order, and move only when the API actually refuses.
 *
 * ── What makes this a different MODE and not a different sort ─────────────────────────
 * `score` forecasts: it reads percentages and moves BEFORE the wall, accepting that a
 * forecast is sometimes wrong in both directions. This mode refuses to forecast. The top
 * account serves every turn until the API itself says no; then the next one does. Nothing
 * else disqualifies an account — not 89%, not an unreadable cache, not a stale one.
 *
 * That is deliberate and it is the whole value of the mode: one account's window is spent to
 * the last turn before the next is touched, so a machine with four accounts gets four full
 * windows rather than four half-spent ones. The price is one visible limit error per account
 * per window — the error the `score` mode exists to avoid. The caller pays it knowingly, and
 * the post-hoc path (`onLimitRejected`) is what turns it into a resend rather than a dead end.
 *
 * A LOCKED window and a `needs-relogin` identity still disqualify: neither is a forecast.
 * The first is the API stating this window will not serve, the second is an account that
 * cannot serve at all.
 */
function chooseSequential(readings: AccountReading[], opts: ChooseOptions): ChooseResult {
  const now = opts.now ?? Date.now();
  const position = (id: string) => {
    const i = opts.orderedIds ? opts.orderedIds.indexOf(id) : -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const rejected: Array<{ id: string; why: string }> = [];
  const resets: number[] = [];
  const eligible: Array<{ id: string; session: number | null; weekly: number | null }> = [];

  for (const reading of readings) {
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
    // An unreadable, stale or number-less reading is NOT a disqualification here. This mode
    // never consults a percentage, so there is nothing for a missing one to invalidate —
    // where `score` cannot vouch for the account, `sequential` does not need to.
    if (!reading.limits) {
      eligible.push({ id: reading.id, session: null, weekly: null });
      continue;
    }
    const w = windows(reading.limits, now);
    resets.push(...w.resets);
    if (w.locked) {
      rejected.push({ id: reading.id, why: 'a usage window is already locked' });
      continue;
    }
    // Only MEASURED numbers reach the banner. This mode consults no percentage anyway, so a
    // window that has rolled over simply has nothing to say about the account it labels.
    eligible.push({
      id: reading.id,
      session: w.session?.measured ?? null,
      weekly: w.weekly?.measured ?? null,
    });
  }

  if (eligible.length === 0) {
    const earliest = resets.length > 0 ? Math.min(...resets) : undefined;
    return { accountId: null, rejected, ...(earliest === undefined ? {} : { earliestResetAt: earliest }) };
  }

  // Strictly the user's order — NOT `currentId` first. Staying put is already the answer here
  // whenever the current account is the highest-priority one still standing; preferring it
  // beyond that would strand the session below the top of the list after a window reopened,
  // which is the opposite of draining in order.
  eligible.sort((a, b) => (position(a.id) - position(b.id)) || a.id.localeCompare(b.id));
  const pick = eligible[0]!;
  return {
    accountId: pick.id,
    ...(pick.session === null ? {} : { sessionPercent: pick.session }),
    ...(pick.weekly === null ? {} : { weeklyPercent: pick.weekly }),
    // No numbers behind the pick: the surface must not imply one was measured.
    ...(pick.session === null && pick.weekly === null ? { unmeasured: true } : {}),
    rejected,
  };
}

export function chooseAccount(readings: AccountReading[], opts: ChooseOptions): ChooseResult {
  if ((opts.strategy ?? DEFAULT_SWITCH_STRATEGY) === 'sequential') {
    return chooseSequential(readings, opts);
  }
  const now = opts.now ?? Date.now();
  const weights = sanitizeSwitchWeights(opts.weights ?? DEFAULT_SWITCH_WEIGHTS);
  /** Where the user put this account. Unknown (or no order given) sorts last, so the
   *  id-based fallback below still decides and nothing becomes a coin flip. */
  const position = (id: string) => {
    const i = opts.orderedIds ? opts.orderedIds.indexOf(id) : -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  /**
   * The same position, BOUNDED, for use as a score term. `position` answers
   * `MAX_SAFE_INTEGER` for an account the caller gave no order for, which is exactly right
   * for a tie-break and catastrophic inside a sum — it would swamp every percentage and make
   * the order the only thing that mattered. An unordered account scores as if it sat one step
   * past the end of the list: last among the known, without erasing the rest of the formula.
   */
  const orderTerm = (id: string) => {
    const i = opts.orderedIds ? opts.orderedIds.indexOf(id) : -1;
    return i < 0 ? readings.length : i;
  };
  const rejected: Array<{ id: string; why: string }> = [];
  const candidates: Array<{
    id: string;
    /** Only what was MEASURED — a rolled-over window reports nothing. */
    session: number | null;
    weekly: number | null;
    score: number;
    /** 1 when too little headroom is left for a switch to be worth making. */
    thin: number;
    /** 1 when only ONE of the two windows could be read. */
    partial: number;
  }> = [];
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
    const w = windows(reading.limits, now);
    resets.push(...w.resets);
    if (w.locked) {
      rejected.push({ id: reading.id, why: 'a usage window is already locked' });
      continue;
    }
    if (w.session === null && w.weekly === null) {
      // NEITHER window parsed: the same situation as an account that publishes none — see
      // LAST RESORT. It reaches here rather than through the probe because the cache existed
      // and refreshed; it just carried nothing usable. ONE readable window is a different
      // case and is handled as a `partial` candidate below.
      lastResort.push(reading.id);
      continue;
    }
    // THE GATE IS ON THE RAW PERCENT, never on the discounted one. The discount below says
    // "spending here is cheap"; it must never be able to say "this account can serve", which
    // is a fact about the API's wall and not about our arithmetic.
    if (w.session !== null && w.session.raw >= opts.threshold) {
      rejected.push({ id: reading.id, why: `session usage is at ${Math.round(w.session.raw)}%` });
      continue;
    }
    if (w.weekly !== null && w.weekly.raw >= opts.threshold) {
      rejected.push({ id: reading.id, why: `weekly usage is at ${Math.round(w.weekly.raw)}%` });
      continue;
    }
    // A window is only worth what is still AHEAD of it. A five-hour window 40 minutes from
    // its reset is use-it-or-lose-it: whatever is unspent at the reset is gone, so a percent
    // already spent there costs the user almost nothing, while the same percent of a week
    // that has six days to run has to last six days. `life` is that ratio, and multiplying
    // the usage by it is what lets one number compare two windows of different size.
    // An unreadable window contributes 0 rather than a guess — see `partial`.
    const spent = (win: WindowReading | null) => (win ? win.raw * win.life : 0);
    // How close the account is to OUR wall on its worst window, undiscounted. This is not a
    // price, it is a capacity: how much work it can still take before we would be moving off
    // it again.
    const worst = Math.max(w.session?.raw ?? 0, w.weekly?.raw ?? 0);
    candidates.push({
      id: reading.id,
      session: w.session?.measured ?? null,
      weekly: w.weekly?.measured ?? null,
      thin: opts.threshold - worst < THIN_HEADROOM_PERCENT ? 1 : 0,
      partial: (w.session === null) !== (w.weekly === null) ? 1 : 0,
      // Rounded HERE, once, so every later comparison is between two settled numbers — see
      // `roundScore`. Two candidates that are mathematically tied but differ by ~1e-16 in
      // binary float would otherwise defeat every tie-break below and move a session for a
      // difference that does not exist.
      score: roundScore(
        weights.session * spent(w.session)
        + weights.weekly * spent(w.weekly)
        + weights.order * orderTerm(reading.id),
      ),
    });
  }

  if (candidates.length === 0 && lastResort.length > 0) {
    // Same tie-break as below, minus the percent nobody has: stay put if we can, else the
    // preferred account, else the user's own order. Deterministic, never a coin flip.
    const rank = (id: string) => (id === opts.currentId ? 0 : id === opts.preferredId ? 1 : 2);
    lastResort.sort((a, b) => (rank(a) - rank(b)) || (position(a) - position(b)) || a.localeCompare(b));
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

  // CAPACITY FIRST, THEN PRICE, THEN THE SCORE.
  //
  // `thin` and `partial` are not tie-breaks; they come BEFORE the score, and each answers a
  // question the score cannot.
  //
  // `thin` is the discount's one real hazard. A week at 89% that resets in ten minutes
  // discounts to almost nothing and would outrank every healthy account on the machine — and
  // it has ONE point of headroom, so the session would move there and move straight back.
  // The discount is right that spending there is cheap; it is silent on there being nothing
  // left to spend. An account inside `THIN_HEADROOM_PERCENT` of the wall therefore sorts
  // behind every account that is not, and only ever wins when nothing roomier exists.
  //
  // `partial` — one window read, one not — sorts behind a fully measured account of the same
  // class, because an unread window is an unknown and not a zero. It sorts AHEAD of a thin
  // one: an account with 5 points left is a worse bet than one with a healthy week and a
  // session we could not read.
  //
  // Then the lowest SCORE wins, and on a tie the account already serving, then the preferred
  // one, then whichever the user put higher in Settings — so a tie never moves a session for
  // nothing, never coin-flips, and never overrules the order the user chose.
  candidates.sort((a, b) => {
    if (a.thin !== b.thin) return a.thin - b.thin;
    if (a.partial !== b.partial) return a.partial - b.partial;
    if (a.score !== b.score) return a.score - b.score;
    const rank = (id: string) => (id === opts.currentId ? 0 : id === opts.preferredId ? 1 : 2);
    const byRank = rank(a.id) - rank(b.id);
    if (byRank !== 0) return byRank;
    const byPos = position(a.id) - position(b.id);
    return byPos !== 0 ? byPos : a.id.localeCompare(b.id);
  });

  const winner = candidates[0]!;
  return {
    accountId: winner.id,
    // Omitted rather than zeroed when the window rolled over or could not be read: the
    // banner states what was measured, and nothing else.
    ...(winner.session === null ? {} : { sessionPercent: winner.session }),
    ...(winner.weekly === null ? {} : { weeklyPercent: winner.weekly }),
    ...(winner.partial ? { partial: true } : {}),
    score: winner.score,
    rejected,
  };
}

/** Session usage at or above this: probe (it is free). */
export const PROBE_THRESHOLD_PERCENT = 80;
/** Session usage at or above this, or any `lockedReason`: switch. */
export const SWITCH_THRESHOLD_PERCENT = 90;
/**
 * Headroom below which an account is a bad PLACE TO MOVE TO, however cheap its discounted
 * score looks. Derived rather than invented: it is exactly the band in which we would already
 * be probing an account to move OFF it (`PROBE_THRESHOLD_PERCENT` → `SWITCH_THRESHOLD_PERCENT`),
 * and an account we would be leaving is not one to arrive at.
 */
export const THIN_HEADROOM_PERCENT = SWITCH_THRESHOLD_PERCENT - PROBE_THRESHOLD_PERCENT;

/**
 * Does the ACTIVE account's reading warrant a switch right now?
 *
 * A `lockedReason` triggers immediately regardless of percent — a locked window is not going
 * to serve the turn whatever the number beside it says.
 */
export function shouldSwitchAway(
  limits: UsageLimitsResponse,
  threshold: number = SWITCH_THRESHOLD_PERCENT,
  now: number = Date.now(),
): boolean {
  const w = windows(limits, now);
  if (w.locked) return true;
  return (w.session !== null && w.session.raw >= threshold)
    || (w.weekly !== null && w.weekly.raw >= threshold);
}

/**
 * Is it worth spending a (free) probe on the active account?
 *
 * Both of these read the ROLLOVER-CORRECTED percent, which is how a session comes home on its
 * own: the account it was moved off has a 95% five-hour window until that window resets, and
 * from the reset onward the very same cached reading says 0 — so nothing forces a switch away
 * from an account whose own window has already reopened.
 */
export function shouldProbe(
  limits: UsageLimitsResponse,
  threshold: number = PROBE_THRESHOLD_PERCENT,
  now: number = Date.now(),
): boolean {
  const w = windows(limits, now);
  if (w.locked) return true;
  return (w.session !== null && w.session.raw >= threshold)
    || (w.weekly !== null && w.weekly.raw >= threshold);
}
