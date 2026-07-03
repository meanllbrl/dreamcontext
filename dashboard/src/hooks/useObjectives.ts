import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/** Roadmap objective — mirrors the server list shape (objectives-store `Objective`). */
export interface Objective {
  slug: string;
  title: string;
  start_date: string | null;
  target_date: string | null;
  depends_on: string[];
  feature: string | null;
  /** Value/effort 2×2: impact 1–5, effort in weeks (>0, ≤52). */
  impact: number | null;
  effort: number | null;
  status: 'not_started' | 'active' | 'review' | 'done' | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CreateObjectiveInput {
  title: string;
  slug?: string;
  start_date?: string | null;
  target_date?: string | null;
  depends_on?: string[];
  impact?: number | null;
  effort?: number | null;
  why?: string;
  feature?: string | null;
}

/** A member task of an objective (from the computed roadmap model). */
export interface RoadmapTaskRef {
  slug: string;
  status: string;
  start_date: string | null;
  due_date: string | null;
  version: string | null;
  updated_at: string | null;
}

/** One objective in the computed model — progress/status/tasks/dependents rolled up. */
export interface RoadmapModelObjective {
  slug: string;
  title: string;
  target_date: string | null;
  depends_on: string[];
  dependents: string[];
  feature: string | null;
  status: 'not_started' | 'active' | 'review' | 'done';
  status_source: 'computed' | 'override';
  progress: { done: number; total: number; pct: number | null };
  forecast_start: string | null;
  forecast_end: string | null;
  slipping: boolean | null;
  tasks: RoadmapTaskRef[];
}

export interface RoadmapModel {
  generated_at: string;
  objectives: RoadmapModelObjective[];
  warnings: string[];
}

/**
 * The computed roadmap model — progress, rollup status, member tasks, computed
 * dependents, and warnings. Merged with `useObjectives` (which carries the authored
 * start_date/impact/effort) by slug in the board. Empty on an older backend.
 */
export function useRoadmap() {
  return useQuery({
    queryKey: ['roadmap'],
    queryFn: () => api.get<RoadmapModel>('/roadmap'),
    retry: 0,
  });
}

/** List every objective. Empty array when none / the route is absent (older backend). */
export function useObjectives() {
  return useQuery({
    queryKey: ['objectives'],
    queryFn: () => api.get<{ objectives: Objective[] }>('/objectives').then((r) => r.objectives),
    // The route may not exist on an older backend build — don't spin on retries.
    retry: 0,
  });
}

export function useCreateObjective() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateObjectiveInput) => api.post<{ objective: Objective }>('/objectives', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['objectives'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
    },
  });
}

/** Editable subset of an objective (dates, prioritization, status, title, feature). */
export interface UpdateObjectivePatch {
  title?: string;
  start_date?: string | null;
  target_date?: string | null;
  impact?: number | null;
  effort?: number | null;
  status?: Objective['status'];
  feature?: string | null;
}

/** PATCH one objective — persists timeline drag-to-reschedule and inline edits. */
export function useUpdateObjective() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, patch }: { slug: string; patch: UpdateObjectivePatch }) =>
      api.patch<{ objective: Objective }>(`/objectives/${slug}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['objectives'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
    },
  });
}

/** Declare `slug` depends on `to` (drag-to-connect). Cycle rejections surface as errors. */
export function useAddDependency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, to }: { slug: string; to: string }) =>
      api.post<{ objective: Objective }>(`/objectives/${slug}/dependencies`, { to }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['objectives'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
    },
  });
}

/** Delete an objective. Fully self-heals server-side (strips it from deps + tasks). */
export function useDeleteObjective() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.del<{ deleted: string; unhealedTasks: string[] }>(`/objectives/${slug}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['objectives'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
      // Tasks may have had this objective stripped from their `objectives:` list.
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

/** Remove the `to → slug` dependency edge. */
export function useRemoveDependency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, to }: { slug: string; to: string }) =>
      api.del<{ objective: Objective }>(`/objectives/${slug}/dependencies/${to}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['objectives'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
    },
  });
}
