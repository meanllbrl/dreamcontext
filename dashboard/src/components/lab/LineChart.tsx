import { useMemo } from 'react';
import type { Series } from '../../hooks/useLab';
import { useI18n } from '../../context/I18nContext';
import { ChartEmpty, type ChartBodyProps } from './chartBody';
import {
  Axis, ChartFrame, Crosshair, Grid, HitArea, cartesianLayout, colorScale, formatTimeKey, formatValue, keyGrain,
  linearScale, allTimeKeys, parseTimeKey, pointPositions, tickCountFor, tickFormatter, timeScale, timeTickFormatter,
  timeTicks, useChartHover, useChartSize, useSeriesToggle,
  type AxisTick, type CartesianLayout, type ChartFormat, type LegendItem, type LegendPosition, type Measure, type Rect,
  type TooltipRow, type TooltipSpec,
} from './chart';

/**
 * The lab line chart, on the shared chart foundation (chart/): it fills the
 * box it is given (never scrolls), draws a calendar x axis and a nice-tick y
 * axis in real pixels, and maps the pointer through the plot's rendered box
 * to the NEAREST x, so the crosshair and the tooltip land on the datum under
 * the pointer at any width and zoom. The tooltip lists every visible series at
 * that x in the legend's fixed order; the legend toggles series without ever
 * repainting the others (colours are assigned over every series first).
 *
 * The x-domain and curve helpers are exported for StackedChart and the tests.
 */

/** A series as the lab charts take it; `other` marks the folded "Other" series (how many it holds). */
export type ChartSeries = Series & { other?: number };

export const LINE_CURVES = ['linear', 'smooth', 'step'] as const;
export type LineCurve = (typeof LINE_CURVES)[number];
export const POINT_MODES = ['auto', 'always', 'never'] as const;
export type PointMode = (typeof POINT_MODES)[number];
export const AXES_MODES = ['both', 'x', 'y', 'none'] as const;
export type AxesMode = (typeof AXES_MODES)[number];

export function toLineCurve(v: unknown): LineCurve {
  return (LINE_CURVES as readonly unknown[]).includes(v) ? (v as LineCurve) : 'linear';
}
export function toPointMode(v: unknown): PointMode {
  return (POINT_MODES as readonly unknown[]).includes(v) ? (v as PointMode) : 'auto';
}
export function toAxesMode(v: unknown): AxesMode {
  return (AXES_MODES as readonly unknown[]).includes(v) ? (v as AxesMode) : 'both';
}
/** Which axes an `axes` option draws. */
export function axesShown(axes: AxesMode): { showX: boolean; showY: boolean } {
  return { showX: axes === 'both' || axes === 'x', showY: axes === 'both' || axes === 'y' };
}

// ─── The shared x domain (line + stacked) ───────────────────────────────────

export interface XDomain {
  /** Every x key, chronological for time keys, first-seen order otherwise (a ranked list stays ranked). */
  keys: string[];
  /** True when every key is a time and there are at least two of them. */
  isTime: boolean;
  /** Epoch ms per key (time domains only). */
  times: number[];
}

export function xDomainOf(series: readonly Series[]): XDomain {
  const seen = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.t))));
  // One instant has no time span to lay out: it sits in the middle like a category.
  if (seen.length < 2 || !allTimeKeys(seen)) return { keys: seen, isTime: false, times: [] };
  const keys = seen.sort((a, b) => (parseTimeKey(a) as number) - (parseTimeKey(b) as number));
  return { keys, isTime: true, times: keys.map((k) => parseTimeKey(k) as number) };
}

/** Plot-local x of every key: a time scale for dates, evenly spaced points for categories. */
export function xPositionsOf(domain: XDomain, width: number, inset: number): number[] {
  if (!domain.isTime) return pointPositions(domain.keys.length, [0, width], inset);
  const ts = timeScale([domain.times[0], domain.times[domain.times.length - 1]], [0, width]);
  return domain.times.map((t) => ts(t));
}

