/**
 * Budget — per-action prompt; never defaults.
 *
 * Per task hard rule (line 254): the agent always asks the user for budget;
 * never defaults a daily/lifetime budget. CLI rejects any campaign / adset
 * mutation without an explicit value. Strategy Optimizer agent emits
 * daily_budget_usd: null + ASK_USER_FOR_BUDGET so main agent prompts.
 */

export interface BudgetSpec {
  /** Currency-major value as the operator typed it (e.g. "30" for ₺30 or $30). */
  amount: number;
  /** ISO 4217 — TRY, USD, EUR, GBP, etc. Inferred from the ad account's currency. */
  currency: string;
}

export class BudgetMissingError extends Error {
  constructor(verb: string) {
    super(
      `${verb} requires --daily-budget <amount>. The agent never assumes or defaults a budget — ` +
      `the operator must specify it for every campaign and adset.`,
    );
    this.name = 'BudgetMissingError';
  }
}

export class BudgetInvalidError extends Error {
  constructor(reason: string) {
    super(`--daily-budget invalid: ${reason}`);
    this.name = 'BudgetInvalidError';
  }
}

/**
 * Parse + validate a CLI --daily-budget argument.
 * Returns the value in MINOR currency units (kuruş for TRY, cents for USD)
 * which is what Meta's Graph API expects in `daily_budget` fields.
 */
export function parseDailyBudget(raw: string | undefined, currency: string): number {
  if (raw == null || raw.trim() === '') {
    throw new BudgetMissingError('this command');
  }
  const cleaned = raw.replace(/[\s,]/g, '');
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) {
    throw new BudgetInvalidError(`"${raw}" is not a number`);
  }
  if (n <= 0) {
    throw new BudgetInvalidError(`budget must be positive (got ${n})`);
  }
  // Meta requires whole minor units; round to nearest.
  const minor = Math.round(n * 100);
  if (!Number.isInteger(minor) || minor < 1) {
    throw new BudgetInvalidError(`budget too small in ${currency} (minor=${minor})`);
  }
  return minor;
}

/**
 * Convert a raw scale percent ("+20", "-15", "20") to a multiplier.
 * Negative percents are allowed for downscaling; reject anything outside
 * [-50, +500] as too large for a single move (snow-globe rule).
 */
export function parseScalePct(raw: string): number {
  const n = Number.parseFloat(raw.replace('+', ''));
  if (!Number.isFinite(n)) {
    throw new BudgetInvalidError(`scale percent "${raw}" is not a number`);
  }
  if (n < -50 || n > 500) {
    throw new BudgetInvalidError(
      `scale percent ${n}% out of safe range [-50, +500]. ` +
      `account-ops.md §4 caps single-move scaling at +20-30%; larger requires duplicate-and-test.`,
    );
  }
  return 1 + n / 100;
}

/**
 * Apply scale percent to a current daily budget (minor units).
 * Returns rounded minor-units integer for Meta's API.
 */
export function applyScale(currentMinor: number, pct: number): number {
  if (currentMinor <= 0) {
    throw new BudgetInvalidError('current budget must be positive');
  }
  const scaled = Math.round(currentMinor * (1 + pct / 100));
  if (scaled < 1) {
    throw new BudgetInvalidError(`scaled budget < 1 minor unit (was ${currentMinor}, pct=${pct})`);
  }
  return scaled;
}

/** Format minor units back to a display string. */
export function formatBudget(minor: number, currency: string): string {
  const major = (minor / 100).toFixed(2);
  return `${major} ${currency}`;
}
