import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatPaneHost, type ChatSurfaceActions } from './ChatPaneHost';
import type { EmptyHero } from './chat/Banners';
import { DEFAULT_CHAT_MODE, type ChatMode } from '../../lib/chatModes';
import type { ModelConfig } from '../../lib/agentComposer';
import { createTranscriptSession } from './transcriptSession';

/** What the owner chose in the landing's composer before the chat existed. */
export interface ChatLandingPick {
  model: string;
  effort: string;
  mode: ChatMode;
  accountId: string;
}

/**
 * A project's Chat page with no chat open (owner 2026-11-24: "real claude code gibi bir mesajımız
 * kalmamıştı"): the Super Agent's welcome (mark, one question, chips) over the real composer, so
 * the owner just types. Nothing runs here: the pane draws a process-less conversation
 * (`createTranscriptSession`, as a parked chat does), and the first message or chip goes through
 * `onStart`, which opens a real chat on what was picked and hands it that message. The pickers
 * act on this component's own state until then; the permission mode is the project's, so it goes
 * through the live handler.
 */
function ChatLandingInner({
  hero, placeholder, actions, modelConfig, permissionMode, canSignInInApp, signInCommand, onStart,
}: {
  hero: EmptyHero;
  placeholder: string;
  actions: ChatSurfaceActions;
  modelConfig: ModelConfig;
  permissionMode: 'auto' | 'bypass';
  canSignInInApp: boolean;
  signInCommand: string;
  /** Open a chat with this first message. False = it did not start, the text stays. */
  onStart: (message: string, pick: ChatLandingPick) => boolean;
}) {
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [mode, setMode] = useState<ChatMode>(DEFAULT_CHAT_MODE);
  const [accountId, setAccountId] = useState('');
  const pick: ChatLandingPick = { model: model || modelConfig.defaultModel, effort: effort || modelConfig.defaultEffort, mode, accountId };
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const startRef = useRef(onStart);
  startRef.current = onStart;
  const [session] = useState(() => {
    const s = createTranscriptSession('');
    // A chip sends through the session (ChatPane's EmptyState): here that starts the chat.
    (s as { send: (text: string) => boolean }).send = (text: string) => {
      const clean = text.trim();
      return clean ? startRef.current(clean, pickRef.current) : false;
    };
    return s;
  });
  useEffect(() => () => session.dispose(), [session]);
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (el && session.container.parentElement !== el) el.appendChild(session.container);
    return () => { if (el && session.container.parentElement === el) el.removeChild(session.container); };
  }, [session]);
  const paneActions = useMemo<ChatSurfaceActions>(() => ({
    ...actions,
    changeModel: (_sid, id) => { if (id) setModel(id); },
    changeEffort: (_sid, level) => { if (level) setEffort(level); },
    changeMode: (_sid, m) => setMode(m),
    changeAccount: (_sid, id) => setAccountId(id),
    changePermissionMode: (_sid, m) => actions.changePermissionMode('', m),
    // A new conversation on another agent or tool starts from a live one: not offered here.
    pickAgent: undefined,
    pickTool: undefined,
    continueInTerminal: () => { /* nothing runs yet */ },
    resumeChat: () => { /* nothing runs yet */ },
    handoffToDevelop: () => { /* nothing runs yet */ },
  }), [actions]);
  const sendVia = useMemo(() => (message: string) => {
    const clean = message.trim();
    return clean ? startRef.current(clean, pickRef.current) : false;
  }, []);
  const pane = (
    <ChatPaneHost
      session={session}
      actions={paneActions}
      modelConfig={modelConfig}
      model={pick.model}
      effort={pick.effort}
      mode={mode}
      permissionMode={permissionMode}
      canSignInInApp={canSignInInApp}
      signInCommand={signInCommand}
      idlePlaceholder={placeholder}
      emptyHero={hero}
      sendVia={sendVia}
    />
  );
  return (
    <div ref={hostRef} className="agent-chat-landing" data-testid="chat-landing">
      {createPortal(pane, session.container)}
    </div>
  );
}

export const ChatLanding = memo(ChatLandingInner);
