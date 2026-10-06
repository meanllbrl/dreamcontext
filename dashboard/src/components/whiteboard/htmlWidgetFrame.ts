/**
 * The HTML widget's sandbox (D6): chat's sandbox with the input bridge taken OUT.
 *
 * Board HTML can come from a shared repo, so the trust bar is lower than chat's, not equal to
 * it. Chat's srcdoc also injects `REACH_BRIDGE`, and its host replays posted chords and presses
 * as real DOM events. On a board, a hostile block could post ⌘A then Backspace, Excalidraw
 * would hear them, and the autosave would write the deletion. So this srcdoc is built from the
 * shared primitives directly: `buildSandboxSrcdoc` + the kit CSS (plus the board's frame reset) + `HEIGHT_BRIDGE`, nothing else.
 * No `KIT_BEHAVIOUR` either, so the kit's `dc-tabs` do not switch here; an author who wants
 * tabs writes their own inline script.
 *
 * The host accepts two messages, both only from this frame's own window: a height, clamped to
 * {@link BOARD_HTML_MAX_HEIGHT}, and a wheel the block could not use ({@link BOARD_WHEEL_BRIDGE}),
 * capped, and taken only while the pointer is over the frame. There is no token (the static
 * bridges carry none), so identity (`event.source === contentWindow`) is the gate.
 *
 * No React, no CSS: root vitest imports this file.
 */
import { buildSandboxSrcdoc } from '../../lib/sandboxHtml';
import { CHAT_HTML_KIT_CSS, HEIGHT_BRIDGE, readHeightMessage } from '../sleepy/chat/chatHtmlKit';

/** The only sandbox grant. Scripts yes; same-origin, popups, navigation and forms never. */
export const BOARD_HTML_SANDBOX = 'allow-scripts';

/** A board block may grow to this and no further. */
export const BOARD_HTML_MAX_HEIGHT = 4000;

/** The root containers that stack their blocks top to bottom, so they can hand out spare height. */
const FILL_ROOT = 'body > :is(.dc-doc, .dc-stack, .dc-card):only-child';

/**
 * The card's spare height goes to the block's BODY, not to an empty band under it (owner,
 * 2026-10-06: "html insightlar yüksekliği kaplamıyor"). The root becomes a column and its
 * elastic blocks (a grid, a list of bars, steps, a funnel, a diagram, a chart) take what is
 * left: a grid's rows grow and its stat tiles put the value at the bottom, a stack spreads its
 * rows. The heading stays on top and whatever follows the elastic block ends on the card's
 * bottom edge. Neither scaling the text up (it reflows and truncates) nor spreading every gap
 * (it pulls a heading away from its content) read right; this does. Content taller than the
 * card is unchanged: nothing here shrinks below its natural height.
 */
const BOARD_HTML_FILL = `
${FILL_ROOT} { display: flex; flex-direction: column; }
${FILL_ROOT} > :is(.dc-stack, .dc-grid, .dc-funnel, .dc-steps, .dc-compare, .dc-graph, .dc-svg) { flex: 1 1 auto; }
${FILL_ROOT} > :is(.dc-stack, .dc-funnel, .dc-steps) { display: flex; flex-direction: column; justify-content: space-around; }
${FILL_ROOT} > .dc-grid > .dc-stat { display: flex; flex-direction: column; }
${FILL_ROOT} > .dc-grid > .dc-stat > .dc-stat-label { flex: 1 1 auto; }
`;

/**
 * Board-only styling after the kit (A19). The widget is already a card, so a block whose whole
 * content is one `dc-card` would draw a second frame inside it: that card loses its border,
 * fill, radius, shadow and padding and its content sits straight on the widget. `!important`
 * because authors inline `style="padding:…"` on it. Styling only: nothing here reaches the CSP,
 * the sandbox or the bridge.
 */
export const BOARD_HTML_CSS = `
body > .dc-card:only-child {
  padding: 0 !important;
  border: none !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}
body { min-height: 100vh; }
body:has(> :only-child) { display: flex; flex-direction: column; }
body > :only-child { flex: 1 0 auto; }
${BOARD_HTML_FILL}`;

