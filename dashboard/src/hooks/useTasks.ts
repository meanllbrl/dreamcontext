import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface RiceFields {
  reach: number | null;
  impact: number | null;
  confidence: number | null;
  effort: number | null;
  score: number | null;
}

export type RiceInput = Partial<Omit<RiceFields, 'score'>>;

export interface Task {
  slug: string;
  id: string;
  name: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  urgency: 'critical' | 'high' | 'medium' | 'low';
  status: 'todo' | 'in_progress' | 'in_review' | 'completed';
  created_at: string;
  updated_at: string;
  tags: string[];
  parent_task: string | null;
  related_feature: string | null;
  /** Roadmap objectives this task serves (many-to-many, local-only — never synced). */
  objectives?: string[];
  version: string | null;
  start_date?: string | null;
  due_date?: string | null;
  assignee?: string | null;
  custom_fields?: Record<string, string | number | null>;
  rice: RiceFields | null;
  why: string;
  user_stories: string;
  acceptance_criteria: string;
  constraints: string;
  technical_details: string;
  notes: string;
  changelog: string;
  sections: string[];
  body: string;
}

interface TasksResponse {
  tasks: Task[];
}

interface TaskResponse {
  task: Task;
}

interface CreateTaskInput {
  name: string;
  description: string;
  priority: string;
  urgency?: string;
  tags?: string[];
  why?: string;
  version?: string;
  custom_fields?: Record<string, string | number | null>;
}

interface UpdateTaskInput {
  slug: string;
  updates: Partial<Pick<Task, 'status' | 'priority' | 'urgency' | 'description' | 'tags' | 'name' | 'related_feature' | 'version' | 'due_date' | 'start_date' | 'assignee' | 'objectives' | 'body'>> & {
    rice?: RiceInput | null;
    custom_fields?: Record<string, string | number | null>;
  };
}

/** A project-declared custom field (from _dream_context/overrides/task.md). */
export interface CustomFieldDef {
  name: string;
  key: string;
  type: 'text' | 'number' | 'select' | 'date';
  /** Whether the agent must set this field on every task. */
  required?: boolean;
  options?: string[];
  sync: Array<'clickup' | 'github'>;
  /** System prompt telling the agent how to determine this field's value. */
  prompt?: string;
  /** Whether Claude asks the user for this value instead of inferring it. */
  ask?: boolean;
}

export interface AddCustomFieldInput {
  name: string;
  key?: string;
  type: 'text' | 'number' | 'select' | 'date';
  required?: boolean;
  options?: string[];
  sync?: Array<'clickup' | 'github'>;
  prompt?: string;
  ask?: boolean;
}

interface InsertTaskSectionInput {
  slug: string;
  section: string;
  content: string;
}

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: () => api.get<TasksResponse>('/tasks'),
    select: (data) => data.tasks,
  });
}

