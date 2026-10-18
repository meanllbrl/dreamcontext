import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import { pollMs } from '../lib/windowActivity';
import type { ProposalsPayload } from './useTaskProposals';
import type { Task } from './useTasks';

/**
 * The Inbox (server: src/server/routes/inbox.ts): proposals and change cards, reviews
 * waiting for the owner's verdict, the records of every owner override with who and
 * through what, parents a sync held open, and what sleep learned.
 */

export type AuditVia = 'cli' | 'dashboard' | 'phone' | 'no-origin';
export type AuditKind = 'approval' | 'send_back' | 'accept' | 'apply' | 'force' | 'held_open' | 'exempt';

export interface AuditEntry {
  id: string;
  at: string;
  kind: AuditKind;
  slug: string;
  actor: string;
  via: AuditVia;
  note: string | null;
  journalId: string | null;
  seen?: { at: string; actor: string; via: AuditVia };
}

export interface LearnedItem {
  /** `lp_…` for a learned rule, `R<n>@<at>` for a task-filing rule change. */
  id: string;
  source: 'correction' | 'filing-rule';
  at: string;
  pattern: string;
  title: string;
  quotes: Array<{ text: string; date: string }>;
  reverted: { at: string; by: string } | null;
}

export interface InboxPayload {
  proposals: ProposalsPayload;
  reviews: Task[];
  records: AuditEntry[];
  flags: AuditEntry[];
  learned: LearnedItem[];
}

const KEY = ['inbox'] as const;

export function useInbox() {
  const api = useApi();
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<InboxPayload>('/inbox'),
    refetchInterval: () => pollMs(30_000),
  });
}

/** The sidebar badge: proposals and change cards, fully evidenced reviews, unseen flags. */
export function useInboxCount() {
  const api = useApi();
  return useQuery({
    queryKey: [...KEY, 'count'],
    queryFn: () => api.get<{ waiting: number }>('/inbox/count'),
    refetchInterval: () => pollMs(30_000),
  });
}

/** Mark one record (a held-open flag) seen. Owner-only: the browser sends Origin. */
export function useInboxSeen() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (id: string) => api.post<{ entry: AuditEntry }>('/inbox/seen', { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

/** Revert something sleep learned (a rule from corrections, or a filing-rule change). */
export function useRevertLearned() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ id, expectAt }: { id: string; expectAt?: string }) =>
      api.post<{ item: LearnedItem }>(`/learned/${encodeURIComponent(id)}/revert`, expectAt ? { expectAt } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY });
      queryClient.invalidateQueries({ queryKey: ['task-proposals'] });
    },
  });
}
