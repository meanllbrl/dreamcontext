/**
 * Board grid geometry: the 12-column layout every board card sits on.
 *
 * PURE and SELF-CONTAINED on purpose: no imports, types declared inline,
 * ES2020 only. `scripts/gen-lab-mirrors.mjs` copies this file BYTE-IDENTICAL to
 * `dashboard/src/generated/grid.ts` (the dashboard cannot import `src/`), and
 * `tests/unit/lab-mirrors-drift.test.ts` fails when the copies differ. Edit
 * this file, then re-run the generator; never edit the copy.
 *
 * Used by the lenient board read (clamp + in-memory overlap resolution), the
 * strict write (overlaps are an error), the brain-sync merge (union, then
 * resolve), the dashboard grid (drag/resize snap) and its narrow layout.
 */

/** Columns on every board. */
export const GRID_COLUMNS = 12;
/** Tallest card, in rows. */
export const GRID_MAX_H = 24;
/** One row, in CSS pixels (the dashboard's row pitch). */
export const GRID_ROW_PX = 56;

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridItem {
  id: string;
  at: GridRect;
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/**
 * LENIENT geometry: any input becomes a legal rect. w 1..12, h 1..24,
 * x 0..12-w, y >= 0. Garbage falls back to a 4x3 card at the origin.
 */
export function clampRect(raw: unknown): GridRect {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const w = Math.min(GRID_COLUMNS, Math.max(1, toInt(r.w, 4)));
  const h = Math.min(GRID_MAX_H, Math.max(1, toInt(r.h, 3)));
  const x = Math.min(GRID_COLUMNS - w, Math.max(0, toInt(r.x, 0)));
  const y = Math.max(0, toInt(r.y, 0));
  return { x, y, w, h };
}

/** Is `r` already legal as written (integers, in range)? The strict write's check. */
export function isValidRect(r: GridRect): boolean {
  const ints = [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isInteger(n));
  return ints
    && r.w >= 1 && r.w <= GRID_COLUMNS
    && r.h >= 1 && r.h <= GRID_MAX_H
    && r.x >= 0 && r.x + r.w <= GRID_COLUMNS
    && r.y >= 0;
}

export function rectsOverlap(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Every overlapping pair, as ids, in item order. */
export function findOverlaps(items: readonly GridItem[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (rectsOverlap(items[i].at, items[j].at)) out.push([items[i].id, items[j].id]);
    }
  }
  return out;
}

/** Reading order: by (y, x), ties by original position. */
export function readingOrder<T extends GridItem>(items: readonly T[]): T[] {
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => a.item.at.y - b.item.at.y || a.item.at.x - b.item.at.x || a.idx - b.idx)
    .map((e) => e.item);
}

/**
 * Resolve overlaps deterministically: items are placed in reading order; an
 * item that overlaps one already placed moves DOWN one row at a time until it
 * fits. Nothing moves up and nothing moves sideways, so a layout with no
 * overlaps comes back unchanged. Returns new items in the input order.
 */
export function resolveOverlaps<T extends GridItem>(items: readonly T[]): T[] {
  const placed: GridRect[] = [];
  const moved = new Map<T, GridRect>();
  for (const item of readingOrder(items)) {
    const at = { ...item.at };
    while (placed.some((p) => rectsOverlap(p, at))) at.y += 1;
    placed.push(at);
    moved.set(item, at);
  }
  return items.map((item) => ({ ...item, at: moved.get(item)! }));
}

/**
 * Vertical compaction: after overlaps are resolved, every item floats up as
 * far as it can without overlapping (reading order). Used after a merge or a
 * removal so boards do not grow holes.
 */
export function compact<T extends GridItem>(items: readonly T[]): T[] {
  const resolved = resolveOverlaps(items);
  const placed: GridRect[] = [];
  const out = new Map<T, GridRect>();
  for (const item of readingOrder(resolved)) {
    const at = { ...item.at };
    while (at.y > 0 && !placed.some((p) => rectsOverlap(p, { ...at, y: at.y - 1 }))) at.y -= 1;
    placed.push(at);
    out.set(item, at);
  }
  return resolved.map((item) => ({ ...item, at: out.get(item)! }));
}

/** The first row below every item (0 on an empty board). */
export function gridBottom(items: readonly GridItem[]): number {
  let bottom = 0;
  for (const item of items) bottom = Math.max(bottom, item.at.y + item.at.h);
  return bottom;
}

/** First free slot for a w x h card, scanning rows top-down, columns left-right. */
export function findFreeSlot(items: readonly GridItem[], w: number, h: number): GridRect {
  const size = clampRect({ x: 0, y: 0, w, h });
  const limit = gridBottom(items) + 1;
  for (let y = 0; y <= limit; y++) {
    for (let x = 0; x + size.w <= GRID_COLUMNS; x++) {
      const at = { x, y, w: size.w, h: size.h };
      if (!items.some((item) => rectsOverlap(item.at, at))) return at;
    }
  }
  return { x: 0, y: limit, w: size.w, h: size.h };
}

/** Narrow (single-column) layout: the cards in reading order, full width. */
export function narrowOrder<T extends GridItem>(items: readonly T[]): T[] {
  return readingOrder(items);
}
