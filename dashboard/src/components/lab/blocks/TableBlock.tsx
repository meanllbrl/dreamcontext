import { useI18n } from '../../../context/I18nContext';
import { toChartFormat } from '../chart';
import { FrameTable, MetricTable, toDensity, type TableOptions } from '../MetricTable';
import { BlockEmpty, boolOption, drawableFrame, stringListOption, type BlockViewProps } from './blockCommon';
import './dataBlocks.css';

/**
 * `table`: rows of numbers. A table frame lists its rows with the chosen
 * `columns` (dim keys, `v`, `n`, `prev`, `delta`) and its filtered total as a
 * footer; a series frame is the metric table (`series`, `latest`, `delta`,
 * `trend`). `where`, `sort` and `limit` shaped the frame already (frameOps);
 * here the header click re-sorts the view, `density` sets the rhythm, `bars`
 * draws inline data bars, `deltaColor` colours the change on top of its arrow
 * and sign, `format` writes the figures. An `Other` fold (topN) keeps its
 * label and the bottom row. The table scrolls inside its cell with a sticky
 * header; nothing else does.
 */
export function TableBlock({ frame, options }: BlockViewProps) {
  const { t } = useI18n();
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const columns = stringListOption(options, 'columns');
  const view: TableOptions = {
    density: toDensity(options.density),
    bars: boolOption(options, 'bars'),
    deltaColor: boolOption(options, 'deltaColor', true),
    format: toChartFormat(options.format),
  };
  const f = drawable.frame;
  return (
    <div className="lab-block-table">
      {f.kind === 'table' ? (
        <FrameTable
          dims={f.dims}
          rows={f.rows}
          unit={f.unit}
          columns={columns}
          total={f.total}
          emptyHint={t('lab.blocks.empty.noData')}
          {...view}
        />
      ) : (
        <MetricTable series={f.series} unit={f.unit} columns={columns} full emptyHint={t('lab.blocks.empty.noData')} {...view} />
      )}
    </div>
  );
}
