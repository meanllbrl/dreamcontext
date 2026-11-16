import { elementBBox, liveElements, unionBBox, type BBox } from './ops.js';
import { elementTag, type WhiteboardElement } from './widgets.js';

/**
 * Cut a board into pictures a phone can read (owner, 2026-11-17: a 97-section board shrunk to
 * one 2000px picture could not be read). How many pictures come out follows from the board
 * itself, never a fixed count:
 *
 *  - `tags`: one picture per tagged group (and per named frame), in reading order (top to
 *    bottom, then left to right), drawing only that group (and loose elements inside it, never
 *    a neighbour reaching into its margin); what belongs to no group comes in bands after them.
 *  - `bands`: the whole board in reading order, tile by tile.
 *
 * A group up to {@link GROUP_SLACK} tiles stays whole; a larger one is cut further, at the gaps
 * between its elements: a line of text is never cut sideways. A tile is sized from the board's own
 * body text: at most {@link TILE_COLUMNS} characters of it across, at most {@link TILE_RATIO} times as tall (a
 * portrait a phone scrolls). Cuts are moved into the empty space between elements where there is one, so a
 * card or a line of text is cut only when nothing else fits.
 */

export type SplitMode = 'tags' | 'bands';
export const SPLIT_MODES: readonly SplitMode[] = ['tags', 'bands'];

export interface Section {
  /** `#tag`, a frame's name, or `part N` (bands), with ` (2/3)` when a group is cut further. */
  label: string;
  region: BBox;
  tag?: string;
  /** The elements this picture draws (absent: everything in the region). */
  ids?: ReadonlySet<string>;
}

/** How many characters of the board's body text fit across one tile. */
export const TILE_COLUMNS = 40;
/** Height to width of a tile: a phone scrolls a tall picture, and Telegram crops an album tile
 *  only past 1:2, so a tile stays under that. */
export const TILE_RATIO = 1.8;
const PAD = 40;
/** A group up to this many tiles across (and down) stays one picture. Kept small on purpose:
 *  measured at a phone's width, a section kept whole at 1.5 tiles set its body text near 3pt;
 *  readable text wins over keeping a section's text beside its picture (owner, 2026-11-17). */
export const GROUP_SLACK = 1.15;

/** The size body text is set at on this board: the size half its characters are set at or
 *  under (titles are few characters, body text many), 16 when there is no text. */
export function bodyFontSize(elements: readonly WhiteboardElement[]): number {
  const sized = liveElements(elements)
    .filter((el) => el.type === 'text' && typeof el.fontSize === 'number' && Number.isFinite(el.fontSize) && (el.fontSize as number) > 0)
    .map((el) => ({ size: el.fontSize as number, chars: Math.max(1, typeof el.text === 'string' ? el.text.length : 1) }))
    .sort((a, b) => a.size - b.size);
  if (!sized.length) return 16;
  const half = sized.reduce((n, s) => n + s.chars, 0) / 2;
  let seen = 0;
  for (const s of sized) {
    seen += s.chars;
    if (seen >= half) return Math.max(10, Math.min(40, s.size));
  }
  return 16;
}

/** The largest board box one readable picture covers. */
export function tileSize(elements: readonly WhiteboardElement[]): { w: number; h: number } {
  const w = bodyFontSize(elements) * TILE_COLUMNS;
  return { w, h: Math.round(w * TILE_RATIO) };
}

type Span = [number, number];

