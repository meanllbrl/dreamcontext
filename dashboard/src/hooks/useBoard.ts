/**
 * useBoard — load + persist the Tasks board preferences (saved views).
 *
 * Two project files back the board (see src/server/routes/board.ts):
 *   shared → overrides/board.json     (version-controlled · "save for all")
 *   local  → state/board.local.json   (git-ignored · "save for yourself")
 *
 * `useBoard()` is the transport layer (GET both blobs, PUT each scope).
 * `useBoardState()` is the orchestration layer the board UI consumes: it holds the
 * runtime working config, merges the two blobs into one view list, and routes each
 * save to the correct scope. Inherently per-machine state (which view is active,
 * card properties, collapse) writes silently to the local file; editing a view's
 * filter/sort/group combination prompts the user for a scope.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  type BoardFilters, type BoardView, type CardProps, type Dim, type LocalBoard,
  type SaveScope, type SharedBoard, type SortKey, type SortDir, type ViewConfig, type Layout,
  type DueFilter, type FieldFilter,
  cfgKey, clone, defaultLocalBoard, defaultSharedBoard, emptyConfig, emptyFilters,
  mergeBoard, normLocalBoard, normSharedBoard,
} from '../components/tasks/boardModel';

interface BoardResponse { shared: unknown; local: unknown; }

function useBoardQuery() {
  return useQuery({
    queryKey: ['board'],
    queryFn: () => api.get<BoardResponse>('/board'),
    staleTime: 5 * 60 * 1000,
  });
}

function putShared(board: SharedBoard): Promise<unknown> {
  return api.put('/board/shared', { board });
}
function putLocal(board: LocalBoard): Promise<unknown> {
  return api.put('/board/local', { board });
}

function newId(): string {
  return 'v' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

export interface BoardState {
  ready: boolean;
  views: BoardView[];
  activeViewId: string;
  activeView: BoardView;
  versions: string[];
  cardProps: CardProps;
  isDirty: boolean;
  // working config (the live, possibly-unsaved view)
  filters: BoardFilters;
  groupBy: Dim;
  subGroupBy: Dim | 'none';
  layout: Layout;
  sortBy: SortKey;
  sortDir: SortDir;
  search: string;
  // working-config setters
  setSearch: (v: string) => void;
  cycleFilter: (key: keyof BoardFilters, val: string, mode: 'inc' | 'exc') => void;
  setDue: (v: DueFilter) => void;
  setMinRice: (v: number) => void;
  clearField: (key: keyof BoardFilters) => void;
  clearAllFilters: () => void;
  setGroupBy: (d: Dim) => void;
  setSubGroupBy: (d: Dim | 'none') => void;
  setLayout: (l: Layout) => void;
  setSort: (by: SortKey) => void;
  toggleSortDir: () => void;
  // card properties (always local)
  toggleCardProp: (k: keyof CardProps) => void;
  // versions (always shared)
  addVersion: (name: string) => void;
  removeVersion: (name: string) => void;
  // views
  applyView: (id: string) => void;
  resetView: () => void;
  saveView: (scope: SaveScope) => void;
  createView: (name: string, scope: SaveScope) => void;
  /** Create a fresh blank view (Kanban, no filters) as a local view; returns its id. */
  createBlankView: () => string;
  renameView: (id: string, name: string) => void;
  duplicateView: (id: string) => void;
  deleteView: (id: string) => void;
}

