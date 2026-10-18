import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useApi } from '../context/VaultContext';
import { pollMs } from '../lib/windowActivity';
import { buildStatusModel, DEFAULT_STATUSES, type StatusDef, type StatusModel } from '../lib/statusModel';

export type { StatusDef, StatusKind, StatusModel } from '../lib/statusModel';

export interface RiceFields {
  reach: number | null;
  impact: number | null;
  confidence: number | null;
  effort: number | null;
  score: number | null;
}

export type RiceInput = Partial<Omit<RiceFields, 'score'>>;

/**
 * The fields every view of a task carries, the list card and the task page alike.
 * Components that take either one (a field editor, the agent face) take this.
 */
export interface TaskBase {
  slug: string;
  id: string;
  name: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  urgency: 'critical' | 'high' | 'medium' | 'low';
  /** A status key of the project's status set (the shipped four + any declared in overrides/task.md). */
  status: string;
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
  /** The AGENT this task is assigned to (its slug), never a person. Local-only: it never
   *  reaches ClickUp/GitHub or the members list. Absent when none. */
  agent?: string | null;
  custom_fields?: Record<string, string | number | null>;
  rice: RiceFields | null;
  /** The cycle the card is planned into (`cy_<id>`), or null (C3). */
  cycle?: string | null;
  /** `next` | `later` when the card waits outside a cycle. */
  queue?: 'next' | 'later' | null;
  /** Order inside its cycle or queue. */
  rank?: number | null;
}

/**
 * One card of `GET /api/tasks` (plan r3 § W4): frontmatter and counts, never a body,
 * a section or the journal. The task page reads {@link TaskDetail} by slug.
 */
export interface Task extends TaskBase {
  created_by?: string | null;
  /** Acceptance criteria on the card: how many, how many ticked. */
  criteria: { total: number; done: number };
  /** Roll-up of the non-cancelled sub-tasks; null for a task with none. */
  children: { total: number; done: number } | null;
  /** The card file's size in bytes. */
  bytes: number;
}

/** One acceptance criterion as the task page shows it. */
export interface CriterionView {
  n: number;
  text: string;
  checked: boolean;
  ref: string | null;
  kind: 'cmd' | 'commit' | 'shot' | 'owner' | 'legacy' | null;
  observed: boolean;
}

/** One task from `GET /api/tasks/:slug`: the whole card, parsed criteria, parent and children. */
export interface TaskDetail extends TaskBase {
  why: string;
  user_stories: string;
  acceptance_criteria: string;
  constraints: string;
  technical_details: string;
  notes: string;
  changelog: string;
  sections: string[];
  body: string;
  criteria: CriterionView[];
  parent: { slug: string; name: string; status: string } | null;
  children: Task[];
}

interface TasksResponse {
  tasks: Task[];
}

interface TaskResponse {
  task: TaskDetail;
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
  updates: Partial<Pick<TaskDetail, 'status' | 'priority' | 'urgency' | 'description' | 'tags' | 'name' | 'related_feature' | 'version' | 'due_date' | 'start_date' | 'assignee' | 'agent' | 'objectives' | 'body'>> & {
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
  const api = useApi();
  return useQuery({
    queryKey: ['tasks'],
    queryFn: () => api.get<TasksResponse>('/tasks'),
    select: (data) => data.tasks,
  });
}

/**
 * One task by slug: the body source of the task page and of every hand-off that needs
 * the card's text (the list carries none). Polls while visible, so criteria ticked by
 * an agent show up live.
 */
export function useTask(slug: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['tasks', slug],
    queryFn: () => api.get<TaskResponse>(`/tasks/${encodeURIComponent(slug)}`),
    select: (data) => data.task,
    enabled: !!slug,
    refetchInterval: () => pollMs(15_000),
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.post<TaskResponse>('/tasks', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, updates }: UpdateTaskInput) =>
      api.patch<TaskResponse>(`/tasks/${encodeURIComponent(slug)}`, updates),
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
      // An agent's usage (the Agents page's "Tasks" list) is derived from `agent:` fields.
      if (variables.updates.agent !== undefined) {
        queryClient.invalidateQueries({ queryKey: ['agents'] });
      }
    },
  });
}

/** Every refusal `POST /api/tasks/:slug/assign-agent` can answer with, by its `error` slug. */
export type AssignAgentRefusal =
  | 'agent_not_approved_to_run'
  | 'agent_disabled'
  | 'agent_busy'
  | 'unknown_task'
  | 'unknown_agent'
  | 'note_too_long'
  | 'missing_agent'
  | 'invalid_note'
  | 'invalid_path'
  | 'assign_failed';

const ASSIGN_REFUSALS: ReadonlySet<string> = new Set<AssignAgentRefusal>([
  'agent_not_approved_to_run', 'agent_disabled', 'agent_busy', 'unknown_task', 'unknown_agent',
  'note_too_long', 'missing_agent', 'invalid_note', 'invalid_path', 'assign_failed',
]);

