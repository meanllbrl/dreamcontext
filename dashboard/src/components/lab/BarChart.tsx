import { BarList } from './BarList';
import { toBarRows } from './barRows';
import { ChartEmpty, type ChartBodyProps } from './chartBody';

/**
 * `bar` render — one horizontal bar per series, sized by that series' LATEST
 * value: the "who is biggest right now" question, where a line chart answers
 * "how did each move". Drawing is the shared BarList (PieChart's ≥7-slice
 * degrade renders the same rows).
 */
export function BarBody({ summary, series, full = false, emptyHint }: ChartBodyProps) {
  const rows = toBarRows(series);
  if (rows.length === 0) return <ChartEmpty hint={emptyHint} />;
  return <BarList rows={rows} unit={summary.unit} full={full} />;
}
