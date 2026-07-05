import type { InsightManifest, ResolvedTweaks, TweakDecl } from './types.js';

/**
 * Pure tweak resolution: turn an insight's declared tweaks into concrete values
 * plus a time window. LOCKED design (no `range` type):
 *   - a relative range is an `enum` tweak whose key is `range` (e.g. `last_30_days`)
 *   - an explicit range is two `date` tweaks, `from` and `to`, which OVERRIDE the enum
 *   - every other tweak simply contributes its resolved value; unknown placeholder
 *     keys pass through unchanged at substitution time.
 */

const DAY_MS = 86_400_000;
/** Fallback window when an insight declares no range/from/to (30 days → daily). */
const DEFAULT_SPAN_DAYS = 30;

/** Multipliers for `last_<n>_<unit>` relative ranges. */
const UNIT_DAYS: Record<string, number> = {
  day: 1, days: 1,
  week: 7, weeks: 7,
  month: 30, months: 30,
  year: 365, years: 365,
};

function toISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Parse `last_30_days` / `last_1_year` → span in days, or null if not a relative range. */
export function parseRelativeRange(value: string): number | null {
  const m = /^last_(\d+)_(day|days|week|weeks|month|months|year|years)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = UNIT_DAYS[m[2]];
  if (!Number.isFinite(n) || n <= 0 || unit === undefined) return null;
  return n * unit;
}

/** The set-or-default value for one declared tweak. */
function tweakValue(decl: TweakDecl): string {
  if (decl.value !== undefined && decl.value !== null && String(decl.value).trim() !== '') {
    return String(decl.value).trim();
  }
  if (decl.default !== undefined && decl.default !== null) return String(decl.default).trim();
  return '';
}

function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * Resolve an insight's tweaks into concrete values + a time window. `now` is
 * injectable so relative-range resolution is deterministic under test.
 */
export function resolveTweaks(manifest: InsightManifest, now: Date = new Date()): ResolvedTweaks {
  const values: Record<string, string> = {};
  for (const decl of manifest.tweaks) {
    values[decl.key] = tweakValue(decl);
  }

  const toDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let fromISO: string | null = null;
  let toISO: string | null = null;

  // 1. Relative range enum (key `range`).
  const rangeVal = values.range;
  if (rangeVal) {
    const span = parseRelativeRange(rangeVal);
    if (span !== null) {
      toISO = toISODate(toDay);
      fromISO = toISODate(new Date(toDay.getTime() - span * DAY_MS));
    }
  }

  // 2. Explicit from/to date tweaks OVERRIDE the relative enum.
  if (values.from && isCalendarDate(values.from)) fromISO = values.from;
  if (values.to && isCalendarDate(values.to)) toISO = values.to;

  // 3. Fallback: a trailing DEFAULT_SPAN_DAYS window when nothing was declared.
  if (!toISO) toISO = toISODate(toDay);
  if (!fromISO) {
    const to = new Date(`${toISO}T00:00:00Z`);
    fromISO = toISODate(new Date(to.getTime() - DEFAULT_SPAN_DAYS * DAY_MS));
  }

  const spanMs = Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`);
  const spanDays = Math.max(0, Math.round(spanMs / DAY_MS));

  return { values, range: { fromISO, toISO }, spanDays };
}
