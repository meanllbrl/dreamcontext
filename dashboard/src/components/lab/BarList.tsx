import { useMemo, type CSSProperties } from 'react';
import { useI18n } from '../../context/I18nContext';
import { rankRows, ROW_CAP, type BarRow } from './barRows';
import {
  Axis, COMPACT_PAD, ChartFrame, EndLabelMarks, Grid, HitArea, OTHER_COLOR, bandScale, cartesianLayout, chartFit, colorScale,
  compactEndLabels, crisp, formatNumber, formatValue, linearScale, tickCountFor, tickFormatter, truncateToWidth,
  useChartHover, useChartSize, useSeriesToggle,
  type AxisTick, type CartesianLayout, type ChartFormat, type EndLabels, type LegendItem, type LegendPosition, type Measure,
  type Rect, type TooltipRow, type TooltipSpec,
} from './chart';
import { entityDomain } from './LineChart';
import './lab-bar-pie-heat.css';

/**
 * The lab's ONE bar renderer, on the chart foundation: a value axis with nice
 * ticks, a category axis whose labels never collide, per-category hover (the
 * pointer snaps to the nearest bar, the whole slot is the hit target) and bars
 * drawn to the dataviz spec: at most 24px thick, a 4px rounded data end,
 * square at the baseline, 2px of surface between touching bars.
 *
 * `BarPlot` draws a BarModel (categories x series, optional previous values)
 * horizontally or vertically, grouped or stacked. `BarList` is the ranked
 * horizontal list the `bar` render, a pie's >= 7-slice degrade and the
 * breakdown's one-dim view all draw: same rows, same ranking, same cap (the
 * tail folds into one Other bar). The row math lives in barRows.ts.
 */

export interface BarCategory {
  key: string;
  /** Display label (untrusted: drawn as text). */
  label: string;
  /** A folded Other bucket (frameOps `topN`): wears the Other grey. */
  other?: boolean;
}

export interface BarSeries {
  id: string;
  label: string;
  /** One value per category (null = no bar). */
  values: (number | null)[];
  /** The previous period per category (comparePrev), when known. */
  prev?: (number | null)[] | null;
  other?: boolean;
}

export interface BarModel {
  categories: BarCategory[];
  series: BarSeries[];
}

export type BarOrientation = 'h' | 'v';
export type BarGroup = 'grouped' | 'stacked';

export interface BarPlotOptions {
  orientation?: BarOrientation;
  group?: BarGroup;
  valueLabels?: boolean;
  /** Draw each bar's previous value as a recessive paired bar, delta in the tooltip. */
  comparePrev?: boolean;
  format?: ChartFormat;
  unit?: string | null;
  /** The block `color` option: 1-based palette slot of the first series. */
  colorStart?: number;
  showX?: boolean;
  showY?: boolean;
  grid?: boolean;
  legend?: LegendPosition;
  /** Single series: the tooltip reads each bar's share of the total. */
  share?: boolean;
  /**
   * Every series name before any pick or filter (BlockProps.colorDomain.series):
   * colours key on it, so a survivor keeps its hue. Absent = the drawn series.
   */
  colorDomain?: readonly string[] | null;
  /**
   * Compact frame (chart/fit.ts): columns fill the frame with no axes, grid or
   * value labels (series named on the right when there are several); rows
   * keep their names and values but drop the value axis, and draw only the
   * rows that fit, "+N" for the rest (the order is the caller's: a ranked list
   * keeps its biggest).
   */
  compact?: boolean;
  /**
   * Small frame (chart/fit.ts): rows (horizontal bars) likewise draw only the
   * ones that fit with a readable name, "+N" for the rest, and drop the value
   * axis when value labels already carry every number.
   */
  small?: boolean;
}

/**
 * Rows a compact or small horizontal bar frame of `height` px draws: one per
 * ~1.6 font heights (the band's padding included, so every row keeps its
 * name), at least one.
 */
export function compactRowCount(height: number, fontPx: number): number {
  return Math.max(1, Math.floor((height - 4) / (fontPx * 1.6)));
}

/** Thickest a bar may be (dataviz: thin marks; the slot's leftover is air). */
export const MAX_BAR = 24;
/** Surface between touching bars and between stacked segments. */
export const BAR_GAP = 2;
/** The rounded data end. */
export const BAR_RADIUS = 4;
/** Share of a category slot left empty between categories. */
const SLOT_PADDING = 0.28;
/** How opaque a previous-period ghost is over the surface. */
const GHOST_MIX = 38;

/** The recessive previous-period twin of a series colour. */
export function ghostColor(color: string): string {
  return `color-mix(in srgb, ${color} ${GHOST_MIX}%, transparent)`;
}

