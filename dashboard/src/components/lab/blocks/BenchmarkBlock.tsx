import { useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent } from 'react';
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

/**
 * Natural heights (px, benchmark.css) the fit plans with, all on the 4px grid.
 * A row is separated from the next by whitespace (`rowGap`, no hairline): its
 * primary line (the metric name and the current value, 20px), the quiet
 * secondary run (change, previous, trend; 16px), the ruler band (16px, plus
 * 16px for the bound labels under it) and the tertiary sources line (16px),
 * each `gap` apart. The legend is one tertiary line with 8px under it.
 */
export const BENCH_PX = { primary: 20, line: 16, gap: 4, rowGap: 12, legend: 24, note: 20 } as const;
/** The row gaps a tier may use, roomiest first: the fit tightens the air before it drops a row. */
export const BENCH_ROW_GAPS = [12, 8, 4] as const;
/** Below this width a one-line row leaves the ruler too short: the ruler takes its own line. */
export const BENCH_NARROW_PX = 380;

export interface BenchmarkFit {
  /** full = the ruler on its own line under the figures; compact = one line with the ruler inline. */
  mode: 'full' | 'compact';
  /** Bound labels ("Floor 20%") under the ruler. */
  labels: boolean;
  /** The sources line under each row. */
  sources: boolean;
  /** The floor / target / now / previous key above the rows. */
  legend: boolean;
  /** Whitespace between two rows (px): 12, tightened to 8 then 4 only to keep every row. */
  rowGap: number;
  count: number;
}

type FitTier = Omit<BenchmarkFit, 'count'>;

/** The px one row takes in a mode, with its bound labels and (when any row has one) its sources line. */
export function benchRowPx(mode: 'full' | 'compact', labels: boolean, sources: boolean): number {
  const { primary, line, gap } = BENCH_PX;
  const ruler = line + (labels ? line : 0);
  // Full: the primary line, the secondary run, then the ruler on its own line. Compact: one line, the ruler inline.
  const body = mode === 'full' ? primary + gap + line + gap + ruler : Math.max(primary, ruler);
  return body + (sources ? gap + line : 0);
}

const tier = (mode: 'full' | 'compact', labels: boolean, sources: boolean, legend: boolean, rowGap: number = BENCH_PX.rowGap): FitTier => ({
  mode, labels, sources, legend, rowGap,
});

/**
 * What the block draws in a cell `height` x `width` px (0 = not measured yet:
 * everything). The first tier whose rows all fit wins: full rows with labels,
 * sources and the legend; one-line rows keeping labels and sources; then
 * labels only; then neither; then no legend; then the same one-line rows with
 * 8px and 4px between them; then as many one-line rows as fit plus a "+N more"
 * line. Air goes before rows; a narrow block keeps the ruler on its own line
 * while that fits. `sources` = any row has a source to print. Never scrolls.
 */
export function benchmarkFit(
  rowCount: number,
  height: number,
  noteLines: number,
  sources: boolean,
  width = 0,
  unmeasured: readonly number[] = [],
  skip = 0,
): BenchmarkFit {
  if (!(height > 0) || rowCount === 0) return { ...tier('full', true, sources, true), count: rowCount };
  const avail = height - noteLines * BENCH_PX.note;
  // An unmeasured row wraps its reason: beside the label on a one-line row, under it on a full row.
  const wrapPx = (mode: 'full' | 'compact', n: number) => unmeasured.slice(0, n).reduce((px, chars) => px + BENCH_PX.line
    * (mode === 'full' ? reasonLines(chars, width) : reasonLines(chars, width * 0.6) - 1), 0);
  const need = (t: FitTier, n: number) => n * benchRowPx(t.mode, t.labels, t.sources) + Math.max(0, n - 1) * t.rowGap
    + wrapPx(t.mode, n) + (t.legend ? BENCH_PX.legend : 0);
  const narrow = width > 0 && width < BENCH_NARROW_PX;
  const tight = BENCH_ROW_GAPS.slice(1).map((g) => tier('compact', false, false, false, g));
  const tiers: FitTier[] = narrow
    ? [tier('full', true, sources, true), tier('full', true, false, true), tier('full', false, false, true), tier('full', false, false, false), tier('compact', false, false, false), ...tight]
    : [tier('full', true, sources, true), tier('compact', true, sources, true), tier('compact', true, false, true), tier('compact', false, false, true), tier('compact', false, false, false), ...tight];
  // `skip`: tiers the rendered block already proved too tall (the estimate was short), never tried again.
  for (const t of tiers.slice(Math.min(skip, tiers.length))) if (need(t, rowCount) <= avail) return { ...t, count: rowCount };
  const last = tier('compact', false, false, false, BENCH_ROW_GAPS[BENCH_ROW_GAPS.length - 1]);
  let count = rowCount - Math.max(0, skip - tiers.length);
  while (count > 1 && need(last, count) + BENCH_PX.note > avail) count--;
  return { ...last, count: Math.max(1, count) };
}

