/**
 * Number and date formatting for chart axes, tooltips and labels. Pure (no DOM).
 *
 *   auto     - grouped digits below 10,000, compact (12.3K, 4.5M) from there;
 *   number   - grouped digits, up to two decimals;
 *   compact  - 1.2K / 3.4M;
 *   percent  - the value is a FRACTION (0.235 -> 23.5%);
 *   currency - the unit names the ISO code when it is one (EUR, TRY), else USD.
 *
 * The unit follows the figure ("1,204 users", "12%" for a `%` unit) except for
 * percent and currency, whose format already carries it. Tick formatters take
 * their precision from the tick STEP, so an axis reads 0 / 0.5 / 1 / 1.5, never
 * 0 / 0.5 / 1 / 1.5000000000000002 nor 0 / 1 / 1 / 2.
 */

export const CHART_FORMATS = ['auto', 'number', 'compact', 'percent', 'currency'] as const;
export type ChartFormat = (typeof CHART_FORMATS)[number];

export function toChartFormat(v: unknown): ChartFormat {
  return (CHART_FORMATS as readonly unknown[]).includes(v) ? (v as ChartFormat) : 'auto';
}

/** The ISO currency a `currency` value uses: the unit when it is a 3-letter code, else USD. */
export function currencyCode(unit: string | null | undefined): string {
  return unit && /^[A-Za-z]{3}$/.test(unit.trim()) ? unit.trim().toUpperCase() : 'USD';
}

export interface FormatOptions {
  format?: ChartFormat;
  unit?: string | null;
  locale?: string;
  /** Decimal places to show at most (default: 2, or what the tick step needs). */
  maxDecimals?: number;
  /** Decimal places to show at least (ticks pin this so 0.5 and 1.0 line up; default 0). */
  minDecimals?: number;
}

const cache = new Map<string, Intl.NumberFormat>();

function nf(locale: string | undefined, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ''}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, opts);
    } catch {
      // An unknown currency code or locale must not take the chart down.
      f = new Intl.NumberFormat(undefined, { maximumFractionDigits: opts.maximumFractionDigits });
    }
    cache.set(key, f);
  }
  return f;
}

/** The unit written after a figure: none for percent/currency (the format carries it). */
export function unitSuffix(format: ChartFormat, unit: string | null | undefined): string {
  const u = unit?.trim();
  if (!u || format === 'percent' || format === 'currency') return '';
  return u === '%' ? '%' : ` ${u}`;
}

/** Which concrete format `auto` resolves to for a value of this magnitude. */
export function resolveFormat(format: ChartFormat, magnitude: number): Exclude<ChartFormat, 'auto'> {
  if (format !== 'auto') return format;
  return Math.abs(magnitude) >= 10_000 ? 'compact' : 'number';
}

/** Format a figure without its unit. `magnitude` decides `auto` (default: the value itself). */
export function formatNumber(v: number, opts: FormatOptions = {}, magnitude = v): string {
  if (!Number.isFinite(v)) return '';
  const format = resolveFormat(opts.format ?? 'auto', magnitude);
  const max = opts.maxDecimals ?? (format === 'compact' || format === 'percent' ? 1 : 2);
  // Money reads in whole cents unless a tick formatter pinned the precision.
  const min = Math.min(opts.minDecimals ?? (format === 'currency' ? 2 : 0), max);
  const digits = { minimumFractionDigits: min, maximumFractionDigits: max };
  switch (format) {
    case 'compact':
      return nf(opts.locale, { notation: 'compact', ...digits }).format(v);
    case 'percent':
      return nf(opts.locale, { style: 'percent', ...digits }).format(v);
    case 'currency':
      return nf(opts.locale, { style: 'currency', currency: currencyCode(opts.unit), ...digits }).format(v);
    default:
      return nf(opts.locale, digits).format(v);
  }
}

/** Format a figure with its unit ("1,204 users", "23.5%", "$1,200.50", "12.3K sessions"). */
export function formatValue(v: number, opts: FormatOptions = {}): string {
  if (!Number.isFinite(v)) return '';
  return formatNumber(v, opts) + unitSuffix(opts.format ?? 'auto', opts.unit);
}

/**
 * A formatter for a SET of figures read side by side (the end labels of a
 * compact chart, one tooltip's rows, a chart's value labels): `auto` resolves
 * ONCE from the largest, so a set never mixes "22K" with "8,859". The rest of
 * the options (unit, decimals) apply to every figure alike.
 */