/** X ticks for a line-shaped (point) x axis: calendar-aligned for dates, one per key otherwise. */
export function pointXTicks(domain: XDomain, width: number, inset: number, fontPx: number, locale?: string): AxisTick[] {
  if (!domain.isTime) {
    const ps = pointPositions(domain.keys.length, [0, width], inset);
    return domain.keys.map((k, i) => ({ pos: ps[i], label: k }));
  }
  const { times } = domain;
  const ts = timeScale([times[0], times[times.length - 1]], [0, width]);
  const maxCount = Math.max(2, Math.floor(width / (fontPx * 6)));
  const tt = timeTicks(times[0], times[times.length - 1], maxCount, keyGrain(domain.keys));
  const f = timeTickFormatter(tt.unit, locale);
  return tt.ticks.map((t, i) => ({ pos: ts(t), label: f(t, i, tt.ticks), value: t }));
}

/**
 * Room a hidden axis would otherwise have given: the edge tick label (drawn
 * centred on the plot's bottom line) and the edge markers (r 4 + a 2px ring)
 * must not be cut by the cell when there is no axis band to sit in.
 */
export function edgePadding(showX: boolean, showY: boolean, fontPx: number): { bottom: number; left: number } {
  return { bottom: showX ? 2 : Math.ceil(fontPx / 2) + 2, left: showY ? 0 : 6 };
}

/** The tooltip title for key `i`: a full date for time keys, the key itself otherwise. */
export function xTitle(domain: XDomain, i: number, locale?: string): string {
  const key = domain.keys[i] ?? '';
  return domain.isTime ? formatTimeKey(key, domain.times[i], locale) : key;
}

/**
 * The entity list a colour scale is built over: the block's unfiltered
 * `colorDomain` (BlockProps.colorDomain, from the raw frame) first, then any
 * drawn name it lacks, in drawn order. Without a domain the drawn names are
 * the domain (legacy callers, whose series are never pre-filtered).
 */
export function entityDomain(domain: readonly string[] | null | undefined, names: readonly string[]): string[] {
  if (!domain || domain.length === 0) return [...names];
  const seen = new Set(domain);
  return [...domain, ...names.filter((n) => !seen.has(n))];
}

/** The label a series shows: its name, or the localized "Other (n)" for a folded series. */
export function seriesLabel(s: ChartSeries, t: (key: string) => string): string {
  if (typeof s.other !== 'number') return s.name;
  return s.other > 0 ? t('lab.blocks.otherCount').replace('{n}', String(s.other)) : t('lab.blocks.other');
}

/** Y ticks for a linear value scale, formatted with one shared precision. */
export function valueTicks(
  values: readonly number[], h: number, fontPx: number,
  opts: { zero: boolean; format: ChartFormat; unit: string | null; locale?: string; fixed?: [number, number] },
): { y: ReturnType<typeof linearScale>; ticks: AxisTick[] } {
  const base = opts.fixed ? [...opts.fixed] : values.length ? values : [0];
  const y = linearScale(base, { range: [h, 0], tickCount: tickCountFor(h, fontPx * 3), zero: opts.zero });
  // A % unit is part of the figure (a share axis reads 0% / 50% / 100%); other units stay in the title.
  const f = tickFormatter(y.ticks, y.step, { format: opts.format, unit: opts.unit, locale: opts.locale }, opts.unit?.trim() === '%');
  return { y, ticks: y.ticks.map((v) => ({ pos: y(v), label: f(v), value: v })) };
}

// ─── Curves ─────────────────────────────────────────────────────────────────

type Pt = readonly [number, number];
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * The SVG path through `pts` (already in px, x ascending):
 *   linear  straight segments (M / L),
 *   smooth  a monotone cubic (C): it never overshoots a datum, so a smooth line
 *           never invents a peak or a dip the data does not have,
 *   step    a step-after (H / V): the value holds until the next key.
 */