/**
 * How far a block may shrink to fit its card (owner, 2026-10-05: "HTML kapsamıyor", content
 * cut at the bottom and not filling the card). Below this the text stops being readable, so
 * the block stays at this scale and scrolls inside the card once it is active.
 */
export const BOARD_HTML_MIN_SCALE = 0.5;

/**
 * The scale a block is drawn at so all of it shows in its card: the frame is laid out at
 * `box / scale` and drawn scaled by `scale`. `contentHeight` is what the frame reported (the
 * body's height at the current layout width, never less than the frame since the body fills
 * it: BOARD_HTML_CSS). It only ever SHRINKS from `current`: a smaller scale lays the block out
 * wider, which makes it shorter, and growing back on that report would narrow it and overflow
 * again (an endless back and forth). The caller starts again from 1 when the box or the
 * markup changes.
 */
export function fitScale(current: number, box: { height: number }, contentHeight: number): number {
  if (!(box.height > 0) || !(contentHeight > 0)) return current;
  const viewport = box.height / current;
  if (contentHeight <= viewport + 1) return current;
  return Math.max(BOARD_HTML_MIN_SCALE, Math.min(current, box.height / contentHeight));
}

/** The message key of a wheel the block hands back to the board. */
export const BOARD_WHEEL_KEY = '__dcBoardWheel';

/** The most one forwarded wheel may move the board, per axis (px of wheel delta). */
export const BOARD_WHEEL_MAX_DELTA = 600;

/**
 * Scroll chaining out of the block (owner, 2026-10-06: "html üstünde scroll edemiyorum"). An
 * ACTIVE block takes the wheel, and a block that fits its card has nothing to scroll, so the
 * wheel went nowhere: the board did not pan either. The block now scrolls its own content (any
 * scrollable element under the pointer, then the page) while it can, and hands every other
 * wheel, and every pinch (ctrl/⌘ + wheel), to the board. Deltas in lines or pages are turned
 * into px here, where the line height is known.
 */
export const BOARD_WHEEL_BRIDGE = `(function () {
  function room(n, dx, dy) {
    if (dy && n.scrollHeight > n.clientHeight + 1
      && (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1)) return true;
    if (dx && n.scrollWidth > n.clientWidth + 1
      && (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1)) return true;
    return false;
  }
  function scroller(el, dx, dy) {
    for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY + ' ' + cs.overflowX) && room(n, dx, dy)) return n;
    }
    var root = document.scrollingElement || document.documentElement;
    return room(root, dx, dy) ? root : null;
  }
  window.addEventListener('wheel', function (e) {
    var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    var dx = e.deltaX * unit, dy = e.deltaY * unit, pinch = e.ctrlKey || e.metaKey;
    var n = pinch ? null : scroller(e.target instanceof Element ? e.target : null, dx, dy);
    e.preventDefault();
    // Scrolled here, not left to the engine: a scaled frame on a zoomed board did not always
    // get its native wheel scroll, and this way it behaves the same in every engine.
    if (n) { n.scrollBy({ left: dx, top: dy, behavior: 'instant' }); return; }
    parent.postMessage({ ${BOARD_WHEEL_KEY}: { dx: dx, dy: dy, pinch: pinch, shift: e.shiftKey, x: e.clientX, y: e.clientY } }, '*');
  }, { passive: false });
})();`;

/** A wheel the board takes from a block: deltas in px, capped; `x`/`y` where the pointer was
 *  in the frame's own layout px (a pinch zooms around it), or null when the frame did not say. */
export interface BoardWheel {
  dx: number;
  dy: number;
  pinch: boolean;
  shift: boolean;
  at: { x: number; y: number } | null;
}

const capDelta = (v: number) => Math.max(-BOARD_WHEEL_MAX_DELTA, Math.min(BOARD_WHEEL_MAX_DELTA, v));

/**
 * The host's wheel gate: a wheel from this frame's own window, or null. `pointerOver` is the
 * host's own knowledge that the pointer is on the frame: a block can only move the board while
 * the owner is wheeling over it, never on its own.
 */
