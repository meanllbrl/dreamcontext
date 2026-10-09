import {
  LabError,
  type FunnelAccess,
  type FunnelAccessRow,
  type FunnelBenchmark,
  type FunnelCacheEntry,
  type FunnelDay,
  type FunnelDef,
  type FunnelDimension,
  type FunnelIntersection,
  type FunnelLadder,
  type FunnelLadderStage,
  type FunnelMetricFormat,
  type FunnelMetricValue,
  type FunnelNote,
  type FunnelPayment,
  type FunnelPaymentCell,
  type FunnelPaymentReason,
  type FunnelProvenance,
  type FunnelRateDef,
  type FunnelSegment,
  type FunnelSet,
  type FunnelSnapshot,
  type FunnelStep,
  type FunnelWeek,
  type FunnelWindow,
  type RawFunnelSet,
  type Series,
} from './types.js';
import { deriveLadderBands } from './funnelLadder.js';

/**
 * Funnel-set contract (`funnel-set/v1`) — validation, caps, snapshots, deltas.
 *
 * A funnel insight's adapter returns ONE funnel-set object instead of Series[].
 * This module is the contract's enforcement point: `parseFunnelSet` validates
 * the shape, applies every cap (funnels, steps, dimensions, segment cardinality
 * → top-N + "Other", total bytes), and reports every truncation as a NOTICE —
 * caps are never silent. `makeFunnelSnapshot`/`appendFunnelHistory` keep a
 * bounded per-sync trail for `previousPeriodPrev` (the Δ-vs-previous-period
 * source when the adapter doesn't provide `prev` itself).
 *
 * Everything here is pure — no fs, no fetch — so the CLI, the sync engine, the
 * routes, and tests all share one implementation.
 */

export const FUNNEL_SET_KIND = 'funnel-set/v1';

// ─── Caps (structural — enforced, not advised; every hit produces a notice) ──
export const MAX_FUNNELS = 40;
/** Real quiz funnels run 40-60 steps — the cap exists to bound pathological
 *  payloads, not to truncate legitimate long funnels. */
export const MAX_STEPS = 64;
export const MAX_DIMENSIONS = 8;
/** Per dimension: values beyond the top-N (by users) collapse into "Other". */
export const MAX_DIMENSION_VALUES = 8;
/** Per funnel: segment cells beyond this (after value collapse) merge into one "Other" cell.
 *  In `lookup` mode the tail beyond it is DROPPED (a looked-up path is never merged). */
export const MAX_SEGMENTS = 64;
/** Per funnel / segment: daily trend days kept (the newest). */
export const MAX_DAILY_DAYS = 92;
/** Max length of a `reason` (why a segment or metric is not measured). */
export const MAX_REASON_CHARS = 200;
/** Max length of a benchmark bound's `floor_source` / `target_source`. */
export const MAX_SOURCE_CHARS = 64;
/** Byte cap on the stored funnel-set JSON. Trim order: segment daily, then
 *  funnel daily, then segments; a set still over the cap after that is rejected. */
export const MAX_FUNNEL_BYTES = 400_000;
/** Bounded per-sync snapshot trail (compact: metrics + step users only). */
export const FUNNEL_HISTORY_MAX = 40;
/** Default low-sample threshold (first-step users) when the payload sets none. */
export const DEFAULT_LOW_SAMPLE_THRESHOLD = 30;
/** Collapsed-value label for over-cap dimension values / segment cells. */
export const OTHER_VALUE = 'Other';

// ─── Explorer caps (every hit produces a notice) ────────────────────────────
/** Notes per level (the set, each funnel). */
export const MAX_NOTES = 8;
export const MAX_NOTE_CHARS = 200;
export const MAX_NOTE_KEYS = 16;
export const MAX_NOTE_CODE_CHARS = 16;
/** Entries in `hints` (set) and `unmeasured` (funnel). */
export const MAX_HINTS = 24;
export const MAX_UNMEASURED = 16;
/** Provenance: filters, each filter's chars, the source's chars, the freshness chars. */
export const MAX_FILTERS = 8;
export const MAX_FILTER_CHARS = 120;
export const MAX_PROVENANCE_CHARS = 120;
export const MAX_FRESHNESS_CHARS = 64;
export const MAX_INTERSECTIONS = 16;
export const MAX_RATES = 32;
export const MAX_LADDER_STAGES = 16;
/** Weekly history per level (input only: the newest are kept). */
export const MAX_WEEKS = 52;
/** Payment cells per funnel (and for the set), reason keys per cell, named reasons. */
export const MAX_PAYMENT_CELLS = 64;
export const MAX_PAYMENT_REASONS = 12;
export const MAX_ACCESS_STAGES = 8;
export const MAX_ACCESS_ROWS = 64;
/** Max length of a key (step, metric, dimension, reason) the explorer fields name. */
const MAX_KEY_CHARS = 64;
/** A `hints` / `unmeasured` key: a contract part, `dim:<key>` or `metric:<key>`. */
export const PART_KEY = /^(daily|weekly|segments|intersections|payment|access|dim:[\w.-]{1,64}|metric:[\w.-]{1,64})$/;

const FORMATS: readonly FunnelMetricFormat[] = ['count', 'pct', 'usd', 'x', 'seconds', 'number'];

export interface ParsedFunnelSet {
  set: FunnelSet;
  /** Human-readable cap/coercion notices — surface them, never swallow. */
  notices: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseDimension(raw: unknown, notices: string[]): FunnelDimension | null {
  if (!isRecord(raw)) return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const mode = raw.mode === 'refetch' ? 'refetch' : 'client';
  const dim: FunnelDimension = {
    key,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : key,
    mode,
  };
  if (typeof raw.tweak === 'string' && raw.tweak.trim()) dim.tweak = raw.tweak.trim();
  if (Array.isArray(raw.values)) {
    const values: { value: string; count?: number }[] = [];
    for (const v of raw.values) {
      if (typeof v === 'string') values.push({ value: v });
      else if (isRecord(v) && typeof v.value === 'string') {
        const count = toFiniteOrNull(v.count);
        values.push(count === null ? { value: v.value } : { value: v.value, count });
      }
    }
    if (values.length > 0) dim.values = values;
  }
  if (raw.mode !== undefined && raw.mode !== 'client' && raw.mode !== 'refetch') {
    notices.push(`dimension "${key}": unknown mode "${String(raw.mode)}" — treated as client.`);
  }
  return dim;
}

/** Trim + cap a free-text field (reason, source). Over-cap text is cut, with a notice. */
function cleanText(raw: unknown, max: number, where: string, notices: string[]): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length <= max) return text;
  notices.push(`${where}: text over ${max} chars, cut.`);
  return text.slice(0, max).trimEnd();
}

