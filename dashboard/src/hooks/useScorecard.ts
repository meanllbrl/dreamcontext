import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import { phoneAllows } from '../lib/phoneSurface';
import type { ScorecardData } from '../lib/scorecardModel';

/**
 * A member's Scorecard (plan uye-karnesi C5): one read the card, the tile and the stars under a run
 * in the member's chat all share, and its writes. While a check or a lesson draft runs the read
 * re-polls, so its result lands without a reload; nothing retries by itself.
 */

const key = (slug: string) => ['scorecard', slug] as const;
const RUNNING_POLL_MS = 4000;

function anyRunning(d: ScorecardData | undefined): boolean {
  return !!d?.runs.some((r) => r.check?.state === 'running' || r.rating?.draft?.state === 'running');
}

export function useScorecard(slug: string | null) {
  const api = useApi();
  const enabled = !!slug && phoneAllows('GET', `/api/agents/${encodeURIComponent(slug)}/scorecard`);
  return useQuery({
    queryKey: key(slug ?? ''),
    queryFn: () => api.get<ScorecardData>(`/agents/${encodeURIComponent(slug ?? '')}/scorecard`),
    enabled,
    retry: 0,
    refetchInterval: (q) => (anyRunning(q.state.data as ScorecardData | undefined) ? RUNNING_POLL_MS : false),
  });
}

export type ScorecardWrite =
  | { kind: 'rate'; run: string; stars: number | null; note?: string }
  | { kind: 'criteria'; op: 'add'; text: string }
  | { kind: 'criteria'; op: 'remove'; id: string }
  | { kind: 'verdict'; run: string; id: string; met: boolean | null }
  | { kind: 'undo'; id: string }
  | { kind: 'use'; id: string }
  | { kind: 'goal'; insight: string; target: number; baseline?: number | null }
  | { kind: 'goalClear' }
  | { kind: 'check'; run: string }
  | { kind: 'draft'; run: string }
  | { kind: 'fresh' };

export function useScorecardWrite(slug: string) {
  const api = useApi();
  const qc = useQueryClient();
  const base = `/agents/${encodeURIComponent(slug)}/scorecard`;
  return useMutation({
    mutationFn: (w: ScorecardWrite): Promise<unknown> => {
      switch (w.kind) {
        case 'rate': return api.post(`${base}/rate`, { run: w.run, stars: w.stars, ...(w.note !== undefined ? { note: w.note } : {}) });
        case 'criteria': return api.post(`${base}/criteria`, w.op === 'add' ? { op: 'add', text: w.text } : { op: 'remove', id: w.id });
        case 'verdict': return api.post(`${base}/verdict`, { run: w.run, id: w.id, met: w.met });
        case 'undo': return api.post(`${base}/lessons/${encodeURIComponent(w.id)}/undo`, {});
        case 'use': return api.post(`${base}/lessons/${encodeURIComponent(w.id)}/use`, {});
        case 'goal': return api.post(`${base}/goal`, { insight: w.insight, target: w.target, ...(w.baseline !== undefined && w.baseline !== null ? { baseline: w.baseline } : {}) });
        case 'goalClear': return api.post(`${base}/goal`, { clear: true });
        case 'check': return api.post(`${base}/check`, { run: w.run });
        case 'draft': return api.post(`${base}/draft`, { run: w.run });
        case 'fresh': return api.post(`${base}/fresh`, {});
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key(slug) }),
  });
}
