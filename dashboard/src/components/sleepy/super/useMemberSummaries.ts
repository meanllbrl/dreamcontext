import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../../api/client';
import { pollMs } from '../../../lib/windowActivity';
import type { SuperMemberSummary } from '../../../lib/superTypes';
import { readMemberHeld, readMemberSummaries } from './memberStageModel';

type Member = SuperMemberSummary & { pending: number };
interface MemberFacts { members: Member[]; held: string[] }

const NONE: Member[] = [];
const NO_HELD: string[] = [];

/** The one poll of `GET /agent/sessions?summary=1` both hooks below read (one query key). */
function useMemberFacts(api: ApiClient, vault: string | null, enabled: boolean): MemberFacts | undefined {
  return useQuery({
    queryKey: ['super-member-summaries', vault ?? ''],
    queryFn: async (): Promise<MemberFacts> => {
      const raw = await api.get<unknown>('/agent/sessions?summary=1');
      return { members: readMemberSummaries(raw), held: readMemberHeld(raw) };
    },
    enabled: enabled && !!vault,
    refetchInterval: pollMs(15_000),
    // Main's waiting work must start a cold member even while this window is in the background
    // (end review M3): react-query pauses an interval in a hidden tab unless told otherwise.
    refetchIntervalInBackground: true,
    staleTime: 5_000,
  }).data;
}

/**
 * This project's members as `GET /agent/sessions?summary=1` names them (plan-r10 1, 1d): what the
 * stage needs to start a cold member (`pending`), show the approval band (`approval`) and a global
 * member's project chip (`global`). The drawer reads the same route on its own.
 */
export function useMemberSummaries(api: ApiClient, vault: string | null, enabled: boolean): Member[] {
  return useMemberFacts(api, vault, enabled)?.members ?? NONE;
}

/**
 * Every session the project's member Supers hold (their own chats, their children, former ones),
 * from the server's records. A window reads only main's record at load and a member's only when it
 * opens it, so without this a restored tab of a member's helper is homed in a chat window (field
 * 2026-11-18). The same array until the poll answers something new.
 */
export function useMemberHeldSessions(api: ApiClient, vault: string | null, enabled: boolean): readonly string[] {
  return useMemberFacts(api, vault, enabled)?.held ?? NO_HELD;
}