function parseMetric(key: string, raw: unknown, where: string, notices: string[]): FunnelMetricValue {
  if (!isRecord(raw)) return { v: toFiniteOrNull(raw), format: 'number' };
  const format = typeof raw.format === 'string' && (FORMATS as readonly string[]).includes(raw.format)
    ? (raw.format as FunnelMetricFormat)
    : 'number';
  const metric: FunnelMetricValue = { v: toFiniteOrNull(raw.v), format };
  if (typeof raw.label === 'string' && raw.label.trim()) metric.label = raw.label.trim();
  if ('prev' in raw) metric.prev = toFiniteOrNull(raw.prev);
  if (raw.measured === false) {
    // Not measured is not zero: an unmeasured metric carries no current value.
    metric.measured = false;
    metric.v = null;
    const reason = cleanText(raw.reason, MAX_REASON_CHARS, `${where} metric "${key}" reason`, notices);
    if (reason) metric.reason = reason;
  }
  return metric;
}

function parseMetrics(raw: unknown, where: string, notices: string[]): Record<string, FunnelMetricValue> {
  const metrics: Record<string, FunnelMetricValue> = {};
  if (isRecord(raw)) {
    for (const [key, v] of Object.entries(raw)) metrics[key] = parseMetric(key, v, where, notices);
  }
  return metrics;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDay(t: string): boolean {
  if (!ISO_DAY.test(t)) return false;
  const ms = Date.parse(`${t}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === t;
}

/** Validate a daily trend: ISO days only, known metric keys only, oldest first,
 *  one entry per day (the later one wins), the newest MAX_DAILY_DAYS kept. */
function parseDaily(raw: unknown, metricKeys: ReadonlySet<string>, where: string, notices: string[]): FunnelDay[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    notices.push(`${where}: daily is not an array, dropped.`);
    return undefined;
  }
  const byDay = new Map<string, FunnelDay>();
  let badDays = 0;
  const unknown = new Set<string>();
  for (const d of raw) {
    const t = isRecord(d) && typeof d.t === 'string' ? d.t.trim() : '';
    if (!isRecord(d) || !isIsoDay(t) || !isRecord(d.m)) {
      badDays += 1;
      continue;
    }
    const m: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(d.m)) {
      if (!metricKeys.has(k)) {
        unknown.add(k);
        continue;
      }
      m[k] = toFiniteOrNull(v);
    }
    byDay.set(t, { t, m });
  }
  if (badDays > 0) notices.push(`${where}: ${badDays} daily entr${badDays === 1 ? 'y' : 'ies'} without a YYYY-MM-DD \`t\` and an \`m\` object dropped.`);
  if (unknown.size > 0) notices.push(`${where}: daily metric key(s) ${[...unknown].map((k) => `"${k}"`).join(', ')} not in metrics, dropped.`);
  let days = [...byDay.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  if (days.length > MAX_DAILY_DAYS) {
    notices.push(`${where}: ${days.length} daily entries, kept the newest ${MAX_DAILY_DAYS}.`);
    days = days.slice(days.length - MAX_DAILY_DAYS);
  }
  return days.length > 0 ? days : undefined;
}

function parseStep(raw: unknown, where: string, notices: string[]): FunnelStep | null {
  if (!isRecord(raw)) return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const users = toFiniteOrNull(raw.users);
  const step: FunnelStep = {
    key,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : key,
    users: users === null ? 0 : Math.max(0, users),
  };
  if ('prev' in raw) step.prev = toFiniteOrNull(raw.prev);
  const median = toFiniteOrNull(raw.median_seconds);
  if (median !== null) step.median_seconds = median;
  if (raw.basis === 'measured' || raw.basis === 'derived') step.basis = raw.basis;
  else if (raw.basis !== undefined) notices.push(`${where} step "${key}": unknown basis "${String(raw.basis)}", treated as measured.`);
  if (raw.measured === false) {
    // Not measured is not zero: the count is dropped, the drop math skips the step.
    step.measured = false;
    step.users = 0;
    const reason = cleanText(raw.reason, MAX_REASON_CHARS, `${where} step "${key}" reason`, notices);
    if (reason) step.reason = reason;
  }
  return step;
}

// ─── Explorer field parsers (lenient: bad input is a notice, never a throw) ──

function cleanKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key && key.length <= MAX_KEY_CHARS ? key : null;
}

/** Keep the first `max` entries of a list, with a notice when more were given. */
function capList<T>(list: T[], max: number, what: string, notices: string[]): T[] {
  if (list.length <= max) return list;
  notices.push(`${what}: ${list.length} given, kept the first ${max}.`);
  return list.slice(0, max);
}

function parseNotes(raw: unknown, where: string, notices: string[]): FunnelNote[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    notices.push(`${where}: notes is not an array, dropped.`);
    return undefined;
  }
  const out: FunnelNote[] = [];
  raw.forEach((n, i) => {
    const at = `${where} note ${i + 1}`;
    if (!isRecord(n)) {
      notices.push(`${at}: not an object, dropped.`);
      return;
    }
    const text = cleanText(n.text, MAX_NOTE_CHARS, `${at} text`, notices);
    if (!text) {
      notices.push(`${at}: no text, dropped.`);
      return;
    }
    const note: FunnelNote = { text };
    const code = cleanText(n.code, MAX_NOTE_CODE_CHARS, `${at} code`, notices);
    if (code) note.code = code;
    if (n.level === 'trap' || n.level === 'info') note.level = n.level;
    else if (n.level !== undefined) notices.push(`${at}: unknown level "${String(n.level)}", treated as trap.`);
    if (Array.isArray(n.keys)) {
      const keys = n.keys.map(cleanKey).filter((k): k is string => k !== null);
      if (keys.length < n.keys.length) notices.push(`${at}: ${n.keys.length - keys.length} unusable key(s) dropped.`);
      const capped = capList(keys, MAX_NOTE_KEYS, `${at} keys`, notices);
      if (capped.length > 0) note.keys = capped;
    }
    out.push(note);
  });
  const capped = capList(out, MAX_NOTES, `${where} notes`, notices);
  return capped.length > 0 ? capped : undefined;
}

function parseWindow(raw: unknown, notices: string[]): FunnelWindow | undefined {
  if (raw === undefined || raw === null) return undefined;
  const day = (v: unknown) => (typeof v === 'string' && isIsoDay(v.trim()) ? v.trim() : null);
  const from = isRecord(raw) ? day(raw.from) : null;
  const to = isRecord(raw) ? day(raw.to) : null;
  if (!isRecord(raw) || !from || !to || from > to) {
    notices.push('window: needs YYYY-MM-DD from <= to, dropped.');
    return undefined;
  }
  const window: FunnelWindow = { from, to };
  const prevFrom = day(raw.prev_from);
  const prevTo = day(raw.prev_to);
  if (prevFrom && prevTo && prevFrom <= prevTo) {
    window.prev_from = prevFrom;
    window.prev_to = prevTo;
  } else if (raw.prev_from !== undefined || raw.prev_to !== undefined) {
    notices.push('window: prev_from / prev_to need YYYY-MM-DD with prev_from <= prev_to, dropped.');
  }
  return window;
}

