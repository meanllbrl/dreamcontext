import { useInsightCache } from '../../../hooks/useBoards';
import { NumberCard } from '../NumberCard';
import type { Frame } from '../board/boardTypes';
import { BlockEmpty, boolOption, drawableFrame, stringListOption, stringOption, type BlockViewProps } from './blockCommon';
import { frameToStat, statFromSeries, type StatValue } from './frameAdapters';
import { formatStat, statUnitSuffix, toStatFormat } from './format';

/** Trailing points the stat's sparkline draws. */
const SPARK_POINTS = 24;

/**
 * `stat`: one figure through NumberCard. `delta: prev` shows the move from
 * the previous point, `spark` the Sparkline, `unit` overrides the frame's
 * unit, `format` writes the figure (number, compact, percent, currency).
 *
 * `series` picks the series the figure, its delta and its spark come from.
 * A series frame is already narrowed to the pick (frameOps). A value frame
 * only carries the insight's default series, so a pick on one reads the
 * insight's cache (the bulk seed, else one read, never a sync) through
 * `StatFromCache`; until it arrives, or when no named series exists, the
 * default figure shows.
 */
export function StatBlock({ frame, options }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['value', 'series'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const pick = stringListOption(options, 'series');
  const f = drawable.frame;
  // A dataset-bound value frame has no series (its spark is empty): nothing to pick from.
  if (pick && f.kind === 'value' && f.spark.length > 0) return <StatFromCache frame={f} pick={pick} options={options} />;
  return <StatView stat={frameToStat(f)} options={options} />;
}

function StatFromCache({ frame, pick, options }: {
  frame: Extract<Frame, { kind: 'value' }>;
  pick: string[];
  options: Record<string, unknown>;
}) {
  const cache = useInsightCache(frame.insight);
  const picked = statFromSeries(cache.data?.cache?.series ?? [], pick, frame.unit);
  return <StatView stat={picked ?? frameToStat(frame)} options={options} series={picked ? pick.join(',') : undefined} />;
}

function StatView({ stat, options, series }: { stat: StatValue | null; options: Record<string, unknown>; series?: string }) {
  if (!stat || stat.value === null) return <BlockEmpty />;

  const format = toStatFormat(options.format);
  const unit = stringOption(options, 'unit') ?? stat.unit;
  const showDelta = options.delta === 'prev';
  const spark = stat.spark.slice(-SPARK_POINTS);

  return (
    <div className="lab-block-stat" data-format={format} data-delta={showDelta ? 'prev' : 'none'} data-series={series}>
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
