/**
 * Pointer -> datum, the pure half of the hover model (useChartHover is the
 * React half). The pointer is mapped through the RENDERED bounding box of the
 * plot, so the answer is right at any cell width and under any zoom: the
 * client rect and the pointer are in the same (zoomed) viewport pixels, and the
 * ratio `layoutSize / rect.size` carries them back into the plot's own layout
 * pixels, where the scales live. Nothing here assumes a viewBox or a fixed width.
 */

export interface ClientRectLike { left: number; top: number; width: number; height: number }

/**
 * A viewport point as plot-local layout pixels. `layoutWidth`/`layoutHeight`
 * are the plot's size in its own coordinate system (what the scales' ranges
 * span); when the element is zoomed or transformed, `rect` is larger or smaller
 * than that and the ratio undoes it.
 */
export function pointerToLocal(
  clientX: number, clientY: number, rect: ClientRectLike, layoutWidth: number, layoutHeight: number,
): { x: number; y: number } {
  const sx = rect.width > 0 ? layoutWidth / rect.width : 1;
  const sy = rect.height > 0 ? layoutHeight / rect.height : 1;
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

/**
 * The index of the position nearest `x` in an ASCENDING list (binary search;
 * ties go to the earlier datum). Out-of-range pointers clamp to the ends; an
 * empty list is -1.
 */
export function nearestIndex(positions: readonly number[], x: number): number {
  const n = positions.length;
  if (n === 0 || !Number.isFinite(x)) return n === 0 ? -1 : 0;
  if (x <= positions[0]) return 0;
  if (x >= positions[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (positions[mid] <= x) lo = mid;
    else hi = mid;
  }
  return x - positions[lo] <= positions[hi] - x ? lo : hi;
}

/**
 * The datum under the pointer: plot-local x through the rect, then the nearest
 * position. This is the whole crosshair contract, in one testable call.
 */
export function pointerToIndex(
  clientX: number, rect: ClientRectLike, layoutWidth: number, positions: readonly number[],
): number {
  const { x } = pointerToLocal(clientX, 0, rect, layoutWidth, 1);
  return nearestIndex(positions, x);
}

/** Step a keyboard-focused index by `delta`, clamped; from "none" it enters at the first/last datum. */
export function stepIndex(current: number | null, delta: number, count: number): number | null {
  if (count <= 0) return null;
  if (current === null || current < 0) return delta < 0 ? count - 1 : 0;
  return Math.min(count - 1, Math.max(0, current + delta));
}

export interface TooltipBox { width: number; height: number }

/**
 * Where a tooltip goes: beside the anchor (right by default), flipped to the
 * other side when it would cross the container's edge, vertically centred on
 * the anchor and clamped inside. If it cannot fit either side it is clamped to
 * the container (it never leaves the cell). Returns the top-left corner.
 */
export function placeTooltip(
  anchor: { x: number; y: number }, box: TooltipBox, bounds: { width: number; height: number }, gap = 12,
): { left: number; top: number; side: 'left' | 'right' } {
  const fitsRight = anchor.x + gap + box.width <= bounds.width;
  const fitsLeft = anchor.x - gap - box.width >= 0;
  let side: 'left' | 'right' = fitsRight || !fitsLeft ? 'right' : 'left';
  let left = side === 'right' ? anchor.x + gap : anchor.x - gap - box.width;
  if (!fitsRight && !fitsLeft) {
    // Neither side has room: take the roomier side and clamp inside the container.
    side = anchor.x > bounds.width / 2 ? 'left' : 'right';
    left = side === 'right' ? anchor.x + gap : anchor.x - gap - box.width;
  }
  left = Math.min(Math.max(0, bounds.width - box.width), Math.max(0, left));
  const top = Math.min(Math.max(0, bounds.height - box.height), Math.max(0, anchor.y - box.height / 2));
  return { left, top, side };
}
