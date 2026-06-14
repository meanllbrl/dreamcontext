import { useCallback, useEffect, useRef } from 'react';
import { usePersistedState } from './usePersistedState';
import { api } from '../api/client';

export interface GraphColorGroup {
  id: string;
  query: string;
  color: string;
}

export interface GraphSettings {
  filters: {
    search: string;
    showTags: boolean;
    showOrphans: boolean;
    showAttachments: boolean;
    existingFilesOnly: boolean;
  };
  groups: GraphColorGroup[];
  display: {
    view: '2d' | '3d';
    arrows: boolean;
    textFadeThreshold: number; // 0..1
    nodeSize: number; // 0..1 (1 = default, higher = bigger)
    linkThickness: number; // 0..1
  };
  forces: {
    centerStrength: number; // 0..1
    repelStrength: number; // 0..1
    linkStrength: number; // 0..1
    linkDistance: number; // 0..1
  };
}

export const DEFAULT_SETTINGS: GraphSettings = {
  filters: {
    search: '',
    showTags: true,
    showOrphans: true,
    showAttachments: false,
    existingFilesOnly: false,
  },
  groups: [],
  display: {
    view: '2d',
    arrows: false,
    textFadeThreshold: 0.85, // default: labels always visible
    nodeSize: 0.5,
    linkThickness: 0.5,
  },
  forces: {
    centerStrength: 0.7,
    repelStrength: 0.35,
    linkStrength: 0.9,
    linkDistance: 0.35,
  },
};

// Map 0..1 slider values to real d3-force params.
export function mapForces(forces: GraphSettings['forces']) {
  return {
    // Center force: strong enough to pull orphans back into the cluster.
    centerStrength: 0.05 + forces.centerStrength * 0.45, // 0.05 .. 0.50
    // Repel: mild so connected neighborhoods don't fly apart.
    repelStrength: -(30 + forces.repelStrength * 240), // -30 .. -270
    linkStrength: 0.1 + forces.linkStrength * 1.2, // 0.1 .. 1.3
    linkDistance: 20 + forces.linkDistance * 180, // 20 .. 200
  };
}

// ─── Server persistence ──────────────────────────────────────────────────────
//
// The desktop app changes its loopback port every launch → a new origin → empty
// localStorage. So we ALSO persist brain settings server-side, per project, and
// hydrate from there on mount. localStorage stays as a fast, flash-free mirror.

interface BrainSettingsResponse {
  settings: Partial<GraphSettings>;
}

/** Merge a (possibly partial) server blob over the defaults, section by section. */
function mergeSettings(server: Partial<GraphSettings>): GraphSettings {
  return {
    filters: { ...DEFAULT_SETTINGS.filters, ...server.filters },
    groups: Array.isArray(server.groups) ? server.groups : DEFAULT_SETTINGS.groups,
    display: { ...DEFAULT_SETTINGS.display, ...server.display },
    forces: { ...DEFAULT_SETTINGS.forces, ...server.forces },
  };
}

export function useGraphSettings() {
  const [settings, setSettings] = usePersistedState<GraphSettings>(
    'brain:settings:v1',
    DEFAULT_SETTINGS,
  );

  // Hydrate once from the server; only adopt a non-empty blob so an untouched
  // project (server returns `{}`) keeps whatever the client already has.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    let cancelled = false;
    api
      .get<BrainSettingsResponse>('/brain-settings')
      .then((res) => {
        if (cancelled) return;
        hydratedRef.current = true;
        const s = res.settings;
        if (s && typeof s === 'object' && Object.keys(s).length > 0) {
          setSettings(mergeSettings(s));
        }
      })
      .catch(() => {
        // Best-effort — fall back to localStorage/defaults (e.g. launcher mode).
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [setSettings]);

  // Debounced write-through to the server (localStorage is written synchronously
  // by usePersistedState). Skipped until the first hydrate completes so we never
  // clobber the server with defaults before we've read it.
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueServerWrite = useCallback((next: GraphSettings) => {
    if (!hydratedRef.current) return;
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      api.put('/brain-settings', { settings: next }).catch(() => {
        /* best-effort; localStorage already has it */
      });
    }, 600);
  }, []);

  const update = useCallback(
    (updater: (prev: GraphSettings) => GraphSettings) => {
      setSettings((prev) => {
        const next = updater(prev);
        queueServerWrite(next);
        return next;
      });
    },
    [setSettings, queueServerWrite],
  );

  const patch = useCallback(
    <K extends keyof GraphSettings>(section: K, updates: Partial<GraphSettings[K]>) => {
      update((prev) => ({ ...prev, [section]: { ...prev[section], ...updates } } as GraphSettings));
    },
    [update],
  );

  const setGroups = useCallback(
    (groups: GraphColorGroup[]) => {
      update((prev) => ({ ...prev, groups }));
    },
    [update],
  );

  const reset = useCallback(() => {
    update(() => DEFAULT_SETTINGS);
  }, [update]);

  return { settings, patch, setGroups, reset };
}
