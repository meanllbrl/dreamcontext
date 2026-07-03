import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePersistedState } from './usePersistedState';
import { api } from '../api/client';
import type { RoadmapLayout, RoadmapSortKey } from '../components/roadmap/chrome';
import type { RoadmapFilters, RoadmapCardProps } from '../components/roadmap/RoadmapToolbar';

/**
 * Roadmap toolbar preferences — filters, sort, view-type, properties, search.
 *
 * Persistence mirrors `useGraphSettings`: localStorage is the fast, flash-free
 * mirror, but the desktop app changes its loopback port every launch → a new
 * origin → empty localStorage. So we ALSO write-through to the server
 * (`/api/roadmap-prefs` → `state/.roadmap-prefs.json`, gitignored/per-machine)
 * and hydrate from there on mount. Best-effort: if the server route is absent
 * (older backend) the localStorage mirror still carries the state on a stable
 * origin. See `knowledge/patterns/shared-local-config-split.md`.
 */

export interface RoadmapPrefs {
  search: string;
  sortBy: RoadmapSortKey;
  sortDir: 'asc' | 'desc';
  layout: RoadmapLayout;
  cardProps: RoadmapCardProps;
  filters: RoadmapFilters;
}

export const DEFAULT_ROADMAP_PREFS: RoadmapPrefs = {
  search: '',
  sortBy: 'manual',
  sortDir: 'asc',
  layout: 'timeline',
  cardProps: { target: true, forecast: true, progress: true, status: true, dependencies: true, priority: true, tasks: false },
  filters: { status: { inc: [], exc: [] }, signal: { inc: [], exc: [] } },
};

/** Merge a (possibly partial) server blob over the defaults, section by section. */
function mergePrefs(server: Partial<RoadmapPrefs>): RoadmapPrefs {
  const d = DEFAULT_ROADMAP_PREFS;
  return {
    search: typeof server.search === 'string' ? server.search : d.search,
    sortBy: server.sortBy ?? d.sortBy,
    sortDir: server.sortDir === 'desc' ? 'desc' : 'asc',
    layout: server.layout ?? d.layout,
    cardProps: { ...d.cardProps, ...(server.cardProps ?? {}) },
    filters: {
      status: { ...d.filters.status, ...(server.filters?.status ?? {}) },
      signal: { ...d.filters.signal, ...(server.filters?.signal ?? {}) },
    },
  };
}

interface RoadmapPrefsResponse {
  settings: Partial<RoadmapPrefs>;
}

export function useRoadmapPrefs() {
  const [stored, setPrefs] = usePersistedState<RoadmapPrefs>('roadmap:prefs:v1', DEFAULT_ROADMAP_PREFS);
  // Normalize on read: a prefs blob saved before a new field existed (e.g. a new
  // card property) would be missing that key. Merging over the defaults backfills
  // any absent key so newly-shipped controls work without a storage-version bump.
  const prefs = useMemo(() => mergePrefs(stored), [stored]);

  // Hydrate once from the server; only adopt a non-empty blob so an untouched
  // project (server returns `{}`) keeps whatever the client already has.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    let cancelled = false;
    api
      .get<RoadmapPrefsResponse>('/roadmap-prefs')
      .then((res) => {
        if (cancelled) return;
        hydratedRef.current = true;
        const s = res.settings;
        if (s && typeof s === 'object' && Object.keys(s).length > 0) {
          setPrefs(mergePrefs(s));
        }
      })
      .catch(() => {
        // Best-effort — fall back to localStorage/defaults (e.g. older backend).
        hydratedRef.current = true;
      });
    return () => { cancelled = true; };
  }, [setPrefs]);

  // Debounced write-through to the server (localStorage is written synchronously
  // by usePersistedState). Skipped until the first hydrate completes so we never
  // clobber the server with defaults before we've read it.
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueServerWrite = useCallback((next: RoadmapPrefs) => {
    if (!hydratedRef.current) return;
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      api.put('/roadmap-prefs', { settings: next }).catch(() => { /* best-effort */ });
    }, 600);
  }, []);

  const update = useCallback((updater: (prev: RoadmapPrefs) => RoadmapPrefs) => {
    setPrefs((prev) => {
      // Normalize prev too, so updaters always see a complete object and we never
      // persist a partial blob back.
      const next = updater(mergePrefs(prev));
      queueServerWrite(next);
      return next;
    });
  }, [setPrefs, queueServerWrite]);

  // ── setter surface consumed by RoadmapBoard ──────────────────────────────────
  const setSearch = useCallback((search: string) => update((p) => ({ ...p, search })), [update]);
  const setSort = useCallback((sortBy: RoadmapSortKey) => update((p) => ({ ...p, sortBy })), [update]);
  const toggleSortDir = useCallback(() => update((p) => ({ ...p, sortDir: p.sortDir === 'asc' ? 'desc' : 'asc' })), [update]);
  const setLayout = useCallback((layout: RoadmapLayout) => update((p) => ({ ...p, layout })), [update]);
  const toggleCardProp = useCallback((k: keyof RoadmapCardProps) =>
    update((p) => ({ ...p, cardProps: { ...p.cardProps, [k]: !p.cardProps[k] } })), [update]);
  const clearAllFilters = useCallback(() =>
    update((p) => ({ ...p, filters: { status: { inc: [], exc: [] }, signal: { inc: [], exc: [] } } })), [update]);
  const cycleFilter = useCallback((section: keyof RoadmapFilters, value: string, kind: 'inc' | 'exc') => {
    update((p) => {
      const cur = p.filters[section];
      // A value lives in exactly one of inc/exc: toggle it in the clicked list and
      // always drop it from the other.
      const on = kind === 'inc'
        ? { inc: cur.inc.includes(value) ? cur.inc.filter((v) => v !== value) : [...cur.inc, value], exc: cur.exc.filter((v) => v !== value) }
        : { exc: cur.exc.includes(value) ? cur.exc.filter((v) => v !== value) : [...cur.exc, value], inc: cur.inc.filter((v) => v !== value) };
      return { ...p, filters: { ...p.filters, [section]: on } };
    });
  }, [update]);

  return { prefs, setSearch, setSort, toggleSortDir, setLayout, toggleCardProp, cycleFilter, clearAllFilters };
}