export function curvePath(pts: readonly Pt[], curve: LineCurve): string {
  if (pts.length === 0) return '';
  const head = `M${n1(pts[0][0])},${n1(pts[0][1])}`;
  if (pts.length === 1) return head;
  if (curve === 'step') {
    return head + pts.slice(1).map(([x, y]) => `H${n1(x)}V${n1(y)}`).join('');
  }
  if (curve === 'smooth' && pts.length > 2) return head + monotoneSegments(pts);
  return head + pts.slice(1).map(([x, y]) => `L${n1(x)},${n1(y)}`).join('');
}

/** Fritsch-Carlson monotone cubic tangents (d3's monotoneX), as C segments. */
function monotoneSegments(pts: readonly Pt[]): string {
  const n = pts.length;
  const h: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(pts[i + 1][0] - pts[i][0] || 1e-9);
    s.push((pts[i + 1][1] - pts[i][1]) / h[i]);
  }
  const m: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const p = (s[i - 1] * h[i] + s[i] * h[i - 1]) / (h[i - 1] + h[i]);
    m[i] = (Math.sign(s[i - 1]) + Math.sign(s[i])) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), 0.5 * Math.abs(p)) || 0;
  }
  m[0] = (3 * s[0] - m[1]) / 2;
  m[n - 1] = (3 * s[n - 2] - m[n - 2]) / 2;
  let out = '';
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const d = h[i] / 3;
    out += `C${n1(x0 + d)},${n1(y0 + d * m[i])},${n1(x1 - d)},${n1(y1 - d * m[i + 1])},${n1(x1)},${n1(y1)}`;
  }
  return out;
}

/** The area under a curve: the curve, then down to `base` and back to the first x. */
export function areaPath(pts: readonly Pt[], curve: LineCurve, base: number): string {
  if (pts.length < 2) return '';
  const first = pts[0];
  const last = pts[pts.length - 1];
  return `${curvePath(pts, curve)}L${n1(last[0])},${n1(base)}L${n1(first[0])},${n1(base)}Z`;
}

// ─── Tooltip ────────────────────────────────────────────────────────────────

/**
 * The crosshair readout at x key `key`: one row per VISIBLE series in their
 * fixed (legend) order, value formatted; a series with no point there is a
 * dimmed "-" row, so the rows never reshuffle as the pointer moves.
 */
export function lineTooltipRows(
  visible: readonly ChartSeries[],
  key: string,
  opts: { color(name: string): string; label(s: ChartSeries): string; format: ChartFormat; unit: string | null; locale?: string },
): TooltipRow[] {
  return visible.map((s) => {
    const p = s.points.find((q) => q.t === key);
    return {
      id: s.name,
      label: visible.length > 1 ? opts.label(s) : '',
      value: p ? formatValue(p.v, { format: opts.format, unit: opts.unit, locale: opts.locale }) : '-',
      color: opts.color(s.name),
      shape: 'line' as const,
      dim: !p,
    };
  });
}

// ─── The chart ──────────────────────────────────────────────────────────────

interface Props {
  series: ChartSeries[];
  unit?: string | null;
  /** A fixed pixel height (legacy cards and panels); omitted = fill the parent's box (blocks). */
  height?: number;
  emptyHint?: string;
  /** Fill the area under each line with a translucent wash of its hue (block `area`). */
  area?: boolean;
  /** 1-based palette slot the first series starts at (block `color`, 1-8). */
  colorIndex?: number;
  /** Series names kept, in this order; unknown names are skipped (block `series`). */
  seriesFilter?: readonly string[] | null;
  /** Every series name before any pick or filter (BlockProps.colorDomain.series): colours key on it. */
  colorDomain?: readonly string[] | null;
  curve?: LineCurve;
  /** Static point markers: auto = only when the points are far enough apart to read. */
  points?: PointMode;
  /** `zero` pins the y axis at 0; `auto` fits the data. */
  yMin?: 'auto' | 'zero';
  /** A dashed reference line at this value, labelled directly. */
  reference?: number | null;
  referenceLabel?: string | null;
  legend?: LegendPosition;
  axes?: AxesMode;
  grid?: boolean;
  format?: ChartFormat;
  ariaLabel?: string;
}

