import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { COARSE_POINTER_QUERY, readRemoteDesktop } from './useIsMobile';

const COLLAPSE_STORAGE_KEY = 'dreamcontext.dashboard.sidebarCollapsed';

// CSS cannot drive @media from custom properties in this Vite setup, so 1024
// is a documented literal matching the responsive breakpoint in Sidebar.css.
const NARROW_QUERY =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(max-width: 1024px)')
    : null;

/** A finger on a remote screen (a tablet on Mac mode's tunnel, hands-free sekmeler W2): the rail
 *  starts folded to its 56 px icons, so the panes get the width. A first-load default only, never
 *  written over the owner's own choice. */
function readTouchRemote(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return readRemoteDesktop() && window.matchMedia(COARSE_POINTER_QUERY).matches;
}

function readUserPref(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

// ── The hold (plan-r8 F9): the rail folds while a project is handed over to its Super Agent ──
// A module signal, not a preference: a project instance holds the rail collapsed while its
// Super Agent has the screen, and releases it on take-back. The saved preference is never
// written, so take-back restores exactly what the owner had.
const holds = new Set<string>();
const holdListeners = new Set<() => void>();

/** Hold (or release) the rail collapsed for this project instance. Idempotent. */
export function holdSidebarCollapsed(instanceId: string, on: boolean): void {
  if (!instanceId || holds.has(instanceId) === on) return;
  if (on) holds.add(instanceId);
  else holds.delete(instanceId);
  for (const l of [...holdListeners]) l();
}

export function isSidebarHeld(instanceId: string | null | undefined): boolean {
  return !!instanceId && holds.has(instanceId);
}

const subscribeHolds = (cb: () => void) => {
  holdListeners.add(cb);
  return () => { holdListeners.delete(cb); };
};

/** Is the rail held collapsed for this instance? (The header disables its toggle while it is.) */
export function useSidebarHeld(instanceId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeHolds, () => isSidebarHeld(instanceId), () => false);
}

/**
 * Shared sidebar-collapse state. Lifted out of the Sidebar so the Header's
 * toggle button and the Sidebar render from the same source of truth (matches
 * the design, where collapse lives in the title bar — not inside the rail).
 *
 * `collapsed` = the user's explicit preference OR a forced auto-collapse at
 * ≤1024px viewport. The toggle only mutates the persisted user preference.
 *
 * CALL THIS FROM EXACTLY ONE OWNER — `WindowChrome`, which passes `collapsed` and `toggle`
 * down to every mounted project instance. The KEY above stays app-global on purpose (one
 * rail width per window is right; two rails of different widths side by side would read as
 * broken), but the STATE is per-hook-call: a second caller reads the key at mount and then
 * never hears about the first one's toggle, so N callers in one window silently diverge.
 * Scoping the key per vault would be the wrong fix for the same reason.
 */
export function useSidebarCollapse(activeInstanceId?: string | null) {
  const [userPref, setUserPref] = useState<boolean>(readUserPref);
  const held = useSidebarHeld(activeInstanceId);
  const [forced, setForced] = useState<boolean>(NARROW_QUERY?.matches ?? false);
  const [touchStart, setTouchStart] = useState<boolean>(readTouchRemote);

  useEffect(() => {
    if (!NARROW_QUERY) return;
    const handler = (e: MediaQueryListEvent) => setForced(e.matches);
    NARROW_QUERY.addEventListener('change', handler);
    return () => NARROW_QUERY.removeEventListener('change', handler);
  }, []);

  const toggle = useCallback(() => {
    // Held by a handed-over project: the toggle is a no-op, and the preference stays as it was.
    if (isSidebarHeld(activeInstanceId)) return;
    // The first-load fold on a remote touch screen: the owner's first toggle opens the rail.
    if (touchStart) {
      setTouchStart(false);
      setUserPref(false);
      return;
    }
    setUserPref((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // localStorage unavailable — ignore
      }
      return next;
    });
  }, [activeInstanceId, touchStart]);

  return { collapsed: forced || userPref || held || touchStart, held, toggle };
}
