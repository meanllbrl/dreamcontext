import { useCallback, useEffect, useState } from 'react';

/**
 * Multi-page insight routing (A2) — the minimal contract a render kind can
 * adopt to get routed pages instead of a slide-over:
 *
 *   /lab/<slug>                → the insight's page 1 (funnel: overview table)
 *   /lab/<slug>/f/<funnelId>   → page 2 (funnel: detail lane)
 *
 * The Lab board card is page 1's entry. View state (filters, breakdown,
 * compare, arcs, sort — see funnelModel's view-state codecs) rides the QUERY
 * STRING so `?vault=` and `?page=` survive untouched; back/forward work via
 * real history entries + popstate. `funnel` is the only adopter today — a
 * future table/cohort-grid insight reuses this module, not a new framework.
 */

export interface LabRoute {
  slug: string | null;
  funnelId: string | null;
}

/** Fired after our own pushState/replaceState (popstate only covers back/forward). */
const NAV_EVENT = 'dc-lab-route';

export function parseLabPath(pathname: string): LabRoute {
  const m = /^\/lab\/([^/]+)(?:\/f\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return { slug: null, funnelId: null };
  try {
    return { slug: decodeURIComponent(m[1]), funnelId: m[2] ? decodeURIComponent(m[2]) : null };
  } catch {
    return { slug: null, funnelId: null };
  }
}

export function labPath(slug: string | null, funnelId: string | null): string {
  if (!slug) return '/';
  return funnelId
    ? `/lab/${encodeURIComponent(slug)}/f/${encodeURIComponent(funnelId)}`
    : `/lab/${encodeURIComponent(slug)}`;
}

function notify(): void {
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Push a new lab location (path change = a history entry the Back button pops). */
export function pushLabPath(slug: string | null, funnelId: string | null): void {
  const target = labPath(slug, funnelId) + window.location.search;
  if (window.location.pathname + window.location.search === target) return;
  window.history.pushState(null, '', target);
  notify();
}

/** Replace the current query string (view-state edits don't spam history). */
export function replaceSearch(params: URLSearchParams): void {
  const search = params.toString();
  const target = window.location.pathname + (search ? `?${search}` : '');
  if (window.location.pathname + window.location.search === target) return;
  window.history.replaceState(null, '', target);
  notify();
}

/** Reset the path to `/` (keeps the query) — used when leaving the Lab page. */
export function clearLabPath(): void {
  if (window.location.pathname === '/') return;
  window.history.replaceState(null, '', '/' + window.location.search);
  notify();
}

/** The absolute deep link for the CURRENT location (copy-link actions). */
export function currentDeepLink(): string {
  return window.location.href;
}

/** Live view of the lab route (path segments). Re-renders on push/pop. */
export function useLabRoute(): LabRoute {
  const [route, setRoute] = useState<LabRoute>(() => parseLabPath(window.location.pathname));
  useEffect(() => {
    const onChange = () => setRoute(parseLabPath(window.location.pathname));
    window.addEventListener('popstate', onChange);
    window.addEventListener(NAV_EVENT, onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener(NAV_EVENT, onChange);
    };
  }, []);
  return route;
}

/** Live view of the query string + an updater that preserves foreign params. */
export function useLabSearchParams(): [URLSearchParams, (mutate: (params: URLSearchParams) => void) => void] {
  const [params, setParams] = useState(() => new URLSearchParams(window.location.search));
  useEffect(() => {
    const onChange = () => setParams(new URLSearchParams(window.location.search));
    window.addEventListener('popstate', onChange);
    window.addEventListener(NAV_EVENT, onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener(NAV_EVENT, onChange);
    };
  }, []);
  const update = useCallback((mutate: (params: URLSearchParams) => void) => {
    const next = new URLSearchParams(window.location.search);
    mutate(next);
    replaceSearch(next);
  }, []);
  return [params, update];
}
