import { useMemo } from 'react';
import { useI18n } from '../../context/I18nContext';
import { BarList } from './BarList';
import { BarPlot, chartHeight, otherLabel, rowsToModel, type BarModel, type BarPlotOptions, type ShareRow } from './BarList';
import { toBarRows, type BarRow } from './barRows';
import { ChartEmpty, type ChartBodyProps } from './chartBody';

/**
 * `bar` render: one horizontal bar per series, sized by that series' LATEST
 * value: the "who is biggest right now" question, where a line chart answers
 * "how did each move". Drawing is the shared BarList (PieChart's >= 7-slice
 * degrade renders the same rows).
 */
export function BarBody({ summary, series, full = false, emptyHint, height }: ChartBodyProps) {
  const rows = toBarRows(series);
  if (rows.length === 0) return <ChartEmpty hint={emptyHint} />;
  // A host with a definite box (a board cell) passes its height: the list fills it instead of sizing to its rows.
  return <BarList rows={rows} unit={summary.unit} full={full} fill={height !== undefined} />;
}

export interface BarChartProps extends Omit<BarPlotOptions, 'colorStart'> {
  /** Single-series share rows (the legacy shape). Ignored when `model` is given. */
  rows?: BarRow[];
  /** Categories x series (a pivoted table, previous values): what a board block draws. */
  model?: BarModel;
  unit: string | null;
  /** Every row instead of the top rows + Other (rows only). */
  full?: boolean;
  /** Palette slot (1-8) of the first series (the block `color` option). */
  colorIndex?: number;
  /** Rank rows by value (rows only). False keeps the caller's order (a block `sort`). */
  ranked?: boolean;
  /** A fixed pixel height; absent = fill the parent (a board cell). */
  height?: number;
  emptyHint?: string;
  ariaLabel?: string;
}

/**
 * The bar chart with its board options: `orientation` (h rows, v columns),
 * `group` (grouped or stacked series), `comparePrev` (a recessive previous
 * bar beside each bar, the delta in the tooltip), `valueLabels`, `format`,
 * axes, grid and legend. It fills the box it is given and never scrolls.
 */
export function BarChart({ rows, model, unit, full = false, colorIndex, ranked = true, height, emptyHint, ariaLabel, ...opts }: BarChartProps) {
  const { t } = useI18n();
  const drawn = useMemo(
    () => model ?? rowsToModel((rows ?? []) as ShareRow[], { full, ranked, other: (n) => otherLabel(t, n) }),
    [model, rows, full, ranked, t],
  );
  if (drawn.categories.length === 0 || drawn.series.length === 0) return <ChartEmpty hint={emptyHint} />;
  return (
    <div className="lab-bar-box" style={chartHeight(height)}>
      <BarPlot
        model={drawn}
        unit={unit}
        colorStart={colorIndex ?? 1}
        share={!model}
        ariaLabel={ariaLabel}
        {...opts}
      />
    </div>
  );
}
