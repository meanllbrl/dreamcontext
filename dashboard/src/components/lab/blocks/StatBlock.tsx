import { useI18n } from '../../../context/I18nContext';
import { useInsightCache } from '../../../hooks/useBoards';
import { NumberCard, periodKey, toStatSize, wholeFigure } from '../NumberCard';
import type { Frame } from '../board/boardTypes';
import { BlockEmpty, boolOption, drawableFrame, stringListOption, stringOption, type BlockViewProps } from './blockCommon';
import { frameToStat, statFromSeries, type StatValue } from './frameAdapters';
import { currencyCode, formatStat, statUnitSuffix, toStatFormat, type StatFormat } from './format';

/** Trailing points the stat's sparkline draws. */
const SPARK_POINTS = 24;

/**
 * How a stat writes its figure, its change and its goal. From 1,000 up the
 * figure is whole (NumberCard `wholeFigure`): no cents on a big KPI, the
 * currency keeps its symbol ("$52,073", "Goal $60,000"). Compact and percent
 * already carry their own precision.
 */
export function statFormatter(value: number | null, format: StatFormat, unit: string | null, locale?: string): (v: number) => string {
  if (!wholeFigure(value) || (format !== 'number' && format !== 'currency')) return (v) => formatStat(v, format, unit, locale);
  const nf = format === 'currency'
    ? new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode(unit), minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return (v) => nf.format(v);
}

/**
 * `stat`: one figure through NumberCard, filling its cell (never scrolls).
 * `delta: prev` shows the move from the previous point (arrow, sign, percent
 * and the period it is measured against), `spark` the Sparkline beside the
 * figure, `unit` overrides the frame's unit, `format` writes the figure
 * (number, compact, percent, currency), `size` how much of the cell the
 * figure takes, `goal` a progress meter with "x% of goal".
 *
 * `series` picks the series the figure, its delta and its spark come from.
 * A series frame is already narrowed to the pick (frameOps). A value frame
 * only carries the insight's default series, so a pick on one reads the
 * insight's cache (the bulk seed, else one read, never a sync) through
 * `StatFromCache`; until it arrives, or when no named series exists, the
 * default figure shows.
 */
export function StatBlock({ frame, options, summary }: BlockViewProps) {
  const drawable = drawableFrame(frame, ['value', 'series'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const pick = stringListOption(options, 'series');
  const f = drawable.frame;
  // The period the change is measured against: the series' own grain, else the insight's.
  const granularity = f.kind === 'series' ? f.granularity : summary?.granularity ?? null;
  // A dataset-bound value frame has no series (its spark is empty): nothing to pick from.
  if (pick && f.kind === 'value' && f.spark.length > 0) return <StatFromCache frame={f} pick={pick} options={options} granularity={granularity} />;
  return <StatView stat={frameToStat(f)} options={options} granularity={granularity} />;
}

function StatFromCache({ frame, pick, options, granularity }: {
  frame: Extract<Frame, { kind: 'value' }>;
  pick: string[];
  options: Record<string, unknown>;
  granularity: string | null;
}) {
  const cache = useInsightCache(frame.insight);
  const picked = statFromSeries(cache.data?.cache?.series ?? [], pick, frame.unit);
  return <StatView stat={picked ?? frameToStat(frame)} options={options} granularity={granularity} series={picked ? pick.join(',') : undefined} />;
}

function StatView({ stat, options, granularity, series }: {
  stat: StatValue | null;
  options: Record<string, unknown>;
  granularity: string | null;
  series?: string;
}) {
  const { t, locale } = useI18n();
  if (!stat || stat.value === null) return <BlockEmpty />;

  const format = toStatFormat(options.format);
  const unit = stringOption(options, 'unit') ?? stat.unit;
  const showDelta = options.delta === 'prev';
  const spark = stat.spark.slice(-SPARK_POINTS);
  const size = toStatSize(options.size);
  const goal = typeof options.goal === 'number' && Number.isFinite(options.goal) && options.goal > 0 ? options.goal : null;

  return (
    <div className="lab-block-stat" data-format={format} data-delta={showDelta ? 'prev' : 'none'} data-size={size} data-series={series}>
      <NumberCard
        latest={stat.value}
        unit={statUnitSuffix(format, unit)}
        series={[{ name: 'spark', points: spark.map((v, i) => ({ t: String(i), v })) }]}
        delta={showDelta && stat.prev !== null ? stat.value - stat.prev : null}
        showDelta={showDelta}
        showSpark={boolOption(options, 'spark')}
        format={statFormatter(stat.value, format, unit, locale)}
        size={size}
        goal={goal}
        period={t(periodKey(granularity))}
        fit
      />
    </div>
  );
}
