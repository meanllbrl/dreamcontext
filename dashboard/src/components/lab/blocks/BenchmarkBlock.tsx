import { useState, type FocusEvent, type PointerEvent } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { formatNumber, linearScale, Tooltip, useChartSize, type LinearScale, type Measure, type TooltipRow } from '../chart';
import { useMeasured } from '../chartBody';
import {
  benchmarkRows,
  funnelSlice,
  type BenchmarkRow,
  type FunnelFrame,
  type FunnelFrameMetric,
  type FunnelMetricFormat,
  type FunnelSlice,
} from '../../../generated/frameOps';
import { BlockEmpty, boolOption, drawableFrame, stringListOption, stringOption, type BlockViewProps } from './blockCommon';
import './benchmark.css';

type Translate = (key: string) => string;

/** How a funnel metric reads: percent points, dollars, a multiple, seconds or a plain figure. */
export function formatMetric(v: number, format: FunnelMetricFormat, locale?: string, signed = false): string {
  const abs = signed ? Math.abs(v) : v;
  let s: string;
  switch (format) {
    case 'pct': s = `${formatNumber(abs, { format: 'number', maxDecimals: 1, locale })}%`; break;
    case 'usd': s = formatNumber(abs, { format: 'currency', unit: 'USD', locale }); break;
    case 'x': s = `${formatNumber(abs, { format: 'number', maxDecimals: 2, locale })}x`; break;
    case 'seconds': s = `${formatNumber(abs, { format: 'number', maxDecimals: 1, locale })}s`; break;
    case 'count': s = formatNumber(abs, { format: 'auto', maxDecimals: 0, locale }); break;
    default: s = formatNumber(abs, { format: 'auto', locale });
  }
  if (!signed) return s;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}`;
}

/** "Not measured: {reason}", or the sentence without its reason clause when none was given. */
export function notMeasuredText(t: Translate, reason: string | null): string {
  return t('lab.blocks.benchmark.notMeasured').replace('{reason}', reason ?? t('lab.blocks.breakdown.noPath'));
}

type Tone = 'below' | 'between' | 'above';

/** Where `v` sits against the row's band, in goodness terms (`better: 'lower'` flips it); frameOps' bandTone. */
export function toneOf(v: number, row: Pick<BenchmarkRow, 'floor' | 'target' | 'better'>): Tone | null {
  if (row.floor === null && row.target === null) return null;
  const worse = (a: number, b: number) => (row.better === 'lower' ? a > b : a < b);
  if (row.floor !== null && worse(v, row.floor)) return 'below';
  if (row.target !== null && !worse(v, row.target)) return 'above';
  return 'between';
}

/** The px the ruler keeps free at each end, so the current dot never leaves the track. */
export const RULER_INSET = 7;

/**
 * The ruler's scale for a row `width` px wide: floor, target, current (and the
 * previous window when compared) on one linear axis, padded so no marker sits
 * on an edge. Null for an unmeasured row or before the ruler is measured.
 */
export function rulerScale(row: BenchmarkRow, width: number, comparePrev: boolean): LinearScale | null {
  if (row.current === null || !(width > RULER_INSET * 2)) return null;
  const values = [row.floor, row.target, row.current, comparePrev ? row.prev : null].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const pad = span > 0 ? span * 0.12 : Math.abs(hi) * 0.1 || 1;
  // A non-negative metric never shows a negative stretch of ruler.
  const d0 = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
  return linearScale([d0, hi + pad], { range: [RULER_INSET, width - RULER_INSET], nice: false, tickCount: 2 });
}

/** The band's zones along the scale's domain, each with the tone its midpoint takes. */
export function rulerZones(row: BenchmarkRow, scale: LinearScale): { tone: Tone; x0: number; x1: number }[] {
  const [d0, d1] = scale.domain;
  const cuts = [row.floor, row.target]
    .filter((v): v is number => v !== null && v > d0 && v < d1)
    .sort((a, b) => a - b);
  const edges = [d0, ...cuts, d1];
  const out: { tone: Tone; x0: number; x1: number }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const tone = toneOf((edges[i] + edges[i + 1]) / 2, row);
    if (tone === null) return [];
    out.push({ tone, x0: scale(edges[i]), x1: scale(edges[i + 1]) });
  }
  return out;
}

/** Natural row heights (px, benchmark.css) the fit plans with. */
const FULL_ROW_PX = 102;
const SOURCE_LINE_PX = 18;
const COMPACT_ROW_PX = 30;
const ROW_GAP_PX = 8;
const NOTE_PX = 20;

/**
 * What the block draws in a cell `height` px tall (0 = not measured yet: full
 * rows): full rows when they all fit, else one-line compact rows, else as many
 * compact rows as fit plus a "+N more" line. The block never scrolls.
 */
export function benchmarkFit(rowCount: number, height: number, notes: number, sources: boolean): { mode: 'full' | 'compact'; count: number } {
  if (!(height > 0) || rowCount === 0) return { mode: 'full', count: rowCount };
  const avail = height - notes * NOTE_PX;
  const need = (row: number, n: number) => n * row + Math.max(0, n - 1) * ROW_GAP_PX;
  if (need(FULL_ROW_PX + (sources ? SOURCE_LINE_PX : 0), rowCount) <= avail) return { mode: 'full', count: rowCount };
  if (need(COMPACT_ROW_PX, rowCount) <= avail) return { mode: 'compact', count: rowCount };
  let count = rowCount;
  while (count > 1 && need(COMPACT_ROW_PX, count) + ROW_GAP_PX + NOTE_PX > avail) count--;
  return { mode: 'compact', count };
}

/** The metric keys a benchmark reads: the option's, else the picked funnel's own (so an unmeasured slice still lists them). */
function metricKeysFor(frame: FunnelFrame, slice: FunnelSlice, picked: string[] | null): { keys: string[]; unknown: string[]; levels: Record<string, FunnelFrameMetric> } {
  const levels = frame.funnels.find((f) => f.id === slice.funnelId)?.metrics ?? {};
  if (!picked) return { keys: Object.keys(levels).length > 0 ? Object.keys(levels) : Object.keys(slice.metrics), unknown: [], levels };
  const known = (k: string) => k in levels || k in slice.metrics;
  return { keys: picked.filter(known), unknown: picked.filter((k) => !known(k)), levels };
}

/**
 * `benchmark`: each metric of the current slice on one ruler, floor and target
 * drawn as ticks over the band's tinted zones, the current value as a dot at
 * its scale position and (`comparePrev`) the previous window as a ghost, with
 * the change and a status word (`better: 'lower'` flips it). `sources` prints
 * where each bound came from. An unmeasured metric reads "Not measured:
 * reason" and draws no marker at all; not measured is never zero.
 */
export function BenchmarkBlock({ frame, options, selection }: BlockViewProps) {
  const { t, locale } = useI18n();
  const [measure, box] = useMeasured<HTMLDivElement>();
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const f = drawable.frame;
  if (f.funnels.length === 0) return <BlockEmpty />;
  const pick = stringOption(options, 'funnel');
  const comparePrev = boolOption(options, 'comparePrev', true);
  const sources = boolOption(options, 'sources', true);
  const slice = funnelSlice(f, pick, selection ?? {});
  const { keys, unknown, levels } = metricKeysFor(f, slice, stringListOption(options, 'metrics'));
  const rows = benchmarkRows(slice, keys).map((r) => (r.label === r.key && levels[r.key]?.label
    ? { ...r, label: levels[r.key].label as string, format: r.current === null ? levels[r.key].format : r.format }
    : r));

  const notes: { key: string; text: string; attr: string }[] = [];
  if (pick && slice.funnelId !== pick) {
    notes.push({ key: 'funnel', attr: 'data-lab-unknown-funnel', text: t('lab.blocks.explorer.unknownFunnel').replace('{id}', pick).replace('{name}', slice.funnelName) });
  }
  if (unknown.length > 0) notes.push({ key: 'metrics', attr: 'data-lab-unknown-metrics', text: t('lab.blocks.explorer.unknownMetrics').replace('{keys}', unknown.join(', ')) });
  if (slice.ignored.length > 0) notes.push({ key: 'split', attr: 'data-lab-not-split', text: t('lab.blocks.explorer.notSplit').replace('{dims}', slice.ignored.join(', ')) });
  if (slice.measured && slice.lowSample) {
    notes.push({ key: 'low', attr: 'data-lab-low-sample', text: t('lab.blocks.explorer.lowSample').replace('{n}', formatNumber(slice.users, { maxDecimals: 0, locale })) });
  }
  const inherited = rows.some((r) => r.inherited);
  const anySource = sources && rows.some((r) => r.floorSource || r.targetSource);
  const fit = benchmarkFit(rows.length, box.height, notes.length + (inherited ? 1 : 0), anySource);
  const shown = rows.slice(0, Math.max(1, fit.count));
  const more = rows.length - shown.length;

  if (rows.length === 0) {
    return (
      <div ref={measure} className="lab-bench" data-lab-benchmark="">
        {notes.map((n) => <div key={n.key} className="lab-bench-note" {...{ [n.attr]: '' }}>{n.text}</div>)}
        <BlockEmpty message={slice.measured ? undefined : notMeasuredText(t, slice.reason)} />
      </div>
    );
  }

  return (
    <div ref={measure} className="lab-bench" data-lab-benchmark="" data-mode={fit.mode} data-measured={slice.measured ? 'true' : 'false'}>
      {notes.map((n) => <div key={n.key} className="lab-bench-note" {...{ [n.attr]: '' }}>{n.text}</div>)}
      <ul className="lab-bench-rows">
        {shown.map((row) => (
          <BenchRowView key={row.key} row={row} mode={fit.mode} comparePrev={comparePrev} sources={sources} t={t} locale={locale} />
        ))}
      </ul>
      {more > 0 && <div className="lab-bench-more">{t('lab.blocks.benchmark.more').replace('{n}', String(more))}</div>}
      {inherited && <div className="lab-bench-note lab-bench-inherited" data-lab-bench-inherited="">{t('lab.blocks.benchmark.inherited')}</div>}
    </div>
  );
}

const TREND_GLYPH = { up: '▲', down: '▼', flat: '▬' } as const;

function BenchRowView({ row, mode, comparePrev, sources, t, locale }: {
  row: BenchmarkRow;
  mode: 'full' | 'compact';
  comparePrev: boolean;
  sources: boolean;
  t: Translate;
  locale: string;
}) {
  const fmt = (v: number) => formatMetric(v, row.format, locale);
  const measured = row.current !== null;
  const statusWord = row.status === 'no-band'
    ? t('lab.blocks.benchmark.noBand')
    : row.status === 'unmeasured' ? '' : t(`lab.blocks.benchmark.status.${row.status}`);
  const sourceParts = [
    row.floorSource ? t('lab.blocks.benchmark.source').replace('{bound}', t('lab.blocks.benchmark.floor')).replace('{source}', row.floorSource) : null,
    row.targetSource ? t('lab.blocks.benchmark.source').replace('{bound}', t('lab.blocks.benchmark.target')).replace('{source}', row.targetSource) : null,
  ].filter((s): s is string => s !== null);
  const showDelta = comparePrev && row.delta !== null && row.trend !== null;
  const glyph = row.delta === null ? null : row.delta > 0 ? TREND_GLYPH.up : row.delta < 0 ? TREND_GLYPH.down : TREND_GLYPH.flat;

  return (
    <li
      className="lab-bench-row"
      data-lab-bench-row={row.key}
      data-status={row.status}
      data-trend={showDelta ? row.trend ?? undefined : undefined}
      data-better={row.better}
    >
      <span className="lab-bench-label">{row.label}</span>
      {measured ? (
        <>
          {statusWord && (
            <span className="lab-bench-status" data-tone={row.status} data-lab-bench-status="" title={mode === 'compact' ? statusWord : undefined}>
              <span className="lab-bench-status-dot" aria-hidden="true" />
              <span className="lab-bench-status-word">{statusWord}</span>
            </span>
          )}
          <span className="lab-bench-figures">
            <span className="lab-bench-value" data-lab-bench-value="">{fmt(row.current as number)}</span>
            {showDelta && (
              <span className="lab-bench-delta" data-lab-bench-delta="">
                <span className="lab-bench-delta-text">
                  {t('lab.blocks.benchmark.delta').replace('{delta}', formatMetric(row.delta as number, row.format, locale, true))}
                </span>
                <span className="lab-bench-trend" data-trend={row.trend ?? undefined}>
                  <span aria-hidden="true">{glyph}</span> {t(`lab.blocks.benchmark.${row.trend}`)}
                </span>
              </span>
            )}
          </span>
          <BenchRuler row={row} comparePrev={comparePrev} compact={mode === 'compact'} fmt={fmt} t={t} />
          {sources && mode === 'full' && sourceParts.length > 0 && (
            <span className="lab-bench-sources" data-lab-bench-source="">{sourceParts.join(' · ')}</span>
          )}
        </>
      ) : (
        <span className="lab-bench-unmeasured" data-lab-bench-unmeasured="">{notMeasuredText(t, row.reason)}</span>
      )}
    </li>
  );
}

/** A bound's value label beside its tick: pushed apart from the other bound, kept inside the ruler. */
function boundLabels(xs: { key: 'floor' | 'target'; x: number; text: string }[], width: number, measure: Measure): Record<string, { left: number }> {
  const out: Record<string, { left: number }> = {};
  const sorted = [...xs].sort((a, b) => a.x - b.x);
  sorted.forEach((b, i) => {
    const w = measure(b.text);
    // Two bounds: the left one's label ends at its tick, the right one's starts at it.
    let left = sorted.length === 2 ? (i === 0 ? b.x - w - 3 : b.x + 3) : b.x - w / 2;
    left = Math.max(0, Math.min(width - w, left));
    out[b.key] = { left };
  });
  return out;
}

function BenchRuler({ row, comparePrev, compact, fmt, t }: {
  row: BenchmarkRow;
  comparePrev: boolean;
  compact: boolean;
  fmt: (v: number) => string;
  t: Translate;
}) {
  const size = useChartSize<HTMLDivElement>();
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const scale = rulerScale(row, size.width, comparePrev);
  const zones = scale ? rulerZones(row, scale) : [];
  const x = (v: number | null) => (scale && v !== null ? scale(v) : null);
  const xs = { floor: x(row.floor), target: x(row.target), current: x(row.current), prev: comparePrev ? x(row.prev) : null };
  const bounds = ([['floor', row.floor], ['target', row.target]] as const)
    .filter(([key, v]) => v !== null && xs[key] !== null)
    .map(([key, v]) => ({ key, x: xs[key] as number, text: fmt(v as number) }));
  const labels = !compact && scale ? boundLabels(bounds, size.width, size.measure) : {};

  const rows: TooltipRow[] = [
    { id: 'current', label: t('lab.blocks.benchmark.current'), value: fmt(row.current as number) },
    ...(comparePrev && row.prev !== null ? [{ id: 'prev', label: t('lab.blocks.benchmark.prev'), value: fmt(row.prev) }] : []),
    ...(row.floor !== null ? [{ id: 'floor', label: row.floorSource ? `${t('lab.blocks.benchmark.floor')} (${row.floorSource})` : t('lab.blocks.benchmark.floor'), value: fmt(row.floor) }] : []),
    ...(row.target !== null ? [{ id: 'target', label: row.targetSource ? `${t('lab.blocks.benchmark.target')} (${row.targetSource})` : t('lab.blocks.benchmark.target'), value: fmt(row.target) }] : []),
  ];
  const show = (e: PointerEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ x: r.left + (xs.current ?? r.width / 2), y: r.top });
  };

  return (
    <div
      ref={size.ref}
      className="lab-bench-ruler"
      data-lab-bench-ruler=""
      tabIndex={0}
      aria-label={rows.map((r) => `${r.label} ${r.value}`).join(', ')}
      onPointerEnter={show}
      onPointerLeave={() => setTip(null)}
      onFocus={show}
      onBlur={() => setTip(null)}
    >
      <div className="lab-bench-track" aria-hidden="true">
        {zones.map((z, i) => (
          <span key={i} className="lab-bench-zone" data-tone={z.tone} style={{ left: `${z.x0}px`, width: `${Math.max(0, z.x1 - z.x0)}px` }} />
        ))}
      </div>
      {scale && (
        <>
          {xs.floor !== null && <span className="lab-bench-mark lab-bench-bound" data-lab-bench-floor="" data-x={xs.floor.toFixed(2)} style={{ left: `${xs.floor}px` }} aria-hidden="true" />}
          {xs.target !== null && <span className="lab-bench-mark lab-bench-bound" data-lab-bench-target="" data-x={xs.target.toFixed(2)} style={{ left: `${xs.target}px` }} aria-hidden="true" />}
          {xs.prev !== null && xs.current !== null && (
            <span
              className="lab-bench-link"
              aria-hidden="true"
              style={{ left: `${Math.min(xs.prev, xs.current)}px`, width: `${Math.abs(xs.current - xs.prev)}px` }}
            />
          )}
          {xs.prev !== null && <span className="lab-bench-mark lab-bench-prev" data-lab-bench-prev="" data-x={xs.prev.toFixed(2)} style={{ left: `${xs.prev}px` }} aria-hidden="true" />}
          {xs.current !== null && <span className="lab-bench-mark lab-bench-current" data-lab-bench-current="" data-x={xs.current.toFixed(2)} style={{ left: `${xs.current}px` }} aria-hidden="true" />}
          {bounds.map((b) => labels[b.key] && (
            <span key={b.key} className="lab-bench-bound-label" data-bound={b.key} style={{ left: `${labels[b.key].left}px` }} aria-hidden="true">{b.text}</span>
          ))}
        </>
      )}
      {tip && (
        <Tooltip
          floating
          anchor={tip}
          bounds={{ width: typeof window !== 'undefined' ? window.innerWidth : 0, height: typeof window !== 'undefined' ? window.innerHeight : 0 }}
          title={row.label}
          rows={rows}
        />
      )}
    </div>
  );
}
