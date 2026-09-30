import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
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

export function useChartSize<T extends HTMLElement = HTMLDivElement>(): ChartSize & { ref: RefObject<T | null> } {
  const ref = useRef<T | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [font, setFont] = useState(() => readFont(null));
  const [dpr, setDpr] = useState(readDpr);

  const refreshFont = useCallback(() => {
    const next = readFont(ref.current);
    setFont((prev) => (prev.font === next.font ? prev : next));
    setDpr(readDpr());
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    refreshFont();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      // contentRect is in the element's own layout pixels (unaffected by transforms),
      // floored so sub-pixel jitter never re-renders the chart.
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      refreshFont();
    });
    observer.observe(el);
    // App zoom scales the type ladder without necessarily resizing the cell.
    window.addEventListener('dreamcontext-zoom', refreshFont);
    return () => {
      observer.disconnect();
      window.removeEventListener('dreamcontext-zoom', refreshFont);
    };
  }, [refreshFont]);

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
