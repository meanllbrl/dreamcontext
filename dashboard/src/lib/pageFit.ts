/**
 * How wide a project web page really is (owner 2026-10-31: a report's card took two thirds of the
 * stage for a column of ~700 px). The answer is measured in the page, never a number made up here.
 *
 * WHAT IT MEASURES: the page's own width cap, a pixel `max-width` on the body or on the blocks that
 * hold all of its content, plus their padding and that of the blocks around them. Anything else
 * answers 0, "needs its width": a fluid page (text that fills whatever it gets), a flex or grid
 * layout, content wider than its box (a wide table), a cap the frame does not let the page reach (a
 * sidebar's margin). Unsure always means the card keeps the width it has today.
 *
 * THE ANSWER CAN STILL FOLLOW THE FRAME: a breakpoint over the cap, a `vw` cap (it computes to px), a
 * child that only overflows once the card narrowed. Answering again would resize the card and flip
 * the answer back, for ever (end review, measured in Chromium and WebKit). So a width answer that
 * changes after the frame was resized is the page saying it has no width of its own: it stays 0
 * until the page loads again. A frame under the answer tests nothing, so the answer stands. A margin
 * on the capped block itself cannot be told from auto's centring: that page bounces once and keeps
 * its width, the safe side.
 *
 * The frame is sandboxed with no same-origin, so the page reports through postMessage and the host
 * accepts it from that frame's window alone (DocumentReader's HtmlPage). A hostile page can only
 * misstate its own card's width, which the stage clamps.
 *
 * No React, no CSS imports: importable by root vitest with a `.js` specifier.
 */

export const PAGE_FIT_KEY = '__dcPageFit';

/** The page's report, posted when its width answer changes. */
export const PAGE_FIT_BRIDGE = `(function () {
  var last = -1, lastColumn = -1, lastFrame = -1, latched = false, queued = 0, gutter = 0, gutterFor = -1;
  function px(v) { return /px$/.test(v) ? parseFloat(v) : 0; }
  function capOf(el, cs) {
    var m = px(cs.maxWidth);
    if (!m) return 0;
    var box = cs.boxSizing === 'content-box' ? m + sides(cs) : m;
    var scrollbar = window.innerWidth - document.documentElement.clientWidth;
    return el.getBoundingClientRect().width + scrollbar < box - 1 ? Infinity : box;
  }
  function sides(cs) {
    return px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
  }
  function column(el, depth) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') return 0;
    var cap = capOf(el, cs);
    if (cap) return cap;
    if (depth <= 0 || (cs.display !== 'block' && cs.display !== 'flow-root')) return Infinity;
    if (!el.children.length) return Infinity;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && /\\S/.test(n.nodeValue)) return Infinity;
    }
    var widest = 0;
    for (var i = 0; i < el.children.length; i++) widest = Math.max(widest, column(el.children[i], depth - 1));
    // An uncapped block fills its parent, so its margins are real, never auto's centring.
    return widest > 0 && widest !== Infinity ? widest + sides(cs) + px(cs.marginLeft) + px(cs.marginRight) : widest;
  }
  function overflows() {
    var root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) return true;
    var all = [document.body].concat([].slice.call(document.body.querySelectorAll('*')));
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      var x = getComputedStyle(el).overflowX;
      if (x !== 'hidden' && x !== 'clip') return true;
    }
    return false;
  }
  function report() {
    queued = 0;
    if (!document.body) return;
    // A frame under the answer cannot test it (a small window, a half stage): it stands.
    if (lastColumn > 0 && window.innerWidth < lastColumn) return;
    var w = overflows() ? 0 : column(document.body, 8);
    if (w === Infinity) w = 0;
    // The width alone is compared: the scrollbar comes and goes with the page's height.
    if (lastColumn > 0 && w !== lastColumn && window.innerWidth !== lastFrame) latched = true;
    lastColumn = w;
    lastFrame = window.innerWidth;
    // The widest scrollbar seen for this width: one that comes only at the narrower of two widths
    // would otherwise flip the answer with no change of width to latch on.
    if (w !== gutterFor) { gutter = 0; gutterFor = w; }
    gutter = Math.max(gutter, window.innerWidth - document.documentElement.clientWidth);
    var fit = w > 0 && !latched ? Math.ceil(w + gutter) : 0;
    if (fit === last) return;
    last = fit;
    var m = {}; m['${PAGE_FIT_KEY}'] = fit;
    parent.postMessage(m, '*');
  }
  function soon() { if (!queued) queued = requestAnimationFrame(report); }
  function start() {
    if (window.ResizeObserver) new ResizeObserver(soon).observe(document.body);
    window.addEventListener('resize', soon);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(soon);
    report();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
  window.addEventListener('load', soon);
})();`;

/** The largest width believed; a page claiming more is simply a wide page. */
export const PAGE_FIT_MAX = 4000;

/** A frame's message: its width in px, 0 for "needs its width", undefined when it is not a report. */
export function readPageFit(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const v = (data as Record<string, unknown>)[PAGE_FIT_KEY];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return v > PAGE_FIT_MAX ? 0 : Math.ceil(v);
}

/** Pages remembered at most: each answer is one number, re-measured on every load. */
export const MAX_PAGE_FITS = 60;
const fits = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

/** The store's key: a report is the same width on any of its cards, and projects share no pages. */
export function pageFitKey(vault: string | null | undefined, ref: string): string {
  return `${vault ?? ''}\u0000${ref}`;
}

/** What the page at `key` measured (0 / absent: it needs its width). */
export function pageFitOf(key: string): number | undefined {
  return fits.get(key) || undefined;
}

export function setPageFit(key: string, width: number): void {
  if ((fits.get(key) ?? 0) === width) return;
  fits.delete(key);
  if (width > 0) fits.set(key, width);
  // A Map iterates in insertion order: the first key is the least recently changed.
  if (fits.size > MAX_PAGE_FITS) fits.delete(fits.keys().next().value as string);
  version += 1;
  for (const l of listeners) l();
}

/** For useSyncExternalStore: the plan is redone only when an answer changed. */
export function subscribePageFits(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function pageFitsVersion(): number { return version; }