export type BarEnd = 'top' | 'bottom' | 'left' | 'right';

/**
 * A bar as a path: square at the baseline, `radius` rounded corners on the
 * `end` side (the data end). The radius never exceeds half the bar's
 * thickness or its length, so a tiny bar stays a bar.
 */
export function barPath(left: number, top: number, right: number, bottom: number, end: BarEnd | null, radius = BAR_RADIUS): string {
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  const f = (n: number) => Number(n.toFixed(2));
  const along = end === 'top' || end === 'bottom' ? w : h;
  const len = end === 'top' || end === 'bottom' ? h : w;
  const r = end ? Math.max(0, Math.min(radius, along / 2, len)) : 0;
  const [l, t, rr, b] = [f(left), f(top), f(left + w), f(top + h)];
  if (r <= 0.01) return `M${l},${t}H${rr}V${b}H${l}Z`;
  const R = f(r);
  switch (end) {
    case 'top':
      return `M${l},${b}V${f(t + r)}A${R},${R} 0 0 1 ${f(l + r)},${t}H${f(rr - r)}A${R},${R} 0 0 1 ${rr},${f(t + r)}V${b}Z`;
    case 'bottom':
      return `M${l},${t}H${rr}V${f(b - r)}A${R},${R} 0 0 1 ${f(rr - r)},${b}H${f(l + r)}A${R},${R} 0 0 1 ${l},${f(b - r)}Z`;
    case 'right':
      return `M${l},${t}H${f(rr - r)}A${R},${R} 0 0 1 ${rr},${f(t + r)}V${f(b - r)}A${R},${R} 0 0 1 ${f(rr - r)},${b}H${l}Z`;
    default:
      return `M${rr},${t}V${b}H${f(l + r)}A${R},${R} 0 0 1 ${l},${f(b - r)}V${f(t + r)}A${R},${R} 0 0 1 ${f(l + r)},${t}Z`;
  }
}

/** One drawn bar (or stacked segment, or previous-period ghost). */
export interface BarMark {
  key: string;
  cat: number;
  series: string;
  ghost: boolean;
  value: number;
  d: string;
  /** The bar's box (plot-absolute px), before its end is rounded. */
  rect: { left: number; top: number; right: number; bottom: number };
  color: string;
  /** Where the value label anchors (plot-absolute px) and which way it reads. */
  tip: { x: number; y: number; side: BarEnd };
}

export interface BarLayoutInput {
  model: BarModel;
  /** Series ids hidden by the legend. */
  hidden?: ReadonlySet<string>;
  opts: BarPlotOptions;
  width: number;
  height: number;
  fontPx: number;
  measure: Measure;
  locale?: string;
}

export interface BarLayout {
  layout: CartesianLayout;
  plot: Rect;
  /** Plot-local category centres along the category axis, ascending. */
  centers: number[];
  /** A category slot's extent along the category axis. */
  slot: number;
  marks: BarMark[];
  labels: { key: string; x: number; y: number; anchor: 'start' | 'middle' | 'end'; text: string }[];
  /** The value-axis zero, plot-local (y for columns, x for rows). */
  zero: number;
  /** Per category: the value-axis extent its bars reach (plot-local), for the tooltip anchor. */
  reach: number[];
  /** Gridline positions along the value axis (drawn even when the axis labels are hidden). */
  gridTicks: { pos: number }[];
  colors: Map<string, string>;
  /** Compact mode: the end labels (series names) or the "+N" of rows left out; null otherwise. */
  ends: EndLabels | null;
}

/**
 * The series colour map: over the unfiltered entity domain (then any drawn
 * series it lacks), never over what is drawn, so a legend toggle, a series
 * pick or a board filter never repaints a survivor. Series ids are the names
 * the domain uses (a pivot's second-dim values).
 */
export function barColors(model: BarModel, colorStart = 1, domain?: readonly string[] | null): Map<string, string> {
  const ids = model.series.map((s) => s.id);
  const scale = colorScale(entityDomain(domain, ids), { start: colorStart, other: model.series.filter((s) => s.other).map((s) => s.id) });
  return new Map(model.series.map((s) => [s.id, scale.color(s.id)] as [string, string]));
}

/** The colour a bar wears: its series colour; a single series' Other bucket wears the Other grey. */
function markColor(colors: Map<string, string>, series: BarSeries, cat: BarCategory, single: boolean): string {
  if (single && cat.other) return OTHER_COLOR;
  return colors.get(series.id) ?? OTHER_COLOR;
}

