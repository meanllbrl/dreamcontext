/**
 * sleepLevels — the dashboard's debt→level mapping, as PURE functions with no
 * React or network imports, so `tests/unit/dashboard-sleep-thresholds.test.ts`
 * can import and exercise it directly instead of parsing it as text.
 *
 * The thresholds are no longer constants: a brain sets its own ladder in
 * `.config.json` `sleep.thresholds` and `/api/sleep` ships the RESOLVED values
 * on every response. The exported `DEFAULT_*` values are the shipped fallback
 * for a zero-config brain (and for a response that predates the field) and are
 * still guarded against backend drift by that test — the mirror silently
 * drifted twice before, each time leaving the app one level away from the
 * terminal for the same debt.
 *
 * Alert 0–23 · Drowsy 24–39 · Sleepy 40–59 · Must Sleep 60+ (defaults).
 */

/** The resolved debt ladder, mirroring `SleepThresholds` in src/lib/sleep-consolidation.ts. */
export interface SleepThresholds {
  drowsy: number;
  sleepy: number;
  mustSleep: number;
  deepAuthority: number;
  cooldownOverride: number;
}

export const DEFAULT_DEBT_DROWSY = 24;
export const DEFAULT_DEBT_SLEEPY = 40;
export const DEFAULT_DEBT_MUST_SLEEP = 60;

export const DEFAULT_SLEEP_THRESHOLDS: SleepThresholds = {
  drowsy: DEFAULT_DEBT_DROWSY,
  sleepy: DEFAULT_DEBT_SLEEPY,
  mustSleep: DEFAULT_DEBT_MUST_SLEEP,
  deepAuthority: Math.round(DEFAULT_DEBT_MUST_SLEEP * 1.5),
  cooldownOverride: DEFAULT_DEBT_MUST_SLEEP * 2,
};

/** The brain's ladder from an `/api/sleep` payload, defaults when it predates the field. */
export function sleepThresholds(
  sleep: { thresholds?: SleepThresholds } | null | undefined,
): SleepThresholds {
  return sleep?.thresholds ?? DEFAULT_SLEEP_THRESHOLDS;
}

/** Debt value at which the bar reads "full" — a consolidation is required. */
export function sleepDebtMax(t: SleepThresholds = DEFAULT_SLEEP_THRESHOLDS): number {
  return t.mustSleep;
}

export function getSleepLevel(debt: number, t: SleepThresholds = DEFAULT_SLEEP_THRESHOLDS): string {
  if (debt < t.drowsy) return 'Alert';
  if (debt < t.sleepy) return 'Drowsy';
  if (debt < t.mustSleep) return 'Sleepy';
  return 'Must Sleep';
}

export function getSleepLevelKey(debt: number, t: SleepThresholds = DEFAULT_SLEEP_THRESHOLDS): string {
  if (debt < t.drowsy) return 'alert';
  if (debt < t.sleepy) return 'drowsy';
  if (debt < t.mustSleep) return 'sleepy';
  return 'must_sleep';
}

/**
 * Map sleep debt onto the Sleepy mascot's three moods, so the companion's face
 * mirrors how rested the project's memory is: wide awake while debt is low, lids
 * dropping as it climbs, fully asleep once a consolidation is overdue.
 */
export function getSleepMood(
  debt: number,
  t: SleepThresholds = DEFAULT_SLEEP_THRESHOLDS,
): 'idle' | 'sleepy' | 'sleeps' {
  if (debt < t.sleepy) return 'idle';
  if (debt < t.mustSleep) return 'sleepy';
  return 'sleeps';
}

/** The four range labels, byte-identical to the backend's `sleepinessRange()`. */
export function sleepRangeLabels(
  t: SleepThresholds = DEFAULT_SLEEP_THRESHOLDS,
): { level: string; range: string }[] {
  return [
    { level: 'Alert', range: `0-${t.drowsy - 1}` },
    { level: 'Drowsy', range: `${t.drowsy}-${t.sleepy - 1}` },
    { level: 'Sleepy', range: `${t.sleepy}-${t.mustSleep - 1}` },
    { level: 'Must Sleep', range: `${t.mustSleep}+` },
  ];
}
