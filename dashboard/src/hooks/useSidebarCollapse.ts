import { useState, useEffect, useCallback } from 'react';

const COLLAPSE_STORAGE_KEY = 'dreamcontext.dashboard.sidebarCollapsed';

// CSS cannot drive @media from custom properties in this Vite setup, so 1024
// is a documented literal matching the responsive breakpoint in Sidebar.css.
const NARROW_QUERY =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(max-width: 1024px)')
    : null;

function readUserPref(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Shared sidebar-collapse state. Lifted out of the Sidebar so the Header's
 * toggle button and the Sidebar render from the same source of truth (matches
 * the design, where collapse lives in the title bar — not inside the rail).
 *
 * `collapsed` = the user's explicit preference OR a forced auto-collapse at
 * ≤1024px viewport. The toggle only mutates the persisted user preference.
 */
export function useSidebarCollapse() {
  const [userPref, setUserPref] = useState<boolean>(readUserPref);
  const [forced, setForced] = useState<boolean>(NARROW_QUERY?.matches ?? false);

  useEffect(() => {
    if (!NARROW_QUERY) return;
    const handler = (e: MediaQueryListEvent) => setForced(e.matches);
    NARROW_QUERY.addEventListener('change', handler);
    return () => NARROW_QUERY.removeEventListener('change', handler);
  }, []);

  const toggle = useCallback(() => {
    setUserPref((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // localStorage unavailable — ignore
      }
      return next;
    });
  }, []);

  return { collapsed: forced || userPref, toggle };
}