export function setFormatter(values: readonly number[], opts: FormatOptions = {}): (v: number) => string {
  const magnitude = values.reduce((m, v) => (Number.isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
  const o: FormatOptions = { ...opts, format: resolveFormat(opts.format ?? 'auto', magnitude) };
  return (v) => formatValue(v, o);
}

/** Decimal places a step of this size needs (0.25 -> 2, 5 -> 0). */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  // Enough places to tell adjacent ticks apart, tolerant of float noise.
  for (let d = 0; d <= 6; d++) {
    if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  }
  return 6;
}

/**
 * A formatter for one axis's ticks: every label shares the precision the step
 * needs and `auto` resolves once from the largest tick, so an axis never mixes
 * "900" with "1.2K". The unit is left off (the axis is labelled once, by the
 * tooltip and the block title); pass `withUnit` for a single-tick axis.
 */
export function tickFormatter(ticks: readonly number[], step: number, opts: FormatOptions = {}, withUnit = false): (v: number) => string {
  const magnitude = ticks.reduce((m, t) => Math.max(m, Math.abs(t)), 0);
  const format = resolveFormat(opts.format ?? 'auto', magnitude);
  let decimals: number;
  if (format === 'compact') {
    // Precision relative to the compact exponent (K = 1e3, M = 1e6 ...).
    const exp = magnitude >= 1e3 ? 3 * Math.floor(Math.log10(magnitude) / 3) : 0;
    decimals = Math.min(2, stepDecimals(step / 10 ** exp));
  } else if (format === 'percent') {
    decimals = Math.min(2, stepDecimals(step * 100));
  } else {
    decimals = Math.min(4, stepDecimals(step));
  }
  const o: FormatOptions = { ...opts, format, maxDecimals: decimals, minDecimals: format === 'compact' ? 0 : decimals };
  return (v) => {
    // A near-zero tick (float noise from the step multiplication) reads as 0, never "-0".
    const x = Math.abs(v) < (step || 1) * 1e-9 ? 0 : v;
    return withUnit ? formatValue(x, o) : formatNumber(x, o, magnitude);
  };
}

// ── Dates ────────────────────────────────────────────────────────────────

const dateCache = new Map<string, Intl.DateTimeFormat>();

function df(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(opts)}`;
  let f = dateCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts });
    dateCache.set(key, f);
  }
  return f;
}

type TickUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * Time-axis tick labels, short and calendar-aware: day ticks "Sep 3", month
 * ticks "Sep" with the year on January and on the first tick ("Sep 2026"),
 * year ticks "2026", sub-day ticks "14:00" with the date where the day changes.
 */
export function timeTickFormatter(unit: TickUnit, locale?: string): (ms: number, index: number, all: readonly number[]) => string {
  return (ms, index, all) => {
    const d = new Date(ms);
    const prev = index > 0 ? new Date(all[index - 1]) : null;
    switch (unit) {
      case 'year':
        return df(locale, { year: 'numeric' }).format(d);
      case 'month':
        if (index === 0 || d.getUTCMonth() === 0 || (prev && prev.getUTCFullYear() !== d.getUTCFullYear())) {
          return df(locale, { month: 'short', year: 'numeric' }).format(d);
        }
        return df(locale, { month: 'short' }).format(d);
      case 'day':
      case 'week':
        return df(locale, { month: 'short', day: 'numeric' }).format(d);
      default:
        if (index === 0 || (prev && prev.getUTCDate() !== d.getUTCDate())) {
          return df(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
        }
        return df(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    }
  };
}

/**
 * A stored time key written for a tooltip title, at the key's own grain:
 * "Sep 3, 2026", "Sep 2026", "2026", a week as its Monday, a date-time with
 * its time. An unparseable key is returned as is.
 */
export function formatTimeKey(key: string, ms: number | null, locale?: string): string {
  if (ms === null) return key;
  const d = new Date(ms);
  const s = key.trim();
  if (/^\d{4}$/.test(s)) return df(locale, { year: 'numeric' }).format(d);
  if (/^\d{4}-\d{2}$/.test(s)) return df(locale, { month: 'short', year: 'numeric' }).format(d);
  if (/T\d{2}:\d{2}/.test(s)) {
    return df(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  }
  return df(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}
