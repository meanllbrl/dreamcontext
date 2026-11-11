import { useEffect, useState } from 'react';
import type { CanvasBox } from '../../components/whiteboard/superFieldLogic';

/**
 * The board canvas's measured box (width, right edge, viewport width), kept current through
 * resizes of the canvas (the Boards list, the agents panel) and of the window. One measurement
 * the page's controls and the writing field both read.
 */
export function useCanvasBox(el: HTMLElement | null): CanvasBox | null {
  const [box, setBox] = useState<CanvasBox | null>(null);
  useEffect(() => {
    if (!el) { setBox(null); return undefined; }
    const read = () => {
      const r = el.getBoundingClientRect();
      const next = { width: Math.round(r.width), right: Math.round(r.right), viewport: window.innerWidth };
      setBox((prev) => (prev && prev.width === next.width && prev.right === next.right && prev.viewport === next.viewport ? prev : next));
    };
    read();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    window.addEventListener('resize', read);
    return () => { ro?.disconnect(); window.removeEventListener('resize', read); };
  }, [el]);
  return box;
}
