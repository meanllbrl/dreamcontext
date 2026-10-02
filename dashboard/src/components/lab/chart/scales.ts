/**
 * Scales for the hand-rolled charts: value -> pixel, with "nice" ticks whose
 * COUNT is chosen from the pixels available (never a fixed 5), so a tall cell
 * gets more gridlines and a short one fewer, and labels never crowd.
 *
 * Pure (no DOM): unit-tested in tests/unit/lab-chart-scales.test.ts.
 */

/** How many ticks fit along `px` pixels with at least `minSpacing` between them (>= 2). */
export function tickCountFor(px: number, minSpacing: number): number {
  if (!(px > 0) || !(minSpacing > 0)) return 2;
  return Math.max(2, Math.floor(px / minSpacing) + 1);
}

const E10 = Math.sqrt(50);
const E5 = Math.sqrt(10);
const E2 = Math.sqrt(2);

/** The 1/2/5 x 10^k step that splits [min, max] into about `count` intervals. */
export function niceStep(min: number, max: number, count: number): number {
  const span = Math.abs(max - min);
  if (!(span > 0) || !(count > 0)) return 0;
  const raw = span / Math.max(1, count);
  const power = Math.floor(Math.log10(raw));
  const error = raw / 10 ** power;
  const factor = error >= E10 ? 10 : error >= E5 ? 5 : error >= E2 ? 2 : 1;
  return factor * 10 ** power;
}

/** Round away the float noise a step multiplication leaves (0.30000000000000004 -> 0.3). */
function clean(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(Math.min(20, decimals)));
}

/**
 * Nice ticks covering [min, max] at about `count` intervals: every tick a
 * multiple of a 1/2/5 step, inside the range (use `niceDomain` first to extend
 * the range to whole steps). A flat range yields the single value.
 */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const step = niceStep(lo, hi, count);
  if (!(step > 0)) return [lo];
  const start = Math.ceil(lo / step - 1e-9);
  const stop = Math.floor(hi / step + 1e-9);
  const out: number[] = [];
  for (let i = start; i <= stop; i++) out.push(clean(i * step, step));
  return out;
}

/** [min, max] extended outward to whole nice steps (the axis ends on a labelled tick). */
export function niceDomain(min: number, max: number, count: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    // A flat series: centre it in a range one unit (or 10%) wide, zero-anchored when it is 0.
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return min === 0 ? [0, 1] : [min - pad, max + pad];
  }
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  // Two passes: extending the range can change the step (d3's niceing loop).
  for (let i = 0; i < 2; i++) {
    const step = niceStep(lo, hi, count);
    if (!(step > 0)) break;
    lo = clean(Math.floor(lo / step + 1e-9) * step, step);
    hi = clean(Math.ceil(hi / step - 1e-9) * step, step);
  }
  return [lo, hi];
}

/** Step multipliers a SHORT axis may use: 2.5 lets 0..25K end at the data instead of 0..40K. */
const TIGHT_STEPS = [1, 2, 2.5, 5];
/** Axes with at most this many ticks pick the step that hugs the data (`niceExtent`). */
export const TIGHT_TICKS = 4;

/**
 * The domain and step for an axis of about `count` intervals. A long axis
 * (count > TIGHT_TICKS) is `niceDomain` + `niceStep`, as before. A short one
 * (a 3x3 cell's 2 or 3 ticks) searches the 1 / 2 / 2.5 / 5 steps for the one
 * whose whole-step domain overshoots the data least, with a small cost for
 * straying from `count` intervals: 0..24K gets 0 / 25K, never 0 / 20K / 40K.
 */
