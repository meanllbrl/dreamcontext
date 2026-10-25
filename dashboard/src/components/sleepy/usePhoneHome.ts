import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ApiClient } from '../../api/client';
import { useApi } from '../../context/VaultContext';
import { pollMs } from '../../lib/windowActivity';
import type { LiveChatsWire } from '../handsfree/macContract';
import type { PastSession } from './ChatHistoryPicker';
import { homeRows, type HomeRow } from './phoneHome';
import type { StackTab } from './phoneStack';
import { rememberSuperMirrorIds } from './superMirrorIds';

const PAST_LIMIT = 50;

interface ChatSessionsResponse { sessions: PastSession[]; total: number }

/**
 * The phone's one list over every chosen project (hands-free sekmeler W3): the Sohbetler list and
 * the chat screen (swipe, back badge, toast) read the same rows. ONE `live-chats` answer spans the
 * chosen projects; each project's past chats come from its own `chat-sessions` (the request names
 * that project; no route changes). Polled only while `active`.
 */
export function usePhoneHome(o: { vault: string; tabs: readonly StackTab[]; active: boolean; q?: string }): {
  rows: HomeRow[];
  projects: string[];
  live: LiveChatsWire | undefined;
  pastTotal: Record<string, number>;
  pastLoading: boolean;
} {
  const api = useApi();
  const q = o.q ?? '';
  const { data: vaultsResp } = useQuery({
    queryKey: ['mac-phone-vaults'],
    queryFn: () => api.get<{ vaults: Array<{ name: string; exists: boolean }> }>('/vaults'),
    enabled: o.active,
    staleTime: 30_000,
    retry: false,
  });
  const projects = useMemo(() => (vaultsResp?.vaults ?? []).filter((v) => v.exists).map((v) => v.name), [vaultsResp]);
  const { data: live } = useQuery({
    queryKey: ['mac-live-chats'],
    queryFn: async () => {
      const wire = await api.get<LiveChatsWire>('/agent/live-chats');
      // Every Super conversation the Mac names is shown as the Super's, however it is opened.
      rememberSuperMirrorIds((wire.supers ?? []).map((x) => x.conversationId));
      return wire;
    },
    enabled: o.active,
    refetchInterval: o.active ? () => pollMs(3_000) : false,
    staleTime: 2_000,
    retry: false,
  });
  // A handed-over project lists its Super row only: its past chats are not read.
  const handedOver = new Set((live?.supers ?? []).map((x) => x.vault));
  const pastProjects = (projects.length ? projects : [o.vault]).filter((p) => !!p && !handedOver.has(p));
  const past = useQueries({
    queries: pastProjects.map((p) => ({
      queryKey: ['phone-list-past', p, q],
      queryFn: () => new ApiClient(p).get<ChatSessionsResponse>(`/agent/chat-sessions?limit=${PAST_LIMIT}&q=${encodeURIComponent(q)}`),
      enabled: o.active,
      refetchInterval: o.active ? () => pollMs(10_000) : false as const,
      staleTime: 5_000,
      placeholderData: (prev: ChatSessionsResponse | undefined) => prev,
      retry: false,
    })),
  });
  const pastByVault: Record<string, PastSession[]> = {};
  const pastTotal: Record<string, number> = {};
  pastProjects.forEach((p, k) => {
    const d = past[k]?.data;
    if (d) { pastByVault[p] = d.sessions; pastTotal[p] = d.total; }
  });
  const pastKey = past.map((x) => x.dataUpdatedAt).join('|');
  const rows = useMemo(
    () => homeRows({ vault: o.vault, tabs: o.tabs, projects: projects.length ? projects : [o.vault], live, pastByVault }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [o.vault, o.tabs, projects, live, pastKey],
  );
  return { rows, projects, live, pastTotal, pastLoading: past.some((x) => x.isLoading) };
}
