import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../context/VaultContext';
import { ChatPaneHost, type ChatSurfaceActions } from './ChatPaneHost';
import type { HistoryEntry } from './chatSession';
import type { ChatMode } from '../../lib/chatModes';
import type { ModelConfig } from '../../lib/agentComposer';
import { createTranscriptSession } from './transcriptSession';

/**
 * A chat tab parked under machine load, drawn exactly like the chat it was (owner 2026-11-03:
 * "parked olsun ama kişi anlamasın"). Parking is a memory detail: the process is stopped, the
 * transcript is on disk. So the pane shows that transcript in the same ChatPane, with the
 * composer open, and the first message the owner sends goes through `onSend`, which resumes the
 * same conversation and hands it the message (AgentSurface `wakeParked`). No "Parked" panel, no
 * Resume button.
 *
 * Nothing is spawned here: the conversation is read from `/agent/chat-history`, keyed by the
 * moment it was parked, so a later park reads the transcript again.
 */
function ParkedChatInner({
  sessionId, claudeId, parkedAt, tool, actions, modelConfig, model, effort, mode, permissionMode,
  canSignInInApp, signInCommand, onSend,
}: {
  /** The parked tab's roster id: what the composer's pickers act on. */
  sessionId: string;
  claudeId: string;
  parkedAt: number;
  /** The tool the conversation is bound to ('' = Claude): its own model list in the composer. */
  tool: string;
  actions: ChatSurfaceActions;
  modelConfig: ModelConfig;
  model: string;
  effort: string;
  mode: ChatMode;
  permissionMode: 'auto' | 'bypass';
  canSignInInApp: boolean;
  signInCommand: string;
  /** The owner's message: resume and deliver it. False = it did not go, the text stays. */
  onSend: (sessionId: string, message: string) => boolean;
}) {
  const api = useApi();
  const [session] = useState(() => {
    const s = createTranscriptSession(claudeId);
    (s as { tool: string }).tool = tool;
    return s;
  });
  const history = useQuery({
    queryKey: ['parked-chat-transcript', claudeId, parkedAt],
    queryFn: async () => {
      const r = await api.get<{ items: HistoryEntry[] }>(`/agent/chat-history?claudeId=${encodeURIComponent(claudeId)}`);
      return Array.isArray(r?.items) ? r.items : [];
    },
    staleTime: Infinity,
  });
  useEffect(() => { if (history.data) session.load(history.data); }, [history.data, session]);
  // A transcript that could not be read still leaves the chat writable: the first message wakes
  // the conversation, whose own resume brings the history back.
  const shown = !!history.data || history.isError;
  useEffect(() => () => session.dispose(), [session]);
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (el && session.container.parentElement !== el) el.appendChild(session.container);
    return () => { if (el && session.container.parentElement === el) el.removeChild(session.container); };
  }, [session]);
  // The pickers act on the parked tab's roster entry (its id, not the transcript's), so the
  // resume that the first message triggers starts on what the owner chose meanwhile.
  const paneActions = useMemo<ChatSurfaceActions>(() => ({
    ...actions,
    changeModel: (_sid, id) => actions.changeModel(sessionId, id),
    changeEffort: (_sid, level) => actions.changeEffort(sessionId, level),
    changePermissionMode: (_sid, m) => actions.changePermissionMode(sessionId, m),
    changeMode: (_sid, m) => actions.changeMode(sessionId, m),
    changeAccount: (_sid, accountId) => actions.changeAccount(sessionId, accountId),
    pickAgent: (_sid, agent) => actions.pickAgent?.(sessionId, agent),
    pickTool: (_sid, t, m) => actions.pickTool?.(sessionId, t, m),
    // Nothing runs: these have nothing to act on until the first message wakes it.
    continueInTerminal: () => { /* parked */ },
    resumeChat: () => { /* parked */ },
    handoffToDevelop: () => { /* parked */ },
  }), [actions, sessionId]);
  const sendVia = useMemo(() => (message: string) => onSend(sessionId, message), [onSend, sessionId]);
  const pane = (
    <ChatPaneHost
      session={session}
      actions={paneActions}
      modelConfig={modelConfig}
      model={model}
      effort={effort}
      mode={mode}
      permissionMode={permissionMode}
      canSignInInApp={canSignInInApp}
      signInCommand={signInCommand}
      sendVia={sendVia}
    />
  );
  // Until the transcript is read the pane stays hidden (never an empty "say something" chat).
  return (
    <div ref={hostRef} data-testid="parked-chat" style={shown ? { display: 'contents' } : { display: 'none' }}>
      {createPortal(pane, session.container)}
    </div>
  );
}

export const ParkedChat = memo(ParkedChatInner);