export function niceExtent(min: number, max: number, count: number): { domain: [number, number]; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max || count > TIGHT_TICKS) {
    const domain = niceDomain(min, max, count);
    return { domain, step: niceStep(domain[0], domain[1], count) };
  }
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const span = hi - lo;
  const top = Math.floor(Math.log10(span));
  let best: { domain: [number, number]; step: number; score: number } | null = null;
  for (let k = top - 2; k <= top + 1; k++) {
    for (const m of TIGHT_STEPS) {
      const step = m * 10 ** k;
      const d0 = clean(Math.floor(lo / step + 1e-9) * step, step);
      const d1 = clean(Math.ceil(hi / step - 1e-9) * step, step);
      const n = Math.round((d1 - d0) / step);
      if (n < 1 || n > count + 1) continue;
      const score = (d1 - d0) / span - 1 + 0.1 * Math.abs(n - count);
      if (!best || score < best.score - 1e-9) best = { domain: [d0, d1], step, score };
    }
  }
  if (!best) {
    const domain = niceDomain(min, max, count);
    return { domain, step: niceStep(domain[0], domain[1], count) };
  }
  return { domain: best.domain, step: best.step };
}

/** Every multiple of `step` in [d0, d1] (the ticks of a `niceExtent`). */
function stepTicks(d0: number, d1: number, step: number): number[] {
  if (!(step > 0)) return [d0];
  const out: number[] = [];
  const start = Math.ceil(d0 / step - 1e-9);
  const stop = Math.floor(d1 / step + 1e-9);
  for (let i = start; i <= stop; i++) out.push(clean(i * step, step));
  return out;
}

export interface LinearScale {
  (v: number): number;
  invert(px: number): number;
  domain: [number, number];
  range: [number, number];
  ticks: number[];
  /** The tick step (0 when the domain is flat): tick formatters take their precision from it. */
  step: number;
}

export interface LinearScaleOptions {
  /** Output pixels, e.g. [plotHeight, 0] for a y axis (top is 0). */
  range: [number, number];
  /** Approximate tick count; use `tickCountFor(px, spacing)`. */
  tickCount?: number;
  /** Extend the domain to whole nice steps (default true). */
  nice?: boolean;
  /** Include zero in the domain (the `yMin: zero` option; bars always want it). */
  zero?: boolean;
}

