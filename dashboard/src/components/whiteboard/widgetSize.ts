/**
 * Widget sizes and grid placement (A17), as pure math over the contract in
 * `lib/whiteboardWidgets.ts`: which preset a widget is, where a moved widget lands on the grid,
 * and what a resize snaps to.
 *
 * Snapping runs once, on pointer-up, against the geometry the widget had at pointer-down, so
 * Excalidraw is never fought mid-drag. Every function answers "nothing to do" (null) when the
 * widget is already where it would snap to, which is what keeps the follow-up `updateScene`
 * from looping.
 *
 * No React, no CSS, no Excalidraw import: root vitest imports this file.
 */
import {
  WIDGET_GRID, WIDGET_SIZES, isWidgetSize, nearestWidgetSize, type WidgetSize,
} from '../../lib/whiteboardWidgets';

/** One grid step: a cell plus the gap after it. A widget's x/y sit on multiples of this. */
export const GRID_PITCH = WIDGET_GRID.cell + WIDGET_GRID.gap;

export const WIDGET_SIZE_ORDER: readonly WidgetSize[] = ['s', 'm', 'l', 'xl'];

export interface WidgetGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A free-form resize rounds the box to this step, so sizes stay tidy without forcing a preset. */
export const RESIZE_STEP = 4;

/** The smallest box a resize leaves a widget: below it the header and one row no longer fit. */
export const MIN_WIDGET_BOX = { width: 120, height: 96 } as const;

function snapToStep(v: number): number {
  return Math.round(v / RESIZE_STEP) * RESIZE_STEP;
}

/** True when the box is exactly a preset's box: the size control shows that preset as current. */
export function isPresetBox(width: number, height: number, size: WidgetSize): boolean {
  const [pw, ph] = WIDGET_SIZES[size];
  return width === pw && height === ph;
}

/** The nearest grid line to a scene coordinate. */
export function snapToGrid(v: number): number {
  // `|| 0` folds the -0 that rounding a small negative gives.
  return Math.round(v / GRID_PITCH) * GRID_PITCH || 0;
}

/** The preset a widget is: its recorded `dc.size`, or (a Phase-1 or free-form widget) the
 *  preset nearest its box. */
export function widgetSizeOf(recorded: unknown, width: number, height: number): WidgetSize {
  return isWidgetSize(recorded) ? recorded : nearestWidgetSize(width, height);
}

export function sizeBox(size: WidgetSize): { width: number; height: number } {
  const [width, height] = WIDGET_SIZES[size];
  return { width, height };
}

/** Where a widget of `size` lands when it is given that size in place: top-left kept, on the grid. */
export function resizeInPlace(geom: WidgetGeometry, size: WidgetSize): WidgetGeometry & { size: WidgetSize } {
  return { x: snapToGrid(geom.x), y: snapToGrid(geom.y), ...sizeBox(size), size };
}

/**
 * What a widget snaps to after a gesture took it from `before` to `after`, or null when the
 * gesture did not move or resize it, or when it already sits exactly where it would snap to.
 *
 * - A resize is free-form: the box keeps the size the user dragged it to (a phone-width web
 *   widget, a tall checklist), rounded to the fine `RESIZE_STEP` (every preset and the grid pitch are multiples of it) and held to `MIN_WIDGET_BOX`.
 *   The edge the user did not drag stays put. `dc.size` records the NEAREST preset, which only
 *   picks the content layout; the S / M / L / XL control snaps the box back to a preset.
 * - A move keeps the widget's size and puts its top-left on the nearest line: a grid line, or
 *   one taken from a nearby widget (`snapMoveTo`), so a card resized shorter than a cell can
 *   still sit one gap under or beside another instead of a whole pitch away.
 * - `snapMove: false` skips the move snap (the gesture also moved free drawing, whose relative
 *   placement to the widget must not change); a resize still snaps.
 */
export function snapAfterGesture(
  before: WidgetGeometry,
  after: WidgetGeometry,
  recorded: unknown,
  opts: { snapMove?: boolean; neighbours?: readonly WidgetGeometry[] } = {},
): (WidgetGeometry & { size: WidgetSize }) | null {
  const resized = before.width !== after.width || before.height !== after.height;
  const moved = before.x !== after.x || before.y !== after.y;
  if (!resized && !moved) return null;
  if (!resized && opts.snapMove === false) return null;

  let next: WidgetGeometry & { size: WidgetSize };
  if (resized) {
    const width = Math.max(MIN_WIDGET_BOX.width, snapToStep(after.width));
    const height = Math.max(MIN_WIDGET_BOX.height, snapToStep(after.height));
    const leftDragged = after.x !== before.x;
    const topDragged = after.y !== before.y;
    const x = leftDragged ? before.x + before.width - width : before.x;
    const y = topDragged ? before.y + before.height - height : before.y;
    next = { x, y, width, height, size: nearestWidgetSize(width, height) };
  } else {
    const size = widgetSizeOf(recorded, after.width, after.height);
    next = { ...snapMoveTo(after, opts.neighbours ?? []), width: after.width, height: after.height, size };
  }
  return isSameSnap(after, recorded, next) ? null : next;
}

