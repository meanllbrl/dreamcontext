import { useEffect, useState } from 'react';
import type { CanvasBox } from '../../components/whiteboard/superFieldLogic';

/** The room kept between the top row's last control and the canvas's right edge (px). */
export const ROW_EDGE_PX = 4;

/**
 * How far the row's rightmost control reaches past the canvas's usable right edge (px; <= 0:
 * the row fits). Pure: the right edges are measured by the hook.
 */
export function rowOverflow(childRights: readonly number[], canvasRight: number, edge = ROW_EDGE_PX): number {
  let right = 0;
  for (const r of childRights) right = Math.max(right, r);
  return right - (canvasRight - edge);
}

/** The width the canvas must reach for the row to fit again (px), or the old need. */
export function nextNeed(prevNeed: number, canvasWidth: number, overflow: number): number {
  return overflow > 0 ? Math.max(prevNeed, canvasWidth + Math.ceil(overflow)) : prevNeed;
}

/**
 * The ONE place that decides whether the page's controls (the save state, the Agents toggle) can
 * ride Excalidraw's top-right row (review r2). Excalidraw lays that row out in a grid that never
 * shrinks below its content, and clips what spills past the canvas. So while the controls are
 * in the row, the row and every control in it are observed: anything that changes their width
 * (the canvas, the save state's words, a language, a late font, a control Excalidraw adds) re-
 * measures. A spill moves the controls aside (true) until the canvas is as wide as the row was
 * measured to need; a language change tries the row again.
 */
export function useTopRowFit(toggleEl: HTMLElement | null, canvas: CanvasBox | null, locale: string): boolean {
  const [need, setNeed] = useState(0);
  useEffect(() => { setNeed(0); }, [locale]);
  const aside = canvas !== null && canvas.width < need;
  useEffect(() => {
    if (aside || !canvas || !toggleEl) return undefined;
    const row = toggleEl.parentElement;
    if (!row) return undefined;
    const measure = () => {
      const over = rowOverflow(Array.from(row.children).map((c) => c.getBoundingClientRect().right), canvas.right);
      if (over > 0) setNeed((prev) => nextNeed(prev, canvas.width, over));
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const watch = () => {
      if (!ro) return;
      ro.disconnect();
      ro.observe(row);
      for (const c of Array.from(row.children)) ro.observe(c);
    };
    watch();
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => { watch(); measure(); });
    mo?.observe(row, { childList: true });
    measure();
    return () => { ro?.disconnect(); mo?.disconnect(); };
  }, [aside, canvas, toggleEl]);
  return aside;
}