function parseProvenance(raw: unknown, notices: string[]): FunnelProvenance | undefined {
  if (raw === undefined || raw === null) return undefined;
  const source = isRecord(raw) ? cleanText(raw.source, MAX_PROVENANCE_CHARS, 'provenance source', notices) : undefined;
  if (!isRecord(raw) || !source) {
    notices.push('provenance: needs a `source` text, dropped.');
    return undefined;
  }
  const out: FunnelProvenance = { source };
  const pulled = cleanText(raw.pulled_at, MAX_FRESHNESS_CHARS, 'provenance pulled_at', notices);
  if (pulled) out.pulled_at = pulled;
  const freshness = cleanText(raw.freshness, MAX_FRESHNESS_CHARS, 'provenance freshness', notices);
  if (freshness) out.freshness = freshness;
  if (Array.isArray(raw.filters)) {
    const filters = raw.filters
      .map((f, i) => cleanText(f, MAX_FILTER_CHARS, `provenance filter ${i + 1}`, notices))
      .filter((f): f is string => !!f);
    const capped = capList(filters, MAX_FILTERS, 'provenance filters', notices);
    if (capped.length > 0) out.filters = capped;
  }
  return out;
}

/** `hints` (how to fill a part) and `unmeasured` (why a funnel lacks one): part key -> text. */
function parsePartMap(raw: unknown, where: string, max: number, notices: string[]): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    notices.push(`${where}: not an object, dropped.`);
    return undefined;
  }
  const out: Record<string, string> = {};
  let kept = 0;
  let over = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!PART_KEY.test(key)) {
      notices.push(`${where}: key "${key}" is not a part (daily, weekly, segments, intersections, payment, access, dim:<key>, metric:<key>), dropped.`);
      continue;
    }
    const text = cleanText(value, MAX_REASON_CHARS, `${where} "${key}"`, notices);
    if (!text) continue;
    if (kept >= max) {
      over += 1;
      continue;
    }
    out[key] = text;
    kept += 1;
  }
  if (over > 0) notices.push(`${where}: ${kept + over} entries, kept the first ${max}.`);
  return kept > 0 ? out : undefined;
}

function parseRates(raw: unknown, notices: string[]): Record<string, FunnelRateDef> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    notices.push('rates: not an object, dropped.');
    return undefined;
  }
  const out: Record<string, FunnelRateDef> = {};
  let kept = 0;
  for (const [metric, def] of Object.entries(raw)) {
    const num = isRecord(def) ? cleanKey(def.num) : null;
    const den = isRecord(def) ? cleanKey(def.den) : null;
    if (!num || !den) {
      notices.push(`rates "${metric}": needs step keys num and den, dropped.`);
      continue;
    }
    if (kept >= MAX_RATES) {
      notices.push(`rates: more than ${MAX_RATES}, "${metric}" dropped.`);
      continue;
    }
    out[metric] = { num, den };
    kept += 1;
  }
  return kept > 0 ? out : undefined;
}

function parseIntersections(raw: unknown, declared: ReadonlySet<string>, notices: string[]): FunnelIntersection[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    notices.push('intersections: not an array, dropped.');
    return undefined;
  }
  const out: FunnelIntersection[] = [];
  raw.forEach((x, i) => {
    const at = `intersections[${i}]`;
    const dims = isRecord(x) && Array.isArray(x.dims)
      ? [...new Set(x.dims.map(cleanKey).filter((k): k is string => k !== null))]
      : [];
    if (!isRecord(x) || dims.length === 0) {
      notices.push(`${at}: needs a dims list, dropped.`);
      return;
    }
    const unknown = dims.filter((d) => !declared.has(d));
    if (unknown.length > 0) {
      notices.push(`${at}: dims ${unknown.map((d) => `"${d}"`).join(', ')} are not declared dimensions, dropped.`);
      return;
    }
    const entry: FunnelIntersection = { dims };
    const min = toFiniteOrNull(x.min_users);
    if (min !== null && min >= 0) entry.min_users = min;
    else if (x.min_users !== undefined) notices.push(`${at}: min_users is not a number >= 0, ignored.`);
    out.push(entry);
  });
  const capped = capList(out, MAX_INTERSECTIONS, 'intersections', notices);
  return capped.length > 0 ? capped : undefined;
}

function wholeIn(v: unknown, min: number, max: number): number | null {
  const n = toFiniteOrNull(v);
  return n !== null && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function parseLadder(raw: unknown, notices: string[]): FunnelLadder | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw) || !Array.isArray(raw.stages)) {
    notices.push('ladder: needs a stages list, dropped.');
    return undefined;
  }
  const stages: FunnelLadderStage[] = [];
  const seen = new Set<string>();
  raw.stages.forEach((s, i) => {
    const at = `ladder stage ${i + 1}`;
    const metric = isRecord(s) ? cleanKey(s.metric) : null;
    if (!isRecord(s) || !metric) {
      notices.push(`${at}: needs a metric key, dropped.`);
      return;
    }
    if (seen.has(metric)) {
      notices.push(`${at}: metric "${metric}" repeats an earlier stage, dropped.`);
      return;
    }
    seen.add(metric);
    const stage: FunnelLadderStage = { metric };
    const floor = toFiniteOrNull(s.book_floor);
    if (floor !== null) stage.book_floor = floor;
    const target = toFiniteOrNull(s.book_target);
    if (target !== null) stage.book_target = target;
    const source = cleanText(s.book_source, MAX_SOURCE_CHARS, `${at} book_source`, notices);
    if (source) stage.book_source = source;
    stages.push(stage);
  });
  const capped = capList(stages, MAX_LADDER_STAGES, 'ladder stages', notices);
  if (capped.length === 0) {
    notices.push('ladder: no usable stage, dropped.');
    return undefined;
  }
  const ladder: FunnelLadder = { stages: capped };
  const knobs: [keyof FunnelLadder & ('min_weeks' | 'min_week_users' | 'max_weeks'), number, number][] = [
    ['min_weeks', 1, MAX_WEEKS],
    ['min_week_users', 0, Number.MAX_SAFE_INTEGER],
    ['max_weeks', 1, MAX_WEEKS],
  ];
  for (const [key, min, max] of knobs) {
    if (raw[key] === undefined) continue;
    const v = wholeIn(raw[key], min, max);
    if (v === null) notices.push(`ladder ${key}: must be a whole number ${min}..${max === Number.MAX_SAFE_INTEGER ? 'up' : max}, default used.`);
    else ladder[key] = v;
  }
  return ladder;
}