/** Merge overlapping spans, sorted. */
function mergeSpans(spans: Span[]): Span[] {
  const s = spans.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out: Span[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Cut [start, end] into pieces no longer than `max`, each cut placed in a gap between `spans`
 * when one lies in the second half of the piece; otherwise a hard cut at `max`.
 */
export function cutAxis(start: number, end: number, max: number, spans: Span[]): number[] {
  const merged = mergeSpans(spans);
  const cuts = [start];
  let at = start;
  while (end - at > max) {
    const limit = at + max;
    let best: number | null = null;
    for (let i = 0; i <= merged.length; i++) {
      // The gap before span i (or after the last span).
      const gapStart = i === 0 ? -Infinity : merged[i - 1][1];
      const gapEnd = i === merged.length ? Infinity : merged[i][0];
      const lo = Math.max(gapStart, at + max / 2);
      const hi = Math.min(gapEnd, limit);
      if (hi < lo) continue;
      // The middle of the gap when it fits, so neither side is cut close; else its usable end.
      const mid = (gapStart + gapEnd) / 2;
      const pick = Number.isFinite(mid) ? Math.max(lo, Math.min(hi, mid)) : hi;
      best = Math.max(best ?? -Infinity, pick);
    }
    at = best !== null && best > at ? best : limit;
    cuts.push(at);
  }
  cuts.push(end);
  return cuts;
}

/** Elements whose box reaches into `region`. */
/** A zero-width or zero-height box (a straight divider) counts as one unit thick, so it lands in
 *  the cell on one side of a cut that falls exactly on it, never in neither. */
const thick = (b: BBox): BBox => (b.w > 0 && b.h > 0 ? b : { x: b.x, y: b.y, w: Math.max(b.w, 1), h: Math.max(b.h, 1) });

/**
 * The boxes whose content must not be cut sideways: text, pictures and widgets. A frame, a
 * background shape or a divider line spanning a section is a container, not content: it never
 * glues the columns inside it into one cluster.
 */
const CONTENT_BOXES = new WeakSet<BBox>();

function inside(boxes: readonly BBox[], region: BBox): BBox[] {
  return boxes.filter((raw) => {
    const b = thick(raw);
    return b.x < region.x + region.w && b.x + b.w > region.x && b.y < region.y + region.h && b.y + b.h > region.y;
  });
}

/** A cluster wider than this many tiles is cut sideways anyway (a huge diagram); a narrower one never is. */
export const WIDE_CLUSTER_TILES = 3;

/**
 * One axis cut into pieces. The natural pieces are the clusters of what lies there (spans that
 * touch or overlap merge), joined while they fit `max × GROUP_SLACK`. Across (x), a cluster is
 * never cut unless it is wider than {@link WIDE_CLUSTER_TILES} tiles, so a line of text stays
 * whole; down (y), a cluster taller than a tile is paged at its gaps (or at the tile height).
 */
function splitAxis(start: number, end: number, spans: Span[], max: number, axis: 'x' | 'y', steer: Span[]): number[] {
  const clusters = mergeSpans(spans.map(([a, b]) => [Math.max(start, a), Math.min(end, b)] as Span));
  if (!clusters.length) return [start, end];
  const cuts = [start];
  let groupStart = start;
  let groupEnd = clusters[0][1];
  const close = (next: number) => { cuts.push(next); groupStart = next; };
  for (let i = 0; i < clusters.length; i++) {
    const [a, b] = clusters[i];
    if (i > 0) {
      if (b - groupStart <= max * GROUP_SLACK) { groupEnd = b; continue; }
      close((groupEnd + a) / 2);
    }
    groupEnd = b;
    const size = b - groupStart;
    if (axis === 'x' ? size > max * WIDE_CLUSTER_TILES : size > max * GROUP_SLACK) {
      // Page this cluster: at its own gaps down, evenly across.
      const inner = axis === 'y'
        ? cutAxis(groupStart, b, max, steer.filter(([p, q]) => q > groupStart && p < b))
        : Array.from({ length: Math.ceil(size / max) + 1 }, (_, k) => groupStart + (size * k) / Math.ceil(size / max));
      for (const c of inner.slice(1, -1)) close(c);
    }
  }
  cuts.push(end);
  return cuts.filter((c, i) => i === 0 || c > cuts[i - 1]);
}

/** Tiles covering `region`, one axis first then the other inside each piece. */
function tileOrder(region: BBox, here: readonly BBox[], tile: { w: number; h: number }, first: 'x' | 'y'): BBox[] {
  const spanOf = (raw: BBox, axis: 'x' | 'y'): Span => { const b = thick(raw); return axis === 'x' ? [b.x, b.x + b.w] : [b.y, b.y + b.h]; };
  // Clusters form from content, and from containers only where they fit a tile on that axis.
  const clusterSpans = (items: readonly BBox[], axis: 'x' | 'y') =>
    items.filter((b) => CONTENT_BOXES.has(b) || (axis === 'x' ? b.w : b.h) <= max(axis)).map((b) => spanOf(b, axis));
  const lo = (axis: 'x' | 'y') => (axis === 'x' ? region.x : region.y);
  const hi = (axis: 'x' | 'y') => (axis === 'x' ? region.x + region.w : region.y + region.h);
  const max = (axis: 'x' | 'y') => (axis === 'x' ? tile.w : tile.h);
  const steer = (items: readonly BBox[], axis: 'x' | 'y') => items.filter((b) => (axis === 'x' ? b.w : b.h) <= max(axis)).map((b) => spanOf(b, axis));
  const second: 'x' | 'y' = first === 'x' ? 'y' : 'x';
  const outer = splitAxis(lo(first), hi(first), clusterSpans(here, first), max(first), first, steer(here, first));
  const out: BBox[] = [];
  for (let i = 0; i < outer.length - 1; i++) {
    const strip: BBox = first === 'y'
      ? { x: region.x, y: outer[i], w: region.w, h: outer[i + 1] - outer[i] }
      : { x: outer[i], y: region.y, w: outer[i + 1] - outer[i], h: region.h };
    const inStrip = inside(here, strip);
    if (!inStrip.length) continue;
    const s0 = second === 'x' ? strip.x : strip.y;
    const s1 = second === 'x' ? strip.x + strip.w : strip.y + strip.h;
    const inner = splitAxis(s0, s1, clusterSpans(inStrip, second), max(second), second, steer(inStrip, second));
    for (let j = 0; j < inner.length - 1; j++) {
      const cell: BBox = second === 'x'
        ? { x: inner[j], y: strip.y, w: inner[j + 1] - inner[j], h: strip.h }
        : { x: strip.x, y: inner[j], w: strip.w, h: inner[j + 1] - inner[j] };
      const items = inside(inStrip, cell);
      if (!items.length) continue;
      // Shrink to what is there (clipped to the cell), padded a little.
      const u = unionBBox(items)!;
      const x0 = Math.max(cell.x, u.x - PAD / 2);
      const y0 = Math.max(cell.y, u.y - PAD / 2);
      const x1 = Math.min(cell.x + cell.w, u.x + u.w + PAD / 2);
      const y1 = Math.min(cell.y + cell.h, u.y + u.h + PAD / 2);
      out.push({ x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) });
    }
  }
  // Reading order whichever way it was cut: top to bottom, then left to right.
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Tiles covering `region`: cut rows-first and columns-first, and keep the one that needs fewer
 * pictures (a section's text column and its picture column stay two pictures, not four).
 * Tiles with nothing in them are dropped.
 */
export function tileRegion(region: BBox, boxes: readonly BBox[], tile: { w: number; h: number }): BBox[] {
  const here = inside(boxes, region);
  const rows = tileOrder(region, here, tile, 'y');
  const cols = tileOrder(region, here, tile, 'x');
  return cols.length < rows.length ? cols : rows;
}

const pad = (b: BBox, p = PAD): BBox => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });

const within = (b: BBox, r: BBox) => b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;

/** The board's sections, in reading order, each one readable picture. */
export function splitBoard(elements: readonly WhiteboardElement[], mode: SplitMode): Section[] {
  const live = liveElements(elements);
  const tile = tileSize(live);
  const boxes = live.map(elementBBox);
  live.forEach((el, i) => { if (el.type === 'text' || el.type === 'image' || el.type === 'embeddable' || el.type === 'iframe') CONTENT_BOXES.add(boxes[i]); });
  const all = unionBBox(boxes);
  if (!all) return [];
  const sections: Section[] = [];
  if (mode === 'bands') {
    tileRegion(pad(all), boxes, tile).forEach((t, i) => sections.push({ label: `part ${i + 1}`, region: t }));
    return sections;
  }
  // Groups: a tag, else the named frame an element sits in (or that the frame is).
  const frames = new Map<string, string>();
  for (const el of live) if ((el.type === 'frame' || el.type === 'magicframe') && typeof el.id === 'string') frames.set(el.id, typeof el.name === 'string' && el.name.trim() ? el.name.trim() : 'Frame');
  const groups = new Map<string, { label: string; tag?: string; ids: Set<string>; boxes: BBox[] }>();
  const loose: { id: string; box: BBox }[] = [];
  live.forEach((el, i) => {
    const id = String(el.id);
    const tag = elementTag(el);
    const frameId = typeof el.frameId === 'string' && frames.has(el.frameId) ? el.frameId : frames.has(id) ? id : null;
    const key = tag ? `t:${tag}` : frameId ? `f:${frameId}` : null;
    if (!key) { loose.push({ id, box: boxes[i] }); return; }
    const g = groups.get(key) ?? { label: tag ? `#${tag}` : frames.get(frameId!)!, ...(tag ? { tag } : {}), ids: new Set<string>(), boxes: [] };
    g.ids.add(id);
    g.boxes.push(boxes[i]);
    groups.set(key, g);
  });
  const ordered = [...groups.values()].map((g) => ({ ...g, raw: unionBBox(g.boxes)!, box: pad(unionBBox(g.boxes)!) }))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const claimed = new Set<string>();
  for (const g of ordered) {
    // A group's picture shows the group and what no group holds inside its box; never a
    // neighbouring group that reaches into the padding.
    const ids = new Set(g.ids);
    // Everything this group's pictures claim steers and keeps its tiles: a hand-pasted picture
    // (no tag) inside the group is drawn in one of them, never dropped with an empty cell.
    const own = [...g.boxes];
    for (const l of loose) if (within(l.box, g.box)) { ids.add(l.id); claimed.add(l.id); own.push(l.box); }
    const tiles = g.raw.w <= tile.w * GROUP_SLACK && g.raw.h <= tile.h * GROUP_SLACK ? [g.box] : tileRegion(g.box, own, tile);
    tiles.forEach((t, i) => sections.push({ label: tiles.length > 1 ? `${g.label} (${i + 1}/${tiles.length})` : g.label, region: t, ids, ...(g.tag ? { tag: g.tag } : {}) }));
  }
  // What no group holds, in bands after the groups.
  const rest = loose.filter((l) => !claimed.has(l.id));
  const restBox = unionBBox(rest.map((l) => l.box));
  if (restBox) {
    const ids = new Set(rest.map((l) => l.id));
    tileRegion(pad(restBox), rest.map((l) => l.box), tile).forEach((t, i) => sections.push({ label: `other ${i + 1}`, region: t, ids }));
  }
  return sections;
}