/** The series a `seriesFilter` keeps, in the filter's order. Empty filter = all. */
export function pickSeries<S extends Series>(series: S[], names: readonly string[] | null | undefined): S[] {
  if (!names || names.length === 0) return series;
  const byName = new Map(series.map((s) => [s.name, s] as [string, S]));
  return names.map((n) => byName.get(n)).filter((s): s is S => s !== undefined);
}

/** Palette colour for series `i` when the scale starts at slot `colorIndex` (1-based). */
export function seriesColor(i: number, colorIndex = 1): string {
  return colorScale(Array.from({ length: i + 1 }, (_, k) => String(k)), { start: colorIndex }).color(String(i));
}

/** Points are drawn in `auto` mode when neighbours sit at least this many tick-font heights apart. */
const AUTO_POINT_SPACING = 2.5;

export interface LineGeometry {
  layout: CartesianLayout;
  plot: Rect;
  xs: number[];
  yOf(v: number): number;
  baseline: number;
  showPoints: boolean;
  lines: { name: string; color: string; d: string; area: string; dots: { x: number; y: number }[] }[];
  reference: { y: number; label: string } | null;
}

/** All of the chart's hover-independent geometry for one measured size. Pure. */
export function lineGeometry(input: {
  visible: readonly ChartSeries[];
  domain: XDomain;
  width: number;
  height: number;
  fontPx: number;
  measure: Measure;
  color(name: string): string;
  curve: LineCurve;
  points: PointMode;
  area: boolean;
  zero: boolean;
  reference: number | null;
  referenceLabel: string | null;
  showX: boolean;
  showY: boolean;
  format: ChartFormat;
  unit: string | null;
  locale?: string;
}): LineGeometry | null {
  const { visible, domain, fontPx } = input;
  if (domain.keys.length === 0 || input.width <= 0 || input.height <= 0) return null;
  const values = visible.flatMap((s) => s.points.map((p) => p.v));
  if (input.reference !== null) values.push(input.reference);
  const fmt = { zero: input.zero, format: input.format, unit: input.unit, locale: input.locale };
  const inset = domain.isTime ? 0 : Math.min(24, fontPx);
  const layout = cartesianLayout({
    width: input.width,
    height: input.height,
    fontPx,
    measure: input.measure,
    showX: input.showX,
    showY: input.showY,
    xLabelMode: domain.isTime ? 'thin' : 'rotate',
    padding: edgePadding(input.showX, input.showY, fontPx),
    yTicks: (h) => valueTicks(values, h, fontPx, fmt).ticks,
    xTicks: (w) => pointXTicks(domain, w, inset, fontPx, input.locale),
  });
  const { plot } = layout;
  const { y } = valueTicks(values, plot.height, fontPx, fmt);
  const xs = xPositionsOf(domain, plot.width, inset);
  const indexOf = new Map(domain.keys.map((k, i) => [k, i] as [string, number]));
  const baseline = Math.min(plot.height, Math.max(0, y(0)));
  const spacing = xs.length > 1 ? plot.width / (xs.length - 1) : Infinity;
  const showPoints = input.points === 'always' || (input.points === 'auto' && spacing >= fontPx * AUTO_POINT_SPACING);
  const lines = visible.map((s) => {
    const pts = s.points
      .filter((p) => indexOf.has(p.t) && Number.isFinite(p.v))
      .map((p) => [plot.left + xs[indexOf.get(p.t) as number], plot.top + y(p.v)] as const)
      .sort((a, b) => a[0] - b[0]);
    return {
      name: s.name,
      color: input.color(s.name),
      d: curvePath(pts, input.curve),
      area: input.area ? areaPath(pts, input.curve, plot.top + baseline) : '',
      // A one-point series has no line to draw: its marker is the whole mark.
      dots: showPoints || pts.length === 1 ? pts.map(([x, py]) => ({ x, y: py })) : [],
    };
  });
  let reference: LineGeometry['reference'] = null;
  if (input.reference !== null) {
    const value = formatValue(input.reference, { format: input.format, unit: input.unit, locale: input.locale });
    reference = { y: y(input.reference), label: input.referenceLabel ? `${input.referenceLabel} ${value}` : value };
  }
  return { layout, plot, xs, yOf: y, baseline, showPoints, lines, reference };
}