/**
 * Pure bar geometry for a measured cell: the cartesian layout, one mark per
 * bar/segment/ghost, the value labels that fit. Exported for the unit tests
 * (the component is this plus hover and chrome).
 */
export function layoutBars({ model: fullModel, hidden, opts, width, height, fontPx, measure, locale }: BarLayoutInput): BarLayout {
  const orientation = opts.orientation ?? 'h';
  const vertical = orientation === 'v';
  const compact = !!opts.compact;
  const smallRows = !compact && !!opts.small && !vertical;
  const valueLabelsAsked = opts.valueLabels ?? true;
  // With labels at the tips, a small frame's value axis only repeats them: its band goes to the rows.
  const dropValueAxis = compact || (smallRows && valueLabelsAsked);
  // Compact and small rows: only the ones that fit (the caller's order), the rest a "+N".
  const rowCap = (compact || smallRows) && !vertical
    ? compactRowCount(height - (dropValueAxis ? 0 : Math.ceil(fontPx * 1.25) + 6), fontPx)
    : Infinity;
  const leftOut = Math.max(0, fullModel.categories.length - rowCap);
  const model: BarModel = leftOut > 0
    ? {
        categories: fullModel.categories.slice(0, rowCap),
        series: fullModel.series.map((s) => ({ ...s, values: s.values.slice(0, rowCap), prev: s.prev ? s.prev.slice(0, rowCap) : s.prev })),
      }
    : fullModel;
  const shown = model.series.filter((s) => !hidden?.has(s.id));
  const single = model.series.length === 1;
  const stacked = (opts.group ?? 'grouped') === 'stacked' && shown.length > 1;
  const compare = !!opts.comparePrev && shown.some((s) => s.prev?.some((v) => typeof v === 'number'));
  const valueLabels = (opts.valueLabels ?? true) && !(compact && vertical);
  const fmt = { format: opts.format ?? 'auto', unit: opts.unit ?? null, locale };
  // Tight rows spend their width on the bar: a unit other than % stays in the title (the tooltip keeps it).
  const labelFmt = (compact || smallRows) && fmt.unit?.trim() !== '%' ? { ...fmt, unit: null } : fmt;
  const showX = (opts.showX ?? true) && !dropValueAxis;
  const showY = (opts.showY ?? true) && !(compact && vertical);
  const colors = barColors(model, opts.colorStart ?? 1, opts.colorDomain);
  const nCat = model.categories.length;
  let ends: EndLabels | null = null;
  if (compact && vertical && !single) {
    ends = compactEndLabels(
      shown.map((s) => ({ id: s.id, color: colors.get(s.id) ?? OTHER_COLOR, shape: 'rect' as const, name: s.label, value: '' })),
      { width, height, fontPx, measure },
    );
  } else if (leftOut > 0) {
    const w = measure(`+${leftOut}`);
    ends = { placed: [], more: leftOut, moreAt: { x: width - w - 2, y: height - 2 - fontPx * 0.7 }, width: w + 10 };
  }
  const endsW = ends?.width ?? 0;

  const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  // Every value the value axis must hold: bars, stack ends, ghosts.
  const extent: number[] = [0];
  const stackEnds = (vals: (s: BarSeries) => number | null | undefined): [number, number] => {
    let pos = 0;
    let neg = 0;
    for (const s of shown) {
      const v = vals(s);
      if (!num(v)) continue;
      if (v >= 0) pos += v;
      else neg += v;
    }
    return [neg, pos];
  };
  for (let c = 0; c < nCat; c++) {
    if (stacked) {
      extent.push(...stackEnds((s) => s.values[c]));
      if (compare) extent.push(...stackEnds((s) => s.prev?.[c]));
    } else {
      for (const s of shown) {
        if (num(s.values[c])) extent.push(s.values[c] as number);
        if (compare && num(s.prev?.[c])) extent.push(s.prev?.[c] as number);
      }
    }
  }

  // The value labels' text, so their room can be reserved before the layout runs.
  const labelText = (v: number) => formatValue(v, labelFmt);
  const labelled: number[] = [];
  if (valueLabels) {
    for (let c = 0; c < nCat; c++) {
      if (stacked) {
        const [neg, pos] = stackEnds((s) => s.values[c]);
        labelled.push(pos + neg);
      } else {
        for (const s of shown) if (num(s.values[c])) labelled.push(s.values[c] as number);
      }
    }
  }
  const widestLabel = labelled.reduce((m, v) => Math.max(m, measure(labelText(v))), 0);
  const hasNegative = extent.some((v) => v < 0);
  const padding = compact
    ? vertical
      ? { top: COMPACT_PAD, bottom: COMPACT_PAD, left: COMPACT_PAD, right: COMPACT_PAD + endsW }
      : { top: 2, bottom: 2, right: (valueLabels ? Math.ceil(widestLabel) + 10 : 8) + endsW }
    : smallRows && endsW > 0
      ? { right: (valueLabels ? Math.ceil(widestLabel) + 10 : 8) + endsW }
      : vertical
      ? { top: valueLabels ? Math.ceil(fontPx * 1.4) + 2 : Math.ceil(fontPx / 2) + 2, bottom: hasNegative && valueLabels ? Math.ceil(fontPx * 1.4) : 2 }
      : { right: valueLabels ? Math.ceil(widestLabel) + 10 : 8 };

  // Category labels: long names are truncated to a share of the cell, never allowed to eat the plot.
  const catLabelMax = Math.max(fontPx * 4, width * (vertical ? 0.5 : 0.34));
  const catLabel = (c: BarCategory) => truncateToWidth(c.label, catLabelMax, measure);

  const valueScale = (len: number) => linearScale(extent, {
    range: vertical ? [len, 0] : [0, len],
    tickCount: tickCountFor(len, vertical ? fontPx * 3 : fontPx * 6),
    zero: true,
  });
  const valueTicks = (len: number): AxisTick[] => {
    const s = valueScale(len);
    const f = tickFormatter(s.ticks, s.step, fmt);
    return s.ticks.map((v) => ({ pos: s(v), label: f(v), value: v }));
  };
  const band = (len: number) => bandScale(nCat, [0, len], { paddingInner: SLOT_PADDING, paddingOuter: SLOT_PADDING / 2 });
  const catTicks = (len: number): AxisTick[] => {
    const b = band(len);
    return model.categories.map((c, i) => ({ pos: b.center(i), label: catLabel(c) }));
  };

  const layout = cartesianLayout({
    width, height, fontPx, measure, showX, showY,
    xLabelMode: vertical ? 'rotate' : 'thin',
    yTicks: (h) => (vertical ? valueTicks(h) : catTicks(h)),
    xTicks: (w) => (vertical ? catTicks(w) : valueTicks(w)),
    padding,
  });
  const { plot } = layout;
  const catLen = vertical ? plot.width : plot.height;
  const valLen = vertical ? plot.height : plot.width;
  const b = band(catLen);
  const scale = valueScale(valLen);
  const zero = scale(0);
  const centers = model.categories.map((_, i) => b.center(i));
  // The "+N" of rows left out reads on the last drawn row's line.
  if (ends && leftOut > 0 && ends.moreAt && centers.length > 0) ends.moreAt = { x: ends.moreAt.x, y: plot.top + centers[centers.length - 1] };
  const slotFull = b.step * (1 - SLOT_PADDING);

  // Bars per category slot: grouped series side by side, each with its ghost when comparing.
  const perSeries = compare ? 2 : 1;
  const lanes = (stacked ? 1 : Math.max(1, shown.length)) * perSeries;
  const thick = Math.max(1, Math.min(MAX_BAR, (slotFull - (lanes - 1) * BAR_GAP) / lanes));
  const groupLen = lanes * thick + (lanes - 1) * BAR_GAP;

  const marks: BarMark[] = [];
  const reach: number[] = model.categories.map(() => zero);
  const toRect = (c: number, lane: number, from: number, to: number) => {
    const a = centers[c] - groupLen / 2 + lane * (thick + BAR_GAP);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    return vertical
      ? { left: plot.left + a, right: plot.left + a + thick, top: plot.top + lo, bottom: plot.top + hi }
      : { left: plot.left + lo, right: plot.left + hi, top: plot.top + a, bottom: plot.top + a + thick };
  };
  const endOf = (v: number): BarEnd => (vertical ? (v >= 0 ? 'top' : 'bottom') : (v >= 0 ? 'right' : 'left'));
  const push = (c: number, lane: number, s: BarSeries, v: number, from: number, to: number, ghost: boolean, rounded: boolean) => {
    const r = toRect(c, lane, from, to);
    const end = endOf(v);
    const color = markColor(colors, s, model.categories[c], single);
    const tip = vertical
      ? { x: (r.left + r.right) / 2, y: end === 'top' ? r.top : r.bottom, side: end }
      : { x: end === 'right' ? r.right : r.left, y: (r.top + r.bottom) / 2, side: end };
    marks.push({
      key: `${ghost ? 'g' : 'b'}:${s.id}:${c}`, cat: c, series: s.id, ghost, value: v,
      d: barPath(r.left, r.top, r.right, r.bottom, rounded ? end : null),
      rect: r,
      color: ghost ? ghostColor(color) : color,
      tip,
    });
    const far = vertical ? Math.min(to, from) : Math.max(to, from);
    reach[c] = vertical ? Math.min(reach[c], far) : Math.max(reach[c], far);
  };

  for (let c = 0; c < nCat; c++) {
    if (stacked) {
      const drawStack = (lane: number, get: (s: BarSeries) => number | null | undefined, ghost: boolean) => {
        // Positives stack up from zero, negatives down; only the outermost segment each way is rounded.
        for (const sign of [1, -1]) {
          const segs = shown.map((s) => ({ s, v: get(s) })).filter((x): x is { s: BarSeries; v: number } => num(x.v) && x.v !== 0 && Math.sign(x.v) === sign);
          let acc = 0;
          segs.forEach(({ s, v }, k) => {
            const from = scale(acc);
            acc += v;
            let to = scale(acc);
            const last = k === segs.length - 1;
            // The 2px surface gap between touching segments: each inner segment stops short.
            if (!last && Math.abs(to - from) > BAR_GAP + 1) to += vertical ? BAR_GAP * sign : -BAR_GAP * sign;
            push(c, lane, s, v, from, to, ghost, last);
          });
        }
      };
      if (compare) drawStack(0, (s) => s.prev?.[c], true);
      drawStack(compare ? 1 : 0, (s) => s.values[c], false);
    } else {
      shown.forEach((s, si) => {
        const lane = si * perSeries;
        const p = s.prev?.[c];
        if (compare && num(p)) push(c, lane, s, p, zero, scale(p), true, true);
        const v = s.values[c];
        if (num(v)) push(c, lane + (compare ? 1 : 0), s, v, zero, scale(v), false, true);
      });
    }
  }

  // Value labels at the bar tips, only where the text fits: never on a ghost, one per stack (its total).
  let labels: BarLayout['labels'] = [];
  // Columns label all or nothing: a few labelled columns among bare ones read as a pattern that is not there.
  let crowded = false;
  if (valueLabels) {
    const gap = 4;
    const right = width - 2 - endsW;
    for (let c = 0; c < nCat; c++) {
      const own = marks.filter((m) => m.cat === c && !m.ghost);
      if (own.length === 0) continue;
      const targets = stacked
        ? [{ value: own.reduce((a, m) => a + m.value, 0), tip: own.reduce((best, m) => (vertical ? (m.tip.y < best.tip.y ? m : best) : (m.tip.x > best.tip.x ? m : best))).tip, key: `t:${c}` }]
        : own.map((m) => ({ value: m.value, tip: m.tip, key: `l:${m.key}` }));
      for (const tg of targets) {
        const text = labelText(tg.value);
        const w = measure(text);
        if (vertical) {
          // A column label must fit its own lane, or it would sit on a neighbour.
          if (w > (stacked ? slotFull : thick) + (lanes === 1 ? b.step * SLOT_PADDING : BAR_GAP)) {
            crowded = true;
            continue;
          }
          const up = tg.value >= 0;
          const y = up ? tg.tip.y - gap : tg.tip.y + gap + fontPx * 0.8;
          if (y - fontPx < 0 || y > height) continue;
          labels.push({ key: tg.key, x: tg.tip.x, y, anchor: 'middle', text });
        } else {
          if (thick < fontPx * 0.7) continue;
          const pos = tg.value >= 0;
          const x = pos ? tg.tip.x + gap : tg.tip.x - gap;
          if (pos ? x + w > right : x - w < plot.left) continue;
          labels.push({ key: tg.key, x, y: tg.tip.y, anchor: pos ? 'start' : 'end', text });
        }
      }
    }
  }

  if (vertical && crowded) labels = [];
  return { layout, plot, centers, slot: b.step, marks, labels, zero, reach, colors, gridTicks: scale.ticks.map((v) => ({ pos: scale(v) })), ends };
}