/** Weekly history (input only): ISO week starts, the newest MAX_WEEKS kept. */
function parseWeekly(raw: unknown, where: string, notices: string[]): FunnelWeek[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    notices.push(`${where}: weekly is not an array, dropped.`);
    return undefined;
  }
  const out: FunnelWeek[] = [];
  let bad = 0;
  for (const w of raw) {
    const t = isRecord(w) && typeof w.t === 'string' ? w.t.trim() : '';
    const users = isRecord(w) ? toFiniteOrNull(w.users) : null;
    if (!isRecord(w) || !isIsoDay(t) || users === null || !isRecord(w.m)) {
      bad += 1;
      continue;
    }
    const m: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(w.m)) m[k] = toFiniteOrNull(v);
    out.push({ t, users: Math.max(0, users), m });
  }
  if (bad > 0) notices.push(`${where}: ${bad} weekly entr${bad === 1 ? 'y' : 'ies'} without a YYYY-MM-DD \`t\`, \`users\` and an \`m\` object dropped.`);
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  if (out.length > MAX_WEEKS) {
    notices.push(`${where}: ${out.length} weekly entries, kept the newest ${MAX_WEEKS}.`);
    return out.slice(out.length - MAX_WEEKS);
  }
  return out.length > 0 ? out : undefined;
}

function parseStringMap(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

function parsePayment(raw: unknown, where: string, notices: string[]): FunnelPayment | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    notices.push(`${where} payment: not an object, dropped.`);
    return undefined;
  }
  const cells: FunnelPaymentCell[] = [];
  const rawCells = Array.isArray(raw.cells) ? raw.cells : [];
  rawCells.forEach((c, i) => {
    const at = `${where} payment cell ${i + 1}`;
    const dims = isRecord(c) ? parseStringMap(c.dims ?? {}) : null;
    const attempts = isRecord(c) ? toFiniteOrNull(c.attempts) : null;
    const declines = isRecord(c) ? toFiniteOrNull(c.declines) : null;
    if (!isRecord(c) || !dims || attempts === null || declines === null) {
      notices.push(`${at}: needs dims, attempts and declines, dropped.`);
      return;
    }
    const cell: FunnelPaymentCell = { dims, attempts: Math.max(0, attempts), declines: Math.max(0, declines) };
    if (c.cohort === 'first' || c.cohort === 'renewal' || c.cohort === 'all') cell.cohort = c.cohort;
    else if (c.cohort !== undefined) notices.push(`${at}: unknown cohort "${String(c.cohort)}", treated as all.`);
    if (isRecord(c.reasons)) {
      const reasons: Record<string, number> = {};
      let kept = 0;
      for (const [k, v] of Object.entries(c.reasons)) {
        const n = toFiniteOrNull(v);
        const key = cleanKey(k);
        if (n === null || !key) continue;
        if (kept >= MAX_PAYMENT_REASONS) {
          notices.push(`${at}: more than ${MAX_PAYMENT_REASONS} reasons, "${key}" dropped.`);
          continue;
        }
        reasons[key] = Math.max(0, n);
        kept += 1;
      }
      if (kept > 0) cell.reasons = reasons;
    }
    cells.push(cell);
  });
  const payment: FunnelPayment = { cells: capList(cells, MAX_PAYMENT_CELLS, `${where} payment cells`, notices) };
  if (raw.measured === false) {
    payment.measured = false;
    const reason = cleanText(raw.reason, MAX_REASON_CHARS, `${where} payment reason`, notices);
    if (reason) payment.reason = reason;
  }
  if (payment.cells.length === 0 && payment.measured !== false) {
    notices.push(`${where} payment: no usable cell, dropped.`);
    return undefined;
  }
  return payment;
}

function parsePaymentReasons(raw: unknown, notices: string[]): FunnelPaymentReason[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    notices.push('payment_reasons: not an array, dropped.');
    return undefined;
  }
  const out: FunnelPaymentReason[] = [];
  const seen = new Set<string>();
  raw.forEach((r, i) => {
    const key = isRecord(r) ? cleanKey(r.key) : null;
    const label = isRecord(r) ? cleanText(r.label, MAX_KEY_CHARS, `payment_reasons[${i}] label`, notices) : undefined;
    if (!isRecord(r) || !key || !label || seen.has(key)) {
      notices.push(`payment_reasons[${i}]: needs a unique key and a label, dropped.`);
      return;
    }
    seen.add(key);
    const reason: FunnelPaymentReason = { key, label };
    const note = cleanText(r.note, MAX_REASON_CHARS, `payment_reasons[${i}] note`, notices);
    if (note) reason.note = note;
    out.push(reason);
  });
  const capped = capList(out, MAX_PAYMENT_REASONS, 'payment_reasons', notices);
  return capped.length > 0 ? capped : undefined;
}

function parseAccess(raw: unknown, notices: string[]): FunnelAccess | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw) || !Array.isArray(raw.stages)) {
    notices.push('access: needs a stages list, dropped.');
    return undefined;
  }
  const stages = raw.stages
    .map((s) => {
      const key = isRecord(s) ? cleanKey(s.key) : null;
      if (!isRecord(s) || !key) return null;
      const label = typeof s.label === 'string' && s.label.trim() ? s.label.trim().slice(0, MAX_KEY_CHARS) : key;
      return { key, label };
    })
    .filter((s): s is { key: string; label: string } => s !== null);
  if (stages.length < raw.stages.length) notices.push(`access: ${raw.stages.length - stages.length} stage(s) without a key dropped.`);
  const keptStages = capList(stages, MAX_ACCESS_STAGES, 'access stages', notices);
  if (keptStages.length === 0) {
    notices.push('access: no usable stage, dropped.');
    return undefined;
  }
  const rows: FunnelAccessRow[] = [];
  (Array.isArray(raw.rows) ? raw.rows : []).forEach((r, i) => {
    if (!isRecord(r) || !isRecord(r.counts)) {
      notices.push(`access row ${i + 1}: needs a counts object, dropped.`);
      return;
    }
    const counts: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(r.counts)) {
      const n = toFiniteOrNull(v);
      counts[k] = n === null ? null : Math.max(0, n);
    }
    const row: FunnelAccessRow = { counts };
    if (r.funnel !== undefined && r.funnel !== null && String(r.funnel).trim()) row.funnel = String(r.funnel).trim();
    const dims = r.dims !== undefined ? parseStringMap(r.dims) : null;
    if (dims && Object.keys(dims).length > 0) row.dims = dims;
    rows.push(row);
  });
  const access: FunnelAccess = { stages: keptStages, rows: capList(rows, MAX_ACCESS_ROWS, 'access rows', notices) };
  const asOf = cleanText(raw.as_of, MAX_FRESHNESS_CHARS, 'access as_of', notices);
  if (asOf) access.as_of = asOf;
  return access;
}