/** Lines an unmeasured row's "Not measured: reason" wraps to at `width` px (at most 3; the title has the rest). */
export function reasonLines(chars: number, width: number): number {
  if (!(width > 0)) return 1;
  return Math.min(3, Math.max(1, Math.ceil((chars * 6.5) / width)));
}

/** The card-level inherited note: only when EVERY banded row inherits the set's band. */
export function allRowsInherit(rows: readonly Pick<BenchmarkRow, 'floor' | 'target' | 'inherited'>[]): boolean {
  const banded = rows.filter((r) => r.floor !== null || r.target !== null);
  return banded.length > 0 && banded.every((r) => r.inherited);
}

/** Lines a note takes at `width` px (about 6.5px a character at the 12px size); 1 before the block is measured. */
export function noteLines(text: string, width: number): number {
  if (!(width > 0)) return 1;
  return Math.max(1, Math.ceil((text.length * 6.5) / width));
}

/** A measured cells-mode selection: its steps are a sum of cells, so it carries no rates by design. */
export function cellsNoRates(frame: FunnelFrame, slice: FunnelSlice): boolean {
  return frame.segmentMode !== 'lookup' && slice.measured && Object.keys(slice.selection).length > 0;
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
  const root = useRef<HTMLDivElement | null>(null);
  const [shrink, setShrink] = useState<{ key: string; skip: number }>({ key: '', skip: 0 });
  const ref = (el: HTMLDivElement | null) => { root.current = el; measure(el); };
  const pendingKey = useRef('');
  useLayoutEffect(() => {
    const el = root.current;
    const key = pendingKey.current;
    if (!el || !key || !(box.height > 0)) return;
    if (el.scrollHeight > el.clientHeight + 1) {
      setShrink((prev) => {
        const skip = prev.key === key ? prev.skip + 1 : 1;
        return skip > 12 ? prev : { key, skip };
      });
    }
  });
  pendingKey.current = '';
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
  const inherited = allRowsInherit(rows);
  const anySource = sources && rows.some((r) => r.floorSource || r.targetSource || r.inherited);
  const inheritedText = t('lab.blocks.benchmark.inherited');
  const lines = notes.reduce((n, x) => n + noteLines(x.text, box.width), 0) + (inherited ? noteLines(inheritedText, box.width) : 0);
  const unmeasuredChars = rows.filter((r) => r.current === null).map((r) => notMeasuredText(t, r.reason).length);
  // The estimate plans the tier; the rendered block has the last word: if it still overflows, step down a tier.
  const fitKey = `${box.width}x${box.height}|${rows.map((r) => r.key).join(',')}|${lines}|${comparePrev}|${sources}`;
  const skip = shrink.key === fitKey ? shrink.skip : 0;
  const fit = benchmarkFit(rows.length, box.height, lines, anySource, box.width, unmeasuredChars, skip);
  const shown = rows.slice(0, Math.max(1, fit.count));
  const more = rows.length - shown.length;
  pendingKey.current = fitKey;

  // Cells mode sums step users for a selection; rates cannot be summed, so a selection has none by design.
  if (cellsNoRates(f, slice)) {
    return (
      <div ref={ref} className="lab-bench" data-lab-benchmark="" data-measured="true">
        {notes.map((n) => <div key={n.key} className="lab-bench-note" {...{ [n.attr]: '' }}>{n.text}</div>)}
        <div className="lab-bench-note" data-lab-bench-cells-no-rates="" role="note">{t('lab.blocks.benchmark.cellsNoRates')}</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div ref={ref} className="lab-bench" data-lab-benchmark="">
        {notes.map((n) => <div key={n.key} className="lab-bench-note" {...{ [n.attr]: '' }}>{n.text}</div>)}
        <BlockEmpty message={slice.measured ? undefined : notMeasuredText(t, slice.reason)} />
      </div>
    );
  }

  const anyRuler = shown.some((r) => r.current !== null);
  return (
    <div
      ref={ref}
      className="lab-bench"
      data-lab-benchmark=""
      data-mode={fit.mode}
      data-labels={fit.labels ? '' : undefined}
      data-sources={fit.sources ? '' : undefined}
      data-row-gap={fit.rowGap}
      data-measured={slice.measured ? 'true' : 'false'}
    >
      {notes.map((n) => <div key={n.key} className="lab-bench-note" {...{ [n.attr]: '' }}>{n.text}</div>)}
      {fit.legend && anyRuler && <BenchLegend t={t} comparePrev={comparePrev} />}
      <ul className="lab-bench-rows">
        {shown.map((row) => (
          <BenchRowView key={row.key} row={row} labels={fit.labels} showSources={fit.sources} comparePrev={comparePrev} sources={sources} t={t} locale={locale} />
        ))}
      </ul>
      {more > 0 && <div className="lab-bench-more">{t('lab.blocks.benchmark.more').replace('{n}', String(more))}</div>}
      {inherited && <div className="lab-bench-note lab-bench-inherited" data-lab-bench-inherited="">{inheritedText}</div>}
    </div>
  );
}

