import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import {
  dailySeries, funnelSlice,
  type FunnelFrame, type FunnelSlice, type SeriesFrame, type TableFrame, type TableRow,
} from '../../../generated/frameOps';
import { BarBlock } from './BarBlock';
import { LineBlock } from './LineBlock';
import { BlockEmpty, boolOption, drawableFrame, stringListOption, stringOption, type BlockViewProps } from './blockCommon';
import { selectionLabel, unknownFunnelPick } from './BreakdownBlock';
import './breakdown.css';

/**
 * `trend`: the explorer's daily page. The card's selection picks the slice
 * (`funnelSlice`), its days become a series frame (`dailySeries`) drawn on the
 * existing LineBlock (`chart: line`, default) or BarBlock (`chart: bar`, one
 * column per day), with `legend`, `axes`, `grid` and `format` passed through.
 * `metrics` picks and orders the metrics; `switch` (default on) draws one at a
 * time behind a segmented control. A null day is a gap, never a 0; an
 * unmeasured slice or metric says so in words and draws no line.
 */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Every metric the slice can trend: its metric keys, then any extra key its days carry. */
export function trendKeys(slice: FunnelSlice): string[] {
  const keys = Object.keys(slice.metrics);
  for (const day of slice.daily) for (const k of Object.keys(day.m)) if (!keys.includes(k)) keys.push(k);
  return keys;
}

/** A metric has a trend when at least one day carries a finite value for it. */
export function hasTrend(slice: FunnelSlice, key: string): boolean {
  return slice.daily.some((d) => finite(d.m[key]));
}

/** The `metrics` pick against what the slice has: the keys to draw (in pick order) and the ones not in the data. */
export function pickMetrics(available: readonly string[], requested: readonly string[] | null): { keys: string[]; unknown: string[] } {
  if (!requested) return { keys: [...available], unknown: [] };
  const keys: string[] = [];
  const unknown: string[] = [];
  for (const k of requested) {
    if (available.includes(k)) {
      if (!keys.includes(k)) keys.push(k);
    } else if (!unknown.includes(k)) unknown.push(k);
  }
  return { keys, unknown };
}

/** A daily series frame as a day x metric table, so the bar chart draws one column per day in date order. */
export function dailyTable(series: SeriesFrame, dayLabel: (t: string) => string, metricLabel: string): TableFrame {
  const rows: TableRow[] = [];
  const days = Array.from(new Set(series.series.flatMap((s) => s.points.map((p) => p.t)))).sort();
  for (const t of days) {
    for (const s of series.series) {
      const p = s.points.find((x) => x.t === t);
      if (p) rows.push({ d: { day: dayLabel(t), metric: s.name }, v: p.v });
    }
  }
  return {
    kind: 'table',
    insight: series.insight,
    dataset: null,
    label: null,
    dims: [{ key: 'day', label: 'day' }, { key: 'metric', label: metricLabel }],
    rows,
    sourceTotal: null,
    total: { count: rows.length, v: null, n: null },
    unit: series.unit,
  };
}

/** `YYYY-MM-DD` as a short calendar day ("Sep 3"); anything else as written. */
function shortDay(key: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(ms));
  } catch {
    return key;
  }
}