function segmentKey(dims: Record<string, string>): string {
  return Object.keys(dims).sort().map((k) => `${k}=${dims[k]}`).join('|');
}

function parseSegment(
  raw: unknown,
  stepKeys: Set<string>,
  funnelMetricKeys: ReadonlySet<string>,
  funnelId: string,
  notices: string[],
): FunnelSegment | null {
  if (!isRecord(raw) || !isRecord(raw.dims)) return null;
  const dims: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.dims)) dims[k] = String(v);
  if (Object.keys(dims).length === 0) return null;
  const where = `funnel ${funnelId} segment ${segmentKey(dims)}`;
  const steps: { key: string; users: number }[] = [];
  if (Array.isArray(raw.steps)) {
    for (const s of raw.steps) {
      if (!isRecord(s) || typeof s.key !== 'string') continue;
      if (!stepKeys.has(s.key)) continue; // a segment step must exist on the funnel
      const users = toFiniteOrNull(s.users);
      steps.push({ key: s.key, users: users === null ? 0 : Math.max(0, users) });
    }
  }
  const users = toFiniteOrNull(raw.users);
  const seg: FunnelSegment = { dims, users: users === null ? (steps[0]?.users ?? 0) : Math.max(0, users), steps };
  if (raw.measured === false) {
    seg.measured = false;
    const reason = cleanText(raw.reason, MAX_REASON_CHARS, `${where} reason`, notices);
    if (reason) seg.reason = reason;
  }
  const metrics = parseMetrics(raw.metrics, where, notices);
  if (Object.keys(metrics).length > 0) seg.metrics = metrics;
  const benchmarks = parseBenchmarks(raw.benchmarks, where, notices);
  if (benchmarks) seg.benchmarks = benchmarks;
  const daily = parseDaily(raw.daily, new Set([...funnelMetricKeys, ...Object.keys(metrics)]), where, notices);
  if (daily) seg.daily = daily;
  return seg;
}

const isMeasured = (seg: FunnelSegment): boolean => seg.measured !== false;

/** Merge segment cells that share identical dims (sums users + per-step users).
 *  cells mode only. An unmeasured cell never adds to a sum: it yields to any
 *  measured cell with the same dims. A true merge drops the per-cell metrics,
 *  bands and daily (rates cannot be summed). */
function mergeSegments(segments: FunnelSegment[]): FunnelSegment[] {
  const byDims = new Map<string, FunnelSegment>();
  for (const seg of segments) {
    const key = segmentKey(seg.dims);
    const prior = byDims.get(key);
    if (!prior || (!isMeasured(prior) && isMeasured(seg))) {
      byDims.set(key, { ...seg, dims: { ...seg.dims }, steps: seg.steps.map((s) => ({ ...s })) });
      continue;
    }
    if (!isMeasured(seg)) continue;
    delete prior.metrics;
    delete prior.benchmarks;
    delete prior.daily;
    prior.users += seg.users;
    const byStep = new Map(prior.steps.map((s) => [s.key, s]));
    for (const s of seg.steps) {
      const p = byStep.get(s.key);
      if (p) p.users += s.users;
      else prior.steps.push({ ...s });
    }
  }
  return [...byDims.values()];
}

/** A folded cell speaks for "Other", not for its own value: its rates go. */
function asOther(seg: FunnelSegment, dims: Record<string, string>): FunnelSegment {
  const out: FunnelSegment = { ...seg, dims };
  delete out.metrics;
  delete out.benchmarks;
  delete out.daily;
  return out;
}

/** Collapse over-cap dimension values to "Other", then over-cap cells to one "Other" cell. */
function capSegments(
  funnelId: string,
  segments: FunnelSegment[],
  dimensions: FunnelDimension[],
  notices: string[],
): FunnelSegment[] {
  let out = segments;

  // Per-dimension value cardinality: keep the top MAX_DIMENSION_VALUES by users.
  for (const dim of dimensions) {
    if (dim.mode !== 'client') continue;
    const usersByValue = new Map<string, number>();
    for (const seg of out) {
      const v = seg.dims[dim.key];
      if (v === undefined) continue;
      usersByValue.set(v, (usersByValue.get(v) ?? 0) + seg.users);
    }
    if (usersByValue.size <= MAX_DIMENSION_VALUES) continue;
    const kept = new Set(
      [...usersByValue.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DIMENSION_VALUES).map(([v]) => v),
    );
    const collapsed = usersByValue.size - kept.size;
    out = out.map((seg) => {
      const v = seg.dims[dim.key];
      if (v === undefined || kept.has(v)) return seg;
      return asOther(seg, { ...seg.dims, [dim.key]: OTHER_VALUE });
    });
    out = mergeSegments(out);
    notices.push(`funnel ${funnelId}: dimension "${dim.key}" had ${usersByValue.size} values — kept top ${MAX_DIMENSION_VALUES}, collapsed ${collapsed} into "${OTHER_VALUE}".`);
  }

  // Total cell cap: merge the tail (by users) into one all-Other cell.
  if (out.length > MAX_SEGMENTS) {
    const sorted = [...out].sort((a, b) => b.users - a.users);
    const kept = sorted.slice(0, MAX_SEGMENTS - 1);
    const tail = sorted.slice(MAX_SEGMENTS - 1);
    const otherDims: Record<string, string> = {};
    for (const k of Object.keys(tail[0].dims)) otherDims[k] = OTHER_VALUE;
    notices.push(`funnel ${funnelId}: ${out.length} segment cells — kept top ${MAX_SEGMENTS - 1}, merged ${tail.length} into "${OTHER_VALUE}".`);
    // One final merge so a kept all-Other cell and the merged tail can't coexist.
    out = mergeSegments([...kept, ...tail.map((seg) => asOther(seg, otherDims))]);
  }

  return out;
}

/** lookup mode: every segment is its own measured path for an exact selection.
 *  Looked up, never summed: no value collapse into "Other", no merge. A repeated
 *  selection keeps its first occurrence; the tail past MAX_SEGMENTS (payload
 *  order, so the script decides what matters) is dropped. Both with a notice. */
function lookupSegments(funnelId: string, segments: FunnelSegment[], notices: string[]): FunnelSegment[] {
  const seen = new Set<string>();
  const out: FunnelSegment[] = [];
  let dupes = 0;
  for (const seg of segments) {
    const key = segmentKey(seg.dims);
    if (seen.has(key)) {
      dupes += 1;
      continue;
    }
    seen.add(key);
    out.push(seg);
  }
  if (dupes > 0) notices.push(`funnel ${funnelId}: ${dupes} lookup segment(s) repeat an earlier selection, later occurrence dropped.`);
  if (out.length > MAX_SEGMENTS) {
    notices.push(`funnel ${funnelId}: ${out.length} lookup segments, kept the first ${MAX_SEGMENTS}, dropped ${out.length - MAX_SEGMENTS}.`);
    out.length = MAX_SEGMENTS;
  }
  return out;
}

