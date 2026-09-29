import { useI18n } from '../../../context/I18nContext';
import { FrameTable, MetricTable } from '../MetricTable';
import { frameToSeries } from './frameAdapters';
import { BlockEmpty, drawableFrame, stringListOption, type BlockViewProps } from './blockCommon';

/**
 * `table`: rows of numbers. A table frame lists its rows with the chosen
 * `columns` (dim keys, `v`, `n`, `prev`) and its filtered total as a footer;
 * a series frame is the metric table (`series`, `latest`, `delta`, `trend`).
 */
export function TableBlock({ frame, options }: BlockViewProps) {
  const { t } = useI18n();
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const columns = stringListOption(options, 'columns');
  const f = drawable.frame;
  return (
    <div className="lab-block-scroll">
      {f.kind === 'table' ? (
        <FrameTable
          dims={f.dims}
          rows={f.rows}
          unit={f.unit}
          columns={columns}
          total={f.total}
          labels={{
            v: t('lab.blocks.table.value'),
            n: t('lab.blocks.table.n'),
            prev: t('lab.blocks.table.prev'),
            total: t('lab.blocks.table.total'),
            rows: t('lab.blocks.table.rows'),
          }}
          emptyHint={t('lab.blocks.empty.noData')}
        />
      ) : (
        <MetricTable series={frameToSeries(f)} unit={f.unit} columns={columns} full emptyHint={t('lab.blocks.empty.noData')} />
      )}
    </div>
  );
}
