/**
 * The size-adaptive policy: what a chart keeps as its cell shrinks. Every
 * threshold is in tick-font heights, so it follows the app's zoom.
 *
 *   regular  everything the options ask for (the large sizes are unchanged).
 *   small    the LEGEND yields first: a wide-short frame takes it to the right
 *            (a column that fits, "+N" for the rest); otherwise it becomes one
 *            row (again "+N"), and below LEGEND_ROW_MIN it hides (the tooltip
 *            still names every series). Axes stay (y keeps 2 labels or none,
 *            layout.ts; x labels thin as always).
 *   compact  too short (or narrow) for axes to leave a readable plot: the chart
 *            draws a sparkline-style mark filling the frame, no axes, no grid,
 *            no legend, with direct end labels (series key, name, last value)
 *            beside it and a tooltip that floats outside the card.
 *
 * Pure: the chart measures its frame (useChartSize on the ChartFrame root) and
 * hands the numbers in.
 */
import type { LegendPosition } from './Legend';
import { truncateToWidth, type Measure } from './layout';
import type { KeyShape } from './Tooltip';

export type ChartSizeClass = 'regular' | 'small' | 'compact';

/** Below this frame height (tick-font heights) axes leave no readable plot: compact mode. */
export const COMPACT_HEIGHT = 5.5;
/** Below this frame width, likewise. */
export const COMPACT_WIDTH = 8;
/** Below this frame height (or SMALL_WIDTH) the legend starts to yield. */
export const SMALL_HEIGHT = 13;
export const SMALL_WIDTH = 22;
/** A small frame keeps a one-row legend only this tall; shorter, the legend hides. */
export const LEGEND_ROW_MIN = 10;
/** A small frame this wide moves its legend beside the plot (width is the cheap resource there). */
export const LEGEND_SIDE_MIN = 40;

const FALLBACK_FONT = 12;
const font = (fontPx: number) => (fontPx > 0 ? fontPx : FALLBACK_FONT);

/** The size class of a measured frame. Unmeasured (0 x 0, first paint) = regular. */
export function chartSizeClass(width: number, height: number, fontPx: number): ChartSizeClass {
  if (!(width > 0 && height > 0)) return 'regular';
  const f = font(fontPx);
  if (height < f * COMPACT_HEIGHT || width < f * COMPACT_WIDTH) return 'compact';
  if (height < f * SMALL_HEIGHT || width < f * SMALL_WIDTH) return 'small';
  return 'regular';
}

/** How the legend is laid out: wrapping rows (as asked), one row, or a column beside the plot. */
export type LegendForm = 'wrap' | 'row' | 'column';

export interface ChartFit {
  size: ChartSizeClass;
  /** Where the legend goes after the policy ('none' = hidden). */
  legend: LegendPosition;
  form: LegendForm;
  /** How many legend items are drawn; the rest fold into a "+N" entry. */
  capacity: number;
}

/** Rows a legend column of `height` px holds: a key row is ~1.5 font heights, 4px between rows. */
export function legendColumnCapacity(height: number, fontPx: number): number {
  const pitch = Math.ceil(font(fontPx) * 1.5) + 4;
  return Math.max(1, Math.floor((height + 4) / pitch));
}

/** A legend item's drawn width: key (a line key is the widest), 4px, the text, 4px padding each side. */
function legendItemWidth(label: string, fontPx: number, measure: Measure): number {
  return font(fontPx) + 4 + measure(label) + 8;
}

/**
 * How many of `labels` one legend row of `width` px holds, leaving room for a
 * "+N" entry when some do not fit. At least 1 (its label ellipsizes).
 */
export function legendRowCapacity(labels: readonly string[], width: number, fontPx: number, measure: Measure): number {
  const gap = 12;
  const widths = labels.map((l) => legendItemWidth(l, fontPx, measure));
  const all = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1);
  if (all <= width) return labels.length;
  const more = measure(`+${labels.length}`) + 8 + gap;
  let used = 0;
  let k = 0;
  while (k < widths.length && used + widths[k] + (k > 0 ? gap : 0) + more <= width) {
    used += widths[k] + (k > 0 ? gap : 0);
    k++;
  }
  return Math.max(1, k);
}

/**
 * The legend after the size policy. `labels` are the legend items' texts (none
 * = no legend); `legend` is the position the options ask for.
 */
export function chartFit(input: {
  width: number;
  height: number;
  fontPx: number;
  measure: Measure;
  legend: LegendPosition;
  labels: readonly string[];
}): ChartFit {
  const { width, height, fontPx, measure, labels } = input;
  const size = chartSizeClass(width, height, fontPx);
  const none: ChartFit = { size, legend: 'none', form: 'wrap', capacity: 0 };
  if (input.legend === 'none' || labels.length === 0) return none;
  if (size === 'regular') {
    return { size, legend: input.legend, form: input.legend === 'right' ? 'column' : 'wrap', capacity: labels.length };
  }
  if (size === 'compact') return none;
  const f = font(fontPx);
  if (width >= f * LEGEND_SIDE_MIN) {
    return { size, legend: 'right', form: 'column', capacity: Math.min(labels.length, legendColumnCapacity(height, f)) };
  }
  if (height >= f * LEGEND_ROW_MIN) {
    return {
      size,
      legend: input.legend === 'right' ? 'bottom' : input.legend,
      form: 'row',
      capacity: legendRowCapacity(labels, width, f, measure),
    };
  }
  return none;
}