export function readBoardWheelMessage(
  event: { source: unknown; data: unknown },
  frameWindow: unknown,
  pointerOver: boolean,
): BoardWheel | null {
  if (!pointerOver || !frameWindow || event.source !== frameWindow) return null;
  const data = event.data;
  if (!data || typeof data !== 'object') return null;
  const raw = (data as Record<string, unknown>)[BOARD_WHEEL_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const { dx, dy, pinch, shift, x, y } = raw as Record<string, unknown>;
  if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dx === 0 && dy === 0) return null;
  const at = typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  return { dx: capDelta(dx), dy: capDelta(dy), pinch: pinch === true, shift: shift === true, at };
}

/** Excalidraw's own zoom bounds and step (0.18.1, `MIN_ZOOM`, `MAX_ZOOM`, `ZOOM_STEP`). */
const BOARD_MIN_ZOOM = 0.1;
const BOARD_MAX_ZOOM = 30;
const BOARD_ZOOM_STEP = 0.1;

/** The part of the board's view a wheel moves. */
export interface BoardView {
  scrollX: number;
  scrollY: number;
  zoom: number;
  offsetLeft: number;
  offsetTop: number;
}

/**
 * Where the board's view goes for one wheel, by Excalidraw's own rule (`handleWheel`): a plain
 * wheel pans by the delta at the current zoom, shift pans sideways, a pinch zooms around
 * `anchor` (a viewport point that stays put). Used for a wheel an HTML block hands back
 * (htmlWidgetFrame.ts), applied through the API: nothing the block sends becomes a DOM event.
 */
export function boardAfterWheel(
  view: BoardView,
  wheel: { dx: number; dy: number; pinch: boolean; shift: boolean },
  anchor: { clientX: number; clientY: number },
): { scrollX: number; scrollY: number; zoom: number } {
  const { scrollX, scrollY, zoom } = view;
  if (wheel.pinch) {
    const sign = Math.sign(wheel.dy);
    const step = BOARD_ZOOM_STEP * 100;
    const delta = Math.abs(wheel.dy) > step ? step * sign : wheel.dy;
    let next = zoom - delta / 100;
    next += Math.log10(Math.max(1, zoom)) * -sign * Math.min(1, Math.abs(wheel.dy) / 20);
    next = Math.min(BOARD_MAX_ZOOM, Math.max(BOARD_MIN_ZOOM, next));
    // The scene point under the anchor stays under it.
    const vx = anchor.clientX - view.offsetLeft;
    const vy = anchor.clientY - view.offsetTop;
    const sx = vx / zoom - scrollX;
    const sy = vy / zoom - scrollY;
    return { scrollX: vx / next - sx, scrollY: vy / next - sy, zoom: next };
  }
  if (wheel.shift) return { scrollX: scrollX - (wheel.dy || wheel.dx) / zoom, scrollY, zoom };
  return { scrollX: scrollX - wheel.dx / zoom, scrollY: scrollY - wheel.dy / zoom, zoom };
}

export function buildBoardHtmlSrcdoc(input: {
  html: string;
  tokens: Record<string, string>;
  scheme: 'light' | 'dark';
}): string {
  return buildSandboxSrcdoc({
    html: input.html,
    css: CHAT_HTML_KIT_CSS + BOARD_HTML_CSS,
    tokens: input.tokens,
    scheme: input.scheme,
    headScript: `${HEIGHT_BRIDGE}\n${BOARD_WHEEL_BRIDGE}`,
  });
}

/**
 * The host's message gate. Returns the height to apply, or null to ignore the message.
 * Anything that is not a height from this frame (a chord, a press, another frame's message)
 * is null and changes nothing.
 */
export function readBoardFrameMessage(
  event: { source: unknown; data: unknown },
  frameWindow: unknown,
): number | null {
  if (!frameWindow || event.source !== frameWindow) return null;
  const h = readHeightMessage(event.data);
  if (h === null) return null;
  return Math.min(BOARD_HTML_MAX_HEIGHT, h);
}
