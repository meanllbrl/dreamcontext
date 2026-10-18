import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';

/**
 * Sleep's task proposals, the tasks it opened itself, and what the owner's
 * verdicts taught it (server: src/server/routes/task-proposals.ts).
 *
 * Proposals live on the Tasks screen, not in a chat: sleep often runs in the
 * background with nobody in a session, so this is polled like the agent feed.
 */

export type FeedbackReason = 'already-exists' | 'abandoned' | 'too-small' | 'badly-written' | 'wrong-project' | 'not-work';
export type FilingBasis = 'ask' | 'defect' | 'discussion' | 'unknown';

export interface TaskProposal {
  id: string;
  name: string;
  why: string;
  quote: string;
  basis: FilingBasis;
  parent: string | null;
  parentName: string | null;
  session: string | null;
  proposedAt: string;
  by: 'sleep' | 'agent';
}

export interface FiledBySleep {
  slug: string;
  name: string;
  why: string;
  quote: string;
  basis: FilingBasis;
  parent: string | null;
  parentName: string | null;
  status: string | null;
  filedAt: string;
}

export interface WeekTrend {
  week: string;
  kept: number;
  rejected: number;
  rate: number | null;
}

export interface RuleChangeRow {
  id: string;
  title: string;
  action: 'add' | 'update' | 'merge' | 'revert';
  by: 'sleep' | 'owner' | 'agent';
  at: string;
  restsOn: number;
  removed: boolean;
}

/** A reorganisation the task migration was not sure about (server: lib/backlog-migration.ts). */
export interface ChangeSuggestion {
  id: string;
  slug: string;
  name: string;
  status: string;
  change: 'merge' | 'cancel' | 'parent' | 'later' | 'feature';
  target: string | null;
  targetName: string | null;
  why: string;
  by: 'code' | 'agent' | 'owner';
  proposedAt: string;
}

export interface ProposalsPayload {
  waiting: number;
  /** Absent from a server that predates the task migration. */
  changes?: ChangeSuggestion[];
  proposals: TaskProposal[];
  filed: FiledBySleep[];
  brake: { window: number; rejected: number; rate: number | null; open: boolean };
  trend: WeekTrend[];
  reasons: Array<{ key: FeedbackReason; label: string }>;
  ruleCount: number;
  rules: RuleChangeRow[];
}

const KEY = ['task-proposals'] as const;
const POLL_MS = 30_000;

export function useTaskProposals() {
  const api = useApi();
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<ProposalsPayload>('/task-proposals'),
    refetchInterval: POLL_MS,
  });
}

/** The sidebar badge: how many things wait for the owner (no bodies). */
export function useTaskProposalsCount() {
  const api = useApi();
  return useQuery({
    queryKey: [...KEY, 'count'],
    queryFn: () => api.get<{ waiting: number }>('/task-proposals/count'),
    refetchInterval: POLL_MS,
  });
}

/**
 * Refetch after a decision. Returned from `onSuccess`, so the mutation stays
 * pending (its button disabled) until the section shows the new state: a second
 * tap can never act on the old one.
 */
function useInvalidate() {
  const queryClient = useQueryClient();
  return () => Promise.all([
    queryClient.invalidateQueries({ queryKey: KEY }),
    queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  ]);
}

export interface AcceptInput {
  id: string;
  name?: string;
  why?: string;
  /** A slug, null for top-level, undefined for sleep's suggestion. */
  parent?: string | null;
}

export function useAcceptProposal() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: AcceptInput) =>
      api.post<{ slug: string; parent: string | null; parentDropped?: string; warning?: string }>(`/task-proposals/${id}/accept`, body),
    onSuccess: invalidate,
  });
}

export interface RejectInput {
  /** A proposal id (`tp_…`) or, with `filed`, the slug of a task sleep opened. */
  id: string;
  filed: boolean;
  reason: FeedbackReason;
  note?: string;
}

export function useRejectItem() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, filed, reason, note }: RejectInput) =>
      api.post<unknown>(filed ? `/task-proposals/filed/${id}/reject` : `/task-proposals/${id}/reject`, { reason, ...(note ? { note } : {}) }),
    onSuccess: invalidate,
  });
}

export function useKeepFiled() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (slug: string) => api.post<unknown>(`/task-proposals/filed/${slug}/keep`, {}),
    onSuccess: invalidate,
  });
}

export interface RevertInput {
  id: string;
  /** The change the owner saw: a newer one refuses, so a double tap never undoes itself. */
  at: string;
}

export function useRevertRule() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, at }: RevertInput) => api.post<unknown>(`/task-filing-rules/${id}/revert`, { at }),
    onSuccess: invalidate,
  });
}

export interface ChangeAnswer {
  slug: string;
  /** The suggestion the owner saw: a newer one refuses, so a stale card never acts. */
  id: string;
  apply: boolean;
}

export function useAnswerChange() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ slug, id, apply }: ChangeAnswer) =>
      api.post<unknown>(`/task-proposals/changes/${slug}/${apply ? 'apply' : 'keep'}`, { id }),
    onSuccess: invalidate,
  });
}
