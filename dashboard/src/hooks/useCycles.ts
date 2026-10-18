import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import { pollMs } from '../lib/windowActivity';

/**
 * Cycles for the Planning screen and the Close deck (server: src/server/routes/cycles.ts,
 * the same library as `dreamcontext cycle`).
 */

export type CycleStatus = 'planned' | 'active' | 'closed';

export interface CycleView {
  id: string;
  number: number;
  goal: string;
  start: string;
  end: string;
  status: CycleStatus;
  created_at: string;
  closed_at?: string;
  carried?: string[];
  backed?: string[];
  cancelled?: string[];
  result?: { done: number; total: number };
}

export interface CycleBrief {
  slug: string;
  name: string;
  status: string;
}

export interface CycleListEntry extends CycleView {
  progress: { total: number; done: number; open: CycleBrief[] };
  daysLeft: number;
}

export interface CyclesPayload {
  cycles: CycleListEntry[];
  active: string | null;
  defaultWeeks: number;
  /** Average leaves done per closed cycle (the last three), or null before the first close. */
  capacityHint: number | null;
}

export type CloseAction = 'carry' | 'back' | 'cancel';

export interface ClosePlanPayload {
  cycle: CycleView;
  into: CycleView | null;
  groups: Array<{ parent: { slug: string; name: string } | null; leaves: Array<{ slug: string; name: string; status: string; carried: number }> }>;
  resuming: boolean;
}

export interface CloseResultPayload {
  cycle: CycleView;
  moved: { carry: string[]; back: string[]; cancel: string[] };
}

const KEY = ['cycles'] as const;

export function useCycles() {
  const api = useApi();
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<CyclesPayload>('/cycles'),
    refetchInterval: () => pollMs(30_000),
  });
}

function useInvalidateCycles() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: KEY });
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };
}

export function useNewCycle() {
  const api = useApi();
  const invalidate = useInvalidateCycles();
  return useMutation({
    mutationFn: (input: { goal: string; start?: string; weeks?: number }) => api.post<{ cycle: CycleView }>('/cycles', input),
    onSuccess: invalidate,
  });
}

export function useStartCycle() {
  const api = useApi();
  const invalidate = useInvalidateCycles();
  return useMutation({
    mutationFn: (id: string) => api.post<{ cycle: CycleView }>(`/cycles/${encodeURIComponent(id)}/start`, {}),
    onSuccess: invalidate,
  });
}

/**
 * What the Close deck shows for one cycle: its unfinished leaves, grouped by parent. The deck
 * turns it off (`enabled: false`) the moment it submits the close: a closed cycle has no plan,
 * and reading one after the close would only meet a 404.
 */
export function useClosePlan(id: string | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...KEY, id, 'close-plan'],
    queryFn: () => api.get<ClosePlanPayload>(`/cycles/${encodeURIComponent(id ?? '')}/close-plan`),
    enabled: !!id && enabled,
  });
}

/**
 * Close a cycle with a decision for every unfinished leaf (a 400 `undecided` names the rest).
 * On success the cycles and the cards refresh, but the closed cycle's close plan is dropped,
 * never refetched: it no longer exists.
 */
export function useCloseCycle() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decisions, into }: { id: string; decisions: Record<string, CloseAction>; into?: string }) =>
      api.post<CloseResultPayload>(`/cycles/${encodeURIComponent(id)}/close`, { decisions, ...(into ? { into } : {}) }),
    onSuccess: (_data, v) => {
      queryClient.removeQueries({ queryKey: [...KEY, v.id, 'close-plan'], exact: true });
      queryClient.invalidateQueries({ queryKey: KEY, predicate: (q) => q.queryKey[2] !== 'close-plan' });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
