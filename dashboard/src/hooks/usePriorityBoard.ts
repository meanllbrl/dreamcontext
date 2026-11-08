import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import type { MoveOp, PriorityPayload } from '../components/roadmap/priorityModel';

/**
 * The priority board's ONE payload (GET /api/roadmap/priority): cards, counts and
 * the agent button all come from it, so they can never disagree. Key
 * ['roadmap', 'priority'], so every existing mutation that invalidates ['roadmap']
 * refreshes it. No refetchInterval: the project client's default already polls
 * every 15 s while the project is active (lib/instanceQueryClient.ts).
 */
export const PRIORITY_KEY = ['roadmap', 'priority'] as const;

export function usePriorityBoard(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: PRIORITY_KEY,
    queryFn: () => api.get<PriorityPayload>('/roadmap/priority'),
    enabled,
    retry: 1,
  });
}

export interface MoveResult {
  changed: boolean;
  note: 'already_linked' | null;
  undo: MoveOp;
  objectives: string[];
}

/** Move ONE objective link (drag): the server applies it to a fresh read and returns the undo. */
export function useMoveObjectiveLink() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, op }: { slug: string; op: MoveOp }) =>
      api.post<MoveResult>(`/tasks/${slug}/objectives/move`, op),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

/** scoring/start is a compare-and-set: `started: false` means another window or click won. */
export async function startScoring(api: ReturnType<typeof useApi>): Promise<boolean> {
  try {
    const r = await api.post<{ started: boolean }>('/roadmap/scoring/start', {});
    return r.started === true;
  } catch {
    return false;
  }
}

export async function stopScoring(api: ReturnType<typeof useApi>): Promise<void> {
  await api.post('/roadmap/scoring/stop', {}).catch(() => { /* best-effort */ });
}
