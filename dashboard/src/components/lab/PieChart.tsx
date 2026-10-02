import { useMemo } from 'react';
import type { Series } from '../../hooks/useLab';
import { useI18n } from '../../context/I18nContext';
import { BarList } from './BarList';
import { chartHeight, otherLabel, type ShareRow } from './BarList';
import { degradesToBars, toBarRows } from './barRows';
import { ChartEmpty, type ChartBodyProps } from './chartBody';
import {
  ChartFrame, chartSizeClass, colorScale, formatNumber, formatValue, truncateToWidth, useChartSize, useMarkHover,
  useSeriesToggle, type ChartFormat, type Measure, type TooltipSpec,
} from './chart';
import { entityDomain } from './LineChart';
import './lab-bar-pie-heat.css';

/**
 * The pie (and donut) on the chart foundation: one slice per row, sized by its
 * share of the visible total. Slices are split by a 2px surface gap; hovering
 * (or focusing) a slice lifts it, dims the rest and reads out value and share;
 * with `centerTotal` the hole shows the total, and the hovered slice while one
 * is hovered. Labels sit in a legend (click to leave a slice out), outside the
 * pie on collision-free leader lines, inside the slices that have room, or
 * nowhere (the tooltip carries them).
 *
 * Past BAR_THRESHOLD slices (barRows.ts, `degradesToBars`) the pie stops being
 * readable at all and degrades to the shared horizontal BarList, the same
 * component the `bar` render draws.
 */

export const PIE_LABELS = ['legend', 'outside', 'inside', 'none'] as const;
export type PieLabels = (typeof PIE_LABELS)[number];

export function toPieLabels(v: unknown): PieLabels {
  return (PIE_LABELS as readonly unknown[]).includes(v) ? (v as PieLabels) : 'legend';
}

/** The id of the legend's "+N" overflow entry (never a slice). */
export const LEGEND_MORE_ID = '\u0000more';

/**
 * How many legend rows a beside-the-pie legend column of `height` px holds: one
 * key row is ~1.5 font heights, 4px (--space-1) between rows. A legend with more
 * slices than this shows the first ones and a "+N" row, so it never overflows
 * the card; the hidden slices still read out on hover.
 */
export function pieLegendCapacity(height: number, fontPx: number): number {
  const pitch = Math.ceil(fontPx * 1.5) + 4;
  return Math.max(1, Math.floor((height + 4) / pitch));
}

/** Legend items for `count` slices in a column that holds `capacity` rows: all, or the first ones plus "+N". */
export function fitLegend<T>(items: readonly T[], capacity: number): { shown: T[]; more: number } {
  if (items.length <= capacity) return { shown: [...items], more: 0 };
  const keep = Math.max(1, capacity - 1);
  return { shown: items.slice(0, keep), more: items.length - keep };
}

/** Inner radius of a donut, as a share of the outer one. */
export const DONUT_HOLE = 0.6;
/** How far a hovered slice lifts out along its bisector. */
const LIFT = 4;
const TAU = Math.PI * 2;

const f = (n: number) => Number(n.toFixed(2));

/**
 * One slice as a path: a wedge (`ri` 0) or a ring sector. A slice that is the
 * whole circle is drawn as two half arcs: a single arc whose endpoints
 * coincide renders nothing, per the SVG spec.
 */
