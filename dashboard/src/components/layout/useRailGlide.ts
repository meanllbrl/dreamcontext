/**
 * The rail collapses and expands in ONE layout; the motion is a slab glided across the strip
 * between its two widths, with `transform` only.
 *
 * The rail used to animate `width` (and the expanded Agent overlay its `left` alongside it),
 * which is a style + layout pass of the whole main area per frame — the page, and with the
 * overlay open every pane's transcript. With two long transcripts side by side that was
 * 14–26 layouts and 130–175ms frames at 4x CPU (verify:chat-smooth), and 66–116ms gaps in
 * the owner's WebKit recording (10-04: "çok takılıyor"). Same move as the pane focus widening
 * (usePaneFocusGlide.ts, 09-28): geometry snaps, a compositor-only element carries the motion.
 *
 * Collapse slides a slab of RAIL out of the strip to the left, so the rail's edge reads as
 * travelling 220 → 56; expand slides a slab of CONTENT out to the right, uncovering the rail
 * that is already laid out underneath. See `.sidebar-glide` in Sidebar.css.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';

/** `--transition-normal` (240ms ease) — what the rail's width transition ran at. */
const GLIDE_MS = 240;

function reducedMotion(): boolean {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
}

/**
 * `shell` is the Shell root (the rail is found inside it), `strip` the `.sidebar-glide`
 * element. Plays only on a CHANGE of `collapsed` — never on mount, where there is nothing to
 * glide from — and a toggle mid-glide restarts from the new direction's first frame.
 */
export function useRailGlide(
  shell: RefObject<HTMLElement | null>,
  strip: RefObject<HTMLElement | null>,
  collapsed: boolean,
): void {
  const prev = useRef(collapsed);
  const anim = useRef<Animation | null>(null);

  // A LAYOUT effect: the rail already sits at its new width (one layout), and the slab has
  // to be on its first frame before paint, or the strip flashes its final state for a frame.
  useLayoutEffect(() => {
    if (prev.current === collapsed) return;
    prev.current = collapsed;
    anim.current?.cancel();
    anim.current = null;
    const el = strip.current;
    const slab = el?.firstElementChild;
    const rail = shell.current?.querySelector('.sidebar');
    if (!el || !(slab instanceof HTMLElement) || !rail || reducedMotion() || typeof slab.animate !== 'function') return;
    // A background project is `display: none` — it has no rail on screen to glide.
    const r = rail.getBoundingClientRect();
    if (!r.height) return;
    el.style.top = `${r.top}px`;
    el.style.height = `${r.height}px`;
    el.dataset.dir = collapsed ? 'collapse' : 'expand';
    anim.current = slab.animate(
      [{ transform: 'translateX(0)' }, { transform: collapsed ? 'translateX(-100%)' : 'translateX(100%)' }],
      { duration: GLIDE_MS, easing: 'ease' },
    );
  }, [collapsed, shell, strip]);

  useLayoutEffect(() => () => anim.current?.cancel(), []);
}
