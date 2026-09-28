/**
 * Tasks toolbar overflow collapse: the pure decisions behind BoardToolbar's "More" menu.
 *
 * The bar hides its right-hand controls from the END while the row overflows, and re-tests
 * from all of them when the space changes. Three signals drive it: a layout pass (does the
 * row overflow?), a ResizeObserver callback (how wide is the bar now?) and the item count
 * settling (close any menu so a popover never orphans). Kept free of React and the DOM so the
 * convergence rule can be unit-tested; BoardToolbar wires them to the real layout.
 *
 * Convergence is the whole point. The bar re-tested on EVERY observer callback and closed the
 * parent's menu on every count change, and a 720px to 1500px resize looped that into React's
 * "Maximum update depth exceeded", taking the whole app down. Measured on a dev build: gating
 * the menu close alone stopped the crash; gating the observer alone did not (the sidebar
 * transition moves the bar's width every frame, so real width changes keep re-testing). Both
 * gates stay: within one bar width the count now only ever goes down, settling in at most
 * `total` steps, and a menu setter runs only for a menu that is open.
 */

export interface BarFit {
  /** How many collapsible controls stay in the bar; the rest live in "More". */
  visible: number;
  /** The bar width the current count was fitted to; null before the first measurement. */
  width: number | null;
}

export const initialFit = (total: number): BarFit => ({ visible: total, width: null });

/** A ResizeObserver callback measured the bar at `width`. Only a real width change re-tests
 *  from all controls; a height-only or repeated callback returns the SAME state, so React
 *  bails out and nothing re-renders. */
export function fitOnResize(fit: BarFit, width: number, total: number): BarFit {
  if (fit.width === width) return fit;
  return { visible: total, width };
}

/** One layout pass: drop one control while the row overflows. Never grows, stops at zero. */
export function fitOnLayout(fit: BarFit, overflows: boolean): BarFit {
  if (!overflows || fit.visible === 0) return fit;
  return { ...fit, visible: fit.visible - 1 };
}

/** The controls' own widths changed (a label, the sync chips): show all and re-shrink. */
export function fitRetest(fit: BarFit, total: number): BarFit {
  return fit.visible === total ? fit : { ...fit, visible: total };
}

/** Which menus the collapse settling must close: only one that is actually open. Calling a
 *  parent's setter with the value it already holds still costs a commit, and inside a
 *  collapse those commits chain. */
export function menusToClose(openMenu: string | null, moreOpen: boolean): { menu: boolean; more: boolean } {
  return { menu: openMenu !== null, more: moreOpen };
}