export function useTask(slug: string) {
  return useQuery({
    queryKey: ['tasks', slug],
    queryFn: () => api.get<TaskResponse>(`/tasks/${slug}`),
    select: (data) => data.task,
    enabled: !!slug,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.post<TaskResponse>('/tasks', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, updates }: UpdateTaskInput) =>
      api.patch<TaskResponse>(`/tasks/${slug}`, updates),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', variables.slug] });
      // A task's `objectives` link feeds the roadmap rollup (progress, member tasks,
      // forecast) — refresh it so the roadmap reflects the change immediately.
      if (variables.updates.objectives !== undefined) {
        queryClient.invalidateQueries({ queryKey: ['roadmap'] });
      }
      // A `related_feature` change writes through to the target/previous feature's
      // `related_tasks` on disk (server: applyTaskFeatureLink) — data the /knowledge
      // endpoint serves. Invalidate it so any feature view reflects the new
      // membership immediately instead of showing stale links.
      if (variables.updates.related_feature !== undefined) {
        queryClient.invalidateQueries({ queryKey: ['knowledge'] });
      }
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.del<{ success: boolean }>(`/tasks/${slug}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      // A deleted task drops out of any objective's rollup — refresh the roadmap.
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
    },
  });
}

export interface RemoteMember {
  slug: string;
  id: string;
  name: string;
  email?: string;
}

export function useTaskMembers() {
  return useQuery({
    queryKey: ['task-members'],
    queryFn: () => api.get<{ members: RemoteMember[] }>('/tasks/members'),
    select: (d) => d.members,
    staleTime: 5 * 60 * 1000,
  });
}

export interface SyncStatus {
  backend: string;
  pendingPush: number;
  queuedOps: number;
  conflicts: number;
  watermark: number | null;
}

export function useSyncStatus() {
  return useQuery({
    queryKey: ['tasks-sync-status'],
    queryFn: () => api.get<{ status: SyncStatus }>('/tasks/sync-status'),
    select: (d) => d.status,
    refetchInterval: 30_000,
  });
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  created: number;
  deleted: number;
  mirrorDeleted: number;
  commentsAdded: number;
  conflicts: Array<{ slug: string; reason: string }>;
  errors: string[];
}

export function useSyncTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ report: SyncReport }>('/tasks/sync', { direction: 'both' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['tasks-sync-status'] });
    },
  });
}

/** The active task custom-field schema (from overrides/task.md). Empty when none. */
export function useTaskOverrides() {
  return useQuery({
    queryKey: ['task-overrides'],
    queryFn: () => api.get<{ present: boolean; customFields: CustomFieldDef[] }>('/task-overrides'),
    select: (d) => d.customFields ?? [],
    staleTime: 10 * 60 * 1000,
  });
}

export interface TaskOverrideDoc {
  present: boolean;
  raw: string;
  customFields: CustomFieldDef[];
  warnings: string[];
}

/** The RAW override markdown (for the Settings editor). */
export function useTaskOverrideDoc() {
  return useQuery({
    queryKey: ['task-override-doc'],
    queryFn: () => api.get<TaskOverrideDoc>('/task-overrides/doc'),
  });
}

function invalidateOverrides(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['task-overrides'] });
  queryClient.invalidateQueries({ queryKey: ['task-override-doc'] });
  queryClient.invalidateQueries({ queryKey: ['tasks'] });
}

/** Save the RAW override markdown. */
export function useSaveTaskOverrideDoc() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (raw: string) =>
      api.put<{ present: boolean; customFields: CustomFieldDef[]; warnings: string[] }>('/task-overrides/doc', { raw }),
    onSuccess: () => invalidateOverrides(queryClient),
  });
}

/** Add or replace one custom-field definition (project-wide schema). */
export function useAddCustomFieldDef() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddCustomFieldInput) =>
      api.post<{ customFields: CustomFieldDef[]; warnings: string[] }>('/task-overrides/fields', input),
    onSuccess: () => invalidateOverrides(queryClient),
  });
}

/** Remove a custom-field definition by id/key. */
export function useRemoveCustomFieldDef() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      api.del<{ customFields: CustomFieldDef[] }>(`/task-overrides/fields/${encodeURIComponent(key)}`),
    onSuccess: () => invalidateOverrides(queryClient),
  });
}

/**
 * Feature PRDs for the related-feature picker, sourced from the knowledge index
 * (PRDs live at knowledge/features/**). `related_feature` stores the feature's
 * CANONICAL slug relative to the features dir — nested features keep their
 * folder prefix (`lina/checkout`), flat ones are the basename — matching what
 * the link engine (src/lib/feature-links.ts) writes and validates. Only the
 * `features/` root prefix is stripped. (ClickUp carries it as short text, so a
 * folder-qualified slug round-trips unchanged.)
 */
export function useFeatureOptions() {
  return useQuery({
    queryKey: ['knowledge'],
    queryFn: () => api.get<{ entries: Array<{ slug: string; name?: string; type?: string }> }>('/knowledge'),
    select: (d) =>
      (d.entries ?? [])
        .filter((e) => e.slug.startsWith('features/'))
        .map((e) => {
          const slug = e.slug.slice('features/'.length);
          const base = e.slug.split('/').pop() ?? e.slug;
          return { slug, name: e.name === e.slug ? base : e.name };
        }),
    staleTime: 60_000,
  });
}

export function useAddTaskChangelog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, content }: { slug: string; content: string }) =>
      api.post<{ success: boolean }>(`/tasks/${slug}/changelog`, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useInsertTaskSection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, section, content }: InsertTaskSectionInput) =>
      api.post<{ success: boolean }>(`/tasks/${slug}/insert`, { section, content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
