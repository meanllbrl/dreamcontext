import type { RoadmapLayout, RoadmapLevel, RoadmapSortKey } from '../components/roadmap/chrome';
import type { RoadmapFilters, RoadmapCardProps } from '../components/roadmap/RoadmapToolbar';

/** The Roadmap toolbar preferences: pure shape + merge (the hook is useRoadmapPrefs.ts). */
export interface RoadmapPrefs {
  search: string;
  sortBy: RoadmapSortKey;
  sortDir: 'asc' | 'desc';
  layout: RoadmapLayout;
  /** Lanes / Map level: objectives first, then tasks. */
  level: RoadmapLevel;
  /** Schema version: 2 = the priority board shipped. A blob without it keeps none of its layout. */
  v: 2;
  cardProps: RoadmapCardProps;
  filters: RoadmapFilters;
}

const LAYOUTS: readonly RoadmapLayout[] = ['lanes', 'map', 'timeline', 'board'];

export const DEFAULT_ROADMAP_PREFS: RoadmapPrefs = {
  search: '',
  sortBy: 'manual',
  sortDir: 'asc',
  layout: 'lanes',
  level: 'objectives',
  v: 2,
  cardProps: { target: true, forecast: true, progress: true, status: true, dependencies: true, priority: true, tasks: false },
  filters: { status: { inc: [], exc: [] }, signal: { inc: [], exc: [] } },
};

/**
 * Merge a (possibly partial) server blob over the defaults, section by section.
 * `layout` is adopted only from a v2 blob: a machine with prefs saved before the
 * priority board opens on the new default (Objectives + Lanes) ONCE, then every
 * later write carries v: 2 and the owner's choice sticks.
 */
export function mergePrefs(server: Partial<Omit<RoadmapPrefs, 'v'>> & { v?: unknown }): RoadmapPrefs {
  const d = DEFAULT_ROADMAP_PREFS;
  const v2 = server.v === 2;
  return {
    search: typeof server.search === 'string' ? server.search : d.search,
    sortBy: server.sortBy ?? d.sortBy,
    sortDir: server.sortDir === 'desc' ? 'desc' : 'asc',
    layout: v2 && server.layout && LAYOUTS.includes(server.layout) ? server.layout : d.layout,
    level: v2 && server.level === 'tasks' ? 'tasks' : d.level,
    v: 2,
    cardProps: { ...d.cardProps, ...(server.cardProps ?? {}) },
    filters: {
      status: { ...d.filters.status, ...(server.filters?.status ?? {}) },
      signal: { ...d.filters.signal, ...(server.filters?.signal ?? {}) },
    },
  };
}

