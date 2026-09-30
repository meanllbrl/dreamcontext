import { LineChart, toAxesMode, toLineCurve, toPointMode, type ChartSeries } from '../LineChart';
import { toChartFormat, toLegendPosition } from '../chart';
import { BlockEmpty, boolOption, drawableFrame, numberOption, stringListOption, stringOption, type BlockViewProps } from './blockCommon';

/**
 * `line`: series over time. Every catalog option passes straight through:
 * `area`, `color` (first palette slot), `series` (pick), `curve`, `points`,
 * `yMin`, `reference` + `referenceLabel`, `legend`, `axes`, `grid`, `format`.
 * The chart fills the cell (no fixed height): it measures the box it is given.
 */
export function LineBlock({ frame, options, colorDomain }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['series'] as const);
  if ('empty' in drawable) return <div className="lab-block-fill"><BlockEmpty reason={drawable.empty} /></div>;
  return (
    <div className="lab-block-fill">
      <LineChart
        series={withOther(drawable.frame.series)}
        unit={drawable.frame.unit}
        area={boolOption(options, 'area')}
        colorIndex={numberOption(options, 'color', 1, 1, 8)}
        seriesFilter={stringListOption(options, 'series')}
        colorDomain={colorDomain?.series}
        curve={toLineCurve(options.curve)}
        points={toPointMode(options.points)}
        yMin={options.yMin === 'zero' ? 'zero' : 'auto'}
        reference={typeof options.reference === 'number' && Number.isFinite(options.reference) ? options.reference : null}
        referenceLabel={stringOption(options, 'referenceLabel')}
        legend={toLegendPosition(options.legend)}
        axes={toAxesMode(options.axes)}
        grid={boolOption(options, 'grid', true)}
        format={toChartFormat(options.format)}
      />
    </div>
  );
}

/** Series frames as chart series, keeping the `other` count a folded "Other" series carries. */
export function withOther(series: readonly { name: string; points: { t: string; v: number }[]; other?: number }[]): ChartSeries[] {
  return series.map((s) => (typeof s.other === 'number' ? { name: s.name, points: s.points, other: s.other } : { name: s.name, points: s.points }));
}
