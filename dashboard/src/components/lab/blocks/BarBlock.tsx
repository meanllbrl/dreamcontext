import { useI18n } from '../../../context/I18nContext';
import { BarChart } from '../BarChart';
import { BarCompareChart } from '../BarCompareChart';
import { BlockEmpty, boolOption, drawableFrame, fillHeight, numberOption, useBlockSize, type BlockViewProps } from './blockCommon';
import { frameToBarRows, frameToCompare, frameToSeries } from './frameAdapters';

const LEGEND_RESERVE = 24;

/**
 * `bar`: values side by side. `orientation` h (bar list) or v (columns),
 * `color` the first palette slot, `comparePrev` the bar_compare drawing:
 * previous vs current per row for a table, the last time buckets for series.
 * A `sort` option keeps its own order instead of ranking by value.
 */
export function BarBlock({ frame, options }: BlockViewProps) {
  const { t } = useI18n();
  const [ref, size] = useBlockSize();
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  const colorIndex = numberOption(options, 'color', 1, 1, 8);
  const height = fillHeight(size.height, 180, LEGEND_RESERVE);

  let body;
  if ('empty' in drawable) {
    body = <BlockEmpty reason={drawable.empty} />;
  } else if (boolOption(options, 'comparePrev')) {
    const table = frameToCompare(drawable.frame, { prev: t('lab.blocks.compare.prev'), current: t('lab.blocks.compare.current') });
    body = table
      ? (table.groups.length === 0
          ? <BlockEmpty message={t('lab.blocks.compare.noPrev')} />
          : <BarCompareChart series={table.series} groups={table.groups} unit={drawable.frame.unit} colorIndex={colorIndex} height={height} full />)
      : <BarCompareChart series={frameToSeries(drawable.frame)} unit={drawable.frame.unit} colorIndex={colorIndex} height={height} full />;
  } else {
    body = (
      <BarChart
        rows={frameToBarRows(drawable.frame)}
        unit={drawable.frame.unit}
        orientation={options.orientation === 'v' ? 'v' : 'h'}
        colorIndex={colorIndex}
        ranked={options.sort === undefined || options.sort === null || options.sort === ''}
        height={height}
        full
      />
    );
  }
  return (
    <div ref={ref} className="lab-block-fill" data-orientation={options.orientation === 'v' ? 'v' : 'h'}>
      {body}
    </div>
  );
}
