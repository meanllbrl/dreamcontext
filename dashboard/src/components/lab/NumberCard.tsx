import type { Series } from '../../hooks/useLab';
import { useI18n } from '../../context/I18nContext';
import { LineChart } from './LineChart';
import { Sparkline } from './Sparkline';
import { DeltaMark, useMeasured, type ChartBodyProps } from './chartBody';
import { useChartSize } from './chart';
import './NumberCard.css';

/**
 * The stat tile (dataviz "figure contract"): the hero figure, its unit, the
 * change against the previous point (arrow + sign + value + percent + the
 * period it is measured against, never colour alone), a trend sparkline that
 * fills the width the figure leaves, and an optional goal meter ("62% of goal").
 *
 * `fit` fills the box the host gives it and scales the figure with it (the
 * foundation's `useChartSize`: the box, and the tick font for app zoom), so a
 * stat never scrolls and never clips at any cell size; `size` picks how much
 * of the box the figure may take. Without `fit` (the detail panel) the figure
 * uses the size's fixed step.
 */

export const STAT_SIZES = ['sm', 'md', 'lg'] as const;
export type StatSize = (typeof STAT_SIZES)[number];

export function toStatSize(v: unknown): StatSize {
  return (STAT_SIZES as readonly unknown[]).includes(v) ? (v as StatSize) : 'md';
}

/**
 * Per size, at 100% zoom: the figure's floor and ceiling in px when it fits a
 * box, the share of the box height it may take, and its fixed px without a box.
 */
const HERO: Record<StatSize, { min: number; max: number; share: number; fixed: number }> = {
  sm: { min: 16, max: 32, share: 0.34, fixed: 24 },
  md: { min: 20, max: 64, share: 0.5, fixed: 32 },
  lg: { min: 24, max: 120, share: 0.7, fixed: 48 },
};

/** Average advance of a semibold digit, in em (a little generous, so the figure never clips). */
const DIGIT_EM = 0.62;

/**
 * The hero figure's font px for a box: the smallest of the size's ceiling, its
 * share of the height left after the other rows (`reserve`), and the width the
 * text of `chars` characters may take; never under the size's floor. `zoom`
 * scales floor and ceiling with the app's type ladder. No box = the fixed step.
 */
export function heroFontPx(size: StatSize, box: { width: number; height: number } | null, chars: number, reserve = 0, zoom = 1): number {
  const h = HERO[size];
  if (!box || box.width <= 0 || box.height <= 0) return Math.round(h.fixed * zoom);
  // The figure's line box is 1.1em tall.
  const byHeight = (Math.max(0, box.height - reserve) * h.share) / 1.1;
  const byWidth = box.width / Math.max(1, chars * DIGIT_EM);
  return Math.round(Math.max(h.min * zoom, Math.min(h.max * zoom, byHeight, byWidth)));
}

/** Value against goal, in percent (unclamped: 112 = past the goal), or null when there is no usable goal. */
export function goalPercent(value: number | null, goal: number | null | undefined): number | null {
  if (value === null || typeof goal !== 'number' || !Number.isFinite(goal) || goal <= 0) return null;
  return (value / goal) * 100;
}

/** The i18n key of the "vs previous ..." period for a granularity. */
export function periodKey(granularity: string | null | undefined): string {
  switch (granularity) {
    case 'daily': return 'lab.blocks.stat.vsDay';
    case 'weekly': return 'lab.blocks.stat.vsWeek';
    case 'monthly': return 'lab.blocks.stat.vsMonth';
    default: return 'lab.blocks.stat.vsPrev';
  }
}

/** Second-to-last / last point delta of the first series. */
function computeDelta(series: Series[]): number | null {
  const points = series[0]?.points ?? [];
  if (points.length < 2) return null;
  return points[points.length - 1].v - points[points.length - 2].v;
}

/** Trailing points of the bound series: the sparkline's whole input. */
const SPARK_POINTS = 24;
/** Narrower than this, a sparkline is a smudge: the slot stays empty. */
const SPARK_MIN_WIDTH = 40;
/** The sparkline before its slot is measured (server render, first paint). */
const SPARK_FALLBACK = { width: 68, height: 18 };

