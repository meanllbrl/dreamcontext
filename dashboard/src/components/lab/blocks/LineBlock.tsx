import { LineChart } from '../LineChart';
import { BlockEmpty, boolOption, drawableFrame, fillHeight, numberOption, stringListOption, useBlockSize, type BlockViewProps } from './blockCommon';
import { frameToSeries } from './frameAdapters';

/** Room under the plot for the legend row a multi-series chart draws. */
const LEGEND_RESERVE = 24;

/** `line`: series over time. `area` fills under each line, `color` picks the first palette slot, `series` picks lines. */
export function LineBlock({ frame, options }: BlockViewProps) {
  const [ref, size] = useBlockSize();
  const drawable = drawableFrame(frame, ['series'] as const);
  const series = 'frame' in drawable ? frameToSeries(drawable.frame) : [];
  const legend = series.length > 1 ? LEGEND_RESERVE : 0;
  return (
    <div ref={ref} className="lab-block-fill">
      {'empty' in drawable ? <BlockEmpty reason={drawable.empty} /> : (
        <LineChart
          series={series}
          unit={drawable.frame.unit}
          height={fillHeight(size.height, 200, legend)}
          area={boolOption(options, 'area')}
          colorIndex={numberOption(options, 'color', 1, 1, 8)}
          seriesFilter={stringListOption(options, 'series')}
        />
      )}
    </div>
  );
}
