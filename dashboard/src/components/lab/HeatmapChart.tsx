import { useMemo } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  ChartFrame, cartesianLayout, divergingColor, divergingScale, formatTimeKey, formatValue, keyGrain, parseTimeKey,
  sequentialColor, sequentialScale, timeTickFormatter, truncateToWidth, useChartSize, useMarkHover, allTimeKeys,
  DIVERGING_STEPS, SEQUENTIAL_STEPS,
  Axis, type AxisTick, type ChartFormat, type Measure, type TooltipSpec, type ValueColorScale,
} from './chart';
import { chartHeight } from './BarList';
import { ChartEmpty, type ChartBodyProps } from './chartBody';
import './lab-bar-pie-heat.css';

/**
 * The heatmap on the chart foundation: a grid of cells whose fill encodes the
 * value on a validated scale, sequential (one hue, more is darker) or
 * diverging (red <- neutral grey midpoint -> blue). Rows and columns are
 * labelled on real axes whose labels never collide; every cell is its own
 * hover/focus target with a row / column / value tooltip; `cellLabels` writes
 * the value inside the cells that have room, in an ink that clears contrast on
 * that fill; a small scale legend reads the extremes.
 *
 * Two data shapes draw it: series (the contributions grid: weeks across,
 * weekdays down, each cell a day's total; weekly/monthly buckets degrade to one
 * strip in time order, no false calendar) and a table (first dim down, second
 * across).
 */

export const HEAT_SCALES = ['sequential', 'diverging'] as const;
export type HeatScale = (typeof HEAT_SCALES)[number];

export function toHeatScale(v: unknown): HeatScale {
  return v === 'diverging' ? 'diverging' : 'sequential';
}

/**
 * Largest a cell grows. Cells grow to fill the card (a 4x4 grid spans a large
 * cell), up to these, so a one-cell grid never becomes one giant slab.
 */
const CELL_MAX_W = 240;
const CELL_MAX_H = 120;
/** Surface between cells. */
const CELL_GAP = 2;
const DAY = 86_400_000;

export interface HeatAxisEntry { key: string; label: string }

export interface HeatCell {
  row: number;
  col: number;
  /** null = a cell in the grid with no value. */
  v: number | null;
  /** Tooltip title and the row's label line. */
  title: string;
  label: string;
}

export interface HeatData {
  rows: HeatAxisEntry[];
  cols: HeatAxisEntry[];
  cells: HeatCell[];
  /** Column labels are dates: thin them rather than rotate. */
  timeCols: boolean;
}

export interface HeatColor {
  color(v: number): string;
  /** The label ink inside that fill (white or ink by the fill's luminance, or the text token). */
  ink(v: number): string;
  /** The legend's swatches, least to most. */
  steps: string[];
  min: number;
  max: number;
  /** The diverging midpoint, when there is one. */
  mid: number | null;
}

/**
 * A custom-hue sequential ramp, least to most: the hue mixed over the surface
 * (16/40/70/100%), then past it toward --lab-heat-far (34/64%). Six steps: the
 * count that keeps every adjacent pair >= 0.06 apart in lightness for all of
 * slots 2-8 in both themes (validate_palette.js --ordinal; lab-bar-pie-heat.css).
 * Each step carries its label ink.
 */
export const HUE_RAMP: readonly { mix: number; toward: 'surface' | 'far'; ink: 'text' | 'hue' | 'far' }[] = [
  { mix: 16, toward: 'surface', ink: 'text' },
  { mix: 40, toward: 'surface', ink: 'text' },
  { mix: 70, toward: 'surface', ink: 'text' },
  { mix: 100, toward: 'surface', ink: 'hue' },
  { mix: 66, toward: 'far', ink: 'far' },
  { mix: 36, toward: 'far', ink: 'far' },
];

/**
 * The colour job for these values. Diverging: the foundation's validated
 * red/grey/blue around `mid` (a value AT the midpoint is the neutral grey).
 * Sequential: slot 1 is the foundation's validated blue ramp (with its inks);
 * the `color` option's other slots take HUE_RAMP over that categorical hue.
 * Magnitudes that are never negative start the ramp at zero, so a small value
 * reads small.
 */
