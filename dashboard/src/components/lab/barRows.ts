/**
 * Row math for the share-based renders — the PURE half of BarList.tsx.
 *
 * The pie and the bar list rank the same rows the same way, and the pie's
 * "too many slices → draw bars instead" decision is a rule about data, not about
 * pixels. Keeping that rule here (rather than inline in a component) is what
 * makes it testable without a DOM: `tests/unit/lab-pie-degrade.test.ts` asserts
 * the threshold and the ranking directly, and textually guards that PieChart
 * still routes its degrade through `degradesToBars`.
 */
import type { Series } from '../../hooks/useLab';
import { CHART_COLORS } from './chartColors';

/** Rows shown before the rest collapse into one "+k more" summary row. */
export const ROW_CAP = 5;

/**
 * At or above this many slices a pie is unreadable — the wedges are thinner than
 * their own borders and the legend outgrows the card — so the render degrades to
 * the horizontal bar list. Six is the last count a donut still reads at
 * (`donut ≤ 6`, the Phase-1 rule); seven is where it stops.
 */
export const BAR_THRESHOLD = 7;

export interface BarRow {
  name: string;
  value: number;
  /** Share of the total (0..1). */
  frac: number;
  color: string;
}

/** Should a pie of this many slices be drawn as bars instead? */
export function degradesToBars(sliceCount: number): boolean {
  return sliceCount >= BAR_THRESHOLD;
}

/** Latest value per series, share-weighted and colored — what both the pie and
 *  the bar list rank. Non-positive values are dropped: a row's share is
 *  meaningless without a positive total, and a 0-height bar reads as missing. */
export function toBarRows(series: Series[]): BarRow[] {
  const values = series
    .map((s) => ({ name: s.name, value: s.points.length > 0 ? s.points[s.points.length - 1].v : 0 }))
    .filter((s) => s.value > 0);
  const total = values.reduce((a, b) => a + b.value, 0);
  if (total <= 0) return [];
  return values.map((s, i) => ({
    name: s.name,
    value: s.value,
    frac: s.value / total,
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));
}

/** Rows by descending value, capped unless `full`: the tail becomes one row. */
export function rankRows(rows: BarRow[], full: boolean): { rows: BarRow[]; restCount: number; restFrac: number } {
  const ranked = [...rows].sort((a, b) => b.value - a.value);
  if (full || ranked.length <= ROW_CAP) return { rows: ranked, restCount: 0, restFrac: 0 };
  const head = ranked.slice(0, ROW_CAP);
  const rest = ranked.slice(ROW_CAP);
  return { rows: head, restCount: rest.length, restFrac: rest.reduce((a, s) => a + s.frac, 0) };
}

export function fmtPct(frac: number): string {
  return `${(frac * 100).toFixed(1)}%`;
}