/**
 * Where a moved widget's top-left lands: on each axis, the nearest of the grid lines and the
 * lines a nearby widget offers (its own edge, to align with it, or its far edge plus one grid
 * gap, to sit beside it; both sides). A widget counts as nearby on an axis when it is within
 * one pitch of the moved box across the other axis, so a card at the far end of the board does
 * not pull. A tie goes to the neighbour.
 */
export function snapMoveTo(box: WidgetGeometry, neighbours: readonly WidgetGeometry[]): { x: number; y: number } {
  const gap = WIDGET_GRID.gap;
  const near = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 + GRID_PITCH && b0 < a1 + GRID_PITCH;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of neighbours) {
    if (near(box.y, box.y + box.height, n.y, n.y + n.height)) {
      xs.push(n.x, n.x + n.width + gap, n.x - box.width - gap, n.x + n.width - box.width);
    }
    if (near(box.x, box.x + box.width, n.x, n.x + n.width)) {
      ys.push(n.y, n.y + n.height + gap, n.y - box.height - gap, n.y + n.height - box.height);
    }
  }
  const pick = (v: number, lines: number[]) => {
    let best = snapToGrid(v);
    for (const l of lines) if (Math.abs(l - v) <= Math.abs(best - v)) best = l;
    return best || 0;
  };
  return { x: pick(box.x, xs), y: pick(box.y, ys) };
}

function isSameSnap(geom: WidgetGeometry, recorded: unknown, next: WidgetGeometry & { size: WidgetSize }): boolean {
  return geom.x === next.x && geom.y === next.y && geom.width === next.width && geom.height === next.height
    && recorded === next.size;
}

/** The top-left of a new widget of `size` (a preset, or a kind's own default box) centred on a scene point, on the grid. */
export function placeNewWidget(at: { x: number; y: number }, size: WidgetSize | { width: number; height: number }): WidgetGeometry {
  const { width, height } = typeof size === 'string' ? sizeBox(size) : size;
  return { x: snapToGrid(at.x - width / 2), y: snapToGrid(at.y - height / 2), width, height };
}

/**
 * How many todo rows an INACTIVE widget of `size` shows before it says "+N more". Derived from
 * the box height (the preset's when none is given), not measured, so the cut is the same on
 * every machine and every zoom: the body is the box minus the header and padding, a row is
 * 28px. XL lays rows in two columns.
 */
export const TODO_ROW_PX = 28;
const TODO_CHROME_PX = 60;

export function todoCapacity(size: WidgetSize, height: number = WIDGET_SIZES[size][1]): number {
  const rows = Math.max(1, Math.floor((height - TODO_CHROME_PX) / TODO_ROW_PX));
  return size === 'xl' ? rows * 2 : rows;
}

/** The items to show and how many were left out. When clipped, the "+N more" line takes a row. */
export function clipTodoItems<T>(items: readonly T[], capacity: number): { shown: readonly T[]; hidden: number } {
  if (items.length <= capacity) return { shown: items, hidden: 0 };
  const keep = Math.max(1, capacity - 1);
  return { shown: items.slice(0, keep), hidden: items.length - keep };
}

/** The size control's own box, in screen px (four segments and the colour button: see
 *  `.wb-size-picker`). */
export const SIZE_PICKER_BOX = { width: 184, height: 32 } as const;

/** The bands Excalidraw's own chrome takes inside the canvas wrapper, in screen px: the tool bar
 *  on top, the zoom / undo bar at the bottom. The size control never lands in either. */
export const CANVAS_CHROME = { top: 72, bottom: 72, side: 8 } as const;

/**
 * Where the size control goes for a widget whose on-screen box is `card` (wrapper px): centred
 * under it, or (when that would collide with the bottom chrome or run off the viewport) above it,
 * or, with no room above either, inside the card's bottom edge. `left` is the control's centre.
 */
export function placeSizePicker(
  card: { left: number; top: number; right: number; bottom: number },
  view: { width: number; height: number },
  gap: number,
): { left: number; top: number } {
  const { width: w, height: h } = SIZE_PICKER_BOX;
  const minLeft = CANVAS_CHROME.side + w / 2;
  const maxLeft = view.width - CANVAS_CHROME.side - w / 2;
  const left = Math.round(Math.max(minLeft, Math.min((card.left + card.right) / 2, maxLeft)));
  const floor = view.height - CANVAS_CHROME.bottom - h;
  const below = card.bottom + gap;
  if (below <= floor) return { left, top: Math.round(below) };
  const above = card.top - gap - h;
  if (above >= CANVAS_CHROME.top) return { left, top: Math.round(above) };
  const inside = Math.min(card.bottom - gap - h, floor);
  return { left, top: Math.round(Math.max(CANVAS_CHROME.top, inside)) };
}
