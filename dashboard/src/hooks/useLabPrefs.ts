import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePersistedState } from './usePersistedState';
import { useApi } from '../context/VaultContext';

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
  /** Manual card order per section: section key → slug list. Slugs not listed
   *  (new insights) render after the ordered ones, in API order. Categorized
   *  sections key as "<category> / <group>", uncategorized as the bare group. */
  order: Record<string, string[]>;
  /** Section keys currently collapsed. */
  collapsed: string[];
  /** Active category tab, or null for "All". */
  category: string | null;
  /** Manual tab order: category names first (in saved order), unlisted ones
   *  (new categories) after, alphabetical. */
  catOrder: string[];
  /** Funnel overview visible columns: insight slug → column keys. Absent slug =
   *  no opinion (the payload's metric columns); an empty array is a real choice
   *  (the user unchecked everything). A URL `cols` param still out-ranks this. */
  columns: Record<string, string[]>;
}

export const DEFAULT_LAB_PREFS: LabPrefs = {
  order: {},
  collapsed: [],
  category: null,
  catOrder: [],
  columns: {},
};

/** A `key → string[]` blob with every malformed entry dropped. */
function stringListMap(blob: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return out;
  for (const [key, values] of Object.entries(blob as Record<string, unknown>)) {
    if (Array.isArray(values)) out[key] = values.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

/** Merge a (possibly partial) blob over the defaults, dropping malformed keys. */
function mergePrefs(blob: Partial<LabPrefs>): LabPrefs {
  const order = stringListMap(blob.order);
  const columns = stringListMap(blob.columns);
  const collapsed = Array.isArray(blob.collapsed)
    ? blob.collapsed.filter((g) => typeof g === 'string')
    : [];
  const category = typeof blob.category === 'string' && blob.category ? blob.category : null;
  const catOrder = Array.isArray(blob.catOrder)
    ? blob.catOrder.filter((c) => typeof c === 'string')
    : [];
  return { order, collapsed, category, catOrder, columns };
}

interface LabPrefsResponse {
  settings: Partial<LabPrefs>;
}

export function useLabPrefs() {
  const api = useApi();
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
  }, [api]);

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

  const setCategory = useCallback((category: string | null) => {
    update((p) => ({ ...p, category }));
  }, [update]);

  const setCategoryOrder = useCallback((catOrder: string[]) => {
    update((p) => ({ ...p, catOrder }));
  }, [update]);

  const setColumnKeys = useCallback((slug: string, keys: string[]) => {
    update((p) => ({ ...p, columns: { ...p.columns, [slug]: keys } }));
  }, [update]);

  return { prefs, toggleCollapsed, setGroupOrder, setCategory, setCategoryOrder, setColumnKeys };
}