function parseFunnel(
  raw: unknown,
  index: number,
  dimensions: FunnelDimension[],
  mode: 'cells' | 'lookup',
  notices: string[],
  weeklyOut: { weeks?: FunnelWeek[] },
): FunnelDef | null {
  if (!isRecord(raw)) {
    notices.push(`funnels[${index}] is not an object — skipped.`);
    return null;
  }
  const id = raw.id !== undefined && raw.id !== null ? String(raw.id).trim() : '';
  if (!id) {
    notices.push(`funnels[${index}] has no id — skipped.`);
    return null;
  }

  const steps: FunnelStep[] = [];
  const seenKeys = new Set<string>();
  if (Array.isArray(raw.steps)) {
    for (const s of raw.steps) {
      const step = parseStep(s, `funnel ${id}`, notices);
      if (!step) continue;
      if (seenKeys.has(step.key)) {
        notices.push(`funnel ${id}: duplicate step key "${step.key}" — later occurrence dropped.`);
        continue;
      }
      seenKeys.add(step.key);
      steps.push(step);
    }
  }
  if (steps.length === 0) {
    notices.push(`funnel ${id} has no valid steps — skipped.`);
    return null;
  }
  if (steps.length > MAX_STEPS) {
    // Keep the first MAX-1 AND the last step: the final step (Finish) carries
    // the funnel's outcome — dropping it would fabricate a different funnel.
    const last = steps[steps.length - 1];
    notices.push(`funnel ${id}: ${steps.length} steps — kept the first ${MAX_STEPS - 1} + the final step "${last.key}".`);
    steps.length = MAX_STEPS - 1;
    steps.push(last);
  }

  const metrics = parseMetrics(raw.metrics, `funnel ${id}`, notices);
  const metricKeys = new Set(Object.keys(metrics));

  const meta: Record<string, string> = {};
  if (isRecord(raw.meta)) {
    for (const [key, v] of Object.entries(raw.meta)) {
      if (v !== null && v !== undefined) meta[key] = String(v);
    }
  }

  const funnel: FunnelDef = { id, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id, meta, metrics, steps };

  const daily = parseDaily(raw.daily, metricKeys, `funnel ${id}`, notices);
  if (daily) funnel.daily = daily;

  if (Array.isArray(raw.segments) && raw.segments.length > 0) {
    const stepKeys = new Set(steps.map((s) => s.key));
    const segments = raw.segments
      .map((s) => parseSegment(s, stepKeys, metricKeys, id, notices))
      .filter((s): s is FunnelSegment => s !== null);
    if (segments.length > 0) {
      funnel.segments = mode === 'lookup'
        ? lookupSegments(id, segments, notices)
        : capSegments(id, mergeSegments(segments), dimensions, notices);
    }
  }

  const where = `funnel ${id}`;
  const notes = parseNotes(raw.notes, where, notices);
  if (notes) funnel.notes = notes;
  const benchmarks = parseBenchmarks(raw.benchmarks, where, notices);
  if (benchmarks) funnel.benchmarks = benchmarks;
  const payment = parsePayment(raw.payment, where, notices);
  if (payment) funnel.payment = payment;
  const unmeasured = parsePartMap(raw.unmeasured, `${where} unmeasured`, MAX_UNMEASURED, notices);
  if (unmeasured) funnel.unmeasured = unmeasured;
  // Input only: collected for the ladder, never stored on the funnel.
  const weeks = parseWeekly(raw.weekly, where, notices);
  if (weeks) weeklyOut.weeks = weeks;

  return funnel;
}

/** A band is kept when it says anything: a bound, or which direction is good. */
function parseBenchmarks(raw: unknown, where: string, notices: string[]): Record<string, FunnelBenchmark> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, FunnelBenchmark> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue;
    const bench: FunnelBenchmark = {};
    const floor = toFiniteOrNull(v.floor);
    const target = toFiniteOrNull(v.target);
    if (floor !== null) bench.floor = floor;
    if (target !== null) bench.target = target;
    const floorSource = cleanText(v.floor_source, MAX_SOURCE_CHARS, `${where} benchmark "${key}" floor_source`, notices);
    if (floorSource && floor !== null) bench.floor_source = floorSource;
    const targetSource = cleanText(v.target_source, MAX_SOURCE_CHARS, `${where} benchmark "${key}" target_source`, notices);
    if (targetSource && target !== null) bench.target_source = targetSource;
    if (v.better === 'higher' || v.better === 'lower') bench.better = v.better;
    else if (v.better !== undefined) notices.push(`${where} benchmark "${key}": unknown better "${String(v.better)}", treated as higher.`);
    if ((v.floor_from === 'book' || v.floor_from === 'own') && floor !== null) bench.floor_from = v.floor_from;
    if ((v.target_from === 'book' || v.target_from === 'own') && target !== null) bench.target_from = v.target_from;
    const weeks = wholeIn(v.weeks, 0, MAX_WEEKS);
    if (weeks !== null) bench.weeks = weeks;
    if (bench.floor !== undefined || bench.target !== undefined || bench.better !== undefined) out[key] = bench;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate + cap a raw funnel-set payload. Throws `LabError` only when the
 * payload is fundamentally not a funnel-set (wrong kind, funnels not an array,
 * or irrecoverably over the byte cap); individual malformed funnels/segments
 * degrade to notices, mirroring the store's lenient-read philosophy.
 */