export function heatColor(values: readonly number[], scale: HeatScale, colorIndex = 1, mid = 0): HeatColor {
  const finite = values.filter((v) => Number.isFinite(v));
  const lo = finite.length ? Math.min(...finite) : 0;
  const hi = finite.length ? Math.max(...finite) : 0;
  if (scale === 'diverging') {
    const s: ValueColorScale = divergingScale(lo, hi, mid);
    const steps = Array.from({ length: DIVERGING_STEPS }, (_, i) => divergingColor(-1 + (2 * i) / (DIVERGING_STEPS - 1)));
    // Both arms span the larger distance from the midpoint: the legend's ends read that reach.
    const reach = Math.max(Math.abs(hi - mid), Math.abs(mid - lo));
    return { color: s.color, ink: s.ink, steps, min: mid - reach, max: mid + reach, mid };
  }
  const min = lo >= 0 ? 0 : lo;
  const s = sequentialScale(min, hi);
  const slot = Math.min(8, Math.max(1, Math.round(colorIndex)));
  if (slot === 1) {
    const steps = Array.from({ length: SEQUENTIAL_STEPS }, (_, i) => sequentialColor(i / (SEQUENTIAL_STEPS - 1)));
    return { color: s.color, ink: s.ink, steps, min, max: hi, mid: null };
  }
  const stepOf = (t: number) => HUE_RAMP[Math.round(Math.min(1, Math.max(0, t)) * (HUE_RAMP.length - 1))];
  const fill = (st: (typeof HUE_RAMP)[number]) => (st.mix === 100
    ? `var(--viz-cat-${slot})`
    : `color-mix(in srgb, var(--viz-cat-${slot}) ${st.mix}%, ${st.toward === 'surface' ? 'var(--viz-surface)' : 'var(--lab-heat-far)'})`);
  const inkOf = (st: (typeof HUE_RAMP)[number]) => (st.ink === 'text' ? 'var(--color-text)' : st.ink === 'hue' ? `var(--lab-cat-ink-${slot})` : 'var(--lab-heat-far-ink)');
  return {
    color: (v) => fill(stepOf(s.t(v))),
    ink: (v) => inkOf(stepOf(s.t(v))),
    steps: HUE_RAMP.map(fill),
    min,
    max: hi,
    mid: null,
  };
}

/** A daily key's weekday, Monday first (0 = Monday), in UTC like parseTimeKey. */
function weekdayOf(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

/** Short weekday names, Monday first, in the reader's language. */
export function weekdayNames(locale?: string, style: 'short' | 'long' = 'short'): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' });
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

/** One value per bucket: every series summed, because a cell is a day's total (a per-series grid is `stacked`'s job). */
export function bucketTotals(series: readonly { name: string; points: readonly { t: string; v: number }[] }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of series) {
    for (const p of s.points) if (Number.isFinite(p.v)) totals.set(p.t, (totals.get(p.t) ?? 0) + p.v);
  }
  return totals;
}

/**
 * Series as heat data. Daily buckets: weeks across (each column starts on a
 * Monday, labelled by its date), weekdays down; days outside the synced window
 * get no cell, days inside it without a value read as zero. Any other grain:
 * one strip of buckets in time order.
 */
