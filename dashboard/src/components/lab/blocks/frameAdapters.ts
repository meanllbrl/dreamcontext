import type { Series } from '../../../hooks/useLab';
import type { BarRow } from '../barRows';
import { toBarRows } from '../barRows';
import { CHART_COLORS } from '../chartColors';
import type { MatrixSet } from '../matrixModel';
import type { Frame, TableRow } from '../../../generated/frameOps';

/**
 * Frame -> chart input adapters: the charts predate boards and take Series[],
 * BarRow[] or a MatrixSet, so each block converts its (already shaped) frame
 * here. Pure; no React.
 */

type TableFrame = Extract<Frame, { kind: 'table' }>;

/** A row's label: its dim values in dim order, joined. */
export function rowLabel(row: TableRow, dims: readonly { key: string }[]): string {
  const parts = dims.map((d) => row.d[d.key]).filter((v): v is string => typeof v === 'string' && v !== '');
  return parts.length > 0 ? parts.join(' / ') : '';
}

/**
 * A frame as Series[]. Series frames pass through. Tables: two or more dims
 * pivot into one series per second-dim value over the first dim; one dim =
 * one single-point series per row (what share charts rank). A value frame is
 * its sparkline.
 */
export function frameToSeries(frame: Frame | null): Series[] {
  if (!frame) return [];
  if (frame.kind === 'series') return frame.series.map((s) => ({ name: s.name, points: s.points }));
  if (frame.kind === 'value') {
    return frame.spark.length > 0 ? [{ name: frame.insight, points: frame.spark.map((v, i) => ({ t: String(i), v })) }] : [];
  }
  if (frame.kind !== 'table') return [];
  const [x, s] = frame.dims;
  if (x && s) {
    const bySeries = new Map<string, Series>();
    for (const row of frame.rows) {
      if (typeof row.v !== 'number') continue;
      const name = row.d[s.key] ?? '';
      const t = row.d[x.key] ?? '';
      const series = bySeries.get(name) ?? { name, points: [] };
      series.points.push({ t, v: row.v });
      bySeries.set(name, series);
    }
    return [...bySeries.values()];
  }
  return frame.rows
    .filter((row) => typeof row.v === 'number')
    .map((row) => ({ name: rowLabel(row, frame.dims) || String(row.v), points: [{ t: frame.label ?? '', v: row.v as number }] }));
}

/**
 * A frame as bar rows, in the frame's own order (its `sort` already ran).
 * Series rank by their latest value (the `bar` render's rule); table rows by
 * `v`. Non-positive values are dropped, as toBarRows does.
 */
export function frameToBarRows(frame: Frame | null): BarRow[] {
  if (!frame) return [];
  if (frame.kind === 'series') return toBarRows(frame.series);
  if (frame.kind !== 'table') return [];
  const kept = frame.rows
    .map((row) => ({ name: rowLabel(row, frame.dims), value: typeof row.v === 'number' ? row.v : 0 }))
    .filter((r) => r.value > 0);
  const total = kept.reduce((a, r) => a + r.value, 0);
  if (total <= 0) return [];
  return kept.map((r, i) => ({ ...r, frac: r.value / total, color: CHART_COLORS[i % CHART_COLORS.length] }));
}

/**
 * A table frame as two compare series (previous, current) grouped by row,
 * for `bar` with `comparePrev`. Only rows carrying a `prev` count. Series
 * frames compare time buckets instead (the `bar_compare` rule) and return null.
 */
export function frameToCompare(
  frame: Frame | null,
  names: { prev: string; current: string },
): { series: Series[]; groups: string[] } | null {
  if (!frame || frame.kind !== 'table') return null;
  const rows = frame.rows.filter((r) => typeof r.v === 'number' && typeof r.prev === 'number');
  if (rows.length === 0) return { series: [], groups: [] };
  const groups = rows.map((r, i) => rowLabel(r, frame.dims) || String(i + 1));
  return {
    groups,
    series: [
      { name: names.prev, points: rows.map((r, i) => ({ t: groups[i], v: r.prev as number })) },
      { name: names.current, points: rows.map((r, i) => ({ t: groups[i], v: r.v as number })) },
    ],
  };
}

/** A table frame IS a matrix set (dataset/v1 spreads MatrixSet); its total is the filtered one. */
export function frameToMatrixSet(frame: TableFrame): MatrixSet {
  return {
    kind: 'matrix/v1',
    dims: frame.dims.map((d) => ({ key: d.key, label: d.label })),
    rows: frame.rows.map((r) => ({ d: r.d, v: r.v, n: r.n ?? null, prev: r.prev ?? null })),
    total: { v: frame.total.v, n: frame.total.n },
    ...(frame.unit ? { unit: frame.unit } : {}),
  };
}

/** What a `stat` block reads: the figure, the previous point and the sparkline values. */
export interface StatValue {
  value: number | null;
  prev: number | null;
  spark: number[];
  unit: string | null;
}

export function frameToStat(frame: Frame | null): StatValue | null {
  if (!frame) return null;
  if (frame.kind === 'value') return { value: frame.value, prev: frame.prev, spark: frame.spark, unit: frame.unit };
  if (frame.kind === 'series') {
    const first = frame.series[0];
    const values = first ? first.points.map((p) => p.v).filter((v) => Number.isFinite(v)) : [];
    return {
      value: values.length > 0 ? values[values.length - 1] : null,
      prev: values.length >= 2 ? values[values.length - 2] : null,
      spark: values,
      unit: frame.unit,
    };
  }
  return null;
}

/**
 * A stat over the first series of `pick` the insight has (the `series`
 * option): its latest point, the point before, and its values as the spark.
 * Null when none of the named series exists, so the caller keeps the default.
 */
export function statFromSeries(series: readonly Series[], pick: readonly string[], unit: string | null): StatValue | null {
  const byName = new Map(series.map((s) => [s.name, s] as [string, Series]));
  const hit = pick.map((name) => byName.get(name)).find((s): s is Series => s !== undefined);
  if (!hit) return null;
  const values = hit.points.map((p) => p.v).filter((v) => Number.isFinite(v));
  return {
    value: values.length > 0 ? values[values.length - 1] : null,
    prev: values.length >= 2 ? values[values.length - 2] : null,
    spark: values,
    unit,
  };
}