/** A linear scale over the extent of `values` (non-finite values ignored). */
export function linearScale(values: readonly number[], opts: LinearScaleOptions): LinearScale {
  const finite = values.filter((v) => Number.isFinite(v));
  let lo = finite.length ? Math.min(...finite) : 0;
  let hi = finite.length ? Math.max(...finite) : 1;
  if (opts.zero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const count = opts.tickCount ?? 5;
  // A short nice axis hugs the data (niceExtent); a long one, and an un-niced range, keep niceTicks.
  const tight = opts.nice !== false && lo !== hi && count <= TIGHT_TICKS ? niceExtent(lo, hi, count) : null;
  const [d0, d1] = tight ? tight.domain : opts.nice === false ? (lo === hi ? niceDomain(lo, hi, count) : [lo, hi]) : niceDomain(lo, hi, count);
  const [r0, r1] = opts.range;
  const span = d1 - d0 || 1;
  const scale = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as LinearScale;
  scale.invert = (px: number) => d0 + ((px - r0) / ((r1 - r0) || 1)) * span;
  scale.domain = [d0, d1];
  scale.range = [r0, r1];
  scale.ticks = tight ? stepTicks(d0, d1, tight.step) : niceTicks(d0, d1, count);
  scale.step = tight ? tight.step : niceStep(d0, d1, count);
  return scale;
}

export interface BandScale {
  /** The band's leading edge for index `i`. */
  start(i: number): number;
  /** The band's centre for index `i`. */
  center(i: number): number;
  /** Mark thickness (capped by `maxBandwidth`; the band's leftover is air). */
  bandwidth: number;
  /** Distance between successive band starts. */
  step: number;
  /** The index whose slot contains pixel `px` (clamped to the ends; -1 when empty). */
  indexAt(px: number): number;
  count: number;
}

export interface BandScaleOptions {
  /** Fraction of the step left empty between bands (default 0.25). */
  paddingInner?: number;
  /** Fraction of a step left empty at each end (default 0.15). */
  paddingOuter?: number;
  /** Thickness cap in px (dataviz: bars <= 24px); the mark is centred in its slot. */
  maxBandwidth?: number;
}

/** Evenly spaced bands for `count` categories across [r0, r1] (bars, heatmap cells). */
export function bandScale(count: number, range: [number, number], opts: BandScaleOptions = {}): BandScale {
  const n = Math.max(0, Math.floor(count));
  const inner = Math.min(0.95, Math.max(0, opts.paddingInner ?? 0.25));
  const outer = Math.max(0, opts.paddingOuter ?? 0.15);
  const [r0, r1] = range;
  const length = r1 - r0;
  const step = n > 0 ? length / Math.max(1, n - inner + outer * 2) : 0;
  const full = step * (1 - inner);
  const bandwidth = opts.maxBandwidth ? Math.min(full, opts.maxBandwidth) : full;
  const first = r0 + step * outer;
  const slotStart = (i: number) => first + step * i;
  return {
    count: n,
    step,
    bandwidth,
    start: (i) => slotStart(i) + (full - bandwidth) / 2,
    center: (i) => slotStart(i) + full / 2,
    indexAt: (px) => {
      if (n === 0 || step === 0) return -1;
      // Each slot owns its band plus half the padding on either side.
      const i = Math.floor((px - first + (step * inner) / 2) / step);
      return Math.min(n - 1, Math.max(0, i));
    },
  };
}

/**
 * Evenly spaced points for `count` categories (a line over non-time keys): the
 * first at r0 + inset, the last at r1 - inset; a single point sits in the middle.
 */
export function pointPositions(count: number, range: [number, number], inset = 0): number[] {
  const n = Math.max(0, Math.floor(count));
  const [r0, r1] = range;
  if (n === 0) return [];
  if (n === 1) return [(r0 + r1) / 2];
  const a = r0 + inset;
  const b = r1 - inset;
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

// ── Time ─────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

/**
 * A series time key as epoch ms (UTC), or null when it is not a time. Accepts
 * what the lab stores: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, ISO week `YYYY-Www` (its
 * Monday) and ISO date-times.
 */
export function parseTimeKey(t: string): number | null {
  const s = t.trim();
  let m = /^(\d{4})$/.exec(s);
  if (m) return Date.UTC(Number(m[1]), 0, 1);
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  m = /^(\d{4})-W(\d{2})$/.exec(s);
  if (m) {
    const year = Number(m[1]);
    const week = Number(m[2]);
    // ISO week 1 holds January 4th; weeks start on Monday.
    const jan4 = Date.UTC(year, 0, 4);
    const jan4Dow = (new Date(jan4).getUTCDay() + 6) % 7;
    return jan4 - jan4Dow * DAY + (week - 1) * 7 * DAY;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** True when every key parses as a time (the x axis is then a real time axis). */
export function allTimeKeys(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((k) => parseTimeKey(k) !== null);
}

export type TimeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

interface TimeInterval { unit: TimeUnit; n: number; approx: number }

const TIME_INTERVALS: TimeInterval[] = [
  { unit: 'minute', n: 1, approx: 60_000 },
  { unit: 'minute', n: 5, approx: 300_000 },
  { unit: 'minute', n: 15, approx: 900_000 },
  { unit: 'minute', n: 30, approx: 1_800_000 },
  { unit: 'hour', n: 1, approx: 3_600_000 },
  { unit: 'hour', n: 3, approx: 10_800_000 },
  { unit: 'hour', n: 6, approx: 21_600_000 },
  { unit: 'hour', n: 12, approx: 43_200_000 },
  { unit: 'day', n: 1, approx: DAY },
  { unit: 'day', n: 2, approx: 2 * DAY },
  { unit: 'week', n: 1, approx: 7 * DAY },
  { unit: 'week', n: 2, approx: 14 * DAY },
  { unit: 'month', n: 1, approx: 30 * DAY },
  { unit: 'month', n: 3, approx: 91 * DAY },
  { unit: 'month', n: 6, approx: 182 * DAY },
  { unit: 'year', n: 1, approx: 365 * DAY },
  { unit: 'year', n: 2, approx: 730 * DAY },
  { unit: 'year', n: 5, approx: 1826 * DAY },
  { unit: 'year', n: 10, approx: 3652 * DAY },
];

/** The first boundary of `iv` at or after `ms` (UTC; weeks start Monday). */
function ceilTo(ms: number, iv: TimeInterval): number {
  const d = new Date(ms);
  switch (iv.unit) {
    case 'minute':
    case 'hour':
      return Math.ceil(ms / iv.approx) * iv.approx;
    case 'day': {
      let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (t < ms) t += DAY;
      // Multi-day steps align to the day number so ticks stay put as the range slides.
      while (Math.round(t / DAY) % iv.n !== 0) t += DAY;
      return t;
    }
    case 'week': {
      let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (t < ms) t += DAY;
      while (new Date(t).getUTCDay() !== 1) t += DAY;
      return t;
    }
    case 'month': {
      let y = d.getUTCFullYear();
      let mo = d.getUTCMonth();
      if (Date.UTC(y, mo, 1) < ms) mo += 1;
      while (mo % iv.n !== 0) mo += 1;
      y += Math.floor(mo / 12);
      return Date.UTC(y, mo % 12, 1);
    }
    case 'year': {
      let y = d.getUTCFullYear();
      if (Date.UTC(y, 0, 1) < ms) y += 1;
      while (y % iv.n !== 0) y += 1;
      return Date.UTC(y, 0, 1);
    }
  }
}

function addInterval(ms: number, iv: TimeInterval): number {
  if (iv.unit === 'month' || iv.unit === 'year') {
    const d = new Date(ms);
    const months = iv.unit === 'month' ? iv.n : iv.n * 12;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1);
  }
  return ms + (iv.unit === 'week' ? iv.n * 7 * DAY : iv.unit === 'day' ? iv.n * DAY : iv.n * iv.approx);
}

export interface TimeTicks {
  ticks: number[];
  unit: TimeUnit;
  /** Interval multiple (every `n` units). */
  n: number;
}

/**
 * Calendar-aligned ticks inside [start, end] (epoch ms), at most `maxCount`:
 * the finest interval on the ladder (minutes .. decades) whose tick count fits.
 * `minUnit` stops the ladder below the data's own grain (daily data never gets
 * hour ticks).
 */
export function timeTicks(start: number, end: number, maxCount: number, minUnit: TimeUnit = 'minute'): TimeTicks {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const order: TimeUnit[] = ['minute', 'hour', 'day', 'week', 'month', 'year'];
  const ladder = TIME_INTERVALS.filter((iv) => order.indexOf(iv.unit) >= order.indexOf(minUnit));
  const cap = Math.max(1, Math.floor(maxCount));
  for (const iv of ladder) {
    if ((hi - lo) / iv.approx + 1 > cap + 1) continue;
    const ticks: number[] = [];
    for (let t = ceilTo(lo, iv); t <= hi && ticks.length <= cap; t = addInterval(t, iv)) ticks.push(t);
    if (ticks.length <= cap) return { ticks, unit: iv.unit, n: iv.n };
  }
  const last = ladder[ladder.length - 1];
  return { ticks: [ceilTo(lo, last)].filter((t) => t <= hi), unit: last.unit, n: last.n };
}

/** The finest time unit a key list is stored at (daily keys -> 'day'), for `timeTicks`' minUnit. */
export function keyGrain(keys: readonly string[]): TimeUnit {
  if (keys.some((k) => /T\d{2}:\d{2}/.test(k))) return 'minute';
  if (keys.some((k) => /^\d{4}-\d{2}-\d{2}$/.test(k.trim()))) return 'day';
  if (keys.some((k) => /^\d{4}-W\d{2}$/.test(k.trim()))) return 'week';
  if (keys.some((k) => /^\d{4}-\d{2}$/.test(k.trim()))) return 'month';
  return 'year';
}

export interface TimeScale {
  (ms: number): number;
  invert(px: number): number;
  domain: [number, number];
  range: [number, number];
}

/** A linear map from epoch ms to pixels; a single instant sits mid-range. */
export function timeScale(domain: [number, number], range: [number, number]): TimeScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const scale = ((ms: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((ms - d0) / span) * (r1 - r0))) as TimeScale;
  scale.invert = (px: number) => (span === 0 ? d0 : d0 + ((px - r0) / ((r1 - r0) || 1)) * span);
  scale.domain = [d0, d1];
  scale.range = [r0, r1];
  return scale;
}
