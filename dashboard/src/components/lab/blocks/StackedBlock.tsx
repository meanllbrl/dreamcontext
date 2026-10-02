import { StackedChart, toStackMode } from '../StackedChart';
import { toAxesMode } from '../LineChart';
import { toChartFormat, toLegendPosition } from '../chart';
import { BlockEmpty, boolOption, drawableFrame, numberOption, type BlockViewProps } from './blockCommon';
import { frameToSeries } from './frameAdapters';
import { withOther } from './LineBlock';

/**
 * `stacked`: parts of a whole per bucket. `mode` bar | area, `normalize` (the
 * frame arrives as shares of 100: frameOps did it, so `lab board show` prints
 * the same numbers), `color` (the bottom layer's slot), `legend`, `axes`,
 * `grid`, `format`. The chart fills the cell.
 */
export function StackedBlock({ frame, options, colorDomain }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  if ('empty' in drawable) return <div className="lab-block-fill"><BlockEmpty reason={drawable.empty} /></div>;
  const f = drawable.frame;
  return (
    <div className="lab-block-fill">
      <StackedChart
        series={f.kind === 'series' ? withOther(f.series) : frameToSeries(f)}
        unit={f.unit}
        colorIndex={numberOption(options, 'color', 1, 1, 8)}
        colorDomain={colorDomain?.series}
        mode={toStackMode(options.mode)}
        normalized={boolOption(options, 'normalize')}
        legend={toLegendPosition(options.legend)}
        axes={toAxesMode(options.axes)}
        grid={boolOption(options, 'grid', true)}
        format={toChartFormat(options.format)}
        fill
      />
    </div>
  );
}