export function useBoardState(): BoardState {
  const { data, isSuccess } = useBoardQuery();

  const [shared, setShared] = useState<SharedBoard>(defaultSharedBoard);
  const [local, setLocal] = useState<LocalBoard>(defaultLocalBoard);
  const [activeViewId, setActiveViewId] = useState<string>('all');
  const [working, setWorking] = useState<ViewConfig>(() => emptyConfig());
  const seeded = useRef(false);

  // Debounced local-file writer (per-machine state changes are frequent).
  const localTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushLocal = useCallback((next: LocalBoard) => {
    if (localTimer.current) clearTimeout(localTimer.current);
    localTimer.current = setTimeout(() => { void putLocal(next).catch(() => {}); }, 500);
  }, []);
  useEffect(() => () => { if (localTimer.current) clearTimeout(localTimer.current); }, []);

  // Seed runtime state once the server blobs arrive.
  useEffect(() => {
    if (!isSuccess || !data || seeded.current) return;
    const s = normSharedBoard(data.shared);
    const l = normLocalBoard(data.local);
    const merged = mergeBoard(s, l);
    const active = merged.find((v) => v.id === l.activeViewId) || merged[0];
    seeded.current = true;
    setShared(s);
    setLocal(l);
    setActiveViewId(active.id);
    setWorking(clone(active.config));
  }, [isSuccess, data]);

  const views = useMemo(() => mergeBoard(shared, local), [shared, local]);
  const activeView = useMemo(
    () => views.find((v) => v.id === activeViewId) || views[0],
    [views, activeViewId],
  );
  const cardProps = local.cardProps ?? shared.cardProps;
  const isDirty = activeView ? cfgKey(working) !== cfgKey(activeView.config) : false;

  // ── persistence helpers ────────────────────────────────────────────────────
  const persistShared = useCallback((next: SharedBoard) => {
    setShared(next);
    void putShared(next).catch(() => {});
  }, []);
  const persistLocal = useCallback((updater: (l: LocalBoard) => LocalBoard) => {
    setLocal((prev) => { const next = updater(prev); flushLocal(next); return next; });
  }, [flushLocal]);

  const setActive = useCallback((id: string) => {
    setActiveViewId(id);
    persistLocal((l) => ({ ...l, activeViewId: id }));
  }, [persistLocal]);

  // ── working-config setters ──────────────────────────────────────────────────
  const patchWorking = useCallback((p: Partial<ViewConfig>) => setWorking((w) => ({ ...w, ...p })), []);
  const patchFilters = useCallback(
    (p: Partial<BoardFilters>) => setWorking((w) => ({ ...w, filters: { ...w.filters, ...p } })),
    [],
  );

  const setSearch = useCallback((v: string) => patchWorking({ search: v }), [patchWorking]);
  const cycleFilter = useCallback((key: keyof BoardFilters, val: string, mode: 'inc' | 'exc') => {
    setWorking((w) => {
      const fld = (w.filters[key] as FieldFilter) || { inc: [], exc: [] };
      const inc = [...fld.inc], exc = [...fld.exc];
      if (mode === 'inc') {
        const i = inc.indexOf(val);
        if (i >= 0) inc.splice(i, 1);
        else { inc.push(val); const e = exc.indexOf(val); if (e >= 0) exc.splice(e, 1); }
      } else {
        const e = exc.indexOf(val);
        if (e >= 0) exc.splice(e, 1);
        else { exc.push(val); const i = inc.indexOf(val); if (i >= 0) inc.splice(i, 1); }
      }
      return { ...w, filters: { ...w.filters, [key]: { inc, exc } } };
    });
  }, []);
  const setDue = useCallback((v: DueFilter) => patchFilters({ due: v }), [patchFilters]);
  const setMinRice = useCallback((v: number) => patchFilters({ minRice: v }), [patchFilters]);
  const clearField = useCallback((key: keyof BoardFilters) => {
    if (key === 'due') patchFilters({ due: 'all' });
    else if (key === 'minRice') patchFilters({ minRice: 0 });
    else patchFilters({ [key]: { inc: [], exc: [] } } as Partial<BoardFilters>);
  }, [patchFilters]);
  const clearAllFilters = useCallback(() => patchWorking({ filters: emptyFilters(), search: '' }), [patchWorking]);

  const setGroupBy = useCallback((d: Dim) => setWorking((w) => ({ ...w, groupBy: d, subGroupBy: w.subGroupBy === d ? 'none' : w.subGroupBy })), []);
  const setSubGroupBy = useCallback((d: Dim | 'none') => patchWorking({ subGroupBy: d }), [patchWorking]);
  const setLayout = useCallback((l: Layout) => patchWorking({ layout: l }), [patchWorking]);
  const setSort = useCallback((by: SortKey) => patchWorking({ sortBy: by }), [patchWorking]);
  const toggleSortDir = useCallback(() => setWorking((w) => ({ ...w, sortDir: w.sortDir === 'asc' ? 'desc' : 'asc' })), []);

  // ── card properties (always local) ──────────────────────────────────────────
  const toggleCardProp = useCallback((k: keyof CardProps) => {
    persistLocal((l) => {
      const base = l.cardProps ?? shared.cardProps;
      return { ...l, cardProps: { ...base, [k]: !base[k] } };
    });
  }, [persistLocal, shared.cardProps]);

  // ── versions (always shared — project structure, version-controlled) ────────
  const addVersion = useCallback((name: string) => {
    const nm = name.trim();
    if (!nm) return;
    persistShared({ ...shared, versions: shared.versions.includes(nm) ? shared.versions : [nm, ...shared.versions] });
  }, [persistShared, shared]);
  const removeVersion = useCallback((name: string) => {
    persistShared({ ...shared, versions: shared.versions.filter((v) => v !== name) });
  }, [persistShared, shared]);

  // ── views ───────────────────────────────────────────────────────────────────
  const applyView = useCallback((id: string) => {
    const v = views.find((x) => x.id === id);
    if (!v) return;
    setActive(id);
    setWorking(clone(v.config));
  }, [views, setActive]);

  const resetView = useCallback(() => {
    if (activeView) setWorking(clone(activeView.config));
  }, [activeView]);

  const saveView = useCallback((scope: SaveScope) => {
    const id = activeViewId;
    const cfg = clone(working);
    if (scope === 'shared') {
      const isShared = shared.views.some((v) => v.id === id);
      if (isShared) {
        // promote to shared truth + drop any private override of this view
        persistShared({ ...shared, views: shared.views.map((v) => (v.id === id ? { ...v, config: cfg } : v)) });
        persistLocal((l) => { const ov = { ...l.overrides }; delete ov[id]; return { ...l, overrides: ov }; });
      } else {
        // a local-only view promoted to "everyone": move it into the shared list
        const lv = local.localViews.find((v) => v.id === id);
        persistShared({ ...shared, views: [...shared.views, { id, name: lv?.name || 'View', removable: true, config: cfg }] });
        persistLocal((l) => ({ ...l, localViews: l.localViews.filter((v) => v.id !== id) }));
      }
    } else {
      const isLocalView = local.localViews.some((v) => v.id === id);
      if (isLocalView) {
        persistLocal((l) => ({ ...l, localViews: l.localViews.map((v) => (v.id === id ? { ...v, config: cfg } : v)) }));
      } else {
        // private override of a shared view
        persistLocal((l) => ({ ...l, overrides: { ...l.overrides, [id]: cfg } }));
      }
    }
  }, [activeViewId, working, shared, local, persistShared, persistLocal]);

  const createView = useCallback((name: string, scope: SaveScope) => {
    const id = newId();
    // A new view always starts blank (Kanban, no filters) — never inherits the
    // current view's filter/sort/group combination.
    const view: BoardView = { id, name: name.trim() || 'New view', removable: true, config: emptyConfig() };
    if (scope === 'shared') {
      persistShared({ ...shared, views: [...shared.views, view] });
    } else {
      persistLocal((l) => ({ ...l, localViews: [...l.localViews, view] }));
    }
    setActive(id);
  }, [working, shared, persistShared, persistLocal, setActive]);

  const createBlankView = useCallback((): string => {
    const id = newId();
    const view: BoardView = { id, name: 'New view', removable: true, config: emptyConfig() };
    persistLocal((l) => ({ ...l, localViews: [...l.localViews, view] }));
    setActiveViewId(id);
    setWorking(emptyConfig());
    persistLocal((l) => ({ ...l, activeViewId: id }));
    return id;
  }, [persistLocal]);

  const renameView = useCallback((id: string, name: string) => {
    const nm = name.trim();
    if (!nm) return;
    if (shared.views.some((v) => v.id === id)) {
      persistShared({ ...shared, views: shared.views.map((v) => (v.id === id ? { ...v, name: nm } : v)) });
    } else {
      persistLocal((l) => ({ ...l, localViews: l.localViews.map((v) => (v.id === id ? { ...v, name: nm } : v)) }));
    }
  }, [shared, persistShared, persistLocal]);

  const duplicateView = useCallback((id: string) => {
    const src = views.find((v) => v.id === id);
    if (!src) return;
    const nid = newId();
    const copy: BoardView = { id: nid, name: `${src.name} copy`, removable: true, config: clone(src.config) };
    // duplicate keeps the source's scope
    if (src.origin === 'shared' && shared.views.some((v) => v.id === id)) {
      persistShared({ ...shared, views: [...shared.views, copy] });
    } else {
      persistLocal((l) => ({ ...l, localViews: [...l.localViews, copy] }));
    }
    setActive(nid);
  }, [views, shared, persistShared, persistLocal, setActive]);

  const deleteView = useCallback((id: string) => {
    const inShared = shared.views.some((v) => v.id === id);
    if (inShared) {
      persistShared({ ...shared, views: shared.views.filter((v) => v.id !== id) });
    }
    persistLocal((l) => {
      const ov = { ...l.overrides };
      delete ov[id];
      return { ...l, localViews: l.localViews.filter((v) => v.id !== id), overrides: ov };
    });
    // move selection off the deleted view
    const remaining = mergeBoard(
      { ...shared, views: shared.views.filter((v) => v.id !== id) },
      { ...local, localViews: local.localViews.filter((v) => v.id !== id) },
    );
    if (activeViewId === id && remaining[0]) applyView(remaining[0].id);
  }, [shared, local, activeViewId, persistShared, persistLocal, applyView]);

  return {
    ready: seeded.current,
    views, activeViewId, activeView, versions: shared.versions, cardProps, isDirty,
    filters: working.filters, groupBy: working.groupBy, subGroupBy: working.subGroupBy,
    layout: working.layout, sortBy: working.sortBy, sortDir: working.sortDir, search: working.search,
    setSearch, cycleFilter, setDue, setMinRice, clearField, clearAllFilters,
    setGroupBy, setSubGroupBy, setLayout, setSort, toggleSortDir,
    toggleCardProp, addVersion, removeVersion,
    applyView, resetView, saveView, createView, createBlankView, renameView, duplicateView, deleteView,
  };
}