export function parseFunnelSet(raw: unknown): ParsedFunnelSet {
  if (!isRecord(raw) || raw.kind !== FUNNEL_SET_KIND) {
    throw new LabError(`Funnel payload must be an object with kind "${FUNNEL_SET_KIND}".`);
  }
  if (!Array.isArray(raw.funnels)) {
    throw new LabError('Funnel payload must have a `funnels` array.');
  }

  const notices: string[] = [];

  let mode: 'cells' | 'lookup' = 'cells';
  if (raw.segment_mode === 'lookup' || raw.segment_mode === 'cells') mode = raw.segment_mode;
  else if (raw.segment_mode !== undefined) notices.push(`unknown segment_mode "${String(raw.segment_mode)}", treated as cells.`);

  const dimensions: FunnelDimension[] = [];
  if (Array.isArray(raw.dimensions)) {
    const seen = new Set<string>();
    for (const d of raw.dimensions) {
      const dim = parseDimension(d, notices);
      if (!dim || seen.has(dim.key)) continue;
      seen.add(dim.key);
      dimensions.push(dim);
    }
  }
  if (dimensions.length > MAX_DIMENSIONS) {
    notices.push(`${dimensions.length} dimensions declared — kept the first ${MAX_DIMENSIONS}.`);
    dimensions.length = MAX_DIMENSIONS;
  }

  let rawFunnels = raw.funnels;
  if (rawFunnels.length > MAX_FUNNELS) {
    notices.push(`${rawFunnels.length} funnels — kept the first ${MAX_FUNNELS}.`);
    rawFunnels = rawFunnels.slice(0, MAX_FUNNELS);
  }
  const funnels: FunnelDef[] = [];
  const seenIds = new Set<string>();
  const funnelWeekly = new Map<string, FunnelWeek[]>();
  for (let i = 0; i < rawFunnels.length; i++) {
    const weeklyOut: { weeks?: FunnelWeek[] } = {};
    const funnel = parseFunnel(rawFunnels[i], i, dimensions, mode, notices, weeklyOut);
    if (!funnel) continue;
    if (seenIds.has(funnel.id)) {
      notices.push(`duplicate funnel id "${funnel.id}" — later occurrence dropped.`);
      continue;
    }
    seenIds.add(funnel.id);
    funnels.push(funnel);
    if (weeklyOut.weeks) funnelWeekly.set(funnel.id, weeklyOut.weeks);
  }

  const set: FunnelSet = { kind: FUNNEL_SET_KIND, dimensions, funnels };
  if (typeof raw.primary === 'string' && raw.primary.trim()) set.primary = raw.primary.trim();
  const lowSample = toFiniteOrNull(raw.low_sample_threshold);
  if (lowSample !== null && lowSample >= 0) set.low_sample_threshold = lowSample;
  const benchmarks = parseBenchmarks(raw.benchmarks, 'set', notices);
  if (benchmarks) set.benchmarks = benchmarks;
  if (raw.segment_mode !== undefined && mode === raw.segment_mode) set.segment_mode = mode;

  // ── Explorer fields (all optional; a payload without them parses as before). ──
  const window = parseWindow(raw.window, notices);
  if (window) set.window = window;
  const provenance = parseProvenance(raw.provenance, notices);
  if (provenance) set.provenance = provenance;
  const notes = parseNotes(raw.notes, 'set', notices);
  if (notes) set.notes = notes;
  const hints = parsePartMap(raw.hints, 'hints', MAX_HINTS, notices);
  if (hints) set.hints = hints;
  const rates = parseRates(raw.rates, notices);
  if (rates) set.rates = rates;
  const intersections = parseIntersections(raw.intersections, new Set(dimensions.map((d) => d.key)), notices);
  if (intersections) set.intersections = intersections;
  const ladder = parseLadder(raw.ladder, notices);
  if (ladder) set.ladder = ladder;
  const payment = parsePayment(raw.payment, 'set', notices);
  if (payment) set.payment = payment;
  const paymentReasons = parsePaymentReasons(raw.payment_reasons, notices);
  if (paymentReasons) set.payment_reasons = paymentReasons;
  const access = parseAccess(raw.access, notices);
  if (access) set.access = access;

  // Weekly history is a band INPUT: consumed by the ladder here, never stored.
  const setWeekly = parseWeekly(raw.weekly, 'set', notices);
  if (set.ladder) deriveLadderBands(set, { set: setWeekly, funnels: funnelWeekly }, notices);
  else if (setWeekly || funnelWeekly.size > 0) notices.push('weekly history given without a ladder: ignored.');

  // ── Byte cap, cheapest detail first (largest funnel first at each stage):
  // segment daily, then funnel daily, then segments; still over = reject. ──
  const over = (): boolean => JSON.stringify(set).length > MAX_FUNNEL_BYTES;
  const bySize = (size: (f: FunnelDef) => number) =>
    set.funnels.filter((f) => size(f) > 0).sort((a, b) => size(b) - size(a));
  const stages: { size: (f: FunnelDef) => number; drop: (f: FunnelDef) => void; what: string }[] = [
    {
      size: (f) => (f.segments ?? []).reduce((n, seg) => n + (seg.daily ? JSON.stringify(seg.daily).length : 0), 0),
      drop: (f) => { for (const seg of f.segments ?? []) delete seg.daily; },
      what: 'segment daily trends',
    },
    { size: (f) => (f.daily ? JSON.stringify(f.daily).length : 0), drop: (f) => { delete f.daily; }, what: 'daily trend' },
    { size: (f) => (f.segments?.length ? JSON.stringify(f.segments).length : 0), drop: (f) => { delete f.segments; }, what: 'segments' },
  ];
  for (const stage of stages) {
    if (!over()) break;
    for (const funnel of bySize(stage.size)) {
      stage.drop(funnel);
      notices.push(`funnel ${funnel.id}: ${stage.what} dropped to fit the ${MAX_FUNNEL_BYTES}-byte cache cap.`);
      if (!over()) break;
    }
  }
  if (over()) {
    throw new LabError(`Funnel payload exceeds the ${MAX_FUNNEL_BYTES}-byte cap even without segments — return fewer funnels/steps (Lab stores insights, not raw dumps).`);
  }

  return { set, notices };
}

// ─── Series synthesis + latest (backward compat with every series consumer) ──

/** Synthesize legacy `Series[]` from step users — one series per funnel, one
 *  point per step (t = step label). Keeps NumberCard/binding/snapshot working. */
export function funnelToSeries(set: FunnelSet): Series[] {
  return set.funnels.map((f) => ({
    name: f.name || f.id,
    // A step that is not measured has no count: it is not a point at 0.
    points: f.steps.filter(isMeasuredStep).map((s) => ({ t: s.label || s.key, v: s.users })),
  }));
}

/** A step carries a real count (an unmeasured step's stored 0 is not one). */
function isMeasuredStep(step: FunnelStep): boolean {
  return step.measured !== false;
}

/** The card/binding `latest` for a funnel-set: the primary metric of the first
 *  funnel, else the users of its first MEASURED step (null when none is). */
export function funnelLatest(set: FunnelSet): number | null {
  const first = set.funnels[0];
  if (!first) return null;
  if (set.primary) {
    const primary = first.metrics[set.primary];
    if (primary && primary.v !== null && Number.isFinite(primary.v)) return primary.v;
  }
  return first.steps.find(isMeasuredStep)?.users ?? null;
}

// ─── History snapshots + previous-period deltas ─────────────────────────────

/** Compact snapshot of one sync (metrics + step users only — no segments/meta). */
export function makeFunnelSnapshot(
  set: FunnelSet,
  range: { fromISO: string; toISO: string },
  at: string,
): FunnelSnapshot {
  return {
    at,
    range,
    funnels: set.funnels.map((f) => ({
      id: f.id,
      metrics: Object.fromEntries(Object.entries(f.metrics).map(([k, m]) => [k, m.v])),
      // An unmeasured step is left out: a later delta reads it as no value, never 0.
      steps: f.steps.filter(isMeasuredStep).map((s) => ({ key: s.key, users: s.users })),
    })),
  };
}

/** Append one snapshot, keeping the newest FUNNEL_HISTORY_MAX. Tolerates a
 *  malformed prior trail (non-array) — mirrors appendHistory in sync.ts. */
