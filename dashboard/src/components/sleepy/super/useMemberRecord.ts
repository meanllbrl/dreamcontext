import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { memberHelpersOf, teamRequestsOf, type MemberHelper, type SuperStateView } from '../../../lib/superTypes';
import { fetchSuperState } from './superApi';
import { memberSuperId } from './memberStageModel';
import { readSuperRecord } from './superRecordStore';
import type { TeamCard } from './TeamTile';

/**
 * The member's own Super session, for a job main gave it as a `request` (plan-r10 1b, Wave 3):
 * from this window's record store when it holds the member's record, else read once from the
 * member's record (`GET /api/super/state?superId=m:<slug>`). Null while unknown or never born.
 */
export function useMemberSuperSession(vault: string, member: string, enabled: boolean): string | null {
  return useMemberSuperRecord(vault, member, enabled, null).session;
}

/** What the card shows of the request from the member's own record: main's text, once the
 *  member closed it (`super team done`) its result, and whether its turn has not reached the
 *  member's session yet (`pending`, or delivered and not taken: no `acceptedAt`). */
export interface MemberRequestView { text: string; result: string | null; undelivered: boolean }

/**
 * The member's record for its card (super-team.mjs T4): its Super session and the request item
 * this job is, from this window's record store, else read from the member's record (and again
 * while the job runs, so the result lands). The request and the answer show from the record at
 * once, whatever the transcript's read does.
 */
export function useMemberSuperRecord(vault: string, member: string, enabled: boolean, requestId: string | null): { session: string | null; request: MemberRequestView | null; record: SuperStateView | null } {
  const api = useApi();
  const held = enabled ? readSuperRecord(vault, memberSuperId(member)) : null;
  const q = useQuery({
    queryKey: ['super-member-record', vault, member],
    queryFn: async () => fetchSuperState(api, memberSuperId(member)),
    enabled: enabled && !held,
    staleTime: 5_000,
    refetchInterval: enabled && !held ? 5_000 : false,
  });
  // A read that is off shows nothing: react-query would hand back its last cached record (a
  // finished tile kept a frozen helper count).
  const rec = enabled ? held ?? q.data ?? null : null;
  const item = requestId ? rec?.queue.find((x) => x.id === requestId && x.kind === 'request') : undefined;
  return {
    session: rec?.session ?? null,
    record: rec,
    request: item && item.text ? {
      text: item.text,
      result: typeof item.result === 'string' && item.result ? item.result : null,
      undelivered: item.state !== 'done' && item.acceptedAt === undefined,
    } : null,
  };
}

/** A member card's helpers, from the member's record (pure {@link memberHelpersOf}). */
export function useMemberHelpers(record: SuperStateView | null, card: TeamCard): MemberHelper[] {
  return useMemo(() => memberHelpersOf(record, teamRequestsOf(card.job)), [record, card.job]);
}
