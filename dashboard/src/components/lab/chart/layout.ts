/**
 * Cartesian layout: where the plot sits inside the measured cell once the y
 * tick labels (left) and x tick labels (bottom) have their room, and which
 * labels are drawn so no two ever overlap (thin first, rotate when the chart
 * asks for it: category axes, where every label matters).
 *
 * Everything is in real CSS pixels of the cell (no viewBox scaling), so text
 * is laid out and drawn at the size it is read at. Pure: the text measurer is
 * injected (`textMeasurer()` in the browser, `estimateTextWidth` in tests).
 */

export interface Rect { left: number; top: number; width: number; height: number }

/** A tick on an axis: its position along the axis (plot-local px) and its label. */
export interface AxisTick { pos: number; label: string; value?: number }

/** A drawn tick label: the tick plus where its text goes after collision handling. */
export interface PlacedLabel extends AxisTick {
  /** Horizontal shift applied so the label stays inside the cell (x axis). */
  dx: number;
}

export interface ResolvedAxis {
  /** Every tick (the grid draws them all). */
  ticks: AxisTick[];
  /** The ticks that carry a label, after thinning. */
  labels: PlacedLabel[];
  /** x axis only: labels are rotated -45deg (and may be truncated to `maxLabel` chars). */
  rotate: boolean;
  /** Pixels the axis band takes (x: height below the plot; y: width left of it). */
  band: number;
}

export type Measure = (text: string) => number;

