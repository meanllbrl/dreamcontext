import { useEffect, useState } from 'react';
import { isMacPhoneSurface } from '../lib/phoneSurface';

/**
 * "Is this a phone?" — the ONE definition of the LAYOUT, so every mobile branch agrees.
 *
 * Two questions that used to be one (hands-free sekmeler, owner 2026-10-25):
 *
 *   SURFACE (trust) — `isMacPhoneSurface()`: this page came through Mac mode's tunnel. Every
 *   security and behaviour branch keys on it (route avoidance, the photo path, phone voice, push,
 *   4401, no read-aloud) and it never changes for the life of the document.
 *
 *   LAYOUT (screen) — this hook: the phone UI (one chat at a time, the Sohbetler list) or the
 *   desktop UI (project chips, chat tabs, panes, the Super stage).
 *
 * On the tunnel: the phone layout iff the primary input is a finger AND the screen is small or
 * upright — `(pointer: coarse)` and (`min(innerWidth, innerHeight) < 600` or portrait). A mouse or
 * trackpad is ALWAYS the desktop layout, whatever the window size; a tablet held landscape gets
 * the desktop, held portrait the phone (owner D4). A computer on the tunnel is `remoteDesktop`
 * ({@link useRemoteDesktop}). Before any window exists the tunnel is the phone, as before.
 *
 * Elsewhere, two conditions, and the second is the load-bearing one:
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
 * watched, and on the tunnel the window's size and orientation too: `pointer` can change under
 * a device-emulation toggle and on a convertible laptop. A layout switch never unmounts a
 * project or closes a chat (the instances stay mounted; only the chrome around them changes).
 *
 * SSR/JSDOM-safe: no `matchMedia` → false off the tunnel, i.e. "desktop", which is the branch
 * that renders everything.
 */
export const MOBILE_WIDTH_QUERY = '(max-width: 768px)';
export const COARSE_POINTER_QUERY = '(pointer: coarse)';
export const PORTRAIT_QUERY = '(orientation: portrait)';
/** On the tunnel, a finger on a screen whose SHORT side is under this is a phone in any
 *  orientation (an 844×390 phone held sideways stays the phone layout). */
export const REMOTE_PHONE_SHORT_SIDE = 600;

/** The tunnel's layout rule: a finger on a small or upright screen. */
function remoteIsPhone(): boolean {
  const coarse = window.matchMedia(COARSE_POINTER_QUERY).matches;
  if (!coarse) return false;
  const w = typeof window.innerWidth === 'number' ? window.innerWidth : 0;
  const h = typeof window.innerHeight === 'number' ? window.innerHeight : 0;
  const portrait = w > 0 && h > 0 ? h > w : window.matchMedia(PORTRAIT_QUERY).matches;
  const short = w > 0 && h > 0 ? Math.min(w, h) : 0;
  return portrait || (short > 0 && short < REMOTE_PHONE_SHORT_SIDE);
}

/** The same answer, read once (for an initial state). */
export function readIsMobile(): boolean {
  const tunnel = isMacPhoneSurface();
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return tunnel;
  if (tunnel) return remoteIsPhone();
  return window.matchMedia(MOBILE_WIDTH_QUERY).matches
    && window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/** A computer or a landscape tablet on the tunnel: the desktop layout, the tunnel's trust. */
export function readRemoteDesktop(): boolean {
  return isMacPhoneSurface() && !readIsMobile();
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(readIsMobile);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const queries = [
      window.matchMedia(MOBILE_WIDTH_QUERY),
      window.matchMedia(COARSE_POINTER_QUERY),
      window.matchMedia(PORTRAIT_QUERY),
    ];
    // Re-READ every query on any change rather than trusting the event's own `matches`:
    // the answer is their conjunction, and an event only carries its own half.
    const onChange = () => setIsMobile(readIsMobile());
    for (const q of queries) q.addEventListener('change', onChange);
    // On the tunnel the short side decides too: a resize can cross it with no query changing.
    const tunnel = isMacPhoneSurface();
    if (tunnel) { window.addEventListener('resize', onChange); window.addEventListener('orientationchange', onChange); }
    // The mount-time state was computed before the effect ran; re-read once in case the
    // viewport settled between render and commit (device emulation does exactly this).
    onChange();
    return () => {
      for (const q of queries) q.removeEventListener('change', onChange);
      if (tunnel) { window.removeEventListener('resize', onChange); window.removeEventListener('orientationchange', onChange); }
    };
  }, []);

  return isMobile;
}

/** {@link readRemoteDesktop}, subscribed: the desktop layout on the tunnel. */
export function useRemoteDesktop(): boolean {
  const isMobile = useIsMobile();
  return isMacPhoneSurface() && !isMobile;
}
