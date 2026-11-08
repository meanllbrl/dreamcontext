import type { PriorityObjective, PriorityTask, RiceValues } from '../../dashboard/src/components/roadmap/priorityModel';

/** Shared payload fixtures for the priority board tests. */
export const NO_RICE: RiceValues = { reach: null, impact: null, confidence: null, effort: null };

export function obj(slug: string, over: Partial<PriorityObjective> = {}): PriorityObjective {
  return {
    slug, title: slug.toUpperCase(), description: null, start_date: null, target_date: null,
    impact: null, effort: null, reach: null, confidence: null, score: null, created_at: '2026-10-01',
    depends_on: [], status: 'active', progress: { done: 0, total: 0, pct: null, source: 'tasks' },
    slipping: null, tasks: [], signal: null, late_days: null, effective_suggestion: null, ...over,
  };
}

export function task(slug: string, over: Partial<PriorityTask> = {}): PriorityTask {
  return {
    slug, name: slug, status: 'todo', status_kind: 'other', rice: NO_RICE, score: null, links: [], mark: null,
    all_links: [], no_objective: false, effective_suggestion: null, subtask_count: 0, updated_at: null, ...over,
  };
}

