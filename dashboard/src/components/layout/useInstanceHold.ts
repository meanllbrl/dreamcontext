/**
 * Changing project without a blank frame (owner, 2026-11-22: opening a closed project "takılıyor
 * ve kasılıyor", and from one project's Tasks to another's there was no smooth change).
 *
 * A project that was just opened draws itself in steps: its frame, then its data, then its chat.
 * Shown at the press, those steps were the transition: an empty card, then content popping in.
 * So the project being LEFT stays on screen, over the arriving one, until the arriving one has
 * stopped growing, and then fades away over it.
 *
 * Nothing about `isActive` moves. The left project is `hidden` and `inert` from the press, as
 * before: its polling stops, it takes no key and no click, and every `:not([hidden])` reader
 * already sees the new project. Only its PAINT is kept, by one attribute (`data-holding`,
 * ProjectInstance.css), at the size it already had, for at most `HOLD_CAP_MS`.
 *
 * Only for a project this window has not shown yet. One that was shown before is already drawn
 * and comes back in a single layout: holding the old one over it laid BOTH out in that frame
 * (measured: a 108 ms switch became 222 ms), so it simply fades in.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { fadeIn, fadeOut } from '../../lib/softMotion';

/** How often the arriving project is looked at. Two looks alike in a row: it is drawn. */
const LOOK_MS = 50;
/** "Alike": a streaming answer or a ticking clock adds a few elements and is not a step of the
 *  page drawing itself, so the count may move by this share between two looks. */
const SAME_SHARE = 0.03;
/** The longest the left project stays, whatever the arriving one is doing. */
export const HOLD_CAP_MS = 900;
/** Fewer elements than this is a frame with nothing in it yet. */
const DRAWN_ELEMENTS = 150;

function instanceEl(id: string): HTMLElement | null {
  const el = document.querySelector(`.project-instance[data-instance="${CSS.escape(id)}"]`);
  return el instanceof HTMLElement ? el : null;
}

/** Keeps `old` painted over `next` until `next` is drawn. Returns the way to end it at once. */
export function holdInstance(old: HTMLElement, next: HTMLElement): () => void {
  let over = false;
  let fading: Animation | null = null;
  let look: number | undefined;
  const clear = () => {
    over = true;
    window.clearTimeout(look);
    window.clearTimeout(cap);
    fading?.cancel();
    delete old.dataset.holding;
    next.style.pointerEvents = '';
  };
  const release = () => {
    if (over || fading) return;
    window.clearTimeout(look);
    window.clearTimeout(cap);
    old.dataset.holding = 'fade';
    const out = fadeOut(old);
    fading = out.animation;
    void out.done.then(() => { if (!over) clear(); });
  };
  // Counted, not observed: an observer of every change never goes quiet under a chat that is
  // streaming, and the project would wait out the whole cap behind it.
  const watch = (before: number) => {
    look = window.setTimeout(() => {
      const now = next.getElementsByTagName('*').length;
      if (now >= DRAWN_ELEMENTS && Math.abs(now - before) <= Math.max(2, now * SAME_SHARE)) release();
      else watch(now);
    }, LOOK_MS);
  };
  const cap = window.setTimeout(release, HOLD_CAP_MS);
  old.dataset.holding = 'hold';
  // The held project is `inert`, so a click on it would fall through to the arriving one, on a
  // control the owner cannot see. Until the arriving one shows, it takes no pointer.
  next.style.pointerEvents = 'none';
  watch(-1);
  return clear;
}

/**
 * `activeId` is the visible project's instance id. Runs as a LAYOUT effect: the attribute lands
 * in the commit that hides the left project, so no frame shows the gap between the two.
 */
export function useInstanceHold(activeId: string | null, on: boolean): void {
  const prev = useRef(activeId);
  const end = useRef<(() => void) | null>(null);
  const seen = useRef(new Set<string>());
  useLayoutEffect(() => {
    const from = prev.current;
    prev.current = activeId;
    end.current?.();
    end.current = null;
    if (!activeId) return;
    const warm = seen.current.has(activeId);
    seen.current.add(activeId);
    if (!on || !from || from === activeId) return;
    const next = instanceEl(activeId);
    if (!next) return;
    if (warm) {
      const arriving = fadeIn(next);
      end.current = () => arriving?.cancel();
      return;
    }
    const old = instanceEl(from);
    if (old) end.current = holdInstance(old, next);
  }, [activeId, on]);
  useEffect(() => () => { end.current?.(); }, []);
}