/** Width estimate for a sans UI face at `fontPx` (tests and first paint before a canvas exists). */
export function estimateTextWidth(text: string, fontPx: number): number {
  let w = 0;
  for (const ch of text) {
    if (/[0-9]/.test(ch)) w += 0.6;
    else if (/[.,:;'|!il ]/.test(ch)) w += 0.3;
    else if (/[MWmw@%]/.test(ch)) w += 0.85;
    else if (/[A-Z]/.test(ch)) w += 0.68;
    else w += 0.55;
  }
  return w * fontPx;
}

let canvasCtx: CanvasRenderingContext2D | null | undefined;

/**
 * A measurer for `font` (a CSS font shorthand, e.g. "12px Inter"): canvas
 * `measureText` when a DOM exists, the estimate otherwise. Cached per string.
 */
export function textMeasurer(font: string, fontPx: number): Measure {
  if (canvasCtx === undefined) {
    canvasCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  const ctx = canvasCtx;
  const memo = new Map<string, number>();
  return (text) => {
    let w = memo.get(text);
    if (w === undefined) {
      if (ctx) {
        ctx.font = font;
        w = ctx.measureText(text).width;
      } else {
        w = estimateTextWidth(text, fontPx);
      }
      memo.set(text, w);
    }
    return w;
  };
}

/** Truncate `text` with an ellipsis to fit `maxPx`. */
export function truncateToWidth(text: string, maxPx: number, measure: Measure): string {
  if (measure(text) <= maxPx) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(chars.slice(0, mid).join('') + '…') <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '…' : chars.slice(0, lo).join('') + '…';
}

/**
 * The smallest stride k (draw every k-th label) at which no two drawn labels
 * overlap, given each label's width and its centre position (horizontal text).
 */
export function thinStride(ticks: readonly AxisTick[], widths: readonly number[], gap: number): number {
  const n = ticks.length;
  for (let k = 1; k <= Math.max(1, n); k++) {
    let ok = true;
    for (let i = k; i < n && ok; i += k) {
      const a = i - k;
      if (ticks[i].pos - ticks[a].pos < (widths[i] + widths[a]) / 2 + gap) ok = false;
    }
    if (ok) return k;
  }
  return Math.max(1, n);
}

export type XLabelMode = 'thin' | 'rotate';

export interface CartesianLayoutInput {
  width: number;
  height: number;
  fontPx: number;
  measure: Measure;
  showX: boolean;
  showY: boolean;
  /** Y ticks for a plot this tall (pos: 0 at the top). Called up to twice. */
  yTicks(plotHeight: number): AxisTick[];
  /** X ticks for a plot this wide (pos: 0 at the left). Called up to twice. */
  xTicks(plotWidth: number): AxisTick[];
  /** Crowded x labels: `thin` (time/number axes) or `rotate` (category axes; default thin). */
  xLabelMode?: XLabelMode;
  /** Breathing room around the whole chart. */
  padding?: Partial<Rect & { right: number; bottom: number }>;
}

export interface CartesianLayout {
  plot: Rect;
  x: ResolvedAxis;
  y: ResolvedAxis;
}

const TICK_GAP = 6;

function resolveY(ticks: AxisTick[], fontPx: number, measure: Measure): ResolvedAxis {
  const minSpacing = fontPx * 1.3;
  const labels: PlacedLabel[] = [];
  let last = -Infinity;
  // Ticks arrive top-first or bottom-first; thin on actual distance either way.
  for (const t of ticks) {
    if (Math.abs(t.pos - last) >= minSpacing) {
      labels.push({ ...t, dx: 0 });
      last = t.pos;
    }
  }
  const widest = labels.reduce((m, l) => Math.max(m, measure(l.label)), 0);
  return { ticks, labels, rotate: false, band: labels.length ? Math.ceil(widest) + TICK_GAP + 2 : 0 };
}

function resolveX(
  ticks: AxisTick[], plot: Rect, width: number, fontPx: number, measure: Measure, mode: XLabelMode, maxBand: number,
): ResolvedAxis {
  const gap = Math.max(6, fontPx * 0.75);
  const widths = ticks.map((t) => measure(t.label));
  const horizontalBand = Math.ceil(fontPx * 1.25) + TICK_GAP;
  const stride = thinStride(ticks, widths, gap);
  const rotateWanted = mode === 'rotate' && stride > 1;
  if (!rotateWanted) {
    const labels: PlacedLabel[] = [];
    let prevRight = -Infinity;
    for (let i = 0; i < ticks.length; i += stride) {
      const t = ticks[i];
      const w = widths[i];
      // Keep the text inside the cell, and out of the y labels' column (the bottom y label
      // sits in that corner): the absolute centre is plot.left + pos.
      const cx = plot.left + t.pos;
      const minC = Math.max(0, plot.left > 0 ? plot.left - TICK_GAP / 2 : 0) + w / 2;
      const maxC = width - w / 2;
      const dx = cx < minC ? minC - cx : cx > maxC ? maxC - cx : 0;
      // An edge clamp can push a label into its neighbour: the edge label stays, the neighbour yields.
      const left = cx + dx - w / 2;
      if (left < prevRight + gap) {
        if (dx === 0) continue;
        labels.pop();
      }
      labels.push({ ...t, dx });
      prevRight = cx + dx + w / 2;
    }
    return { ticks, labels, rotate: false, band: ticks.length ? horizontalBand : 0 };
  }
  // Rotated -45deg: successive labels need ~1.3 font heights between their anchors.
  const step = ticks.length > 1 ? Math.abs(ticks[1].pos - ticks[0].pos) : Infinity;
  const rotStride = Math.max(1, Math.ceil((fontPx * 1.3) / Math.max(1, step)));
  const longest = widths.reduce((m, w) => Math.max(m, w), 0);
  const band = Math.min(maxBand, Math.ceil(longest * Math.SQRT1_2 + fontPx * Math.SQRT1_2) + TICK_GAP);
  // A label longer than the band allows is truncated, never clipped by the cell edge.
  const maxLabel = Math.max(fontPx, (band - TICK_GAP) / Math.SQRT1_2 - fontPx);
  const labels: PlacedLabel[] = [];
  for (let i = 0; i < ticks.length; i += rotStride) {
    const t = ticks[i];
    // The text runs down-left from its tick: it may not cross the cell's left edge either.
    const leftRoom = (plot.left + t.pos) / Math.SQRT1_2;
    labels.push({ ...t, label: truncateToWidth(t.label, Math.max(fontPx, Math.min(maxLabel, leftRoom)), measure), dx: 0 });
  }
  return { ticks, labels, rotate: true, band };
}

/**
 * Lay out a cartesian chart in a `width` x `height` cell. Two passes: the x
 * band decides the plot height (and so the y ticks and their label width), the
 * y band decides the plot width (and so the x ticks and whether they rotate);
 * a rotation that grows the x band triggers one re-run of the y side.
 */
export function cartesianLayout(input: CartesianLayoutInput): CartesianLayout {
  const { width, height, fontPx, measure, showX, showY } = input;
  const pad = { top: Math.ceil(fontPx / 2) + 2, right: 8, bottom: 2, left: 0, ...input.padding };
  const mode = input.xLabelMode ?? 'thin';
  const maxRotBand = Math.max(fontPx * 2, height * 0.4);
  const empty: ResolvedAxis = { ticks: [], labels: [], rotate: false, band: 0 };

  let xBand = showX ? Math.ceil(fontPx * 1.25) + TICK_GAP : 0;
  let x = empty;
  let y = empty;
  let plot: Rect = { left: pad.left, top: pad.top, width: 0, height: 0 };
  for (let pass = 0; pass < 2; pass++) {
    const plotH = Math.max(1, height - pad.top - pad.bottom - xBand);
    y = showY ? resolveY(input.yTicks(plotH), fontPx, measure) : empty;
    const plotW = Math.max(1, width - pad.left - pad.right - y.band);
    plot = { left: pad.left + y.band, top: pad.top, width: plotW, height: plotH };
    x = showX ? resolveX(input.xTicks(plotW), plot, width, fontPx, measure, mode, maxRotBand) : empty;
    if (!showX || x.band <= xBand) break;
    xBand = x.band;
  }
  return { plot, x, y };
}
