import { useMemo } from 'react';
import type { Frame } from '../../../generated/frameOps';
import type { ShareRow } from '../BarList';
import { PieChart, toPieLabels } from '../PieChart';
import { toChartFormat } from '../chart';
import { BlockEmpty, boolOption, drawableFrame, numberOption, type BlockViewProps } from './blockCommon';
import { barSortMode, orderCategories, type BarSortMode } from './BarBlock';
import { rowLabel } from './frameAdapters';

/**
 * `pie`: shares of a total. Every option passes through: `donut`,
 * `centerTotal`, `labels` (legend / outside / inside / none), `sort` (missing
 * = largest first), `topN` (its Other slice is grey and last), `color` (the
 * first slice's palette slot), `format`. Seven or more slices still degrade to
 * the bar list (PieChart's own rule, kept). The chart fills the cell.
 */

/**
 * A shaped frame as share rows: each series at its latest point, or each table
 * row (dims joined), positive values only (a share of nothing is not a slice),
 * ordered by `mode` with an Other bucket last.
 */
export function pieRowsFromFrame(frame: Frame, mode: BarSortMode): ShareRow[] {
  let raw: { name: string; value: number; other?: number | null }[] = [];
  if (frame.kind === 'series') {
    raw = frame.series.map((s) => {
      const pts = s.points.filter((p) => typeof p.v === 'number' && Number.isFinite(p.v));
      return { name: s.name, value: pts.length > 0 ? pts[pts.length - 1].v : 0, other: s.other ?? null };
    });
  } else if (frame.kind === 'table') {
    raw = frame.rows.map((r, i) => ({
      name: rowLabel(r, frame.dims) || String(i + 1),
      value: typeof r.v === 'number' && Number.isFinite(r.v) ? r.v : 0,
      other: r.other ?? null,
    }));
  }
  const kept = raw.filter((r) => r.value > 0);
  const total = kept.reduce((a, r) => a + r.value, 0);
  if (total <= 0) return [];
  const order = orderCategories(kept.map((r) => r.value), kept.map((r) => !!r.other), mode);
  // The colour a slice wears is assigned by PieChart over this order (Other always grey).
  return order.map((i) => ({ name: kept[i].name, value: kept[i].value, frac: kept[i].value / total, color: '', other: kept[i].other }));
}

export function PieBlock({ frame, options, colorDomain }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  const shaped = 'frame' in drawable ? drawable.frame : null;
  const mode = barSortMode(options.sort);
  const rows = useMemo(() => (shaped ? pieRowsFromFrame(shaped, mode) : []), [shaped, mode]);
  return (
    <div className="lab-block-fill lab-chart-cell" data-sort={mode}>
      {'empty' in drawable ? <BlockEmpty reason={drawable.empty} /> : rows.length === 0 ? <BlockEmpty /> : (
        <PieChart
          rows={rows}
          unit={drawable.frame.unit}
          donut={boolOption(options, 'donut')}
          centerTotal={boolOption(options, 'centerTotal')}
          labels={toPieLabels(options.labels)}
          colorIndex={numberOption(options, 'color', 1, 1, 8)}
          format={toChartFormat(options.format)}
          ranked={false}
          colorDomain={colorDomain?.rows}
          full
        />
      )}
    </div>
  );
}