// ─── Compact mode: the sparkline-style drawing and its direct end labels ─────

/** Inset of a compact mark from the frame edge (an end dot's radius plus its ring). */
export const COMPACT_PAD = 4;

export interface EndLabelItem {
  id: string;
  color: string;
  shape: KeyShape;
  /** The series name ('' = a single series: the value alone). Untrusted: drawn as text. */
  name: string;
  /** The formatted value ('' = a name-only key, e.g. a bar series). */
  value: string;
}

export interface PlacedEndLabel extends EndLabelItem {
  /** The name as drawn (truncated with an ellipsis when the label would pass its budget). */
  shownName: string;
  /** Left edge of the key, frame px. */
  x: number;
  /** Text baseline centre (the key and text are centred on it), frame px. */
  y: number;
}

export interface EndLabels {
  placed: PlacedEndLabel[];
  /** Items that did not fit (drawn as "+N" after the last one). */
  more: number;
  /** Where the "+N" goes, when there is one. */
  moreAt: { x: number; y: number } | null;
  /** Width the labels take from the right of the frame, gap included (0 = none). */
  width: number;
}

/** Key swatch plus the gap after it. */
const KEY_W = 14;
const ITEM_GAP = 12;

/** One label's text as drawn: name then value, separated by a space. */
export function endLabelText(it: EndLabelItem): string {
  return it.name && it.value ? `${it.name} ${it.value}` : it.name || it.value;
}

/**
 * Direct end labels for a compact chart, right-aligned in the frame: one per
 * line while they fit vertically, otherwise flowed into the lines there are,
 * "+N" for the rest. They take at most `maxShare` of the width (names are
 * truncated by the renderer to `nameMax`), so the mark always keeps the most.
 */
export function compactEndLabels(items: readonly EndLabelItem[], opts: {
  width: number;
  height: number;
  fontPx: number;
  measure: Measure;
  maxShare?: number;
}): EndLabels {
  const { width, height, measure } = opts;
  const f = font(opts.fontPx);
  const empty: EndLabels = { placed: [], more: 0, moreAt: null, width: 0 };
  if (items.length === 0 || width <= 0 || height <= 0) return empty;
  const budget = Math.max(f * 4, width * (opts.maxShare ?? 0.45));
  const lineH = f * 1.35;
  const lines = Math.max(1, Math.floor(height / lineH));
  // The value is semibold (~8% wider than the regular face the measurer reads), plus the name's space.
  const textW = (it: EndLabelItem) => (it.name ? measure(it.name) + f * 0.3 : 0) + (it.value ? measure(it.value) * 1.08 : 0);
  const w = (it: EndLabelItem) => KEY_W + textW(it);
  const moreW = (n: number) => measure(`+${n}`);

  // Flow items into rows of at most `budget` px, `lines` rows at most.
  const rows: EndLabelItem[][] = [[]];
  const rowW: number[] = [0];
  let placedCount = 0;
  for (const it of items) {
    const need = Math.min(w(it), budget);
    const r = rows.length - 1;
    const add = rowW[r] === 0 ? need : ITEM_GAP + need;
    // One per line while there are lines for every item (a column reads cleanest).
    const column = items.length <= lines && rows[r].length > 0;
    if (!column && rowW[r] + add <= budget) {
      rows[r].push(it);
      rowW[r] += add;
    } else if (rows.length < lines && rows[r].length > 0) {
      rows.push([it]);
      rowW.push(need);
    } else if (rows[r].length === 0) {
      rows[r].push(it);
      rowW[r] = need;
    } else {
      break;
    }
    placedCount++;
  }
  let more = items.length - placedCount;
  // Room for "+N" on the last row: give back items until it fits.
  if (more > 0) {
    const last = rows.length - 1;
    while (rows[last].length > 1 && rowW[last] + ITEM_GAP + moreW(more) > budget) {
      const it = rows[last].pop() as EndLabelItem;
      rowW[last] -= ITEM_GAP + Math.min(w(it), budget);
      more++;
    }
  }
  const colW = Math.max(...rowW, more > 0 ? rowW[rows.length - 1] + ITEM_GAP + moreW(more) : 0);
  const blockW = Math.min(budget, colW);
  // 2px clear of the frame's right edge: text never touches the clip.
  const left = width - blockW - 2;
  const top = (height - rows.length * lineH) / 2 + lineH / 2;
  const placed: PlacedEndLabel[] = [];
  let moreAt: EndLabels['moreAt'] = null;
  rows.forEach((row, r) => {
    let x = left;
    const y = top + r * lineH;
    row.forEach((it) => {
      const shownName = w(it) <= budget || !it.name
        ? it.name
        : truncateToWidth(it.name, Math.max(f, budget - KEY_W - f * 0.3 - (it.value ? measure(it.value) * 1.08 : 0)), measure);
      placed.push({ ...it, shownName, x, y });
      x += Math.min(w(it), budget) + ITEM_GAP;
    });
    if (more > 0 && r === rows.length - 1) moreAt = { x, y };
  });
  return { placed, more, moreAt, width: blockW + ITEM_GAP + 2 };
}