/** The ruler's key: the same marks the ruler draws, each named. */
function BenchLegend({ t, comparePrev }: { t: Translate; comparePrev: boolean }) {
  const items: { key: string; label: string }[] = [
    { key: 'floor', label: t('lab.blocks.benchmark.floor') },
    { key: 'target', label: t('lab.blocks.benchmark.target') },
    { key: 'current', label: t('lab.blocks.benchmark.current') },
    ...(comparePrev ? [{ key: 'prev', label: t('lab.blocks.benchmark.prev') }] : []),
  ];
  return (
    <div className="lab-bench-legend" data-lab-bench-legend="">
      {items.map((it) => (
        <span key={it.key} className="lab-bench-key" data-key={it.key}>
          <span className={`lab-bench-key-mark lab-bench-key-mark--${it.key}`} aria-hidden="true" />
          {it.label}
        </span>
      ))}
    </div>
  );
}

const TREND_GLYPH = { up: '▲', down: '▼', flat: '▬' } as const;

function BenchRowView({ row, labels, showSources, comparePrev, sources, t, locale }: {
  row: BenchmarkRow;
  labels: boolean;
  showSources: boolean;
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
  const signed = showDelta ? formatMetric(row.delta as number, row.format, locale, true) : '';
  const sourceLine = sources && showSources && (sourceParts.length > 0 || row.inherited);
  const mark = row.inherited ? (
    <span
      className="lab-bench-inherit"
      data-inherited=""
      title={t('lab.blocks.benchmark.inheritedTitle')}
      aria-label={t('lab.blocks.benchmark.inheritedTitle')}
    >
      {t('lab.blocks.benchmark.inheritedMark')}
    </span>
  ) : null;

  return (
    <li
      className="lab-bench-row"
      data-lab-bench-row={row.key}
      data-status={row.status}
      data-trend={showDelta ? row.trend ?? undefined : undefined}
      data-better={row.better}
      title={measured ? undefined : notMeasuredText(t, row.reason)}
    >
      <span className="lab-bench-label" title={row.label}>{row.label}</span>
      {measured ? (
        <>
          {/* Primary: the current value. Secondary: one quiet run for the change, the previous window and the trend. */}
          <span className="lab-bench-value" data-lab-bench-value="">{fmt(row.current as number)}</span>
          {showDelta && (
            <span className="lab-bench-delta" data-lab-bench-delta="" title={t('lab.blocks.benchmark.delta').replace('{delta}', signed)}>
              <span className="lab-bench-change" data-trend={row.trend ?? undefined}>
                <span aria-hidden="true">{glyph}</span> <span className="lab-bench-delta-text">{signed}</span>
              </span>
              {row.prev !== null && (
                <span className="lab-bench-prev-value" data-lab-bench-prev-value="">
                  {t('lab.blocks.benchmark.prev')} {fmt(row.prev)}
                </span>
              )}
              <span className="lab-bench-trend" data-trend={row.trend ?? undefined}>
                <span className="lab-bench-trend-word">{t(`lab.blocks.benchmark.${row.trend}`)}</span>
              </span>
            </span>
          )}
          {(statusWord || (mark && !sourceLine)) && (
            <span className="lab-bench-side">
              {!sourceLine && mark}
              {statusWord && (
                <span className="lab-bench-status" data-tone={row.status} data-lab-bench-status="" title={statusWord}>
                  <span className="lab-bench-status-word">{statusWord}</span>
                  {/* One-line rows share their line with the ruler: they print the short word. */}
                  <span className="lab-bench-status-short" aria-hidden="true">
                    {row.status === 'no-band' ? statusWord : t(`lab.blocks.benchmark.statusShort.${row.status}`)}
                  </span>
                </span>
              )}
            </span>
          )}
          <BenchRuler row={row} comparePrev={comparePrev} labels={labels} fmt={fmt} t={t} />
          {sourceLine && (
            <span className="lab-bench-sources-line">
              {sourceParts.length > 0 && <span className="lab-bench-sources" data-lab-bench-source="">{sourceParts.join(' · ')}</span>}
              {mark}
            </span>
          )}
        </>
      ) : (
        <span className="lab-bench-unmeasured" data-lab-bench-unmeasured="">{notMeasuredText(t, row.reason)}</span>
      )}
    </li>
  );
}

/**
 * The bound labels under the ruler ("Floor 20%", "Target 30%"), each at its
 * tick: with two bounds the left label ends at its tick and the right one
 * starts at it, so they never overlap; all kept inside the ruler. When the
 * worded labels do not fit side by side they fall back to the bare numbers,
 * and to nothing when even those do not (the tooltip still names them).
 */
export function boundLabels(
  bounds: readonly { key: 'floor' | 'target'; x: number; word: string; value: string }[],
  width: number,
  measure: Measure,
): { key: 'floor' | 'target'; left: number; text: string }[] {
  const sorted = [...bounds].sort((a, b) => a.x - b.x);
  const place = (texts: string[]) => {
    const out = sorted.map((b, i) => {
      const w = measure(texts[i]);
      let left = sorted.length === 2 ? (i === 0 ? b.x - w - 4 : b.x + 4) : b.x - w / 2;
      left = Math.max(0, Math.min(width - w, left));
      return { key: b.key, left, right: left + w, text: texts[i] };
    });
    // Two text runs on one line keep at least 8px of air.
    const clash = out.length === 2 && out[0].right + 8 > out[1].left;
    return clash || out.some((o) => o.right - o.left > width) ? null : out.map(({ key, left, text }) => ({ key, left, text }));
  };
  return place(sorted.map((b) => `${b.word} ${b.value}`)) ?? place(sorted.map((b) => b.value)) ?? [];
}

function BenchRuler({ row, comparePrev, labels, fmt, t }: {
  row: BenchmarkRow;
  comparePrev: boolean;
  labels: boolean;
  fmt: (v: number) => string;
  t: Translate;
}) {
  const size = useChartSize<HTMLDivElement>();
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const scale = rulerScale(row, size.width, comparePrev);
  const zones = scale ? rulerZones(row, scale) : [];
  const x = (v: number | null) => (scale && v !== null ? scale(v) : null);
  const xs = { floor: x(row.floor), target: x(row.target), current: x(row.current), prev: comparePrev ? x(row.prev) : null };
  const words = { floor: t('lab.blocks.benchmark.floor'), target: t('lab.blocks.benchmark.target') };
  const bounds = ([['floor', row.floor], ['target', row.target]] as const)
    .filter(([key, v]) => v !== null && xs[key] !== null)
    .map(([key, v]) => ({ key, x: xs[key] as number, word: words[key], value: fmt(v as number) }));
  const placed = labels && scale ? boundLabels(bounds, size.width, size.measure) : [];

  const rows: TooltipRow[] = [
    { id: 'current', label: t('lab.blocks.benchmark.current'), value: fmt(row.current as number) },
    ...(comparePrev && row.prev !== null ? [{ id: 'prev', label: t('lab.blocks.benchmark.prev'), value: fmt(row.prev) }] : []),
    ...(row.floor !== null ? [{ id: 'floor', label: row.floorSource ? `${words.floor} (${row.floorSource})` : words.floor, value: fmt(row.floor) }] : []),
    ...(row.target !== null ? [{ id: 'target', label: row.targetSource ? `${words.target} (${row.targetSource})` : words.target, value: fmt(row.target) }] : []),
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
      data-labels={labels ? '' : undefined}
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
          {xs.floor !== null && <span className="lab-bench-mark lab-bench-bound lab-bench-bound--floor" data-lab-bench-floor="" data-x={xs.floor.toFixed(2)} style={{ left: `${xs.floor}px` }} aria-hidden="true" />}
          {xs.target !== null && <span className="lab-bench-mark lab-bench-bound lab-bench-bound--target" data-lab-bench-target="" data-x={xs.target.toFixed(2)} style={{ left: `${xs.target}px` }} aria-hidden="true" />}
          {xs.prev !== null && xs.current !== null && (
            <span
              className="lab-bench-link"
              aria-hidden="true"
              style={{ left: `${Math.min(xs.prev, xs.current)}px`, width: `${Math.abs(xs.current - xs.prev)}px` }}
            />
          )}
          {xs.prev !== null && <span className="lab-bench-mark lab-bench-prev" data-lab-bench-prev="" data-x={xs.prev.toFixed(2)} style={{ left: `${xs.prev}px` }} aria-hidden="true" />}
          {xs.current !== null && <span className="lab-bench-mark lab-bench-current" data-lab-bench-current="" data-x={xs.current.toFixed(2)} style={{ left: `${xs.current}px` }} aria-hidden="true" />}
          {placed.map((b) => (
            <span key={b.key} className="lab-bench-bound-label" data-bound={b.key} data-lab-bench-bound-label={b.key} style={{ left: `${b.left}px` }} aria-hidden="true">{b.text}</span>
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