export function TrendBlock({ frame, options, selection, block }: BlockViewProps) {
  const { t, locale } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const switchRef = useRef<HTMLDivElement>(null);
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <div className="lab-block-fill"><BlockEmpty reason={drawable.empty} /></div>;
  const f: FunnelFrame = drawable.frame;

  const pick = stringOption(options, 'funnel');
  const unknownFunnel = unknownFunnelPick(f, pick);
  const slice = funnelSlice(f, unknownFunnel ? null : pick, selection ?? {});
  const dimOrder = (f.dimensions ?? []).map((d) => d.key);
  const dimLabel = (k: string) => f.dimensions?.find((d) => d.key === k)?.label ?? k;
  const noPath = t('lab.blocks.breakdown.noPath');

  const notes: { key: string; text: string }[] = [];
  if (unknownFunnel) {
    notes.push({
      key: 'funnel',
      text: t('lab.blocks.explorer.unknownFunnel').replace('{id}', unknownFunnel).replace('{name}', slice.funnelName),
    });
  }
  if (slice.ignored.length > 0) {
    notes.push({ key: 'split', text: t('lab.blocks.explorer.notSplit').replace('{dims}', slice.ignored.map(dimLabel).join(', ')) });
  }

  const shell = (body: ReactNode, attrs: Record<string, string> = {}) => (
    <div className="lab-block-fill lab-trend" data-lab-trend="" {...attrs}>
      {notes.map((n) => (
        <div key={n.key} className="lab-explorer-note" data-lab-trend-note={n.key}>{n.text}</div>
      ))}
      {body}
    </div>
  );

  if (!slice.measured) {
    const sel = selectionLabel(slice.selection, dimOrder) ?? t('lab.blocks.breakdown.all');
    return shell(
      <div className="lab-explorer-state" data-lab-not-measured="">
        {t('lab.blocks.explorer.notMeasured').replace('{sel}', sel).replace('{reason}', slice.reason ?? noPath)}
      </div>,
      { 'data-state': 'unmeasured' },
    );
  }
  if (slice.daily.length === 0) {
    return shell(<BlockEmpty message={t('lab.blocks.trend.noDaily')} />, { 'data-state': 'no-daily' });
  }

  const { keys, unknown } = pickMetrics(trendKeys(slice), stringListOption(options, 'metrics'));
  if (unknown.length > 0) notes.push({ key: 'metrics', text: t('lab.blocks.explorer.unknownMetrics').replace('{keys}', unknown.join(', ')) });
  if (slice.lowSample) {
    notes.push({ key: 'low', text: t('lab.blocks.explorer.lowSample').replace('{n}', slice.users.toLocaleString(locale)) });
  }
  if (keys.length === 0) return shell(<BlockEmpty message={t('lab.blocks.trend.noDaily')} />, { 'data-state': 'no-daily' });

  const labelOf = (k: string) => slice.metrics[k]?.label ?? k;
  const whyNot = (k: string) => t('lab.blocks.trend.metricNotMeasured')
    .replace('{metric}', labelOf(k))
    .replace('{reason}', slice.metrics[k]?.reason ?? noPath);
  const useSwitch = boolOption(options, 'switch', true) && keys.length > 1;
  const active = useSwitch ? (picked !== null && keys.includes(picked) ? picked : keys[0]) : null;
  const drawn = (active ? [active] : keys).filter((k) => hasTrend(slice, k));
  if (!active) {
    for (const k of keys) if (!hasTrend(slice, k)) notes.push({ key: `m-${k}`, text: whyNot(k) });
  }

  const onSwitchKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = keys[(keys.indexOf(active) + step + keys.length) % keys.length];
    setPicked(next);
    switchRef.current?.querySelector<HTMLButtonElement>(`[data-lab-trend-metric="${CSS.escape(next)}"]`)?.focus();
  };

  const metricSwitch = useSwitch && (
    <div
      ref={switchRef}
      className="lab-trend-switch"
      role="radiogroup"
      aria-label={t('lab.blocks.trend.metric')}
      data-lab-trend-switch=""
      onKeyDown={onSwitchKey}
    >
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          role="radio"
          className="lab-trend-switch-option"
          data-lab-trend-metric={k}
          data-measured={hasTrend(slice, k) ? undefined : 'false'}
          aria-checked={k === active}
          tabIndex={k === active ? 0 : -1}
          onClick={() => setPicked(k)}
        >
          {labelOf(k)}
        </button>
      ))}
    </div>
  );

  let chart: ReactNode;
  if (drawn.length === 0) {
    chart = <div className="lab-explorer-state" data-lab-not-measured="">{whyNot(active ?? keys[0])}</div>;
  } else {
    const series = dailySeries(slice, drawn, f.insight);
    // Colours are assigned over every trendable metric, so switching never repaints one.
    const colorDomain = { series: keys.map(labelOf), rows: [] as string[] };
    const pass = { legend: options.legend, axes: options.axes, grid: options.grid, format: options.format };
    chart = options.chart === 'bar'
      ? (
        <BarBlock
          block={block}
          frame={dailyTable(series, (d) => shortDay(d, locale), t('lab.blocks.trend.metric'))}
          options={{ ...pass, orientation: 'v', sort: 'none', valueLabels: false, legend: options.legend ?? (drawn.length > 1 ? 'bottom' : 'none') }}
          colorDomain={colorDomain}
        />
      )
      : <LineBlock block={block} frame={series} options={pass} colorDomain={colorDomain} />;
  }

  return shell(
    <>
      {metricSwitch}
      <div className="lab-trend-chart" data-lab-trend-chart={options.chart === 'bar' ? 'bar' : 'line'} data-lab-trend-series={drawn.join(',')}>
        {chart}
      </div>
    </>,
    { 'data-state': 'ok' },
  );
}