export function seriesHeatData(
  series: readonly { name: string; points: readonly { t: string; v: number }[] }[], granularity: string | null, locale?: string,
): HeatData | null {
  const totals = bucketTotals(series);
  if (totals.size === 0) return null;
  const keys = [...totals.keys()];
  const timed = allTimeKeys(keys);
  const sorted = timed ? keys.sort((a, b) => (parseTimeKey(a) as number) - (parseTimeKey(b) as number)) : keys;
  if (granularity === 'daily' && timed) {
    const ms = sorted.map((k) => parseTimeKey(k) as number);
    const first = ms[0];
    const last = ms[ms.length - 1];
    const start = first - weekdayOf(first) * DAY;
    const weeks = Math.floor((last - start) / (7 * DAY)) + 1;
    const byDay = new Map(sorted.map((k, i) => [Math.round(ms[i] / DAY), totals.get(k) as number] as [number, number]));
    const names = weekdayNames(locale);
    const long = weekdayNames(locale, 'long');
    const colTicks = Array.from({ length: weeks }, (_, w) => start + w * 7 * DAY);
    const tick = timeTickFormatter('week', locale);
    const cols = colTicks.map((t, i) => ({ key: String(t), label: tick(t, i, colTicks) }));
    const cells: HeatCell[] = [];
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const t = start + (w * 7 + d) * DAY;
        if (t < first || t > last) continue;
        const iso = new Date(t).toISOString().slice(0, 10);
        cells.push({ row: d, col: w, v: byDay.get(Math.round(t / DAY)) ?? 0, title: formatTimeKey(iso, t, locale), label: long[d] });
      }
    }
    return { rows: names.map((n, i) => ({ key: String(i), label: n })), cols, cells, timeCols: true };
  }
  const grain = timed ? keyGrain(sorted) : null;
  const ms = timed ? sorted.map((k) => parseTimeKey(k) as number) : [];
  const tick = grain ? timeTickFormatter(grain, locale) : null;
  const cols = sorted.map((k, i) => ({ key: k, label: tick ? tick(ms[i], i, ms) : k }));
  const cells = sorted.map((k, i) => ({
    row: 0, col: i, v: totals.get(k) as number, title: timed ? formatTimeKey(k, ms[i], locale) : k, label: '',
  }));
  return { rows: [{ key: '', label: '' }], cols, cells, timeCols: timed };
}

/** A table as heat data: first dim down, second across (one dim = one row of cells). Values summed per cell. */
export function tableHeatData(
  dims: readonly { key: string; label: string }[], rows: readonly { d: Record<string, string>; v: number | null }[],
): HeatData | null {
  const rowDim = dims[0]?.key;
  const colDim = dims[1]?.key;
  if (!rowDim || rows.length === 0) return null;
  const distinct = (key: string) => rows.reduce<string[]>((acc, r) => {
    const v = r.d[key];
    if (v !== undefined && !acc.includes(v)) acc.push(v);
    return acc;
  }, []);
  const rowValues = distinct(rowDim);
  const colValues = colDim ? distinct(colDim) : [''];
  const sums = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.v !== 'number' || !Number.isFinite(r.v)) continue;
    const k = `${r.d[rowDim] ?? ''}\u0000${colDim ? r.d[colDim] ?? '' : ''}`;
    sums.set(k, (sums.get(k) ?? 0) + r.v);
  }
  const cells: HeatCell[] = [];
  rowValues.forEach((rv, ri) => colValues.forEach((cv, ci) => {
    const v = sums.get(`${rv}\u0000${cv}`);
    cells.push({ row: ri, col: ci, v: v ?? null, title: cv ? `${rv}, ${cv}` : rv, label: cv ? `${dims[0].label}: ${rv}` : dims[0].label });
  }));
  return {
    rows: rowValues.map((v) => ({ key: v, label: v })),
    cols: colValues.map((v) => ({ key: v, label: v })),
    cells,
    timeCols: false,
  };
}

export interface HeatLayoutInput {
  data: HeatData;
  width: number;
  height: number;
  fontPx: number;
  measure: Measure;
}

/** Pure heat geometry: the axes (collision-free), the cell size, the legend's band. */
export function layoutHeat({ data, width, height, fontPx, measure }: HeatLayoutInput) {
  const nR = Math.max(1, data.rows.length);
  const nC = Math.max(1, data.cols.length);
  const legendBand = Math.ceil(fontPx * 1.25) + 8;
  const cw = (w: number) => Math.min(CELL_MAX_W, w / nC);
  const ch = (h: number) => Math.min(CELL_MAX_H, h / nR);
  const showY = data.rows.some((r) => r.label !== '');
  const rowLabelMax = Math.max(fontPx * 3, width * 0.3);
  const layout = cartesianLayout({
    width, height: Math.max(1, height - legendBand), fontPx, measure, showX: true, showY,
    xLabelMode: data.timeCols ? 'thin' : 'rotate',
    yTicks: (h): AxisTick[] => data.rows.map((r, i) => ({ pos: (i + 0.5) * ch(h), label: truncateToWidth(r.label, rowLabelMax, measure) })),
    xTicks: (w): AxisTick[] => data.cols.map((c, i) => ({ pos: (i + 0.5) * cw(w), label: c.label })),
  });
  const cellW = cw(layout.plot.width);
  const cellH = ch(layout.plot.height);
  // The x labels hang under the grid, not under the plot's empty remainder.
  const gridH = cellH * nR;
  // The scale legend sits right under the column labels (a capped grid leaves room below it), never past the cell.
  const underAxis = layout.plot.top + gridH + layout.x.band + 6;
  return { layout, cellW, cellH, gridW: cellW * nC, gridH, legendBand, legendY: Math.min(height - legendBand + 4, underAxis) };
}