export function LineChart({
  series: allSeries, unit = null, height, emptyHint, area = false, colorIndex = 1, seriesFilter = null, colorDomain = null,
  curve = 'linear', points = 'auto', yMin = 'auto', reference = null, referenceLabel = null, legend = 'bottom',
  axes = 'both', grid = true, format = 'auto', ariaLabel,
}: Props) {
  const { t, locale } = useI18n();
  const size = useChartSize();
  const series = useMemo(() => pickSeries(allSeries, seriesFilter), [allSeries, seriesFilter]);
  // Colours follow the entity over EVERY series (the raw frame's, before a block pick or filter,
  // then before this chart's pick and the legend hide any), so none of them repaints a survivor.
  const colors = useMemo(
    () => colorScale(entityDomain(colorDomain, allSeries.map((s) => s.name)), {
      start: colorIndex, other: allSeries.filter((s) => typeof s.other === 'number').map((s) => s.name),
    }),
    [allSeries, colorDomain, colorIndex],
  );
  const names = useMemo(() => series.map((s) => s.name), [series]);
  const toggle = useSeriesToggle(names);
  const visible = useMemo(() => series.filter((s) => !toggle.hidden.has(s.name)), [series, toggle.hidden]);
  const domain = useMemo(() => xDomainOf(series), [series]);
  const { showX, showY } = axesShown(axes);
  const ref = typeof reference === 'number' && Number.isFinite(reference) ? reference : null;

  const geo = useMemo(() => (size.ready ? lineGeometry({
    visible, domain, width: size.width, height: size.height, fontPx: size.fontPx, measure: size.measure,
    color: colors.color, curve, points, area, zero: yMin === 'zero', reference: ref, referenceLabel,
    showX, showY, format, unit, locale,
  }) : null), [size.ready, size.width, size.height, size.fontPx, size.measure, visible, domain, colors, curve, points, area, yMin, ref, referenceLabel, showX, showY, format, unit, locale]);

  const hover = useChartHover({ positions: geo?.xs ?? [], plotWidth: geo?.plot.width ?? 0, plotHeight: geo?.plot.height ?? 0 });
  const hi = hover.index;

  if (series.every((s) => s.points.length === 0)) return <ChartEmpty hint={emptyHint} />;

  const label = (s: ChartSeries) => seriesLabel(s, t);
  const hoverKey = hi !== null ? domain.keys[hi] ?? null : null;
  const hoverDots = geo && hoverKey !== null
    ? visible.flatMap((s) => {
      const p = s.points.find((q) => q.t === hoverKey);
      return p && Number.isFinite(p.v) ? [{ name: s.name, color: colors.color(s.name), y: geo.plot.top + geo.yOf(p.v) }] : [];
    })
    : [];
  let tooltip: TooltipSpec | null = null;
  if (geo && hi !== null && hoverKey !== null) {
    // Keyboard focus has no pointer: point at the highest hovered datum instead.
    const top = hoverDots.length ? Math.min(...hoverDots.map((d) => d.y)) - geo.plot.top : geo.plot.height / 2;
    tooltip = {
      anchor: { x: geo.plot.left + geo.xs[hi], y: geo.plot.top + (hover.pointer?.y ?? top) },
      title: xTitle(domain, hi, locale),
      rows: lineTooltipRows(visible, hoverKey, { color: colors.color, label, format, unit, locale }),
    };
  }
  const legendItems: LegendItem[] = series.map((s) => ({ id: s.name, label: label(s), color: colors.color(s.name), shape: 'line' as const }));

  const chart = (
    <ChartFrame
      plotRef={size.ref}
      data-chart="line"
      data-curve={curve}
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
          aria-label={ariaLabel ?? t('lab.chart.line')}
          {...hover.focusProps}
        >
          {grid && <Grid plot={geo.plot} y={geo.layout.y.ticks} dpr={size.dpr} />}
          {showY && <Axis orientation="y" axis={geo.layout.y} plot={geo.plot} dpr={size.dpr} />}
          <Axis orientation="x" axis={geo.layout.x} plot={geo.plot} baseline={showX ? geo.baseline : null} dpr={size.dpr} />
          {geo.reference && (
            <ReferenceMark plot={geo.plot} y={geo.reference.y} label={geo.reference.label} fontPx={size.fontPx} />
          )}
          {geo.lines.map((l) => (l.area ? (
            <path key={`a-${l.name}`} data-area="" d={l.area} fill={l.color} fillOpacity={0.1} stroke="none" pointerEvents="none" />
          ) : null))}
          {geo.lines.map((l) => (
            <path
              key={l.name}
              d={l.d}
              fill="none"
              stroke={l.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              data-series={l.name}
              pointerEvents="none"
            />
          ))}
          {geo.lines.map((l) => l.dots.map((d) => (
            <circle
              key={`p-${l.name}-${d.x}`}
              data-point=""
              cx={d.x}
              cy={d.y}
              r={4}
              fill={l.color}
              stroke="var(--viz-surface)"
              strokeWidth={2}
              pointerEvents="none"
            />
          )))}
          {hi !== null && <Crosshair plot={geo.plot} x={geo.xs[hi]} dpr={size.dpr} />}
          {hi !== null && hoverDots.map((d) => (
            <circle
              key={`h-${d.name}`}
              data-hover-point=""
              cx={geo.plot.left + geo.xs[hi]}
              cy={d.y}
              r={4.5}
              fill={d.color}
              stroke="var(--viz-surface)"
              strokeWidth={2}
              pointerEvents="none"
            />
          ))}
          <HitArea plot={geo.plot} {...hover.hitProps} />
        </svg>
      )}
    </ChartFrame>
  );
  // A fixed height (legacy card / panel) gets its own box; a block's cell is the box otherwise.
  return height !== undefined ? <div style={{ height, minWidth: 0 }}>{chart}</div> : chart;
}

