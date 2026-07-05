import type { Agg, Granularity, RawSeries, Series, SeriesPoint } from './types.js';

/**
 * Granularity-capped rollup — the STRUCTURAL guarantee that an insight is a
 * curated metric, never a raw data dump. Every series is bucketed by a derived
 * granularity and coarsened until it fits under MAX_POINTS. The cap is enforced
 * here, not merely advised.
 *
 * Granularity derives from the resolved tweak span:
 *   > 180 days           → monthly
 *   45 < span ≤ 180 days → weekly
 *   ≤ 45 days            → daily
 * A ~1-year span is therefore monthly-only (no daily/weekly survive); a ~1-month
 * span may stay daily.
 */

/** Hard per-series point cap. */
export const MAX_POINTS = 62;

export function deriveGranularity(spanDays: number): Granularity {
  if (spanDays > 180) return 'monthly';
  if (spanDays > 45) return 'weekly';
  return 'daily';
}

const LADDER: Granularity[] = ['daily', 'weekly', 'monthly'];

function parseDate(t: string): Date | null {
  const ms = Date.parse(t.length === 10 ? `${t}T00:00:00Z` : t);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** ISO-8601 week key (YYYY-Www), computed in UTC. */
function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // move to Thursday of this week
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function bucketKey(t: string, granularity: Granularity): string {
  const d = parseDate(t);
  if (!d) return t; // unparseable → its own bucket (keeps a bad point visible, never crashes)
  if (granularity === 'daily') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  if (granularity === 'monthly') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return isoWeekKey(d);
}

function aggregate(values: number[], agg: Agg): number {
  if (values.length === 0) return 0;
  switch (agg) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'mean': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'max': return Math.max(...values);
    case 'last':
    default: return values[values.length - 1];
  }
}

/** Bucket ascending-sorted points at one granularity, aggregating each bucket. */
function bucketize(points: SeriesPoint[], granularity: Granularity, agg: Agg): SeriesPoint[] {
  const sorted = [...points].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const groups = new Map<string, number[]>();
  for (const p of sorted) {
    const key = bucketKey(p.t, granularity);
    const bucket = groups.get(key);
    if (bucket) bucket.push(p.v);
    else groups.set(key, [p.v]);
  }
  return [...groups.entries()]
    .map(([t, vals]) => ({ t, v: aggregate(vals, agg) }))
    .sort((a, b) => (a.t < b.t ? -1 : 1));
}

/**
 * Cap a single series: start at `granularity`, coarsen one level at a time until
 * it fits under MAX_POINTS; if still over at monthly, keep the newest MAX_POINTS.
 */
export function capSeries(
  rawPoints: SeriesPoint[],
  granularity: Granularity,
  agg: Agg,
): { points: SeriesPoint[]; granularity: Granularity } {
  let idx = LADDER.indexOf(granularity);
  if (idx < 0) idx = 0;
  let points = bucketize(rawPoints, LADDER[idx], agg);
  while (points.length > MAX_POINTS && idx < LADDER.length - 1) {
    idx += 1;
    points = bucketize(rawPoints, LADDER[idx], agg);
  }
  if (points.length > MAX_POINTS) points = points.slice(points.length - MAX_POINTS);
  return { points, granularity: LADDER[idx] };
}

/**
 * Roll up every raw series to a SHARED granularity (so multi-series charts stay
 * aligned on one x-axis): derive from `spanDays`, coarsen until every series is
 * under cap, then bucket all series at that final granularity.
 */
export function rollupSeries(
  rawSeries: RawSeries[],
  spanDays: number,
  agg: Agg,
): { series: Series[]; granularity: Granularity } {
  let idx = LADDER.indexOf(deriveGranularity(spanDays));
  if (idx < 0) idx = 0;
  while (idx < LADDER.length - 1) {
    const g = LADDER[idx];
    const allUnder = rawSeries.every((s) => bucketize(s.points, g, agg).length <= MAX_POINTS);
    if (allUnder) break;
    idx += 1;
  }
  const granularity = LADDER[idx];
  const series: Series[] = rawSeries.map((s) => {
    let points = bucketize(s.points, granularity, agg);
    if (points.length > MAX_POINTS) points = points.slice(points.length - MAX_POINTS);
    return { name: s.name, points };
  });
  return { series, granularity };
}
