import { useMemo } from 'react';
import { useI18n } from '../../context/I18nContext';
import { ChartEmpty, type ChartBodyProps } from './chartBody';
import {
  Axis, ChartFrame, Crosshair, EndLabelMarks, Grid, HitArea, bandScale, cartesianLayout, chartFit, colorScale,
  compactEndLabels, formatValue, keyGrain, linearScale, timeTickFormatter, useChartHover, useChartSize, useSeriesToggle,
  type AxisTick, type CartesianLayout, type ChartFormat, type EndLabelItem, type EndLabels, type LegendItem,
  type LegendPosition, type Measure, type Rect, type TooltipRow,
} from './chart';
import {
  NO_AXIS, axesShown, compactPlot, edgePadding, entityDomain, lastPoint, pointXTicks, seriesLabel, valueTicks, xDomainOf,
  xPositionsOf, xTitle, type AxesMode, type ChartSeries, type XDomain,
} from './LineChart';

/**
 * `stacked`: composition over time (which series make up the total, and how
 * that mix moves), on the shared chart foundation. Two shapes: `bar` (one
 * stacked column per bucket, segments split by a 2px surface gap, the top one
 * rounded) and `area` (stacked bands). `normalized` data (frameOps already
 * turned each bucket into shares of 100) pins the axis to 0-100%.
 *
 * Same x domain and hover contract as LineChart: the pointer snaps to the
 * nearest bucket and the tooltip reads out EVERY visible layer there, in the
 * legend's fixed order, with the bucket's total in the footer.
 */

export const STACK_MODES = ['bar', 'area'] as const;
export type StackMode = (typeof STACK_MODES)[number];
export function toStackMode(v: unknown): StackMode {
  return (STACK_MODES as readonly unknown[]).includes(v) ? (v as StackMode) : 'bar';
}

/** The surface gap between stacked segments (dataviz: separation by white, never by a stroke). */
const SEGMENT_GAP = 2;
/** Radius of a column's data end (the top segment only; the baseline end stays square). */
const DATA_END_RADIUS = 4;
/** Stacked columns are thin marks (dataviz: bars <= 24px), wider than a plain bar never. */
const MAX_COLUMN = 24;

/** A value a stack can draw: a stack has no meaning below zero, so a negative part draws as nothing. */
const stackable = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);

export interface StackedColumn {
  key: string;
  /** Each visible series' [low, high] cumulative span, in series order. */
  spans: { name: string; lo: number; hi: number; value: number | null }[];
  total: number;
}

/** The stack per x key over the VISIBLE series (series order = bottom to top). Pure. */
export function stackColumns(visible: readonly ChartSeries[], keys: readonly string[]): StackedColumn[] {
  const lookup = visible.map((s) => new Map(s.points.map((p) => [p.t, p.v] as [string, number])));
  return keys.map((key) => {
    let acc = 0;
    const spans = visible.map((s, i) => {
      const raw = lookup[i].get(key);
      const lo = acc;
      acc += stackable(raw);
      return { name: s.name, lo, hi: acc, value: typeof raw === 'number' && Number.isFinite(raw) ? raw : null };
    });
    return { key, spans, total: acc };
  });
}

/**
 * The readout for one bucket: a row per visible series (value as sent, "-"
 * when it has none there), and the bucket total for the footer.
 */
export function stackedTooltip(
  column: StackedColumn,
  opts: { color(name: string): string; label(name: string): string; format: ChartFormat; unit: string | null; locale?: string },
): { rows: TooltipRow[]; total: string } {
  // Shares read to one decimal (46.7%): a second one is noise at a glance.
  const fmt = { format: opts.format, unit: opts.unit, locale: opts.locale, ...(opts.unit?.trim() === '%' ? { maxDecimals: 1 } : {}) };
  const rows = column.spans.map((s) => ({
    id: s.name,
    label: opts.label(s.name),
    value: s.value === null ? '-' : formatValue(s.value, fmt),
    color: opts.color(s.name),
    shape: 'rect' as const,
    dim: s.value === null,
  }));
  return { rows, total: formatValue(column.total, fmt) };
}