/**
 * A reference value: a dashed, recessive hairline across the plot (dashed so
 * it never reads as a gridline) with its label written directly on it, above
 * the line, or below when the line hugs the plot's top edge.
 */
function ReferenceMark({ plot, y, label, fontPx }: { plot: Rect; y: number; label: string; fontPx: number }) {
  const py = plot.top + y;
  const below = y < fontPx + 4;
  return (
    <g data-reference="" aria-hidden="true" pointerEvents="none">
      <line
        x1={plot.left}
        x2={plot.left + plot.width}
        y1={py}
        y2={py}
        stroke="var(--viz-crosshair)"
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      <text
        className="lab-chart-tick"
        x={plot.left + plot.width - 2}
        y={below ? py + 4 : py - 4}
        dy={below ? '0.71em' : undefined}
        textAnchor="end"
        paintOrder="stroke"
        stroke="var(--viz-surface)"
        strokeWidth={3}
        strokeLinejoin="round"
      >
        {label}
      </text>
    </g>
  );
}

/**
 * Registry body (`line`). A host with a definite box (a board cell) passes its
 * `height`: the chart fills that box. Otherwise the panel's canvas is taller
 * and the card is a thumbnail.
 */
export function LineBody({ summary, series, full = false, emptyHint, height }: ChartBodyProps) {
  return <LineChart series={series} unit={summary.unit} height={height !== undefined ? undefined : full ? 340 : 200} emptyHint={emptyHint} />;
}
