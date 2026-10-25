import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { useAgentModelConfig } from '../../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../../lib/agentComposer';
import { ChatPaneHost, type ChatSurfaceActions } from '../ChatPaneHost';
import type { HistoryEntry } from '../chatSession';
import { createTranscriptSession } from '../transcriptSession';

const noop = () => { /* a finished child: the pane offers nothing to act on */ };
const ACTIONS: ChatSurfaceActions = {
  changeModel: noop, changeEffort: noop, continueInTerminal: noop, resumeChat: noop,
  changePermissionMode: noop, changeMode: noop, changeAccount: noop, handoffToDevelop: noop,
  openAppPage: noop, signIn: async () => { /* nothing to sign in */ },
};

/**
 * A shown child with no live chat in this window (it finished and exited; a relaunch keeps it as
 * a dormant tab): its saved transcript, read only, in the same ChatPane a live child's card shows.
 * Read from disk through `/agent/chat-history` (the server resolves the account's projects
 * folder); no `claude` is started for it. The live chat takes the slot back the moment the child
 * runs again (`super resume`), because the card then has a session and draws the slot instead.
 */
export function ChildTranscript({ claudeId }: { claudeId: string }) {
  const api = useApi();
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const [session] = useState(() => createTranscriptSession(claudeId));
  const hostRef = useRef<HTMLDivElement>(null);
  const history = useQuery({
    queryKey: ['super-child-transcript', claudeId],
    queryFn: async () => {
      const r = await api.get<{ items: HistoryEntry[] }>(`/agent/chat-history?claudeId=${encodeURIComponent(claudeId)}`);
      return Array.isArray(r?.items) ? r.items : [];
    },
    staleTime: 15_000,
  });
  useEffect(() => { if (history.data) session.load(history.data); }, [history.data, session]);
  useEffect(() => () => session.dispose(), [session]);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (el && session.container.parentElement !== el) el.appendChild(session.container);
    return () => { if (el && session.container.parentElement === el) el.removeChild(session.container); };
  }, [session]);
  const pane = useMemo(() => (
    <ChatPaneHost
      session={session}
      actions={ACTIONS}
      modelConfig={modelConfig}
      model={modelConfig.defaultModel}
      effort={modelConfig.defaultEffort}
      mode={session.mode}
      permissionMode="auto"
      canSignInInApp={false}
      signInCommand="claude auth login"
      readOnly="finished"
    />
  ), [session, modelConfig]);
  return (
    <div className="super-slot" data-testid="super-child-transcript" ref={hostRef}>
      {createPortal(pane, session.container)}
    </div>
  );
}