/** "+10 (+25%)": the change from `prev` to `cur`, signed, formatted like the values. */
export function formatDelta(cur: number, prev: number, fmt: { format?: ChartFormat; unit?: string | null; locale?: string }): string {
  const diff = cur - prev;
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
  const abs = formatValue(Math.abs(diff), fmt);
  if (prev === 0) return `${sign}${abs}`;
  const pct = formatNumber(Math.abs(diff / prev), { format: 'percent', locale: fmt.locale });
  return `${sign}${abs} (${sign}${pct})`;
}

export interface BarTooltipCopy {
  current: string;
  previous: string;
  total: string;
  /** "{delta} vs previous" */
  vsPrev: string;
  /** "Share: {pct}" */
  share: string;
}

/**
 * The tooltip for category `c`: every visible series' value (value leads,
 * name follows), the previous value and the delta when comparing, the stack
 * total when stacked, a single series' share of the total. Pure.
 */
export function barTooltipContent(
  model: BarModel, c: number, opts: BarPlotOptions, colors: Map<string, string>, copy: BarTooltipCopy,
  hidden?: ReadonlySet<string>, locale?: string,
): Omit<TooltipSpec, 'anchor'> {
  const fmt = { format: opts.format ?? 'auto', unit: opts.unit ?? null, locale };
  const shown = model.series.filter((s) => !hidden?.has(s.id));
  const single = model.series.length === 1;
  const cat = model.categories[c];
  const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  const compare = !!opts.comparePrev;
  const rows: TooltipRow[] = [];
  let footer: string | undefined;
  if (single) {
    const s = shown[0] ?? model.series[0];
    const v = s.values[c];
    const p = s.prev?.[c];
    const color = markColor(colors, s, cat, true);
    rows.push({ id: 'value', label: compare && num(p) ? copy.current : '', value: num(v) ? formatValue(v, fmt) : '-', color, shape: 'rect', dim: !num(v) });
    if (compare && num(p)) {
      rows.push({ id: 'prev', label: copy.previous, value: formatValue(p, fmt), color: ghostColor(color), shape: 'rect' });
      if (num(v)) footer = copy.vsPrev.replace('{delta}', formatDelta(v, p, fmt));
    } else if (opts.share && num(v)) {
      const total = s.values.reduce<number>((a, x) => a + (num(x) && x > 0 ? x : 0), 0);
      if (total > 0 && v > 0) footer = copy.share.replace('{pct}', formatNumber(v / total, { format: 'percent', locale }));
    }
    return { title: cat.label, rows, footer };
  }
  let total = 0;
  let any = false;
  for (const s of shown) {
    const v = s.values[c];
    const p = s.prev?.[c];
    if (num(v)) {
      total += v;
      any = true;
    }
    const delta = compare && num(v) && num(p) ? `, ${copy.vsPrev.replace('{delta}', formatDelta(v, p, fmt))}` : '';
    rows.push({
      id: s.id,
      label: `${s.label}${delta}`,
      value: num(v) ? formatValue(v, fmt) : '-',
      color: colors.get(s.id) ?? OTHER_COLOR,
      shape: 'rect',
      dim: !num(v),
    });
  }
  if ((opts.group ?? 'grouped') === 'stacked' && any) footer = `${copy.total}: ${formatValue(total, fmt)}`;
  return { title: cat.label, rows, footer };
}

