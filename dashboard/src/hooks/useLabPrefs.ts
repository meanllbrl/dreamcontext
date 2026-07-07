import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePersistedState } from './usePersistedState';
import { api } from '../api/client';

/**
 * Insights (Lab) board preferences — per-group card order + collapsed groups.
 *
 * Persistence mirrors `useRoadmapPrefs`: localStorage is the fast, flash-free
 * mirror, but the desktop app changes its loopback port every launch → a new
 * origin → empty localStorage. So we ALSO write-through to the server
 * (`/api/lab-prefs` → `state/.lab-prefs.json`, gitignored/per-machine) and
 * hydrate from there on mount. Best-effort: if the server route is absent
 * (older backend) the localStorage mirror still carries the state on a stable
 * origin. See `knowledge/patterns/shared-local-config-split.md`.
 */

export interface LabPrefs {
  /** Manual card order per group: group name → slug list. Slugs not listed
   *  (new insights) render after the ordered ones, in API order. */
  order: Record<string, string[]>;
  /** Group section names currently collapsed. */
  collapsed: string[];
}

export const DEFAULT_LAB_PREFS: LabPrefs = {
  order: {},
  collapsed: [],
};

/** Merge a (possibly partial) blob over the defaults, dropping malformed keys. */
function mergePrefs(blob: Partial<LabPrefs>): LabPrefs {
  const order: Record<string, string[]> = {};
  if (blob.order && typeof blob.order === 'object' && !Array.isArray(blob.order)) {
    for (const [group, slugs] of Object.entries(blob.order)) {
      if (Array.isArray(slugs)) order[group] = slugs.filter((s) => typeof s === 'string');
    }
  }
  const collapsed = Array.isArray(blob.collapsed)
    ? blob.collapsed.filter((g) => typeof g === 'string')
    : [];
  return { order, collapsed };
}

interface LabPrefsResponse {
  settings: Partial<LabPrefs>;
}

export function useLabPrefs() {
  const [stored, setPrefs] = usePersistedState<LabPrefs>('lab:prefs:v1', DEFAULT_LAB_PREFS);
  const prefs = useMemo(() => mergePrefs(stored), [stored]);

  // Hydrate once from the server; only adopt a non-empty blob so an untouched
  // project (server returns `{}`) keeps whatever the client already has.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    let cancelled = false;
    api
      .get<LabPrefsResponse>('/lab-prefs')
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
  const queueServerWrite = useCallback((next: LabPrefs) => {
    if (!hydratedRef.current) return;
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      api.put('/lab-prefs', { settings: next }).catch(() => { /* best-effort */ });
    }, 600);
  }, []);

  const update = useCallback((updater: (prev: LabPrefs) => LabPrefs) => {
    setPrefs((prev) => {
      const next = updater(mergePrefs(prev));
      queueServerWrite(next);
      return next;
    });
  }, [setPrefs, queueServerWrite]);

  const toggleCollapsed = useCallback((group: string) => {
    update((p) => ({
      ...p,
      collapsed: p.collapsed.includes(group)
        ? p.collapsed.filter((g) => g !== group)
        : [...p.collapsed, group],
    }));
  }, [update]);

  const setGroupOrder = useCallback((group: string, slugs: string[]) => {
    update((p) => ({ ...p, order: { ...p.order, [group]: slugs } }));
  }, [update]);

  return { prefs, toggleCollapsed, setGroupOrder };
}
