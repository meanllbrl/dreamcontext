/**
 * The page viewer's zoom bridge (FrameViewer, 2026-10-22): while the owner clicks INSIDE a page
 * shown full screen ("Click" mode), its wheel and its trackpad pinch land in the page's own
 * document, out of the viewer's reach. This script, run in the sandboxed page, posts them to the
 * parent so the viewer still scrolls and zooms; it stops the page itself zooming on ctrl+wheel.
 * Esc pressed inside the page (its focus is in the page after a click) closes the viewer too.
 *
 * The page's own scripts can read this script and post the same messages, so the parent trusts
 * none of it beyond "a zoom or a scroll was asked": it accepts only messages from that frame's
 * own window (`event.source`), of the shapes below, with finite numbers it clamps itself.
 */
export const ZOOM_MESSAGE_KEY = '__dreamFrameZoom';

export const ZOOM_BRIDGE = `(function () {
  function post(m) { parent.postMessage({ ${ZOOM_MESSAGE_KEY}: m }, '*'); }
  window.addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
    post({ kind: 'wheel', dx: e.deltaX, dy: e.deltaY, ctrl: !!(e.ctrlKey || e.metaKey), x: e.clientX, y: e.clientY });
  }, { passive: false });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') post({ kind: 'escape' });
  });
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) {
    window.addEventListener(t, function (e) {
      e.preventDefault();
      post({ kind: 'gesture', phase: t.slice(7), scale: e.scale, x: e.clientX, y: e.clientY });
    });
  });
})();`;

export type ZoomMessage =
  | { kind: 'escape' }
  | { kind: 'wheel'; dx: number; dy: number; ctrl: boolean; x: number; y: number }
  | { kind: 'gesture'; phase: 'start' | 'change' | 'end'; scale: number; x: number; y: number };

const BIG = 100_000;
const num = (v: unknown, lo: number, hi: number): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

/** A bridge message, or null for anything else (an unknown shape, a non-finite number). */
export function readZoomMessage(data: unknown): ZoomMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = (data as Record<string, unknown>)[ZOOM_MESSAGE_KEY];
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  if (r.kind === 'escape') return { kind: 'escape' };
  const x = num(r.x, -BIG, BIG);
  const y = num(r.y, -BIG, BIG);
  if (x === null || y === null) return null;
  if (r.kind === 'wheel') {
    const dx = num(r.dx, -BIG, BIG);
    const dy = num(r.dy, -BIG, BIG);
    if (dx === null || dy === null || typeof r.ctrl !== 'boolean') return null;
    return { kind: 'wheel', dx, dy, ctrl: r.ctrl, x, y };
  }
  if (r.kind === 'gesture' && (r.phase === 'start' || r.phase === 'change' || r.phase === 'end')) {
    // A pinch's own scale: 1/10 to 10 times where it started.
    const scale = num(r.scale, 0.1, 10);
    if (scale === null || scale <= 0) return null;
    return { kind: 'gesture', phase: r.phase, scale, x, y };
  }
  return null;
}