export function slicePath(cx: number, cy: number, r: number, ri: number, a0: number, a1: number): string {
  if (a1 - a0 >= TAU - 1e-6) {
    const outer = `M${f(cx + r)},${f(cy)}A${f(r)},${f(r)} 0 1 1 ${f(cx - r)},${f(cy)}A${f(r)},${f(r)} 0 1 1 ${f(cx + r)},${f(cy)}Z`;
    if (ri <= 0) return outer;
    return `${outer}M${f(cx + ri)},${f(cy)}A${f(ri)},${f(ri)} 0 1 0 ${f(cx - ri)},${f(cy)}A${f(ri)},${f(ri)} 0 1 0 ${f(cx + ri)},${f(cy)}Z`;
  }
  const at = (rad: number, a: number) => `${f(cx + rad * Math.cos(a))},${f(cy + rad * Math.sin(a))}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  if (ri <= 0) return `M${f(cx)},${f(cy)}L${at(r, a0)}A${f(r)},${f(r)} 0 ${large} 1 ${at(r, a1)}Z`;
  return `M${at(r, a0)}A${f(r)},${f(r)} 0 ${large} 1 ${at(r, a1)}L${at(ri, a1)}A${f(ri)},${f(ri)} 0 ${large} 0 ${at(ri, a0)}Z`;
}

/** A ring sector (kept for callers of the old name). */
export function donutPath(cx: number, cy: number, r: number, ri: number, startAngle: number, endAngle: number): string {
  return slicePath(cx, cy, r, ri, startAngle, endAngle);
}

export interface PieSlice {
  id: string;
  label: string;
  value: number;
  other?: boolean;
}

export interface PieGeometryInput {
  slices: readonly PieSlice[];
  hidden?: ReadonlySet<string>;
  width: number;
  height: number;
  fontPx: number;
  measure: Measure;
  hole: boolean;
  labels: PieLabels;
  locale?: string;
}

export interface PieArc {
  id: string;
  index: number;
  value: number;
  share: number;
  a0: number;
  a1: number;
  d: string;
  /** Unit vector along the bisector (the hover lift). */
  mid: { x: number; y: number };
}

export interface PieGeometry {
  cx: number;
  cy: number;
  r: number;
  ri: number;
  total: number;
  arcs: PieArc[];
  outside: { id: string; name: string; share: string; x: number; y: number; anchor: 'start' | 'end'; leader: string }[];
  /** Share inside the slice, with the slice's name above it where both lines fit. */
  inside: { id: string; text: string; name: string | null; x: number; y: number }[];
}

/** A share as a short percent: one decimal under 10%, none above. */
export function shareText(frac: number, locale?: string): string {
  return formatNumber(frac, { format: 'percent', locale, maxDecimals: frac < 0.1 ? 1 : 0 });
}

/**
 * Pure pie geometry for a measured box: radius (leaving room for outside
 * labels), one arc per visible slice clockwise from 12 o'clock, outside labels
 * pushed apart per side so no two overlap, inside labels only where they fit.
 */
export function pieGeometry({ slices, hidden, width, height, fontPx, measure, hole, labels, locale }: PieGeometryInput): PieGeometry {
  const shown = slices.filter((s) => !hidden?.has(s.id) && s.value > 0);
  const total = shown.reduce((a, s) => a + s.value, 0);
  const cx = width / 2;
  const cy = height / 2;
  const rMax = Math.max(8, Math.min(width, height) / 2 - LIFT - 2);
  let r = rMax;
  const texts = shown.map((s) => ({ s, share: shareText(total > 0 ? s.value / total : 0, locale) }));
  if (labels === 'outside') {
    const widest = texts.reduce((m, x) => Math.max(m, measure(`${x.s.label} ${x.share}`)), 0);
    const room = Math.min(widest, width * 0.3) + 24;
    r = Math.max(Math.min(rMax, 28), Math.min(rMax, (width - 2 * room) / 2, height / 2 - fontPx));
  }
  const ri = hole ? r * DONUT_HOLE : 0;

  const arcs: PieArc[] = [];
  let a = -Math.PI / 2;
  shown.forEach((s) => {
    const share = total > 0 ? s.value / total : 0;
    const a0 = a;
    const a1 = a + share * TAU;
    a = a1;
    const m = (a0 + a1) / 2;
    arcs.push({
      id: s.id, index: slices.indexOf(s), value: s.value, share, a0, a1,
      d: slicePath(cx, cy, r, ri, a0, a1),
      mid: { x: Math.cos(m), y: Math.sin(m) },
    });
  });

  const outside: PieGeometry['outside'] = [];
  if (labels === 'outside' && arcs.length > 0) {
    const lh = fontPx * 1.4;
    const top = fontPx * 0.7;
    const bottom = height - fontPx * 0.7;
    for (const side of [1, -1]) {
      const items = arcs
        .map((arc, k) => ({ arc, k, y: cy + (r + 10) * arc.mid.y }))
        .filter((x) => (x.arc.mid.x >= 0 ? 1 : -1) === side)
        .sort((p, q) => p.y - q.y);
      // Push apart downward, then pull back up from the bottom edge: no two labels overlap.
      for (let i = 0; i < items.length; i++) {
        items[i].y = Math.max(items[i].y, i > 0 ? items[i - 1].y + lh : top);
      }
      for (let i = items.length - 1; i >= 0; i--) {
        items[i].y = Math.min(items[i].y, i < items.length - 1 ? items[i + 1].y - lh : bottom);
      }
      const textX = cx + side * (r + 18);
      const maxW = Math.max(fontPx * 2, (side > 0 ? width - textX : textX) - 2);
      for (const it of items) {
        const share = texts[it.k].share;
        const name = truncateToWidth(texts[it.k].s.label, Math.max(fontPx, maxW - measure(` ${share}`)), measure);
        const p0 = { x: cx + (r + 1) * it.arc.mid.x, y: cy + (r + 1) * it.arc.mid.y };
        const elbow = { x: cx + (r + 10) * it.arc.mid.x, y: it.y };
        outside.push({
          id: it.arc.id, name, share, x: textX, y: it.y, anchor: side > 0 ? 'start' : 'end',
          leader: `M${f(p0.x)},${f(p0.y)}L${f(elbow.x)},${f(elbow.y)}L${f(textX - side * 4)},${f(it.y)}`,
        });
      }
    }
  }

  const inside: PieGeometry['inside'] = [];
  if (labels === 'inside') {
    const rl = hole ? (r + ri) / 2 : r * 0.62;
    const thickness = hole ? r - ri : r;
    for (const arc of arcs) {
      const text = shareText(arc.share, locale);
      const span = arc.a1 - arc.a0;
      const chord = span >= Math.PI ? Infinity : 2 * rl * Math.sin(span / 2);
      if (measure(text) + 6 > chord || fontPx + 4 > thickness) continue;
      const m = (arc.a0 + arc.a1) / 2;
      // The name rides along when a second line fits (identity must not rest on colour alone).
      const label = slices[arc.index]?.label ?? '';
      const nameFits = label !== '' && thickness >= fontPx * 3 && span >= 0.5 && chord >= Math.min(measure(label), fontPx * 5) + 6;
      const name = nameFits ? truncateToWidth(label, chord - 6, measure) : null;
      inside.push({ id: arc.id, text, name, x: cx + rl * Math.cos(m), y: cy + rl * Math.sin(m) });
    }
  }
  return { cx, cy, r, ri, total, arcs, outside, inside };
}

/** The surface gap between strip segments (the same 2px the slices are split by). */
const STRIP_GAP = 2;
/** Thickest a share strip gets (a bar: thin mark). */
const STRIP_MAX = 24;

export interface StripSegment {
  id: string;
  index: number;
  value: number;
  share: number;
  x: number;
  w: number;
  /** Text inside the segment: "name share", the share alone, or nothing, whichever fits. */
  label: string | null;
}

/**
 * A compact frame's pie: the same shares as ONE horizontal 100% strip (the
 * part-to-whole form a wide, short cell can hold; dataviz), segments in slice
 * order split by a 2px surface gap, each labelled inside only where the text
 * fits (the tooltip reads the rest). Pure.
 */
export function pieStripGeometry({ slices, hidden, width, height, fontPx, measure, locale }: Omit<PieGeometryInput, 'hole' | 'labels'>): {
  top: number;
  thickness: number;
  total: number;
  segments: StripSegment[];
} {
  const shown = slices.filter((s) => !hidden?.has(s.id) && s.value > 0);
  const total = shown.reduce((a, s) => a + s.value, 0);
  const thickness = Math.max(4, Math.min(STRIP_MAX, height - 2));
  const top = (height - thickness) / 2;
  const room = Math.max(0, width - STRIP_GAP * Math.max(0, shown.length - 1));
  const textFits = thickness >= fontPx + 2;
  let x = 0;
  const segments = shown.map((s) => {
    const share = total > 0 ? s.value / total : 0;
    const w = share * room;
    const pct = shareText(share, locale);
    const both = `${s.label} ${pct}`;
    const label = !textFits ? null : measure(both) + 8 <= w ? both : measure(pct) + 8 <= w ? pct : null;
    const seg = { id: s.id, index: slices.indexOf(s), value: s.value, share, x, w, label };
    x += w + STRIP_GAP;
    return seg;
  });
  return { top, thickness, total, segments };
}

/**
 * Whether the donut's centre text fits its hole: the figure needs its width
 * inside ~85% of the hole's diameter, the caption a second line under it.
 */
export function centerTextFit(ri: number, value: string, fontPx: number, centerFont: number, measure: Measure): { value: boolean; caption: boolean } {
  const valueW = measure(value) * (centerFont / fontPx);
  const fitsValue = ri > 0 && valueW <= ri * 1.7 && ri >= fontPx * 1.2;
  return { value: fitsValue, caption: fitsValue && ri >= fontPx * 2.4 };
}

/** The label ink for text inside a slice of this colour (see lab-bar-pie-heat.css). */
function insideInk(slot: number | null): string {
  return slot === null ? 'var(--lab-other-ink)' : `var(--lab-cat-ink-${slot + 1})`;
}

export interface PieChartProps {
  /** Legacy input: one slice per series, sized by its latest value. */
  series?: Series[];
  /** Share rows (a board block), in display order; wins over `series`. */
  rows?: ShareRow[];
  /** Legacy fixed diameter; the chart now fills its box (the caller sizes the box). */
  size?: number;
  unit?: string | null;
  /** Detail panel: every row when degraded to bars. */
  full?: boolean;
  emptyHint?: string;
  /** Draw a ring instead of a filled pie. */
  donut?: boolean;
  /** The formatted total in the hole (a hole is drawn for it); hover shows the hovered slice there. */
  centerTotal?: boolean;
  labels?: PieLabels;
  /** Palette slot (1-8) of the first slice. */
  colorIndex?: number;
  format?: ChartFormat;
  /** Rank slices by value (the default); false keeps the rows' order (a block `sort`). */
  ranked?: boolean;
  /** A fixed pixel height; absent = fill the parent. */
  height?: number;
  /**
   * Every slice name before any pick, filter, sort or top N (BlockProps.colorDomain.rows):
   * colours key on it, so a surviving slice keeps its hue. Absent = the drawn slices.
   */
  colorDomain?: readonly string[] | null;
}

export function PieChart({
  series, rows, unit = null, full = false, emptyHint, donut = false, centerTotal = false, labels = 'legend',
  colorIndex = 1, format = 'auto', ranked = true, height, colorDomain = null,
}: PieChartProps) {
  const slices: ShareRow[] = rows ?? toBarRows(series ?? []);

  if (slices.length === 0) {
    return <ChartEmpty hint={emptyHint} />;
  }

  if (degradesToBars(slices.length)) {
    return (
      <div className="lab-pie-box" style={chartHeight(height)}>
        <BarList rows={slices} unit={unit} full={full} ranked={ranked} colorIndex={colorIndex} format={format} fill />
      </div>
    );
  }

  return (
    <div className="lab-pie-box" style={chartHeight(height)}>
      <PiePlot
        rows={ranked ? [...slices].sort((p, q) => Number(!!p.other) - Number(!!q.other) || q.value - p.value) : slices}
        unit={unit}
        hole={donut || centerTotal}
        centerTotal={centerTotal}
        labels={labels}
        colorIndex={colorIndex}
        format={format}
        colorDomain={colorDomain}
      />
    </div>
  );
}

function PiePlot({ rows, unit, hole, centerTotal, labels, colorIndex, format, colorDomain }: {
  colorDomain: readonly string[] | null;
  rows: ShareRow[];
  unit: string | null;
  hole: boolean;
  centerTotal: boolean;
  labels: PieLabels;
  colorIndex: number;
  format: ChartFormat;
}) {
  const { t, locale } = useI18n();
  const size = useChartSize();
  // The whole box (legend included) decides where the legend goes: beside a wide pie, under a tall one.
  const box = useChartSize();
  const slices = useMemo<PieSlice[]>(
    // A slice's id IS its entity name (what the colour domain lists); a repeated name gets a suffix.
    () => rows.map((r, i) => ({
      id: rows.findIndex((q) => q.name === r.name) === i ? r.name : `${r.name}\u0000${i}`,
      label: r.other ? otherLabel(t, r.other) : r.name,
      value: r.value,
      other: !!r.other,
    })),
    [rows, t],
  );
  const ids = useMemo(() => slices.map((s) => s.id), [slices]);
  // Colour follows the slice over the unfiltered domain (before a pick, filter, top N or legend toggle); Other is grey.
  const colors = useMemo(
    () => colorScale(entityDomain(colorDomain, ids), { start: colorIndex, other: slices.filter((s) => s.other).map((s) => s.id) }),
    [ids, slices, colorIndex, colorDomain],
  );
  const toggle = useSeriesToggle(ids);
  // Too short for a readable pie (chart/fit.ts compact): the shares as one strip, no legend.
  const sizeClass = box.ready ? chartSizeClass(box.width, box.height, size.fontPx) : 'regular';
  const compact = sizeClass === 'compact';
  const geo = useMemo(() => (size.ready && !compact
    ? pieGeometry({ slices, hidden: toggle.hidden, width: size.width, height: size.height, fontPx: size.fontPx, measure: size.measure, hole, labels, locale })
    : null), [size.ready, compact, size.width, size.height, size.fontPx, size.measure, slices, toggle.hidden, hole, labels, locale]);
  const hover = useMarkHover(size.ref, size.width, size.height);
  const fmt = { format, unit, locale };
  const strip = useMemo(() => (compact && size.ready
    ? pieStripGeometry({ slices, hidden: toggle.hidden, width: size.width, height: size.height, fontPx: size.fontPx, measure: size.measure, locale })
    : null), [compact, size.ready, size.width, size.height, size.fontPx, size.measure, slices, toggle.hidden, locale]);
  const activeSeg = strip && hover.active !== null ? strip.segments.find((g) => g.index === hover.active) ?? null : null;
  const arcActive = geo && hover.active !== null ? geo.arcs.find((a) => a.index === hover.active) ?? null : null;
  const active = strip ? activeSeg : arcActive;
  const activeSlice = active ? slices[active.index] : null;

  const tooltip: TooltipSpec | null = active && activeSlice && hover.anchor ? {
    anchor: hover.anchor,
    title: activeSlice.label,
    rows: [{
      id: activeSlice.id,
      label: t('lab.chart.share').replace('{pct}', shareText(active.share, locale)),
      value: formatValue(active.value, fmt),
      color: colors.color(activeSlice.id),
      shape: 'rect',
    }],
  } : null;

  const legendPos = box.ready && box.width < box.height * 1.15 && box.height >= 220 ? 'bottom' as const : 'right' as const;
  // A narrow beside-legend keeps the names and leaves the shares to the tooltip.
  const legendShares = !box.ready || legendPos === 'bottom' || box.width >= 300;
  const legendItems = geo ? slices.map((s) => {
    const arc = geo.arcs.find((a) => a.id === s.id);
    return { id: s.id, label: arc && legendShares ? `${s.label} ${shareText(arc.share, locale)}` : s.label, color: colors.color(s.id), shape: 'rect' as const };
  }) : [];
  // A column beside the pie holds only so many rows: the rest become "+N" (the pie's hover still reads them).
  const fitted = legendPos === 'right' && box.ready
    ? fitLegend(legendItems, pieLegendCapacity(box.height, size.fontPx))
    : { shown: legendItems, more: 0 };
  const legend = labels === 'legend' && geo && !compact
    ? {
        position: legendPos,
        items: fitted.more > 0
          ? [...fitted.shown, { id: LEGEND_MORE_ID, label: `+${fitted.more}`, color: 'transparent', shape: 'rect' as const }]
          : fitted.shown,
        hidden: toggle.hidden,
        onToggle: (id: string) => { if (id !== LEGEND_MORE_ID) toggle.toggle(id); },
      }
    : null;

  // The centre figure scales with the hole; its caption sits one line under it, the pair centred.
  const centerFont = geo ? Math.max(size.fontPx + 1, Math.min(28, geo.ri * 0.38)) : 0;
  const centerValue = geo ? formatValue(activeSlice && arcActive ? arcActive.value : geo.total, fmt) : '';
  const centerFit = geo ? centerTextFit(geo.ri, centerValue, size.fontPx, centerFont, size.measure) : { value: false, caption: false };
  // A lone figure centres on the hole; with its caption the pair centres together.
  const centerY = geo ? (centerFit.caption ? geo.cy + centerFont * 0.35 - size.fontPx * 0.6 : geo.cy + centerFont * 0.35) : 0;

  return (
    <div ref={box.ref} className="lab-pie-frame">
    <ChartFrame
      plotRef={size.ref}
      className="lab-pie-chart"
      data-chart="pie"
      data-labels={labels}
      data-hover-index={hover.active ?? ''}
      data-pie-form={compact ? 'strip' : 'pie'}
      data-size={sizeClass}
      fit={compact ? { size: 'compact', legend: 'none', form: 'wrap', capacity: 0 } : null}
      legend={legend}
      tooltip={tooltip}
    >
      {strip && (
        <svg
          className="lab-chart-svg"
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="img"
          aria-label={t(hole ? 'lab.chart.donut.aria' : 'lab.chart.pie.aria')}
          data-pie-strip=""
        >
          <g className="lab-pie-slices">
            {strip.segments.map((g) => {
              const s = slices[g.index];
              return (
                <rect
                  key={g.id}
                  className="lab-pie-slice lab-pie-strip-seg"
                  x={g.x}
                  y={strip.top}
                  width={Math.max(1, g.w)}
                  height={strip.thickness}
                  rx={Math.min(3, g.w / 2)}
                  fill={colors.color(s.id)}
                  data-slice={s.label}
                  data-share={g.share.toFixed(4)}
                  data-other={s.other ? 'true' : undefined}
                  data-dim={hover.active !== null && hover.active !== g.index ? 'true' : undefined}
                  aria-label={`${s.label}: ${formatValue(g.value, fmt)}, ${shareText(g.share, locale)}`}
                  {...hover.bind(g.index)}
                />
              );
            })}
          </g>
          {strip.segments.map((g) => (g.label ? (
            <text
              key={`l-${g.id}`}
              className="lab-pie-inside"
              data-pie-label="inside"
              x={g.x + g.w / 2}
              y={strip.top + strip.thickness / 2}
              dy="0.32em"
              textAnchor="middle"
              fill={insideInk(colors.slot(slices[g.index].id))}
            >
              {g.label}
            </text>
          ) : null))}
        </svg>
      )}
      {geo && !strip && (
        <svg
          className="lab-chart-svg"
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="img"
          aria-label={t(hole ? 'lab.chart.donut.aria' : 'lab.chart.pie.aria')}
          data-donut={hole ? '' : undefined}
        >
          <g className="lab-pie-slices">
            {geo.arcs.map((arc) => {
              const s = slices[arc.index];
              const on = hover.active === arc.index;
              const lift = on && geo.arcs.length > 1 ? `translate(${f(arc.mid.x * LIFT)} ${f(arc.mid.y * LIFT)})` : undefined;
              return (
                <path
                  key={arc.id}
                  className="lab-pie-slice"
                  d={arc.d}
                  fill={colors.color(s.id)}
                  fillRule="evenodd"
                  transform={lift}
                  data-slice={s.label}
                  data-share={arc.share.toFixed(4)}
                  data-other={s.other ? 'true' : undefined}
                  data-dim={hover.active !== null && !on ? 'true' : undefined}
                  aria-label={`${s.label}: ${formatValue(arc.value, fmt)}, ${shareText(arc.share, locale)}`}
                  {...hover.bind(arc.index)}
                />
              );
            })}
          </g>
          {geo.outside.map((l) => (
            <g key={l.id} data-pie-label="outside">
              <path className="lab-pie-leader" d={l.leader} />
              <text className="lab-pie-label" x={l.x} y={l.y} dy="0.32em" textAnchor={l.anchor}>
                {l.name} <tspan className="lab-pie-label-share">{l.share}</tspan>
              </text>
            </g>
          ))}
          {geo.inside.map((l) => {
            const s = slices.find((x) => x.id === l.id);
            return (
              <text key={l.id} className="lab-pie-inside" data-pie-label="inside" x={l.x} y={l.y} dy={l.name ? '-0.25em' : '0.32em'} textAnchor="middle" fill={insideInk(s ? colors.slot(s.id) : null)}>
                {l.name ? <><tspan className="lab-pie-inside-name">{l.name}</tspan><tspan x={l.x} dy="1.2em">{l.text}</tspan></> : l.text}
              </text>
            );
          })}
          {centerTotal && geo.ri > 0 && centerFit.value && (
            <g data-center-total="">
              <text className="lab-pie-center-value" x={geo.cx} y={centerY} textAnchor="middle" style={{ fontSize: centerFont }}>
                {centerValue}
              </text>
              {centerFit.caption && (
                <text className="lab-pie-center-label" x={geo.cx} y={centerY + size.fontPx * 1.4} textAnchor="middle">
                  {truncateToWidth(activeSlice ? activeSlice.label : t('lab.chart.totalCaption'), geo.ri * 1.6, size.measure)}
                </text>
              )}
            </g>
          )}
        </svg>
      )}
    </ChartFrame>
    </div>
  );
}

/** Registry body (`pie`). The panel gets the bigger pie and every row; a board cell's box is filled. */
export function PieBody({ summary, series, full = false, emptyHint, height }: ChartBodyProps) {
  return (
    <PieChart
      series={series}
      unit={summary.unit}
      height={height !== undefined ? undefined : full ? 280 : 170}
      full={full}
      emptyHint={emptyHint}
    />
  );
}