export function appendFunnelHistory(
  prior: FunnelSnapshot[] | undefined,
  snapshot: FunnelSnapshot,
): FunnelSnapshot[] {
  const priorTrail = Array.isArray(prior) ? prior : [];
  const trail = [...priorTrail, snapshot];
  return trail.length > FUNNEL_HISTORY_MAX ? trail.slice(trail.length - FUNNEL_HISTORY_MAX) : trail;
}

const DAY_MS = 86_400_000;

function spanDays(range: { fromISO: string; toISO: string }): number | null {
  const from = Date.parse(`${range.fromISO}T00:00:00Z`);
  const to = Date.parse(`${range.toISO}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / DAY_MS);
}

/** Previous-period values per funnel, derived per metric/step. Precedence:
 *  adapter-provided `prev` on the metric/step wins; else the best history
 *  snapshot — one covering an equal-length (±25%) window ending at/before the
 *  current window's start, closest to it. Null when neither source exists. */
export interface FunnelPrev {
  /** funnel id → metric key → previous value (null = unknown). */
  metrics: Record<string, Record<string, number | null>>;
  /** funnel id → step key → previous users (null = unknown). */
  steps: Record<string, Record<string, number | null>>;
  /** Which snapshot fed the history-derived values (null = adapter-only/none). */
  source: { at: string; range: { fromISO: string; toISO: string } } | null;
}

/** Pick the history snapshot that best represents "the previous equal-length period". */
export function pickPreviousSnapshot(
  current: { fromISO: string; toISO: string },
  history: FunnelSnapshot[] | undefined,
): FunnelSnapshot | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const currentSpan = spanDays(current);
  const currentFrom = Date.parse(`${current.fromISO}T00:00:00Z`);
  if (currentSpan === null || !Number.isFinite(currentFrom)) return null;

  let best: FunnelSnapshot | null = null;
  let bestDistance = Infinity;
  for (const snap of history) {
    if (!snap || !snap.range) continue;
    const snapSpan = spanDays(snap.range);
    const snapTo = Date.parse(`${snap.range.toISO}T00:00:00Z`);
    if (snapSpan === null || !Number.isFinite(snapTo)) continue;
    // Equal-length within ±25% (history cadence rarely aligns perfectly).
    const tolerance = Math.max(1, currentSpan * 0.25);
    if (Math.abs(snapSpan - currentSpan) > tolerance) continue;
    // Must END at or before the current window's start (a genuinely previous period).
    if (snapTo > currentFrom) continue;
    const distance = currentFrom - snapTo;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = snap;
    }
  }
  return best;
}

/** The window a set declares as a cache range, or null when it declares none. */
export function funnelSetRange(set: FunnelSet): { fromISO: string; toISO: string } | null {
  return set.window ? { fromISO: set.window.from, toISO: set.window.to } : null;
}

/** Compute previous-period values for every funnel/metric/step in the set.
 *  A set that declares its own `window` is a snapshot whose previous period is
 *  its payload's own `prev`: history is never consulted (an earlier sync of the
 *  same window is not a previous period). */
export function computeFunnelPrev(entry: FunnelCacheEntry, history: FunnelSnapshot[] | undefined): FunnelPrev {
  const snapshot = entry.set.window ? null : pickPreviousSnapshot(entry.range, history);
  const snapById = new Map((snapshot?.funnels ?? []).map((f) => [f.id, f]));

  const metrics: Record<string, Record<string, number | null>> = {};
  const steps: Record<string, Record<string, number | null>> = {};
  for (const funnel of entry.set.funnels) {
    const snap = snapById.get(funnel.id);
    const m: Record<string, number | null> = {};
    for (const [key, metric] of Object.entries(funnel.metrics)) {
      if (metric.prev !== undefined) m[key] = metric.prev;
      else m[key] = snap?.metrics[key] ?? null;
    }
    metrics[funnel.id] = m;

    // A snapshot step without a finite count (left out, or null in an older trail) is no value, never 0.
    const snapSteps = new Map((snap?.steps ?? [])
      .filter((s) => typeof s.users === 'number' && Number.isFinite(s.users))
      .map((s) => [s.key, s.users]));
    const st: Record<string, number | null> = {};
    for (const step of funnel.steps) {
      if (!isMeasuredStep(step)) st[step.key] = null;
      else if (step.prev !== undefined) st[step.key] = step.prev;
      else st[step.key] = snapSteps.get(step.key) ?? null;
    }
    steps[funnel.id] = st;
  }

  return {
    metrics,
    steps,
    source: snapshot ? { at: snapshot.at, range: snapshot.range } : null,
  };
}

// ─── Step math (shared by CLI `lab show` and tests; the dashboard mirrors it) ──

export interface StepRow {
  key: string;
  label: string;
  users: number;
  /** % of the first (top) step, 0-100. Null when top is 0. */
  ofTop: number | null;
  /** % of the previous step, 0-100. Null on the first step or when prev is 0. */
  ofPrev: number | null;
  /** Absolute drop from the previous step (negative = users increased). */
  drop: number | null;
  /** Present (false) only on a step that is not measured: no rates, no drop, never the worst. */
  measured?: false;
}

/** Per-step rates + drops for one funnel. Honest about weird data: a 0-user
 *  mid-step yields null ofPrev on the next step (no divide-by-zero), and users
 *  INCREASING between steps yields a negative drop (rendered as ↑, not clamped). */
export function computeStepRows(steps: FunnelStep[]): StepRow[] {
  // An unmeasured step (measured: false) has no count: its users are not a 0,
  // it gets no rates and no drop, and the next step compares with the last
  // MEASURED one. "Top" is the first measured step.
  const top = steps.find((s) => s.measured !== false)?.users ?? 0;
  let prev: number | null = null;
  return steps.map((step) => {
    if (step.measured === false) {
      return { key: step.key, label: step.label, users: step.users, ofTop: null, ofPrev: null, drop: null, measured: false };
    }
    const row: StepRow = {
      key: step.key,
      label: step.label,
      users: step.users,
      ofTop: top > 0 ? (step.users / top) * 100 : null,
      ofPrev: prev === null ? null : prev > 0 ? (step.users / prev) * 100 : null,
      drop: prev === null ? null : prev - step.users,
    };
    prev = step.users;
    return row;
  });
}

/** Index (1-based, the arriving step) of the worst adjacent drop by RATE, or null. */
export function worstDropIndex(rows: StepRow[]): number | null {
  let worst: number | null = null;
  let worstRate = Infinity;
  for (let i = 1; i < rows.length; i++) {
    const rate = rows[i].ofPrev;
    if (rate === null || rows[i].measured === false) continue;
    if (rate < worstRate) {
      worstRate = rate;
      worst = i;
    }
  }
  return worst;
}
