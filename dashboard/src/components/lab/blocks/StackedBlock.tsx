import { StackedChart } from '../StackedChart';
import { BlockEmpty, drawableFrame, fillHeight, numberOption, useBlockSize, type BlockViewProps } from './blockCommon';
import { frameToSeries } from './frameAdapters';

const LEGEND_RESERVE = 24;

/** `stacked`: parts of a whole per bucket. `color` is the palette slot the bottom layer takes. */
export function StackedBlock({ frame, options }: BlockViewProps) {
  const [ref, size] = useBlockSize();
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  return (
    <div ref={ref} className="lab-block-fill">
      {'empty' in drawable ? <BlockEmpty reason={drawable.empty} /> : (
        <StackedChart
          series={frameToSeries(drawable.frame)}
          unit={drawable.frame.unit}
          colorIndex={numberOption(options, 'color', 1, 1, 8)}
          height={fillHeight(size.height, 150, LEGEND_RESERVE)}
          full
        />
      )}
    </div>
  );
}