export interface BarPlotProps extends BarPlotOptions {
  model: BarModel;
  ariaLabel?: string;
  /** `data-chart` for the verify harness. */
  chart?: string;
}

/** Draws a BarModel into the cell it is given (fills its parent; never scrolls). */
export function BarPlot({ model, ariaLabel, chart = 'bar', ...opts }: BarPlotProps) {
  const { t, locale } = useI18n();
  const size = useChartSize();
  // The whole frame (legend included) decides what yields as the cell shrinks (chart/fit.ts).
  const frame = useChartSize();
  const vertical = (opts.orientation ?? 'h') === 'v';
  const ids = useMemo(() => model.series.map((s) => s.id), [model]);
  const toggle = useSeriesToggle(ids);
  const hidden = toggle.hidden;
  const legendColors = barColors(model, opts.colorStart ?? 1, opts.colorDomain);
  const copy: BarTooltipCopy = {
    current: t('lab.blocks.compare.current'),
    previous: t('lab.blocks.compare.prev'),
    total: t('lab.chart.totalCaption'),
    vsPrev: t('lab.chart.vsPrev'),
    share: t('lab.chart.share'),
  };
  const single = model.series.length === 1;
  const legendItems: LegendItem[] = single
    ? []
    : model.series.map((s) => ({ id: s.id, label: s.label, color: legendColors.get(s.id) ?? OTHER_COLOR, shape: 'rect' as const }));
  const compareLegend = single && opts.comparePrev && model.series[0].prev?.some((v) => typeof v === 'number');
  const legendPos = opts.legend ?? 'bottom';
  const legend = legendItems.length > 1
    ? { position: legendPos, items: legendItems, hidden, onToggle: toggle.toggle }
    : compareLegend
      ? {
          position: legendPos,
          items: [
            { id: 'current', label: copy.current, color: legendColors.get(model.series[0].id) ?? OTHER_COLOR, shape: 'rect' as const },
            { id: 'prev', label: copy.previous, color: ghostColor(legendColors.get(model.series[0].id) ?? OTHER_COLOR), shape: 'rect' as const },
          ],
        }
      : null;
  const fit = chartFit({
    width: frame.width, height: frame.height, fontPx: frame.fontPx, measure: frame.measure,
    legend: legendPos, labels: legend ? legend.items.map((it) => it.label) : [],
  });
  const compact = fit.size === 'compact';

  const geo = useMemo(() => {
    if (!size.ready || model.categories.length === 0) return null;
    return layoutBars({ model, hidden, opts: { ...opts, compact, small: fit.size === 'small' }, width: size.width, height: size.height, fontPx: size.fontPx, measure: size.measure, locale });
    // opts is spread fresh each render; its fields are listed instead.
  }, [size.ready, size.width, size.height, size.fontPx, size.measure, model, hidden, locale, compact, fit.size, // eslint-disable-line react-hooks/exhaustive-deps
    opts.orientation, opts.group, opts.valueLabels, opts.comparePrev, opts.format, opts.unit, opts.colorStart, opts.colorDomain, opts.showX, opts.showY]);

  const hover = useChartHover({
    positions: geo?.centers ?? [],
    plotWidth: geo?.plot.width ?? 0,
    plotHeight: geo?.plot.height ?? 0,
    axis: vertical ? 'x' : 'y',
  });
  const hi = hover.index;
  const colors = geo?.colors ?? legendColors;

  let tooltip: TooltipSpec | null = null;
  if (geo && hi !== null) {
    const c = geo.centers[hi];
    const far = geo.reach[hi];
    const anchor = vertical
      ? { x: geo.plot.left + c, y: geo.plot.top + (hover.pointer?.y ?? far) }
      : { x: geo.plot.left + far, y: geo.plot.top + c };
    tooltip = { anchor, ...barTooltipContent(model, hi, opts, colors, copy, hidden, locale) };
  }


  const slotRect = (i: number) => {
    if (!geo) return null;
    const half = geo.slot / 2;
    return vertical
      ? { x: geo.plot.left + geo.centers[i] - half, y: geo.plot.top, width: geo.slot, height: geo.plot.height }
      : { x: geo.plot.left, y: geo.plot.top + geo.centers[i] - half, width: geo.plot.width, height: geo.slot };
  };
  const hoverSlot = hi !== null ? slotRect(hi) : null;

  return (
    <ChartFrame
      plotRef={size.ref}
      frameRef={frame.ref}
      fit={fit}
      className="lab-bar-chart"
      data-chart={chart}
      data-orientation={vertical ? 'v' : 'h'}
      data-group={opts.group ?? 'grouped'}
      data-hover-index={hi ?? ''}
      legend={legend}
      tooltip={tooltip}
    >
      {geo && (
        <svg
          className="lab-chart-svg"
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="img"
          aria-label={ariaLabel ?? t('lab.chart.bar.aria')}
          {...hover.focusProps}
        >
          {(opts.grid ?? true) && !compact && (vertical
            ? <Grid plot={geo.plot} y={geo.gridTicks} dpr={size.dpr} />
            : <Grid plot={geo.plot} x={geo.gridTicks} dpr={size.dpr} />)}
          {hoverSlot && <rect className="lab-bar-hover" data-hover-slot="" {...hoverSlot} />}
          {(opts.showY ?? true) && <Axis orientation="y" axis={geo.layout.y} plot={geo.plot} dpr={size.dpr} />}
          {/* The baseline the bars grow from stays whatever the axes show: it anchors the marks. */}
          <Axis orientation="x" axis={geo.layout.x} plot={geo.plot} baseline={vertical ? geo.zero : null} dpr={size.dpr} />
          {!vertical && (
            <line
              className="lab-chart-axis-line"
              x1={crisp(geo.plot.left + geo.zero, size.dpr)}
              x2={crisp(geo.plot.left + geo.zero, size.dpr)}
              y1={geo.plot.top}
              y2={geo.plot.top + geo.plot.height}
            />
          )}
          <g className="lab-bar-marks">
            {geo.marks.map((m) => (
              <path
                key={m.key}
                d={m.d}
                fill={m.color}
                data-bar=""
                data-series={m.series}
                data-cat={m.cat}
                data-ghost={m.ghost ? 'true' : undefined}
                data-active={hi === null ? undefined : hi === m.cat ? 'true' : 'false'}
              />
            ))}
          </g>
          {geo.labels.map((l) => (
            <text key={l.key} className="lab-bar-value" data-value-label="" x={l.x} y={l.y} dy={vertical ? undefined : '0.32em'} textAnchor={l.anchor}>
              {l.text}
            </text>
          ))}
          {geo.ends && <EndLabelMarks labels={geo.ends} />}
          <HitArea plot={geo.plot} {...hover.hitProps} />
        </svg>
      )}
    </ChartFrame>
  );
}