interface HeatGridProps {
  data: HeatData;
  unit: string | null;
  scale?: HeatScale;
  colorIndex?: number;
  cellLabels?: boolean;
  format?: ChartFormat;
  chart: string;
}

function HeatGrid({ data, unit, scale = 'sequential', colorIndex = 1, cellLabels = false, format = 'auto', chart }: HeatGridProps) {
  const { t, locale } = useI18n();
  const size = useChartSize();
  const hover = useMarkHover(size.ref, size.width, size.height);
  const values = useMemo(() => data.cells.map((c) => c.v).filter((v): v is number => v !== null), [data]);
  const colors = useMemo(() => heatColor(values, scale, colorIndex), [values, scale, colorIndex]);
  const geo = useMemo(
    () => (size.ready ? layoutHeat({ data, width: size.width, height: size.height, fontPx: size.fontPx, measure: size.measure }) : null),
    [size.ready, size.width, size.height, size.fontPx, size.measure, data],
  );
  const fmt = { format, unit, locale };
  const active = hover.active !== null ? data.cells[hover.active] ?? null : null;
  const tooltip: TooltipSpec | null = active && hover.anchor ? {
    anchor: hover.anchor,
    title: active.title,
    rows: [{
      id: 'cell',
      label: active.label,
      value: active.v === null ? '-' : formatValue(active.v, fmt),
      color: active.v === null ? undefined : colors.color(active.v),
      shape: 'rect',
      dim: active.v === null,
    }],
  } : null;

  // The x axis sits under the grid (which may be shorter than the plot when cells hit their cap).
  const xAxisPlot = geo ? { ...geo.layout.plot, height: geo.gridH } : null;

  return (
    <ChartFrame plotRef={size.ref} className="lab-heat-chart" data-chart={chart} data-scale={scale} data-hover-index={hover.active ?? ''} tooltip={tooltip}>
      {geo && xAxisPlot && (
        <svg
          className="lab-chart-svg"
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="img"
          aria-label={t('lab.chart.heatmap.aria')}
        >
          <Axis orientation="y" axis={geo.layout.y} plot={geo.layout.plot} dpr={size.dpr} />
          <Axis orientation="x" axis={geo.layout.x} plot={xAxisPlot} dpr={size.dpr} />
          <g className="lab-heat-cells">
            {data.cells.map((c, i) => {
              const x = geo.layout.plot.left + c.col * geo.cellW;
              const y = geo.layout.plot.top + c.row * geo.cellH;
              const w = Math.max(1, geo.cellW - CELL_GAP);
              const h = Math.max(1, geo.cellH - CELL_GAP);
              return (
                <rect
                  key={`${c.row}:${c.col}`}
                  className="lab-heat-cell"
                  data-heat-cell=""
                  data-value={c.v ?? ''}
                  data-empty={c.v === null ? 'true' : undefined}
                  data-active={hover.active === i ? 'true' : undefined}
                  x={x + CELL_GAP / 2}
                  y={y + CELL_GAP / 2}
                  width={w}
                  height={h}
                  rx={Math.min(3, w / 4, h / 4)}
                  fill={c.v === null ? undefined : colors.color(c.v)}
                  aria-label={`${c.title}${c.label ? `, ${c.label}` : ''}: ${c.v === null ? '-' : formatValue(c.v, fmt)}`}
                  {...hover.bind(i)}
                />
              );
            })}
          </g>
          {cellLabels && data.cells.map((c) => {
            if (c.v === null) return null;
            const text = formatValue(c.v, { ...fmt, unit: null });
            if (size.measure(text) + 4 > geo.cellW - CELL_GAP || size.fontPx + 2 > geo.cellH - CELL_GAP) return null;
            const ink = colors.ink(c.v);
            return (
              <text
                key={`l${c.row}:${c.col}`}
                className="lab-heat-label"
                data-cell-label=""
                x={geo.layout.plot.left + (c.col + 0.5) * geo.cellW}
                y={geo.layout.plot.top + (c.row + 0.5) * geo.cellH}
                dy="0.32em"
                textAnchor="middle"
                fill={ink}
              >
                {text}
              </text>
            );
          })}
          <HeatLegend colors={colors} x={geo.layout.plot.left} y={geo.legendY} width={Math.min(geo.gridW, size.width - geo.layout.plot.left - 2)} fontPx={size.fontPx} measure={size.measure} fmt={fmt} />
        </svg>
      )}
    </ChartFrame>
  );
}

