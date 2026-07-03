import { useMemo } from 'react';
import { useObjectives, useRoadmap, type RoadmapTaskRef } from './useObjectives';

/**
 * One roadmap row, merged from the two sources of truth:
 *   • `useObjectives` — the authored fields (start_date, target_date, impact, effort,
 *     depends_on, manual status override)
 *   • `useRoadmap`    — the computed model (rollup status, progress, member tasks)
 *
 * The forecast/slip cascade is computed separately (roadmap-forecast.ts) from the
 * committed start/target dates so it stays live under drag. `status` here is the
 * effective status: PO override if set, else the task-rollup, else not_started.
 */
export interface RoadmapItem {
  slug: string;
  title: string;
  start_date: string | null;
  target_date: string | null;
  depends_on: string[];
  status: 'not_started' | 'active' | 'review' | 'done';
  statusOverride: boolean;
  progress: { done: number; total: number; pct: number | null };
  tasks: RoadmapTaskRef[];
  impact: number | null;
  effort: number | null;
}

export function useRoadmapItems(): {
  items: RoadmapItem[];
  warnings: string[];
  isLoading: boolean;
} {
  const { data: objectives = [], isLoading } = useObjectives();
  const { data: model } = useRoadmap();

  const items = useMemo<RoadmapItem[]>(() => {
    const bySlug = new Map((model?.objectives ?? []).map((m) => [m.slug, m]));
    return objectives.map((o) => {
      const m = bySlug.get(o.slug);
      return {
        slug: o.slug,
        title: o.title,
        start_date: o.start_date,
        target_date: o.target_date,
        depends_on: o.depends_on,
        status: o.status ?? m?.status ?? 'not_started',
        statusOverride: o.status != null,
        progress: m?.progress ?? { done: 0, total: 0, pct: null },
        tasks: m?.tasks ?? [],
        impact: o.impact,
        effort: o.effort,
      };
    });
  }, [objectives, model]);

  return { items, warnings: model?.warnings ?? [], isLoading };
}