/** Rows in the given order (no ranking), capped unless `full` like {@link rankRows}. */
export function capRows(rows: BarRow[], full: boolean): { rows: BarRow[]; restCount: number; restFrac: number } {
  if (full || rows.length <= ROW_CAP) return { rows, restCount: 0, restFrac: 0 };
  const rest = rows.slice(ROW_CAP);
  return { rows: rows.slice(0, ROW_CAP), restCount: rest.length, restFrac: rest.reduce((a, s) => a + s.frac, 0) };
}

/** A share row that may be a folded Other bucket (frameOps `topN`, or the card cap). */
export type ShareRow = BarRow & { other?: number | null; prev?: number | null };

/** The Other label: "Other" or "Other (3)" in the reader's language. */
export function otherLabel(t: (key: string) => string, count: number | null | undefined): string {
  return typeof count === 'number' && count > 0 ? t('lab.blocks.otherCount').replace('{n}', String(count)) : t('lab.blocks.other');
}

/**
 * Share rows as a single-series BarModel: ranked (or kept in order), capped
 * unless `full` with the tail folded into ONE Other bar (never a "+k more"
 * line: the cap is part of the chart, and the tooltip still reads it).
 */
export function rowsToModel(rows: readonly ShareRow[], opts: { full: boolean; ranked: boolean; other: (n: number | null | undefined) => string }): BarModel {
  const capped = opts.ranked ? rankRows([...rows], opts.full) : capRows([...rows], opts.full);
  const head = capped.rows as ShareRow[];
  const restValue = capped.restCount > 0 ? rows.filter((r) => !head.includes(r)).reduce((a, r) => a + r.value, 0) : 0;
  const cats: BarCategory[] = head.map((r) => ({ key: r.name, label: r.other ? opts.other(r.other) : r.name, other: !!r.other }));
  const values: (number | null)[] = head.map((r) => r.value);
  const prev: (number | null)[] = head.map((r) => (typeof r.prev === 'number' ? r.prev : null));
  if (capped.restCount > 0) {
    cats.push({ key: '\u0000other', label: opts.other(capped.restCount), other: true });
    values.push(restValue);
    prev.push(null);
  }
  return { categories: cats, series: [{ id: 'value', label: '', values, prev: prev.some((p) => p !== null) ? prev : null }] };
}

