import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import {
  dailySeries, funnelSlice, selectionKey,
  type FunnelFrame, type FunnelMetricFormat, type FunnelSlice, type SeriesFrame, type TableFrame, type TableRow,
} from '../../../generated/frameOps';
import { fill, fmtCount, fmtMetric, hintLine } from '../explorer/explorerFormat';
import { BarBlock } from './BarBlock';
import { LineBlock } from './LineBlock';
import { BlockEmpty, boolOption, drawableFrame, stringListOption, stringOption, type BlockViewProps } from './blockCommon';
import { selectionLabel, unknownFunnelPick, useCompactFit } from './BreakdownBlock';
import './breakdown.css';
import '../explorer/explorer.css';

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
  // The segmented switch until a label would not fit its width, then a select (a name is never truncated).
  const [switchRef, compactSwitch] = useCompactFit<HTMLDivElement>(
    'width',
    `${JSON.stringify(options)}|${selectionKey(selection ?? {})}`,
  );
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
  const noDaily = () => shell(
    <DailyEmpty frame={f} slice={slice} dimOrder={dimOrder} t={t} />,
    { 'data-state': 'no-daily' },
  );
  if (slice.daily.length === 0) return noDaily();

  const { keys, unknown } = pickMetrics(trendKeys(slice), stringListOption(options, 'metrics'));
  if (unknown.length > 0) notes.push({ key: 'metrics', text: t('lab.blocks.explorer.unknownMetrics').replace('{keys}', unknown.join(', ')) });
  if (slice.lowSample) {
    notes.push({ key: 'low', text: t('lab.blocks.explorer.lowSample').replace('{n}', fmtCount(slice.users, locale)) });
  }
  if (keys.length === 0) return noDaily();

  const labelOf = (k: string) => slice.metrics[k]?.label ?? k;
  // Why a metric draws no line: its own not-measured reason, else the days simply do not carry it.
  const reasonOf = (k: string) => slice.metrics[k]?.reason ?? t('lab.blocks.trend.noDaily');
  const whyNot = (k: string) => t('lab.blocks.trend.metricNotMeasured')
    .replace('{metric}', labelOf(k))
    .replace('{reason}', reasonOf(k));
  // The metrics with no daily values, grouped by reason: said ONCE under the switch, never as a
  // row of struck-through chips that leave the reader guessing.
  const silent = keys.filter((k) => !hasTrend(slice, k));
  const silentGroups = new Map<string, string[]>();
  for (const k of silent) silentGroups.set(reasonOf(k), [...(silentGroups.get(reasonOf(k)) ?? []), labelOf(k)]);
  const useSwitch = boolOption(options, 'switch', true) && keys.length > 1;
  const active = useSwitch ? (picked !== null && keys.includes(picked) ? picked : keys[0]) : null;
  const drawn = (active ? [active] : keys).filter((k) => hasTrend(slice, k));
  if (!active) {
    for (const k of keys) if (!hasTrend(slice, k)) notes.push({ key: `m-${k}`, text: whyNot(k) });
  }
  const silentLine = active && silentGroups.size > 0 ? (
    <div className="lab-trend-unmeasured" data-lab-trend-unmeasured={silent.join(',')} role="note">
      {[...silentGroups.entries()].map(([reason, labels]) => (
        <span key={reason} className="lab-trend-unmeasured-group">
          {labels.join(', ')} · {t('lab.explorer.notMeasuredWhy').replace('{reason}', reason)}
        </span>
      ))}
    </div>
  ) : null;

  const onSwitchKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = keys[(keys.indexOf(active) + step + keys.length) % keys.length];
    setPicked(next);
    switchRef.current?.querySelector<HTMLButtonElement>(`[data-lab-trend-metric="${CSS.escape(next)}"]`)?.focus();
  };

  const metricSwitch = useSwitch && compactSwitch ? (
    <select
      className="lab-trend-select"
      aria-label={t('lab.blocks.trend.metric')}
      data-lab-trend-switch=""
      data-compact="true"
      value={active ?? ''}
      onChange={(e) => setPicked(e.target.value)}
    >
      {keys.map((k) => (
        <option key={k} value={k} data-lab-trend-metric={k}>
          {hasTrend(slice, k) ? labelOf(k) : t('lab.blocks.breakdown.optionUnmeasured').replace('{value}', labelOf(k))}
        </option>
      ))}
    </select>
  ) : useSwitch && (
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
          title={hasTrend(slice, k) ? undefined : whyNot(k)}
          onClick={() => setPicked(k)}
        >
          {hasTrend(slice, k) ? labelOf(k) : <><span className="lab-trend-switch-dash" aria-hidden="true">–</span>{labelOf(k)}</>}
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
      {silentLine}
      <div className="lab-trend-chart" data-lab-trend-chart={options.chart === 'bar' ? 'bar' : 'line'} data-lab-trend-series={drawn.join(',')}>
        {chart}
      </div>
      {boolOption(options, 'table') && (
        <DayTable slice={slice} keys={keys.filter((k) => hasTrend(slice, k))} labelOf={labelOf} locale={locale} />
      )}
    </>,
    { 'data-state': 'ok' },
  );
}

/**
 * The empty Daily page, saying what is missing: the funnel level carries days
 * but this path does not ("the snapshot carries daily for the funnel level
 * only"), or the snapshot carries none at all. The snapshot's own hint on how
 * to fill `daily` follows when it has one.
 */
function DailyEmpty({ frame, slice, dimOrder, t }: {
  frame: FunnelFrame;
  slice: FunnelSlice;
  dimOrder: readonly string[];
  t: (key: string) => string;
}) {
  const level = frame.funnels.find((x) => x.id === slice.funnelId);
  const onPath = Object.keys(slice.selection).length > 0 && (level?.daily?.length ?? 0) > 0;
  const text = onPath
    ? fill(t('lab.explorer.emptyDailyPath'), { sel: selectionLabel(slice.selection, dimOrder) ?? '' })
    : t('lab.explorer.emptyDaily');
  const hint = hintLine(t, frame, 'daily');
  return (
    <div className="lab-x-empty" data-lab-empty="daily" data-scope={onPath ? 'path' : 'set'} role="note">
      <span>{text}</span>
      {hint && <span className="lab-x-empty-hint" data-lab-hint="">{hint}</span>}
    </div>
  );
}

/**
 * The day-by-day table under the chart (`table`): one row per day, newest
 * first, one column per metric that has a trend. A missing day value is an
 * empty cell, never a 0.
 */
function DayTable({ slice, keys, labelOf, locale }: {
  slice: FunnelSlice;
  keys: readonly string[];
  labelOf: (k: string) => string;
  locale: string;
}) {
  const { t } = useI18n();
  if (keys.length === 0) return null;
  const days = [...slice.daily].sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
  const formatOf = (k: string): FunnelMetricFormat => slice.metrics[k]?.format ?? 'number';
  return (
    <div className="lab-x-table-wrap lab-trend-table" data-lab-trend-table="">
      <table className="lab-x-table">
        <thead>
          <tr>
            <th scope="col" data-lab-trend-day-header="">{t('lab.explorer.dayHeader')}</th>
            {keys.map((k) => <th key={k} scope="col" className="lab-x-r">{labelOf(k)}</th>)}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.t} data-lab-trend-day={day.t}>
              <td className="lab-x-num">{shortDay(day.t, locale)}</td>
              {keys.map((k) => {
                const v = day.m[k];
                return <td key={k} className="lab-x-r">{finite(v) ? fmtMetric(v, formatOf(k), locale) : ''}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