export function NumberCard({
  latest, unit, series, delta: deltaOverride, showDelta = true, showSpark = true, format,
  size = 'md', goal = null, period = null, fit = false,
}: {
  latest: number | null;
  unit: string | null;
  series: Series[];
  /** The change to show; absent = last minus previous point of the first series. */
  delta?: number | null;
  /** Board `stat` block `delta: none` hides the change. */
  showDelta?: boolean;
  /** Board `stat` block `spark: false` hides the sparkline. */
  showSpark?: boolean;
  /** Board `stat` block `format`: how the figure and its change are written. */
  format?: (v: number) => string;
  /** Board `stat` block `size`: how much of the box the figure takes. */
  size?: StatSize;
  /** Board `stat` block `goal`: draws the goal meter when > 0. */
  goal?: number | null;
  /** What the change is measured against ("vs previous day"); null = unnamed. */
  period?: string | null;
  /** Fill the host's box and scale the figure with it. */
  fit?: boolean;
}) {
  const { t, locale } = useI18n();
  const box = useChartSize();
  const [sparkRef, sparkBox] = useMeasured<HTMLSpanElement>();

  const delta = showDelta ? (deltaOverride !== undefined ? deltaOverride : computeDelta(series)) : null;
  const fmt = format ?? ((v: number) => v.toLocaleString(locale));
  const figure = latest !== null ? fmt(latest) : '-';
  const sparkPoints = (series[0]?.points ?? []).slice(-SPARK_POINTS);
  const hasSpark = showSpark && sparkPoints.length > 1;
  const pct = goalPercent(latest, goal);
  const prev = latest !== null && delta !== null ? latest - delta : null;
  const change = delta !== null && prev !== null && prev !== 0 ? delta / Math.abs(prev) : null;

  // Rows under the figure: the change (one line) and the goal meter (bar + one line). A
  // box too short for the figure at its floor plus a row drops that row (the goal first),
  // so the figure is never clipped.
  const zoom = box.fontPx / 12;
  const fitted = fit && box.ready;
  const lineH = box.fontPx * 1.5;
  const deltaRowH = lineH + 4;
  const goalRowH = lineH + 20;
  const heroFloor = HERO[size].min * zoom * 1.1;
  const showDeltaRow = delta !== null && (!fitted || heroFloor + deltaRowH <= box.height);
  const showGoal = pct !== null && (!fitted || heroFloor + (showDeltaRow ? deltaRowH : 0) + goalRowH <= box.height);
  const reserve = (showDeltaRow ? deltaRowH : 0) + (showGoal ? goalRowH : 0);
  // With a sparkline beside it, the figure gets at most two thirds of the row.
  const rowWidth = box.width * (hasSpark ? 0.66 : 1) - (unit ? box.fontPx * (unit.length * 0.6 + 1) : 0);
  const heroPx = heroFontPx(size, fit && box.ready ? { width: rowWidth, height: box.height } : null, figure.length, reserve, zoom);
  const sparkMeasured = sparkBox.width > 0;
  const sparkW = sparkMeasured ? Math.floor(sparkBox.width) : SPARK_FALLBACK.width;
  const sparkH = sparkMeasured ? Math.max(SPARK_FALLBACK.height, Math.round(Math.min(heroPx * 0.8, sparkBox.height || heroPx))) : SPARK_FALLBACK.height;

  const pctText = (v: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(v) < 10 ? 1 : 0 }).format(v);
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(Math.abs(v))}`;

  return (
    <div
      ref={box.ref}
      className={`lab-stat lab-stat--${size}${fit ? ' lab-stat--fit' : ''}`}
      data-size={size}
      data-hero-px={heroPx}
    >
      <div className="lab-stat-inner">
        <div className="lab-stat-main">
          <span className="lab-stat-value" style={{ fontSize: heroPx }}>{figure}</span>
          {unit && <span className="lab-stat-unit">{unit}</span>}
          {hasSpark && (
            <span ref={sparkRef} className="lab-stat-spark" style={{ height: fit ? Math.round(heroPx * 0.9) : undefined }} data-spark="">
              {sparkW >= SPARK_MIN_WIDTH && (
                <Sparkline points={sparkPoints} width={sparkW} height={sparkH} color="var(--viz-cat-1)" />
              )}
            </span>
          )}
        </div>
        {delta !== null && showDeltaRow && (
          <div className="lab-stat-delta">
            <DeltaMark
              delta={delta}
              format={fmt}
              suffix={(
                <>
                  {change !== null && <span className="lab-stat-change">({signed(change)})</span>}
                  {period && <span className="lab-stat-period">{period}</span>}
                </>
              )}
            />
          </div>
        )}
        {pct !== null && goal !== null && showGoal && (
          <div className="lab-stat-goal" data-goal-pct={Math.round(pct)} data-reached={pct >= 100 ? '' : undefined}>
            <div
              className="lab-stat-goal-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(Math.min(100, pct))}
              aria-label={t('lab.blocks.stat.goalProgress')}
            >
              <span className="lab-stat-goal-fill" style={{ width: `${Math.min(100, Math.max(0, pct)).toFixed(1)}%` }} />
            </div>
            <div className="lab-stat-goal-text">
              <span>{t('lab.blocks.stat.ofGoal').replace('{pct}', `${pctText(pct)}%`)}</span>
              <span className="lab-stat-goal-target">{t('lab.blocks.stat.goal').replace('{v}', fmt(goal))}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Registry body (`number`): the card's whole story is the figure itself. On a board it fills its cell. */
export function NumberBody({ summary, series, height }: ChartBodyProps) {
  const { t } = useI18n();
  return (
    <NumberCard
      latest={summary.latest}
      unit={summary.unit}
      series={series}
      period={t(periodKey(summary.granularity))}
      fit={height !== undefined}
    />
  );
}

/** Registry detail body (`number`): the panel has room for the real trend, so
 *  the glyph is joined by a full line chart whenever there is a series to draw. */
export function NumberDetailBody({ summary, series }: ChartBodyProps) {
  const { t } = useI18n();
  return (
    <>
      <NumberCard latest={summary.latest} unit={summary.unit} series={series} period={t(periodKey(summary.granularity))} />
      {series.some((s) => s.points.length > 1) && (
        <div className="idp-chart-trend">
          <LineChart series={series} unit={summary.unit} height={280} />
        </div>
      )}
    </>
  );
}
