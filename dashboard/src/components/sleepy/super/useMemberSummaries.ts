import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../../api/client';
import { pollMs } from '../../../lib/windowActivity';
import type { SuperMemberSummary } from '../../../lib/superTypes';
import { readMemberSummaries } from './memberStageModel';

const NONE: Array<SuperMemberSummary & { pending: number }> = [];

/**
 * This project's members as `GET /agent/sessions?summary=1` names them (plan-r10 1, 1d): what the
 * stage needs to start a cold member (`pending`), show the approval band (`approval`) and a global
 * member's project chip (`global`). The drawer reads the same route on its own.
 */
export function useMemberSummaries(api: ApiClient, vault: string | null, enabled: boolean): Array<SuperMemberSummary & { pending: number }> {
  const q = useQuery({
    queryKey: ['super-member-summaries', vault ?? ''],
    queryFn: async () => readMemberSummaries(await api.get<unknown>('/agent/sessions?summary=1')),
    enabled: enabled && !!vault,
    refetchInterval: pollMs(15_000),
    // Main's waiting work must start a cold member even while this window is in the background
    // (end review M3): react-query pauses an interval in a hidden tab unless told otherwise.
    refetchIntervalInBackground: true,
    staleTime: 5_000,
  });
  return q.data ?? NONE;
}