export interface StackedGeometry {
  layout: CartesianLayout;
  plot: Rect;
  /** Hover positions: bucket centres (bar) or key x (area). */
  xs: number[];
  /** Value -> plot-local y. */
  yOf(v: number): number;
  baseline: number;
  columns: StackedColumn[];
  /** bar mode: one path per non-empty segment. */
  segments: { key: string; index: number; name: string; color: string; d: string }[];
  /** area mode: one band per visible series. */
  bands: { name: string; color: string; d: string; top: string }[];
  bandwidth: number;
  /** Compact mode: the direct end labels (null otherwise). */
  ends: EndLabels | null;
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** A column segment from y0 (bottom, px) up to y1 (top, px); `round` gives it a 4px rounded data end. */
function segmentPath(x: number, w: number, y0: number, y1: number, round: boolean): string {
  const h = y0 - y1;
  if (!round || h <= 0) return `M${n1(x)},${n1(y0)}V${n1(y1)}H${n1(x + w)}V${n1(y0)}Z`;
  const r = Math.min(DATA_END_RADIUS, w / 2, h);
  return `M${n1(x)},${n1(y0)}V${n1(y1 + r)}Q${n1(x)},${n1(y1)} ${n1(x + r)},${n1(y1)}H${n1(x + w - r)}Q${n1(x + w)},${n1(y1)} ${n1(x + w)},${n1(y1 + r)}V${n1(y0)}Z`;
}

/** Bucket-centred x ticks for columns: dates in the calendar's short form, other keys as they are. */
function bandXTicks(domain: XDomain, centers: readonly number[], locale?: string): AxisTick[] {
  if (!domain.isTime) return domain.keys.map((k, i) => ({ pos: centers[i], label: k }));
  const f = timeTickFormatter(keyGrain(domain.keys), locale);
  return domain.times.map((t, i) => ({ pos: centers[i], label: f(t, i, domain.times), value: t }));
}

/** All hover-independent geometry for one measured size. Pure. */
export function stackedGeometry(input: {
  visible: readonly ChartSeries[];
  domain: XDomain;
  mode: StackMode;
  normalized: boolean;
  width: number;
  height: number;
  fontPx: number;
  measure: Measure;
  color(name: string): string;
  showX: boolean;
  showY: boolean;
  format: ChartFormat;
  unit: string | null;
  locale?: string;
  /** Compact (fit.ts): the stack fills the frame (no axes, no grid) beside direct end labels from `endItems`. */
  compact?: boolean;
  endItems?: readonly EndLabelItem[];
}): StackedGeometry | null {
  const { domain, fontPx, mode } = input;
  if (domain.keys.length === 0 || input.width <= 0 || input.height <= 0) return null;
  const columns = stackColumns(input.visible, domain.keys);
  const totals = columns.map((c) => c.total);
  const fmt = { zero: true, format: input.format, unit: input.unit, locale: input.locale, fixed: input.normalized ? [0, 100] as [number, number] : undefined };
  const band = (w: number) => bandScale(domain.keys.length, [0, w], { maxBandwidth: MAX_COLUMN });
  let ends: EndLabels | null = null;
  const layout: CartesianLayout = input.compact ? (() => {
    ends = compactEndLabels(input.endItems ?? [], { width: input.width, height: input.height, fontPx, measure: input.measure });
    return { plot: compactPlot(input.width, input.height, ends), x: NO_AXIS, y: NO_AXIS };
  })() : cartesianLayout({
    width: input.width,
    height: input.height,
    fontPx,
    measure: input.measure,
    showX: input.showX,
    showY: input.showY,
    xLabelMode: domain.isTime ? 'thin' : 'rotate',
    padding: edgePadding(input.showX, input.showY, fontPx),
    yTicks: (h) => valueTicks(totals, h, fontPx, fmt).ticks,
    xTicks: (w) => {
      if (mode === 'area') return pointXTicks(domain, w, 0, fontPx, input.locale);
      const b = band(w);
      return bandXTicks(domain, domain.keys.map((_, i) => b.center(i)), input.locale);
    },
  });
  const { plot } = layout;
  // Compact: the stack spends the frame's few pixels on its own range (from zero; shares 0-100).
  const y = input.compact
    ? linearScale(fmt.fixed ?? totals, { range: [plot.height, 0], nice: false, zero: true })
    : valueTicks(totals, plot.height, fontPx, fmt).y;
  const baseline = Math.min(plot.height, Math.max(0, y(0)));
  const segments: StackedGeometry['segments'] = [];
  const bands: StackedGeometry['bands'] = [];
  let xs: number[];
  let bandwidth = 0;
  if (mode === 'bar') {
    const b = band(plot.width);
    bandwidth = b.bandwidth;
    xs = domain.keys.map((_, i) => b.center(i));
    columns.forEach((col, ci) => {
      const drawn = col.spans.filter((s) => s.hi > s.lo);
      drawn.forEach((s, k) => {
        const y0 = plot.top + y(s.lo);
        // Every segment above the first gives up the surface gap at its foot (when it has room to).
        const foot = k > 0 && y0 - (plot.top + y(s.hi)) > SEGMENT_GAP * 2 ? SEGMENT_GAP : 0;
        segments.push({
          key: col.key,
          index: ci,
          name: s.name,
          color: input.color(s.name),
          d: segmentPath(plot.left + b.start(ci), b.bandwidth, y0 - foot, plot.top + y(s.hi), k === drawn.length - 1),
        });
      });
    });
  } else {
    xs = xPositionsOf(domain, plot.width, 0);
    input.visible.forEach((s, si) => {
      const upper = columns.map((c, i) => `${n1(plot.left + xs[i])},${n1(plot.top + y(c.spans[si].hi))}`);
      const lower = columns.map((c, i) => `${n1(plot.left + xs[i])},${n1(plot.top + y(c.spans[si].lo))}`).reverse();
      bands.push({
        name: s.name,
        color: input.color(s.name),
        d: `M${upper.join('L')}L${lower.join('L')}Z`,
        top: `M${upper.join('L')}`,
      });
    });
  }
  return { layout, plot, xs, yOf: y, baseline, columns, segments, bands, bandwidth, ends };
}

/** Registry body (`stacked`). A host with a definite box passes `height`: the chart fills it. */
export function StackedBody({ summary, series, full = false, emptyHint, height }: ChartBodyProps) {
  return <StackedChart series={series} unit={summary.unit} full={full} emptyHint={emptyHint} fill={height !== undefined} />;
}

/** The stacked drawing. `colorIndex` is the palette slot (1-8) the bottom layer takes. */
export function StackedChart({
  series, unit, full = false, emptyHint, colorIndex = 1, colorDomain = null, height: heightProp, fill = false, mode = 'bar', normalized = false,
  legend = 'bottom', axes = 'both', grid = true, format = 'auto', ariaLabel,
}: {
  series: ChartSeries[];
  unit: string | null;
  full?: boolean;
  emptyHint?: string;
  colorIndex?: number;
  /** Every series name before any pick or filter (BlockProps.colorDomain.series): colours key on it. */
  colorDomain?: readonly string[] | null;
  /** A fixed pixel height; omitted = the legacy card (150) or panel (280) height, unless `fill`. */
  height?: number;
  /** Fill the parent's box (blocks): no fixed height at all. */
  fill?: boolean;
  mode?: StackMode;
  /** The data is already shares of 100 (frameOps `normalize`): pin the axis to 0-100%. */
  normalized?: boolean;
  legend?: LegendPosition;
  axes?: AxesMode;
  grid?: boolean;
  format?: ChartFormat;
  ariaLabel?: string;
}) {
  const { t, locale } = useI18n();
  const size = useChartSize();
  // The whole frame (legend included) decides what yields as the cell shrinks (chart/fit.ts).
  const frame = useChartSize();
  const colors = useMemo(
    () => colorScale(entityDomain(colorDomain, series.map((s) => s.name)), {
      start: colorIndex, other: series.filter((s) => typeof s.other === 'number').map((s) => s.name),
    }),
    [series, colorDomain, colorIndex],
  );
  const names = useMemo(() => series.map((s) => s.name), [series]);
  const toggle = useSeriesToggle(names);
  const visible = useMemo(() => series.filter((s) => !toggle.hidden.has(s.name)), [series, toggle.hidden]);
  const domain = useMemo(() => xDomainOf(series), [series]);
  const { showX, showY } = axesShown(axes);
  // Shares read as shares: 25%, never 0.25 or 2,500%.
  const shareUnit = normalized ? '%' : unit;
  const shareFormat: ChartFormat = normalized ? 'number' : format;
  const byName = new Map(series.map((s) => [s.name, s] as [string, ChartSeries]));
  const label = (name: string) => {
    const s = byName.get(name);
    return s ? seriesLabel(s, t) : name;
  };
  const legendItems: LegendItem[] = series.map((s) => ({ id: s.name, label: label(s.name), color: colors.color(s.name), shape: 'rect' as const }));
  const fit = chartFit({
    width: frame.width, height: frame.height, fontPx: frame.fontPx, measure: frame.measure,
    legend, labels: series.length > 1 ? legendItems.map((it) => it.label) : [],
  });
  const compact = fit.size === 'compact';
  // Compact: each visible layer's latest value, named when there is more than one layer (a unit other than % stays in the title).
  const endItems = useMemo<EndLabelItem[]>(() => (compact ? visible.flatMap((s) => {
    const last = lastPoint(s, domain);
    return last ? [{
      id: s.name, color: colors.color(s.name), shape: 'rect' as const, name: series.length > 1 ? seriesLabel(s, t) : '',
      value: formatValue(last.v, { format: shareFormat, unit: shareUnit?.trim() === '%' ? shareUnit : null, locale, ...(normalized ? { maxDecimals: 1 } : {}) }),
    }] : [];
  }) : []), [compact, visible, domain, colors, series.length, t, shareFormat, shareUnit, locale, normalized]);

  const geo = useMemo(() => (size.ready ? stackedGeometry({
    visible, domain, mode, normalized, width: size.width, height: size.height, fontPx: size.fontPx, measure: size.measure,
    color: colors.color, showX, showY, format: shareFormat, unit: shareUnit, locale, compact, endItems,
  }) : null), [size.ready, size.width, size.height, size.fontPx, size.measure, visible, domain, mode, normalized, colors, showX, showY, shareFormat, shareUnit, locale, compact, endItems]);

  const hover = useChartHover({ positions: geo?.xs ?? [], plotWidth: geo?.plot.width ?? 0, plotHeight: geo?.plot.height ?? 0 });
  const hi = hover.index;

  if (domain.keys.length === 0) return <ChartEmpty hint={emptyHint} />;

  const column = geo && hi !== null ? geo.columns[hi] ?? null : null;
  const readout = column ? stackedTooltip(column, { color: colors.color, label, format: shareFormat, unit: shareUnit, locale }) : null;
  const tooltip = geo && hi !== null && column && readout ? {
    anchor: {
      x: geo.plot.left + geo.xs[hi] + (mode === 'bar' ? geo.bandwidth / 2 : 0),
      y: hover.pointer ? geo.plot.top + hover.pointer.y : geo.plot.top + geo.plot.height / 2,
    },
    title: xTitle(domain, hi, locale),
    rows: readout.rows,
    footer: visible.length > 1 ? (
      <span data-total="">
        <span className="lab-chart-tooltip-value">{readout.total}</span> {t('lab.chart.total')}
      </span>
    ) : undefined,
  } : null;
  const chart = (
    <ChartFrame
      plotRef={size.ref}
      frameRef={frame.ref}
      fit={fit}
      data-chart="stacked"
      data-mode={mode}
      data-normalized={normalized ? 'true' : 'false'}
      data-hover-index={hi ?? ''}
      legend={series.length > 1 ? { position: legend, items: legendItems, hidden: toggle.hidden, onToggle: toggle.toggle } : null}
      tooltip={tooltip}
    >
      {geo && (
        <svg
          className="lab-chart-svg"
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="img"
          aria-label={ariaLabel ?? t('lab.chart.stacked')}
          {...hover.focusProps}
        >
          {grid && !compact && <Grid plot={geo.plot} y={geo.layout.y.ticks} dpr={size.dpr} />}
          {showY && !compact && <Axis orientation="y" axis={geo.layout.y} plot={geo.plot} dpr={size.dpr} />}
          {geo.bands.map((b) => (
            <g key={b.name} data-series={b.name} pointerEvents="none">
              <path data-band="" d={b.d} fill={b.color} fillOpacity={0.35} stroke="none" />
              <path d={b.top} fill="none" stroke={b.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {geo.segments.map((s) => (
            <path
              key={`${s.key}-${s.name}`}
              data-segment=""
              data-series={s.name}
              d={s.d}
              fill={s.color}
              // The hovered bucket stays full strength; the rest step back so it reads as picked.
              opacity={hi === null || hi === s.index ? 1 : 0.45}
              pointerEvents="none"
            />
          ))}
          {!compact && <Axis orientation="x" axis={geo.layout.x} plot={geo.plot} baseline={showX ? geo.baseline : null} dpr={size.dpr} />}
          {hi !== null && mode === 'area' && <Crosshair plot={geo.plot} x={geo.xs[hi]} dpr={size.dpr} />}
          {hi !== null && mode === 'area' && column && column.spans.map((s) => (s.hi > s.lo ? (
            <circle
              key={`h-${s.name}`}
              data-hover-point=""
              cx={geo.plot.left + geo.xs[hi]}
              cy={geo.plot.top + geo.yOf(s.hi)}
              r={compact ? 3 : 4}
              fill={colors.color(s.name)}
              stroke="var(--viz-surface)"
              strokeWidth={compact ? 1 : 2}
              pointerEvents="none"
            />
          ) : null))}
          {geo.ends && <EndLabelMarks labels={geo.ends} />}
          <HitArea plot={geo.plot} {...hover.hitProps} />
        </svg>
      )}
    </ChartFrame>
  );
  if (fill) return chart;
  return <div style={{ height: heightProp ?? (full ? 280 : 150), minWidth: 0 }}>{chart}</div>;
}
