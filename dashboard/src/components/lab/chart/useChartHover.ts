import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { nearestIndex, pointerToLocal, stepIndex } from './hover';

/**
 * The one hover model for axis charts (line, area, stacked, bars): the pointer
 * is mapped through the hit area's rendered bounding box to plot-local pixels
 * and snapped to the NEAREST datum position, so the reader aims at a date or a
 * category, never at a 2px line. The same index is reachable by keyboard: the
 * focusable chart takes Left/Right (Up/Down for a vertical category axis),
 * Home/End and Escape.
 *
 * Usage:
 *   const hover = useChartHover({ positions: xs, plotWidth: plot.width, plotHeight: plot.height });
 *   <svg {...hover.focusProps}> ... <rect {...hover.hitProps} x=.. y=.. width=.. height=.. /> </svg>
 *   hover.index  -> the datum to crosshair + tooltip (null = none)
 */

export interface ChartHoverOptions {
  /** Plot-local positions of the data along the hovered axis, ASCENDING. */
  positions: readonly number[];
  /** The hit area's layout size (the plot's width/height the scales span). */
  plotWidth: number;
  plotHeight: number;
  /** Which axis the data runs along: x (default; columns, lines) or y (horizontal bars). */
  axis?: 'x' | 'y';
}

export interface ChartHover {
  /** The hovered datum, or null. */
  index: number | null;
  /** The pointer in plot-local px while it is over the plot (null on keyboard focus). */
  pointer: { x: number; y: number } | null;
  setIndex(i: number | null): void;
  /** Spread onto the transparent hit <rect> covering exactly the plot area. */
  hitProps: {
    onPointerMove(e: PointerEvent<Element>): void;
    onPointerDown(e: PointerEvent<Element>): void;
    onPointerLeave(): void;
  };
  /** Spread onto the focusable chart element (the <svg>). */
  focusProps: {
    tabIndex: number;
    onKeyDown(e: KeyboardEvent<Element>): void;
    onBlur(): void;
  };
}

export function useChartHover(opts: ChartHoverOptions): ChartHover {
  const { positions, plotWidth, plotHeight } = opts;
  const axis = opts.axis ?? 'x';
  const [index, setIndexState] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const latest = useRef({ positions, plotWidth, plotHeight, axis });
  latest.current = { positions, plotWidth, plotHeight, axis };

  // A data refresh that shrinks the list must not leave a dangling index.
  const count = positions.length;
  useEffect(() => {
    setIndexState((i) => (i !== null && i >= count ? null : i));
  }, [count]);

  const fromPointer = useCallback((e: PointerEvent<Element>) => {
    const { positions: ps, plotWidth: w, plotHeight: h, axis: a } = latest.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const local = pointerToLocal(e.clientX, e.clientY, rect, w, h);
    setPointer(local);
    const i = nearestIndex(ps, a === 'x' ? local.x : local.y);
    setIndexState(i < 0 ? null : i);
  }, []);

  const clear = useCallback(() => {
    setIndexState(null);
    setPointer(null);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent<Element>) => {
    const n = latest.current.positions.length;
    const back = latest.current.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = latest.current.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    let next: number | null | undefined;
    if (e.key === back) next = stepIndex(index, -1, n);
    else if (e.key === fwd) next = stepIndex(index, 1, n);
    else if (e.key === 'Home') next = n > 0 ? 0 : null;
    else if (e.key === 'End') next = n > 0 ? n - 1 : null;
    else if (e.key === 'Escape') next = null;
    if (next === undefined) return;
    e.preventDefault();
    setPointer(null);
    setIndexState(next);
  }, [index]);

  return {
    index: index !== null && index < count ? index : null,
    pointer,
    setIndex: setIndexState,
    hitProps: { onPointerMove: fromPointer, onPointerDown: fromPointer, onPointerLeave: clear },
    focusProps: { tabIndex: 0, onKeyDown, onBlur: clear },
  };
}

/**
 * Per-mark hover (pie slices, heatmap cells, bar list rows): the MARK is the hit
 * target. `bind(i)` returns the handlers for mark i; `anchor` is where the
 * tooltip should point, in the container's layout pixels (the pointer while it
 * moves, the mark's centre on keyboard focus).
 */
export interface MarkHover {
  active: number | null;
  anchor: { x: number; y: number } | null;
  bind(i: number): {
    tabIndex: number;
    onPointerEnter(e: PointerEvent<Element>): void;
    onPointerMove(e: PointerEvent<Element>): void;
    onPointerLeave(): void;
    onFocus(e: { currentTarget: Element }): void;
    onBlur(): void;
  };
  clear(): void;
}

/**
 * `containerRef` is the element the anchor is relative to (the plot from
 * useChartSize) and `layoutWidth/Height` its measured size, so the anchor is
 * right under zoom for the same reason the crosshair is.
 */
export function useMarkHover(containerRef: RefObject<Element | null>, layoutWidth: number, layoutHeight: number): MarkHover {
  const [active, setActive] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const size = useRef({ layoutWidth, layoutHeight });
  size.current = { layoutWidth, layoutHeight };

  const toLocal = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return null;
    return pointerToLocal(clientX, clientY, el.getBoundingClientRect(), size.current.layoutWidth, size.current.layoutHeight);
  }, [containerRef]);

  const clear = useCallback(() => {
    setActive(null);
    setAnchor(null);
  }, []);

  const bind = useCallback((i: number) => ({
    tabIndex: 0,
    onPointerEnter: (e: PointerEvent<Element>) => {
      setActive(i);
      setAnchor(toLocal(e.clientX, e.clientY));
    },
    onPointerMove: (e: PointerEvent<Element>) => {
      setActive(i);
      setAnchor(toLocal(e.clientX, e.clientY));
    },
    onPointerLeave: clear,
    onFocus: (e: { currentTarget: Element }) => {
      const r = e.currentTarget.getBoundingClientRect();
      setActive(i);
      setAnchor(toLocal(r.left + r.width / 2, r.top + r.height / 2));
    },
    onBlur: clear,
  }), [toLocal, clear]);

  return { active, anchor, bind, clear };
}
