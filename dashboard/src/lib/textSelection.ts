/**
 * Selected text, wherever it was selected (owner 2026-10-31: "select it, Copy and Comment right
 * under it, and it moves to the composer").
 *
 * A selection inside a sandboxed frame is invisible to the window (`getSelection` cannot cross an
 * opaque origin), so the frame's bridge reports it and the HOST draws the bar: the page never gets
 * a button of its own. Everything in a report is the PAGE's word: `readSelectionMessage` takes
 * plain text under a length limit and four numbers, nothing else, and the listener accepts it only
 * from that frame's window (`event.source`, never origin: see the sandboxed-app-bridge pattern).
 * A page that lies gets a bar over or just outside its own frame at most, and a click on it is what it can
 * win: Comment stages a removable chip of up to 1,000 page-chosen characters (a short label shows,
 * the rest is in its popover) that the owner's next Send carries, as a quote; Copy puts up to
 * 20,000 of them on the clipboard. No page reaches either without that click, and none can send.
 *
 * React-free and DOM-free, so root vitest loads it directly (text-selection.test.ts).
 */

export const SELECTION_MESSAGE_KEY = '__dreamHtmlSelection';
export const SELECTION_CLEAR_KEY = '__dreamHtmlSelectionClear';
/** What Copy takes at most; a comment's quote is shorter (MAX_SELECTION_QUOTE). */
export const MAX_SELECTION_TEXT = 20_000;
/** A frame's bar wakes this long after its words or its place last changed, or it came into
 *  sight, so a bar a page just moved under a pointer does not take the click meant for the page.
 *  It stops nothing else: a bar that stays still, anywhere over its frame, is awake. */
export const FRAME_BAR_ARM_MS = 400;

export interface SelectionBox { x: number; y: number; width: number; height: number }
export type SelectionReport = { kind: 'clear'; esc: boolean } | { kind: 'selection'; text: string; line: SelectionBox };

/** A page's words as text: bounded, control characters gone but line breaks and tabs. Format
 *  characters stay for Copy (they hold joined emoji and Persian together); a quote drops them. */
export function cleanSelection(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.slice(0, MAX_SELECTION_TEXT).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, '');
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : null);

/** A frame's report, or null for anything else. */
export function readSelectionMessage(data: unknown): SelectionReport | null {
  if (!data || typeof data !== 'object') return null;
  const m = (data as Record<string, unknown>)[SELECTION_MESSAGE_KEY];
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const text = cleanSelection(r.text);
  if (!text.trim()) return { kind: 'clear', esc: r.esc === true };
  const [x, y, width, height] = [num(r.x), num(r.y), num(r.width), num(r.height)];
  if (x === null || y === null || width === null || height === null || width < 0 || height < 0) return null;
  return { kind: 'selection', text, line: { x, y, width, height } };
}

/**
 * Where the bar sits: under the selection's last line, centred on it, inside `bounds`. No room
 * below: above the line. Never past an edge.
 */
export function placeBar(
  line: SelectionBox, bar: { width: number; height: number },
  bounds: { left: number; top: number; right: number; bottom: number }, gap = 8,
): { left: number; top: number } {
  const below = line.y + line.height + gap;
  const top = below + bar.height <= bounds.bottom ? below : line.y - gap - bar.height;
  const left = line.x + line.width / 2 - bar.width / 2;
  return {
    left: Math.max(bounds.left, Math.min(left, bounds.right - bar.width)),
    top: Math.max(bounds.top, Math.min(top, bounds.bottom - bar.height)),
  };
}

/** The frame's half: reports its selection when the press ends, and on its way off. Esc with a bar
 *  open closes the bar, and the host keeps that one press from the app. In the head, before the
 *  reach bridge. */
export const SELECTION_BRIDGE = `(function () {
  var KEY = ${JSON.stringify(SELECTION_MESSAGE_KEY)}, CLEAR = ${JSON.stringify(SELECTION_CLEAR_KEY)}, MAX = ${MAX_SELECTION_TEXT};
  var down = false, open = false, muted = false, timer = 0;
  var slow = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  function read() {
    var s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return null;
    var text = String(s);
    if (!text.trim()) return null;
    var range = s.getRangeAt(0), rects = range.getClientRects(), r = null;
    for (var i = rects.length - 1; i >= 0 && !r; i--) if (rects[i].width > 0) r = rects[i];
    r = r || range.getBoundingClientRect();
    return { text: text.slice(0, MAX), x: r.left, y: r.top, width: r.width, height: r.height };
  }
  function send(esc) {
    var b = muted ? null : read();
    if (!b && !open) return;
    open = !!b;
    var m = {}; m[KEY] = b || { text: '', esc: !!esc };
    try { parent.postMessage(m, '*'); } catch (e) { /* the host went away */ }
  }
  function soon(ms) { clearTimeout(timer); timer = setTimeout(function () { if (!down) send(); }, ms); }
  document.addEventListener('selectionchange', function () { muted = false; soon(slow ? 350 : 120); });
  window.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'touch') down = true; }, true);
  function up() { if (down) { down = false; soon(10); } }
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('scroll', function () { if (open) soon(30); }, true);
  window.addEventListener('resize', function () { if (open) soon(30); });
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !open) return;
    muted = true; send(true);
  }, true);
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || !e.data[CLEAR]) return;
    var s = window.getSelection(); if (s) s.removeAllRanges();
  });
})();`;
