import { useMemo } from 'react';
import type { Series } from '../../hooks/useLab';
import { useI18n } from '../../context/I18nContext';
import { BarPlot, chartHeight, otherLabel, type BarModel, type BarPlotOptions } from './BarList';
import { formatTimeKey, parseTimeKey } from './chart';
import { ChartEmpty, unionTimeKeys, type ChartBodyProps } from './chartBody';

/**
 * `bar_compare` render: grouped columns, one group per time bucket, one bar
 * per series inside it. The before/after comparison (plan vs actual, this
 * week vs last), which a line chart blurs and a pie cannot express at all.
 *
 * Only the LAST few buckets are drawn: comparing more than a handful of groups
 * side by side stops being a comparison and becomes an unreadable line chart.
 * Drawn by the shared BarPlot (axes, per-group hover, legend toggles).
 */

/** Buckets compared side by side: the card has less room than the panel. */
const BUCKETS = { card: 4, full: 6 };
/** Series drawn before the rest fold into one Other series. */
const SERIES_CAP = 6;

export function BarCompareBody({ summary, series, full = false, emptyHint, height }: ChartBodyProps) {
  return <BarCompareChart series={series} unit={summary.unit} full={full} emptyHint={emptyHint} fill={height !== undefined} />;
}

/**
 * The grouped-bar drawing behind `bar_compare`. `groups` names the groups in
 * display order; absent = the last few time buckets, the render's own rule.
 * `colorIndex` is the palette slot (1-8) the first series takes. A `height`
 * fixes the box; absent = the render's own height (`fill` = the parent's).
 */
export function BarCompareChart({ series, unit, full = false, emptyHint, groups, colorIndex = 1, height: heightProp, fill = false, ...opts }: {
  series: Series[];
  unit: string | null;
  full?: boolean;
  emptyHint?: string;
  groups?: readonly string[];
  colorIndex?: number;
  height?: number;
  fill?: boolean;
} & Omit<BarPlotOptions, 'colorStart' | 'unit'>) {
  const { t, locale } = useI18n();
  const model = useMemo<BarModel>(() => {
    const drawn = series.slice(0, SERIES_CAP);
    const rest = series.slice(SERIES_CAP);
    const keys = groups ? [...groups] : unionTimeKeys(series).slice(-(full ? BUCKETS.full : BUCKETS.card));
    const at = (s: Series, k: string) => s.points.find((p) => p.t === k)?.v ?? null;
    const out: BarModel = {
      categories: keys.map((k) => ({ key: k, label: formatTimeKey(k, parseTimeKey(k), locale) })),
      series: drawn.map((s) => ({ id: s.name, label: s.name, values: keys.map((k) => at(s, k)) })),
    };
    if (rest.length > 0) {
      out.series.push({
        id: '\u0000other',
        label: otherLabel(t, rest.length),
        other: true,
        values: keys.map((k) => {
          const vs = rest.map((s) => at(s, k)).filter((v): v is number => v !== null);
          return vs.length > 0 ? vs.reduce((a, v) => a + v, 0) : null;
        }),
      });
    }
    return out;
  }, [series, groups, full, locale, t]);

  if (model.categories.length === 0 || model.series.length === 0) return <ChartEmpty hint={emptyHint} />;
  const height = fill ? undefined : heightProp ?? (full ? 260 : 150);
  return (
    <div className="lab-bar-box" style={chartHeight(height)}>
      <BarPlot model={model} chart="bar-compare" orientation="v" unit={unit} colorStart={colorIndex} valueLabels={false} {...opts} />
    </div>
  );
}