/**
 * A chart box's own height as the `--lab-chart-h` variable (lab-bar-pie-heat.css
 * applies it), not an inline height: a board card can then still make a legacy
 * body fill the card instead of scrolling inside it. Undefined = fill the parent.
 */
export function chartHeight(px: number | undefined): CSSProperties | undefined {
  return px === undefined ? undefined : ({ '--lab-chart-h': `${Math.round(px)}px` } as CSSProperties);
}

/** Rows per px of a content-sized list: one 20px row plus air. */
const LIST_ROW = 26;

export function BarList({ rows, unit, full = false, ranked = true, colorIndex, fill = false, format, valueLabels = true, showX = true, grid = true }: {
  rows: BarRow[];
  unit: string | null;
  /** Detail panel: every row instead of the card's top-N + one Other bar. */
  full?: boolean;
  /** Rank by value (the default). False keeps the caller's order (a board block's `sort`). */
  ranked?: boolean;
  /** Palette slot (1-8) the bars wear; absent = slot 1. */
  colorIndex?: number;
  /** Fill the parent's height (a board cell, a pie's degrade) instead of sizing to the rows. */
  fill?: boolean;
  format?: ChartFormat;
  valueLabels?: boolean;
  showX?: boolean;
  grid?: boolean;
}) {
  const { t } = useI18n();
  const model = useMemo(
    () => rowsToModel(rows as ShareRow[], { full, ranked, other: (n) => otherLabel(t, n) }),
    [rows, full, ranked, t],
  );
  const n = model.categories.length;
  return (
    <div className="lab-bar-list" style={fill ? undefined : chartHeight(n * LIST_ROW + 32)} data-fill={fill ? 'true' : undefined}>
      <BarPlot
        model={model}
        chart="bar-list"
        orientation="h"
        unit={unit}
        colorStart={colorIndex ?? 1}
        format={format}
        valueLabels={valueLabels}
        showX={showX}
        grid={grid}
        share
        ariaLabel={t('lab.chart.shares.aria')}
      />
    </div>
  );
}