/** The scale legend: least value, the ramp's swatches (the grey midpoint visible on a diverging scale), most value. */
function HeatLegend({ colors, x, y, width, fontPx, measure, fmt }: {
  colors: HeatColor;
  x: number;
  y: number;
  width: number;
  fontPx: number;
  measure: Measure;
  fmt: { format: ChartFormat; unit: string | null; locale?: string };
}) {
  const lo = formatValue(colors.min, { ...fmt, unit: null });
  const hi = formatValue(colors.max, fmt);
  const sw = Math.max(6, Math.min(14, fontPx));
  const swH = Math.max(6, Math.round(fontPx * 0.7));
  const rampW = colors.steps.length * sw;
  const need = measure(lo) + measure(hi) + rampW + 12;
  const showText = need <= width;
  const rampX = showText ? x + measure(lo) + 6 : x;
  const cy = y + fontPx * 0.5;
  return (
    <g className="lab-heat-legend" data-heat-legend="" aria-hidden="true">
      {showText && <text className="lab-heat-legend-label" x={x} y={cy} dy="0.32em">{lo}</text>}
      {colors.steps.map((c, i) => (
        <rect key={i} x={rampX + i * sw} y={cy - swH / 2} width={sw} height={swH} fill={c} data-step={i + 1} />
      ))}
      {showText && <text className="lab-heat-legend-label" x={rampX + rampW + 6} y={cy} dy="0.32em">{hi}</text>}
    </g>
  );
}

export function HeatmapBody({ summary, cache, series, full = false, emptyHint, height }: ChartBodyProps) {
  return (
    <HeatmapChart
      series={series}
      unit={summary.unit}
      granularity={cache?.granularity ?? summary.granularity}
      full={full}
      emptyHint={emptyHint}
      height={height !== undefined ? undefined : full ? 260 : 160}
    />
  );
}

export interface HeatOptions {
  /** The block `color` option (1-8): slot 1 = the validated blue ramp, others a ramp of that hue. */
  colorIndex?: number;
  scale?: HeatScale;
  cellLabels?: boolean;
  format?: ChartFormat;
  /** A fixed pixel height; absent = fill the parent. */
  height?: number;
}

/** The series heatmap (the weekday grid, or a strip for non-daily buckets). */
export function HeatmapChart({ series, unit, granularity, emptyHint, height, full: _full, ...opts }: {
  series: { name: string; points: { t: string; v: number }[] }[];
  unit: string | null;
  granularity: string | null;
  full?: boolean;
  emptyHint?: string;
} & HeatOptions) {
  const { locale } = useI18n();
  const data = useMemo(() => seriesHeatData(series, granularity, locale), [series, granularity, locale]);
  if (!data) return <ChartEmpty hint={emptyHint} />;
  return (
    <div className="lab-heat-box" style={chartHeight(height)}>
      <HeatGrid data={data} unit={unit} chart="heatmap" {...opts} />
    </div>
  );
}

/**
 * A table frame's heatmap: rows = the first dim, columns = the second. What a
 * board `heatmap` block bound to a dataset draws.
 */
export function HeatmapMatrix({ dims, rows, unit, emptyHint, height, ...opts }: {
  dims: readonly { key: string; label: string }[];
  rows: readonly { d: Record<string, string>; v: number | null }[];
  unit: string | null;
  emptyHint?: string;
} & HeatOptions) {
  const data = useMemo(() => tableHeatData(dims, rows), [dims, rows]);
  if (!data) return <ChartEmpty hint={emptyHint} />;
  return (
    <div className="lab-heat-box" style={chartHeight(height)}>
      <HeatGrid data={data} unit={unit} chart="heatmap-matrix" {...opts} />
    </div>
  );
}
