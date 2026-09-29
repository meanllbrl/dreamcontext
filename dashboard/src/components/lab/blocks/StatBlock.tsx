import { NumberCard } from '../NumberCard';
import { BlockEmpty, boolOption, drawableFrame, stringOption, type BlockViewProps } from './blockCommon';
import { frameToStat } from './frameAdapters';
import { formatStat, statUnitSuffix, toStatFormat } from './format';

/** Trailing points the stat's sparkline draws. */
const SPARK_POINTS = 24;

/**
 * `stat`: one figure through NumberCard. `delta: prev` shows the move from
 * the previous point, `spark` the Sparkline, `unit` overrides the frame's
 * unit, `format` writes the figure (number, compact, percent, currency).
 */
export function StatBlock({ frame, options }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['value', 'series'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const stat = frameToStat(drawable.frame);
  if (!stat || stat.value === null) return <BlockEmpty />;

  const format = toStatFormat(options.format);
  const unit = stringOption(options, 'unit') ?? stat.unit;
  const showDelta = options.delta === 'prev';
  const spark = stat.spark.slice(-SPARK_POINTS);

  return (
    <div className="lab-block-stat" data-format={format} data-delta={showDelta ? 'prev' : 'none'}>
      <NumberCard
        latest={stat.value}
        unit={statUnitSuffix(format, unit)}
        series={[{ name: 'spark', points: spark.map((v, i) => ({ t: String(i), v })) }]}
        delta={showDelta && stat.prev !== null ? stat.value - stat.prev : null}
        showDelta={showDelta}
        showSpark={boolOption(options, 'spark')}
        format={(v) => formatStat(v, format, unit)}
      />
    </div>
  );
}
