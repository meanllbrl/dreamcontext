/**
 * The app's short entrances, run from script (WAAPI): opacity only, so they stay on the
 * compositor and never lay anything out. Script-run motion is outside the stylesheet's global
 * reduced-motion rule, so every one of them asks here first.
 */
import { isLightMode } from './lightMode';

/** The page-level entrance: long enough to read as a move, short enough to never be waited on. */
export const SOFT_MS = 160;

/** True when nothing should move: the system asks for reduced motion, or light mode is on. */
export function softMotionOff(): boolean {
  if (isLightMode()) return true;
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
}

/** Fades `el` in. Returns the running animation, or null when nothing ran. */
export function fadeIn(el: Element | null | undefined, ms: number = SOFT_MS): Animation | null {
  if (!el || typeof el.animate !== 'function' || softMotionOff()) return null;
  return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' });
}

/** Fades `el` out and resolves when it is gone (at once when nothing may move). */
export function fadeOut(el: Element | null | undefined, ms: number = SOFT_MS): { animation: Animation | null; done: Promise<void> } {
  if (!el || typeof el.animate !== 'function' || softMotionOff()) return { animation: null, done: Promise.resolve() };
  const animation = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
  return { animation, done: animation.finished.then(() => undefined, () => undefined) };
}
