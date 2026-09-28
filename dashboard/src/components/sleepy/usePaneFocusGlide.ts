/**
 * The focused pane's accent bar GLIDES to it; the panes themselves land in one frame.
 *
 * The widening used to be a `flex-basis` transition, and a layout property animated is a
 * layout per frame — of EVERY pane in the row, transcripts, cards and diagram frames
 * included. Measured in WebKit (the desktop app's engine) with long transcripts: 6 frames in
 * 160ms with 36ms gaps, against 13 frames / 14ms for the same row empty. That is the
 * "kare kare" report (owner, 09-28).
 *
 * So the geometry snaps — one layout, which the content needed anyway to re-wrap at its new
 * width — and the motion moves to ONE absolutely-positioned bar animated with `transform`
 * only (FLIP: land it at the new rect, then play it from the old rect back to none), which
 * the compositor runs without touching layout. The ring on the pane fades in (CSS) while the
 * bar slides, so the switch still reads as the row rebalancing, not a cut.
 *
 * Owner call 09-28, from a card that also offered freezing the content (measured 9 frames,
 * 67ms worst gap — better, not smooth) and `content-visibility` (smoothest, but it reverses
 * the documented stick-to-bottom decision in chatEntities.ts).
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const GLIDE_MS = 120;

interface Rect { x: number; w: number }

function reducedMotion(): boolean {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
}

/**
 * `row` is `.agent-panes` (positioned, so it is the panes' offsetParent), `bar` the glide
 * element inside it. A focus or pane-count change glides the bar; a resize of the row (the
 * window, the sidebar) re-seats it WITHOUT animating — a window being dragged must not trail
 * a sliding bar behind it.
 */
export function usePaneFocusGlide(
  row: RefObject<HTMLElement | null>,
  bar: RefObject<HTMLElement | null>,
  activeId: string | undefined,
  count: number,
): void {
  const last = useRef<Rect | null>(null);
  const anim = useRef<Animation | null>(null);

  const place = (animate: boolean) => {
    const host = row.current;
    const el = bar.current;
    if (!host || !el) return;
    const pane = count > 1 ? host.querySelector<HTMLElement>(':scope > .agent-pane.active') : null;
    if (!pane) {
      el.style.display = 'none';
      last.current = null;
      return;
    }
    // Mid-glide, "where it was" is where the bar IS on screen, not the rect it was heading
    // to — so a second switch continues from there instead of jumping back first.
    let prev = last.current;
    if (prev && anim.current?.playState === 'running') {
      const b = el.getBoundingClientRect();
      prev = { x: b.left - host.getBoundingClientRect().left, w: b.width };
    }
    anim.current?.cancel();
    const next: Rect = { x: pane.offsetLeft, w: pane.offsetWidth };
    last.current = next;
    el.style.display = '';
    el.style.left = `${next.x}px`;
    el.style.width = `${next.w}px`;
    if (!animate || !prev || next.w <= 0 || (prev.x === next.x && prev.w === next.w)) return;
    if (reducedMotion() || typeof el.animate !== 'function') return;
    anim.current = el.animate(
      [{ transform: `translateX(${prev.x - next.x}px) scaleX(${prev.w / next.w})` }, { transform: 'none' }],
      { duration: GLIDE_MS, easing: 'ease' },
    );
  };

  // Layout effect: the panes already sit at their new widths (one layout), and the bar has
  // to be at its FIRST frame before paint, or it flashes at the destination for a frame.
  // Keyed on focus + count, never every render: a render mid-stream would otherwise force
  // a synchronous layout just to read a rect that did not move.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { place(true); }, [activeId, count]);

  useEffect(() => {
    const host = row.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(host);
    return () => { ro.disconnect(); anim.current?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count > 1]);
}
