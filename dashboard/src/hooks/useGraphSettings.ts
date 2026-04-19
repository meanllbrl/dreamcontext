import { useCallback } from 'react';
import { usePersistedState } from './usePersistedState';

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

export function useGraphSettings() {
  const [settings, setSettings] = usePersistedState<GraphSettings>(
    'brain:settings:v1',
    DEFAULT_SETTINGS,
  );

  const patch = useCallback(
    <K extends keyof GraphSettings>(section: K, updates: Partial<GraphSettings[K]>) => {
      setSettings((prev) => ({ ...prev, [section]: { ...prev[section], ...updates } } as GraphSettings));
    },
    [setSettings],
  );

  const setGroups = useCallback(
    (groups: GraphColorGroup[]) => {
      setSettings((prev) => ({ ...prev, groups }));
    },
    [setSettings],
  );

  const reset = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
  }, [setSettings]);

  return { settings, patch, setGroups, reset };
}
