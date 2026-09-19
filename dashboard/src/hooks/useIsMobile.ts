import { useEffect, useState } from 'react';

/**
 * "Is this a phone?" — the ONE definition, so every mobile branch agrees.
 *
 * Two conditions, and the second is the load-bearing one:
 *
 *   `(max-width: 768px)`  — narrow enough that the desktop chrome does not fit.
 *   `(pointer: coarse)`   — the primary input is a finger, not a mouse.
 *
 * Width alone would be wrong in the direction that hurts: a narrowed desktop window
 * (or a Tauri pane dragged small) would flip the app into the chat-only phone layout and
 * take the dashboard away from someone who never asked for it. A phone satisfies both; a
 * narrow desktop window satisfies only the first and keeps every desktop affordance.
 *
 * Subscribed rather than sampled, so a rotation (portrait 390 → landscape 844) re-evaluates
 * instead of leaving the layout in whichever branch happened to mount first. Both queries are
 * watched: `pointer` can change under a device-emulation toggle and on a convertible laptop.
 *
 * SSR/JSDOM-safe: no `matchMedia` → false, i.e. "desktop", which is the branch that renders
 * everything.
 */
export const MOBILE_WIDTH_QUERY = '(max-width: 768px)';
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

function readIsMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_WIDTH_QUERY).matches
    && window.matchMedia(COARSE_POINTER_QUERY).matches;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(readIsMobile);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const queries = [
      window.matchMedia(MOBILE_WIDTH_QUERY),
      window.matchMedia(COARSE_POINTER_QUERY),
    ];
    // Re-READ both queries on any change rather than trusting the event's own `matches`:
    // the answer is their conjunction, and an event only carries its own half.
    const onChange = () => setIsMobile(readIsMobile());
    for (const q of queries) q.addEventListener('change', onChange);
    // The mount-time state was computed before the effect ran; re-read once in case the
    // viewport settled between render and commit (device emulation does exactly this).
    onChange();
    return () => { for (const q of queries) q.removeEventListener('change', onChange); };
  }, []);

  return isMobile;
}
