import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../../api/client';
import type { SuperStateView } from '../../../lib/superTypes';
import { pollMs } from '../../../lib/windowActivity';
import type { LiveChatsWire, SuperChatWire } from '../../handsfree/macContract';
import { superRowFor } from '../phoneList';
import { fetchRemoteStage } from './remoteStage';

/**
 * The remote stage's lifecycle (hands-free sekmeler W2, D5) for a computer on the tunnel: the live
 * list (a 200 always) says whether this project is handed over and whether the Mac runs its Super
 * Agent; the stage is then read from `GET /api/agent/super-stage` and followed through the
 * `super_stage` frames on the Super's mirror. A read that failed (a tunnel 502) is tried again on
 * every poll of the live list until the stage is drawn; taken back, the stage goes.
 */
export function useRemoteStage(o: {
  remoteDesktop: boolean;
  vault: string | null;
  api: ApiClient;
  /** The stage is drawn now: no retry needed. */
  shown: boolean;
  onStage: (st: SuperStateView) => void;
  onOff: () => void;
}): { superRow: SuperChatWire | null } {
  const { data: live, dataUpdatedAt } = useQuery({
    queryKey: ['remote-live-chats', o.vault],
    queryFn: () => o.api.get<LiveChatsWire>('/agent/live-chats'),
    enabled: o.remoteDesktop && !!o.vault,
    refetchInterval: () => pollMs(10_000),
    retry: false,
  });
  const superRow = o.remoteDesktop && o.vault ? superRowFor(live, o.vault) : null;
  const session = superRow?.conversationId ?? null;
  const cb = useRef({ onStage: o.onStage, onOff: o.onOff });
  cb.current = { onStage: o.onStage, onOff: o.onOff };
  // Until the stage is drawn, each poll of the live list is a retry; once drawn, frames keep it.
  const retry = o.shown ? 0 : dataUpdatedAt;
  useEffect(() => {
    if (!o.remoteDesktop) return undefined;
    if (!session) { cb.current.onOff(); return undefined; }
    let cancelled = false;
    void fetchRemoteStage(o.api).then((st) => {
      if (cancelled || !st) return;
      if (st === 'off' || !st.enabled) { cb.current.onOff(); return; }
      cb.current.onStage(st);
    });
    return () => { cancelled = true; };
  }, [o.remoteDesktop, session, o.api, retry]);
  return { superRow };
}
