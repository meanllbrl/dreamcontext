import { useCallback, useEffect, useMemo, useState } from 'react';
import { textMeasurer, type Measure } from './layout';

/**
 * The real size of a chart's plot area, from a ResizeObserver on the element
 * (width AND height), plus what text needs to be laid out crisply at that size:
 * the tick font's pixel size (it follows the app's --zoom), a measurer for it,
 * and the device pixel ratio for hairline snapping.
 *
 * Charts draw in these pixels 1:1 (an SVG whose viewBox equals its size), so a
 * 12px label is a 12px label at every cell width; nothing is stretched.
 */
export interface ChartSize {
  width: number;
  height: number;
  /** Tick/label font size in CSS px (12 x --zoom). */
  fontPx: number;
  /** Measures text in the chart's tick font. */
  measure: Measure;
  /** window.devicePixelRatio at the last measure (>= 1). */
  dpr: number;
  /** True once the element has been measured with a non-zero size. */
  ready: boolean;
}

const FALLBACK_FONT_PX = 12;

function readFont(el: Element | null): { fontPx: number; font: string } {
  if (!el || typeof getComputedStyle === 'undefined') {
    return { fontPx: FALLBACK_FONT_PX, font: `${FALLBACK_FONT_PX}px sans-serif` };
  }
  const cs = getComputedStyle(el);
  const fontPx = parseFloat(cs.fontSize) || FALLBACK_FONT_PX;
  return { fontPx, font: `${cs.fontWeight || 400} ${fontPx}px ${cs.fontFamily || 'sans-serif'}` };
}

function readDpr(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

/**
 * A ref that FOLLOWS its element: a callback ref (React calls it with the node
 * on mount, null on unmount, the new node on a swap) that also exposes
 * `.current`, so it can be handed anywhere a RefObject is read. Each attach
 * disconnects the previous observer and observes the new node, so a chart that
 * first renders an empty state and mounts its plot later (data arriving after
 * a cache load) is still measured. Pure (no React): unit-tested with fake nodes.
 */
export type FollowedRef<T> = ((node: T | null) => void) & { current: T | null };

export function followElement<T extends Element>(
  onResize: (width: number, height: number) => void,
  onAttach: (node: T | null) => void,
): FollowedRef<T> {
  let observer: ResizeObserver | null = null;
  const ref = ((node: T | null) => {
    if (node === ref.current) return;
    observer?.disconnect();
    observer = null;
    ref.current = node;
    onAttach(node);
    if (!node || typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      // contentRect is in the element's own layout pixels (unaffected by transforms),
      // floored so sub-pixel jitter never re-renders the chart.
      onResize(Math.floor(entry.contentRect.width), Math.floor(entry.contentRect.height));
    });
    observer.observe(node);
  }) as FollowedRef<T>;
  ref.current = null;
  return ref;
}

export function useChartSize<T extends HTMLElement = HTMLDivElement>(): ChartSize & { ref: FollowedRef<T> } {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [font, setFont] = useState(() => readFont(null));
  const [dpr, setDpr] = useState(readDpr);

  const refreshFont = useCallback((el: Element | null) => {
    const next = readFont(el);
    setFont((prev) => (prev.font === next.font ? prev : next));
    setDpr(readDpr());
  }, []);

  // Stable for the component's life: React re-invokes it only when the node itself changes.
  const ref = useMemo(() => followElement<T>(
    (width, height) => {
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      refreshFont(ref.current);
    },
    (node) => {
      // Detached (an empty state replaced the plot): not ready until the next node is measured.
      if (!node) setBox((prev) => (prev.width === 0 && prev.height === 0 ? prev : { width: 0, height: 0 }));
      else refreshFont(node);
    },
  ), [refreshFont]);

  useEffect(() => {
    // App zoom scales the type ladder without necessarily resizing the cell.
    const onZoom = () => refreshFont(ref.current);
    window.addEventListener('dreamcontext-zoom', onZoom);
    return () => window.removeEventListener('dreamcontext-zoom', onZoom);
  }, [ref, refreshFont]);

  const measure = useMemo(() => textMeasurer(font.font, font.fontPx), [font]);
  return {
    ref,
    width: box.width,
    height: box.height,
    fontPx: font.fontPx,
    measure,
    dpr,
    ready: box.width > 0 && box.height > 0,
  };
}

/**
 * A coordinate snapped so a 1px hairline lands on whole device pixels (crisp,
 * never a blurred 2px grey line).
 */
export function crisp(v: number, dpr = 1): number {
  const d = dpr > 0 ? dpr : 1;
  return (Math.round(v * d) + 0.5) / d;
}
