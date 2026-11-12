import { useCallback, useLayoutEffect, useState, type MutableRefObject, type RefObject } from 'react';
import { GLIDE_MS, glideEase, glideFrom, type UnreadUnit } from './superUnread';
import { lineHostOf } from './useSuperUnread';

/**
 * The scroll of an unread jump. Its own frames rather than the browser's smooth scroll: every
 * offset write the pane makes kills a smooth scroll where it stands, and the target is re-measured
 * per frame, so a report landing during the jump cannot throw it off. A layout effect, so it runs
 * after a reveal's hold has settled. The caller owns `glideRef`: its pin and hold stand aside
 * while that is set, and its input handlers end a jump through `stopGlideRef`.
 */
export function useUnreadJump({ scrollRef, rowOf, look, measureTop, landingOf, flashMs, holdRow, captureAnchor, prevTopRef, restoreTopRef, glideRef, stopGlideRef }: {
  scrollRef: RefObject<HTMLElement | null>;
  rowOf: (u: UnreadUnit) => HTMLElement | null;
  look: () => void;
  measureTop: (node: Element, scroller: HTMLElement) => number;
  /** Where the row lands below the view's top: its line and a strip in view, nothing over them;
   *  a question card whole when it fits (landingFor). */
  landingOf: (unit: UnreadUnit, row: HTMLElement, scroller: HTMLElement) => number;
  flashMs: number;
  /** The row landed on: the pane's hold keeps ITS start in place while the layout settles. */
  holdRow: (row: HTMLElement) => void;
  captureAnchor: () => void;
  prevTopRef: MutableRefObject<number>;
  restoreTopRef: MutableRefObject<number>;
  glideRef: MutableRefObject<{ frame: number } | null>;
  stopGlideRef: MutableRefObject<() => void>;
}): (unit: UnreadUnit, opts?: { instant?: boolean }) => void {
  const [jump, setJump] = useState<{ unit: UnreadUnit; n: number; instant: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!jump) return undefined;
    stopGlideRef.current();
    const scroller = scrollRef.current;
    const row = rowOf(jump.unit);
    if (!scroller || !row) return undefined;
    const target = () => Math.max(0, Math.min(
      scroller.scrollHeight - scroller.clientHeight,
      measureTop(lineHostOf(row), scroller) - landingOf(jump.unit, row, scroller),
    ));
    const write = (top: number) => {
      scroller.scrollTop = top;
      prevTopRef.current = scroller.scrollTop;
      restoreTopRef.current = scroller.scrollTop;
    };
    // An opened pane's first landing is instant: no glide on arrival.
    const still = jump.instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = still ? target() : glideFrom(scroller.scrollTop, target());
    write(from);
    const glide = { frame: 0 };
    glideRef.current = glide;
    const land = () => {
      if (glideRef.current !== glide) return;
      cancelAnimationFrame(glide.frame);
      glideRef.current = null;
      stopGlideRef.current = () => {};
      holdRow(row);
      captureAnchor();
      look();
    };
    stopGlideRef.current = land;
    const startedAt = performance.now();
    const step = (now: number) => {
      // Parked in the garage mid-jump: no offset to write, and 0 must not become the reader's place.
      if (scroller.clientHeight === 0) { land(); return; }
      const p = Math.min(1, (now - startedAt) / GLIDE_MS);
      const to = target();
      write(from + (to - from) * glideEase(p));
      if (p < 1) glide.frame = requestAnimationFrame(step);
      else land();
    };
    if (still) land(); else glide.frame = requestAnimationFrame(step);
    if (jump.instant) return () => { land(); };
    row.setAttribute('data-reply-flash', '');
    const flash = setTimeout(() => row.removeAttribute('data-reply-flash'), flashMs);
    return () => { clearTimeout(flash); row.removeAttribute('data-reply-flash'); land(); };
  }, [jump, scrollRef, rowOf, look, measureTop, landingOf, flashMs, holdRow, captureAnchor, prevTopRef, restoreTopRef, glideRef, stopGlideRef]);
  return useCallback((unit: UnreadUnit, opts?: { instant?: boolean }) => {
    setJump((prev) => ({ unit, n: (prev?.n ?? 0) + 1, instant: !!opts?.instant }));
  }, []);
}