/**
 * A refused assignment, TYPED, so the composer can branch on it rather than toast it. The one
 * that matters most is `agent_not_approved_to_run`: the composer answers it in place with the
 * agent's review and "Approve and assign", which a generic error toast would bury.
 * `code` is `'unknown'` for an answer the route never gives (a proxy page, a network failure).
 */
export class AssignAgentError extends Error {
  constructor(message: string, readonly code: AssignAgentRefusal | 'unknown', readonly status: number) {
    super(message);
    this.name = 'AssignAgentError';
  }
}

/** Turn whatever the request threw into an {@link AssignAgentError}. Pure, for the tests. */
export function toAssignAgentError(err: unknown): AssignAgentError {
  if (err instanceof AssignAgentError) return err;
  const e = err as { message?: unknown; code?: unknown; status?: unknown } | null;
  const message = typeof e?.message === 'string' && e.message ? e.message : 'The task could not be assigned.';
  const status = typeof e?.status === 'number' ? e.status : 0;
  const code = typeof e?.code === 'string' && ASSIGN_REFUSALS.has(e.code) ? e.code as AssignAgentRefusal : 'unknown';
  return new AssignAgentError(message, code, status);
}

/** What a started assignment answers (202). The run itself continues in the background. */
export interface AssignAgentResult {
  jobId: string;
  /** The run's thread id (its fire time, ISO). */
  runId: string;
  /** The task moved to its active status (only ever from an open-kind or missing status). */
  statusMoved: boolean;
}

/**
 * "Assign to agent": set `agent:`, log it on the task, and start the agent's run on it. Refusals
 * reject with an {@link AssignAgentError}; nothing here shows a toast.
 */
export function useAssignTaskToAgent() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation<AssignAgentResult, AssignAgentError, { slug: string; agent: string; note?: string }>({
    mutationFn: async ({ slug, agent, note }) => {
      const body = note && note.trim() ? { agent, note } : { agent };
      try {
        return await api.post<AssignAgentResult>(`/tasks/${encodeURIComponent(slug)}/assign-agent`, body);
      } catch (err) {
        throw toAssignAgentError(err);
      }
    },
    onSuccess: (_data, { slug }) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', slug] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['automations-run-job'] });
      queryClient.invalidateQueries({ queryKey: ['automations-feed'] });
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (slug: string) => api.del<{ success: boolean }>(`/tasks/${encodeURIComponent(slug)}`),
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
  const api = useApi();
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
  const api = useApi();
  return useQuery({
    queryKey: ['tasks-sync-status'],
    queryFn: () => api.get<{ status: SyncStatus }>('/tasks/sync-status'),
    select: (d) => d.status,
    refetchInterval: () => pollMs(30_000),
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

/**
 * Background sync job — the server-owned counterpart of useSyncTasks. A bulk
 * first sync (or a hard refresh) runs for minutes; the job lives in the server
 * process, so it keeps running when the user navigates away, and this poll
 * re-adopts it (with live progress) whenever the Tasks page is back.
 */
export interface SyncJob {
  id: string;
  kind: 'sync' | 'hard-refresh';
  status: 'running' | 'success' | 'error';
  phase: 'push' | 'pull' | null;
  current: number;
  total: number;
  bootstrap: boolean;
  attempt: number;
  startedAt: number;
  finishedAt: number | null;
  report: SyncReport | null;
  error: string | null;
  backupDir: string | null;
}

export function useSyncJob() {
  const api = useApi();
  return useQuery({
    queryKey: ['tasks-sync-job'],
    queryFn: () => api.get<{ job: SyncJob | null }>('/tasks/sync-jobs/current'),
    select: (d) => d.job,
    // Poll fast while a job runs so the progress bar is live; idle otherwise.
    refetchInterval: (query) => (query.state.data?.job?.status === 'running' ? pollMs(800) : false),
    refetchOnWindowFocus: true,
  });
}

export function useStartSyncJob() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (vars?: { hard?: boolean }) =>
      api.post<{ job: SyncJob; started: boolean }>('/tasks/sync-jobs', { direction: 'both', hard: !!vars?.hard }),
    onSuccess: (d) => {
      // Seed the poll cache so the bar appears immediately (no 800ms gap).
      queryClient.setQueryData(['tasks-sync-job'], { job: d.job });
      queryClient.invalidateQueries({ queryKey: ['tasks-sync-job'] });
    },
  });
}

export interface TaskOverridesResponse {
  present: boolean;
  customFields: CustomFieldDef[];
  /** The EFFECTIVE status set (shipped four + declared), sorted by order. */
  statuses: StatusDef[];
  /** The locked keys (cannot be removed or re-kinded). */
  shippedStatusKeys: string[];
  warnings: string[];
}

function useTaskOverridesQuery() {
  const api = useApi();
  return useQuery({
    queryKey: ['task-overrides'],
    queryFn: () => api.get<TaskOverridesResponse>('/task-overrides'),
    staleTime: 10 * 60 * 1000,
  });
}

/** The active task custom-field schema (from overrides/task.md). Empty when none. */
export function useTaskOverrides() {
  const q = useTaskOverridesQuery();
  return { ...q, data: q.data?.customFields ?? [] };
}

/**
 * The project's status model — column order, per-status label/colour and the
 * kind predicates (`isTerminal` & co). The shipped four until the override
 * query lands; every task view reads it instead of a hardcoded status list.
 */
export function useStatusModel(): StatusModel {
  const q = useTaskOverridesQuery();
  const statuses = q.data?.statuses;
  return useMemo(() => buildStatusModel(statuses && statuses.length > 0 ? statuses : DEFAULT_STATUSES), [statuses]);
}

export interface TaskOverrideDoc extends TaskOverridesResponse {
  raw: string;
}

export interface AddStatusInput {
  name: string;
  key?: string;
  kind?: 'open' | 'active' | 'review' | 'done' | 'cancelled';
  /** Which shipped status it lives under (the remote carrier). */
  parent?: string;
  order?: number;
  color?: string;
  /** Remote-backend (ClickUp) status-name aliases. */
  remoteAliases?: string[];
}

/** The RAW override markdown (for the Settings editor). */
export function useTaskOverrideDoc() {
  const api = useApi();
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
  const api = useApi();
  return useMutation({
    mutationFn: (raw: string) =>
      api.put<{ present: boolean; customFields: CustomFieldDef[]; warnings: string[] }>('/task-overrides/doc', { raw }),
    onSuccess: () => invalidateOverrides(queryClient),
  });
}

/** Add or replace one custom-field definition (project-wide schema). */
export function useAddCustomFieldDef() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (input: AddCustomFieldInput) =>
      api.post<{ customFields: CustomFieldDef[]; warnings: string[] }>('/task-overrides/fields', input),
    onSuccess: () => invalidateOverrides(queryClient),
  });
}

