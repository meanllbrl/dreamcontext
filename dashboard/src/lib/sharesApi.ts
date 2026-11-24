/**
 * Live links from the owner's screens (tunel-paylasim C4, D8). Opening a link and reading it back
 * are the owner's own click (`ownerPost`, the key only the shell holds); the list never carries a
 * link, token or password; closing is a plain local call.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import type { ApiClient } from '../api/client';

export type ShareKind = 'app' | 'board';
export type ShareState = 'starting' | 'open' | 'closing' | 'broken';
export type ShareStage = 'download' | 'tunnel' | 'probe';

/** `GET /api/shares` row (server `PublicShare`). */
export interface LiveShare {
  id: string;
  kind: ShareKind;
  vault: string;
  slug: string;
  name: string;
  state: ShareState;
  stage: ShareStage | null;
  error?: string;
  people: number;
  password: boolean;
  ai: boolean;
  openedAt: string;
}

export interface OpenShareInput { kind: ShareKind; vault: string; slug: string; password?: string | null; ai?: boolean }

export const LIVE_SHARES_KEY = ['live-shares'] as const;

/** Every live link of this Mac (all projects). Fast while one is starting, slow otherwise. */
export function useLiveShares() {
  const api = useApi();
  return useQuery({
    queryKey: LIVE_SHARES_KEY,
    queryFn: async () => (await api.get<{ shares: LiveShare[] }>('/shares')).shares ?? [],
    refetchInterval: (q) => {
      const rows = (q.state.data ?? []) as LiveShare[];
      if (rows.some((s) => s.state === 'starting' || s.state === 'closing')) return 1_000;
      return rows.length ? 4_000 : 15_000;
    },
    staleTime: 500,
  });
}

export function openLiveShare(api: ApiClient, input: OpenShareInput): Promise<LiveShare & { existing: boolean }> {
  return api.ownerPost('/shares', input);
}

export function revealLiveShare(api: ApiClient, id: string): Promise<{ link: string; password?: string }> {
  return api.ownerPost(`/shares/${encodeURIComponent(id)}/reveal`, {});
}

export function closeLiveShare(api: ApiClient, id: string): Promise<unknown> {
  return api.post(`/shares/${encodeURIComponent(id)}/close`, {});
}

export function closeAllLiveShares(api: ApiClient): Promise<unknown> {
  return api.post('/shares/all/close', {});
}

/** Re-read the list now (after an open or a close). */
export function useRefreshShares(): () => void {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: LIVE_SHARES_KEY }); };
}
