import { useLayoutEffect, type RefObject } from 'react';

/**
 * How far the title bar has to give way: 0 = everything at full size. The menu tabs and the
 * project label never give way first; the sleep tracker does, step by step (NewShell.css,
 * `[data-squeeze]`):
 *   1 the tracker drops its word (face + count + bar)
 *   2 the tracker is the face and a small bar (the full reading stays in its title)
 *   3 the zoom icon goes (Settings › General keeps the control)
 *   4 the project name shortens with an ellipsis, its logo stays
 *   5 (a phone-width window, ~390 px) the tracker goes and the tabs sit closer: nothing overlaps
 * Measured, not guessed from a width: the bar's own contents differ with the zoom, the language,
 * the project name and the tab count, so a fixed breakpoint would be wrong the moment one moves.
 */
export const BAR_SQUEEZE_MAX = 5;

type BarLike = Pick<HTMLElement, 'scrollWidth' | 'clientWidth'> & { querySelector?: HTMLElement['querySelector'] };

/**
 * True while what the bar holds is wider than the bar (levels 0–3 never let a cluster shrink), or
 * while the last menu tab reaches under the right cluster: the bar's own scroll width cannot see
 * that, because at the last levels the left cluster shrinks to fit the bar and the tabs spill
 * into the cluster beside them instead of past the bar's edge (390 px, measured 2026-11-23).
 */
function overflows(bar: BarLike): boolean {
  if (bar.scrollWidth > bar.clientWidth) return true;
  const lastTab = bar.querySelector?.('.ns-tabs')?.lastElementChild;
  const right = bar.querySelector?.('.ns-tb-right');
  return !!lastTab && !!right && lastTab.getBoundingClientRect().right > right.getBoundingClientRect().left + 0.5;
}

/** The smallest level at which the bar's contents fit, written to `data-squeeze` (exported for the test). */
export function fitBar(bar: Pick<HTMLElement, 'setAttribute'> & BarLike): number {
  let level = 0;
  for (; level < BAR_SQUEEZE_MAX; level++) {
    bar.setAttribute('data-squeeze', String(level));
    if (!overflows(bar)) break;
  }
  bar.setAttribute('data-squeeze', String(level));
  return level;
}

/**
 * Sets `data-squeeze` on the bar to the smallest level that fits. It re-fits on a resize of the
 * bar, a change of what the bar holds (the tabs, the tracker's text) and whenever `deps` change
 * (the zoom, the project). One pass is at most five style reads inside a frame, only when
 * something above changed: no timer, no polling, no animation.
 */
export function useBarSqueeze(barRef: RefObject<HTMLElement | null>, enabled: boolean, deps: readonly unknown[]): void {
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    if (!enabled) {
      bar.removeAttribute('data-squeeze');
      return undefined;
    }
    let raf = 0;
    const fit = () => { raf = 0; fitBar(bar); };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(fit); };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(bar);
    // Contents only (children and text): the attribute this hook writes is not watched, so a fit
    // never triggers the next one.
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
    mo?.observe(bar, { childList: true, characterData: true, subtree: true });
    // A web font arriving changes every width in the bar.
    void document.fonts?.ready.then(schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      mo?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barRef, enabled, ...deps]);
}