/** Remove a custom-field definition by id/key. */
export function useRemoveCustomFieldDef() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (key: string) =>
      api.del<{ customFields: CustomFieldDef[] }>(`/task-overrides/fields/${encodeURIComponent(key)}`),
    onSuccess: () => invalidateOverrides(queryClient),
  });
}

/** Add or replace one status definition (project-wide, written to overrides/task.md). */
export function useAddStatusDef() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (input: AddStatusInput) =>
      api.post<TaskOverridesResponse>('/task-overrides/statuses', input),
    onSuccess: () => invalidateOverrides(queryClient),
  });
}

/** Remove a declared status by key. The server answers 409 while tasks still carry it. */
export function useRemoveStatusDef() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (key: string) =>
      api.del<TaskOverridesResponse>(`/task-overrides/statuses/${encodeURIComponent(key)}`),
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
  const api = useApi();
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

/** One journal entry as `GET /api/tasks/:slug/journal` serves it. */
export interface TaskJournalEntry {
  id: string;
  date: string;
  kind: 'created' | 'log' | 'evidence' | 'status' | 'approval' | 'sleep' | 'remote';
  label: string;
  actor: string | null;
  body: string;
}

/** The task's newest journal entries (history lives beside the card, not in it). */
export function useTaskJournal(slug: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['tasks', slug, 'journal'],
    queryFn: () => api.get<{ total: number; entries: TaskJournalEntry[] }>(`/tasks/${encodeURIComponent(slug)}/journal`),
    enabled: !!slug,
  });
}

export function useAddTaskChangelog() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, content }: { slug: string; content: string }) =>
      api.post<{ success: boolean }>(`/tasks/${encodeURIComponent(slug)}/changelog`, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useInsertTaskSection() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, section, content }: InsertTaskSectionInput) =>
      api.post<{ success: boolean }>(`/tasks/${encodeURIComponent(slug)}/insert`, { section, content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

// ─── The owner's verdict, planning and ranking (plan r3 § W4) ────────────────

/** A refusal from the verdict, plan or rank routes: the server's code and message. */
export interface TaskActionError {
  error: string;
  message: string;
}

/** Approve a task in review, or send it back with a note (owner-only; the browser sends Origin). */
export function useTaskVerdict() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, verdict, note }: { slug: string; verdict: 'approve' | 'send_back'; note?: string }) =>
      api.post<TaskResponse>(`/tasks/${encodeURIComponent(slug)}/verdict`, { verdict, ...(note ? { note } : {}) }),
    onSuccess: (_data, v) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', v.slug] });
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
}

/** Plan a task into Now / Next / Later or a cycle (a parent brings its open sub-tasks). */
export function usePlanTask() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, target }: { slug: string; target: 'now' | 'next' | 'later' | string }) =>
      api.post<{ placement: { cycle: string | null; queue: 'next' | 'later' | null }; moved: string[] }>(
        `/tasks/${encodeURIComponent(slug)}/plan`, { target }),
    onSuccess: (_data, v) => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', v.slug] });
      queryClient.invalidateQueries({ queryKey: ['cycles'] });
    },
  });
}

/** Order a task just before or after another one of the same cycle or queue. */
export function useRankTask() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, before, after }: { slug: string; before?: string; after?: string }) =>
      api.post<{ rank: number | null }>(`/tasks/${encodeURIComponent(slug)}/rank`, before ? { before } : { after }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
