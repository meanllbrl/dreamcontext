import { memo, useCallback } from 'react';
import { ChatPane } from './ChatPane';
import type { ModelConfig } from '../../lib/agentComposer';
import type { AutomationRunRef } from '../../lib/automationRunChat';
import type { ChatMode } from '../../lib/chatModes';
import type { ChatSession } from './chatSession';

/**
 * The MEMO BOUNDARY between AgentSurface and a chat transcript.
 *
 * AgentSurface re-renders on `bumpStatus` — i.e. on ANY session's busy/asking/status/
 * attention edge, anywhere in the roster. Its portal loop used to build `<ChatPane>`
 * directly with ~14 props, over half of them inline arrows closing over `cs`, so a single
 * token arriving in one split pane re-rendered every OTHER chat pane's entire transcript
 * too. That is the blast radius this component exists to stop.
 *
 * Two rules make the boundary hold, and both are load-bearing:
 *
 *   1. Every prop here is a stable reference or a primitive. `session` is the imperative
 *      engine object (created once per session), `actions` is AgentSurface's ref-backed
 *      dispatcher whose identity NEVER changes, and everything else is a string/boolean.
 *   2. The per-session closures `ChatPane` actually wants (`onResume`, `onModelChange`, …)
 *      are derived HERE, inside the memo, from `actions` + `session` — so they are created
 *      once per mounted pane rather than once per surface render.
 *
 * `ChatPane` itself keeps subscribing to its own session directly (see its `subscribe`
 * effect), so a real event in THIS conversation still re-renders it immediately. What the
 * memo removes is every render it was getting for somebody else's conversation.
 */

/** The surface-owned actions a chat pane can ask for. Session-scoped ones take the session
 *  (or its id) rather than being pre-bound per pane, so the whole object can be ONE stable
 *  identity shared by every mounted host. */
export interface ChatSurfaceActions {
  changeModel: (sid: string, id: string) => void;
  changeEffort: (sid: string, level: string) => void;
  /** chat→terminal: dispose and resume this conversation UUID as a terminal agent. */
  continueInTerminal: (cs: ChatSession) => void;
  /** State 12's "Session ended · Resume" — respawn the same UUID as a fresh chat. */
  resumeChat: (cs: ChatSession) => void;
  /** App-wide remembered permission-mode default (not per session — see AgentSurface). */
  changePermissionMode: (mode: 'auto' | 'bypass') => void;
  /** Re-brief this conversation's agent. A mode is a spawn-time system-prompt append, so
   *  this RESPAWNS the session under the new brief (same conversation UUID, transcript kept)
   *  rather than switching anything live — see AgentSurface's `changeChatMode`. */
  changeMode: (sid: string, mode: ChatMode) => void;
  /** Plan → Develop: open a NEW chat in Develop mode carrying `taskSlug`, then close the plan
   *  tab. Fired by a `develop` action button the plan agent wrote into its own message. */
  handoffToDevelop: (cs: ChatSession, taskSlug: string) => void;
  openAppPage: (page: 'tasks' | 'knowledge' | 'core', id: string) => void;
  signIn: () => void;
}

function ChatPaneHostInner({
  session, actions, modelConfig, model, effort, mode, automation, permissionMode, canSignInInApp,
  signInCommand,
}: {
  session: ChatSession;
  actions: ChatSurfaceActions;
  modelConfig: ModelConfig;
  model: string;
  effort: string;
  /** How this conversation's agent is briefed. A PRIMITIVE, like `model`/`effort` beside it,
   *  rather than read off `session` — the memo boundary's rule 1 (see this file's header) is
   *  that every prop is a stable reference or a primitive, and a mode CHANGE respawns the
   *  session anyway, so the surface is the honest owner of the current value. */
  mode: ChatMode;
  /** Set only when this conversation is an automation run reopened from its run history.
   *  Safe across the memo boundary because AgentSurface keeps ONE object per conversation
   *  uuid and never rewrites it (rule 1 above: stable references only). */
  automation?: AutomationRunRef;
  permissionMode: 'auto' | 'bypass';
  canSignInInApp: boolean;
  signInCommand: string;
}) {
  const onModelChange = useCallback((id: string) => actions.changeModel(session.id, id), [actions, session]);
  const onEffortChange = useCallback((level: string) => actions.changeEffort(session.id, level), [actions, session]);
  const onContinueInTerminal = useCallback(() => actions.continueInTerminal(session), [actions, session]);
  const onResume = useCallback(() => actions.resumeChat(session), [actions, session]);
  const onPermissionModeChange = useCallback(
    (next: 'auto' | 'bypass') => actions.changePermissionMode(next), [actions],
  );
  const onModeChange = useCallback((next: ChatMode) => actions.changeMode(session.id, next), [actions, session]);
  const onHandoffToDevelop = useCallback(
    (taskSlug: string) => actions.handoffToDevelop(session, taskSlug), [actions, session],
  );
  const onOpenAppPage = useCallback(
    (page: 'tasks' | 'knowledge' | 'core', id: string) => actions.openAppPage(page, id), [actions],
  );
  const onSignIn = useCallback(() => actions.signIn(), [actions]);

  return (
    <ChatPane
      session={session}
      modelConfig={modelConfig}
      model={model}
      effort={effort}
      onModelChange={onModelChange}
      onEffortChange={onEffortChange}
      onContinueInTerminal={onContinueInTerminal}
      permissionMode={permissionMode}
      onPermissionModeChange={onPermissionModeChange}
      mode={mode}
      onModeChange={onModeChange}
      onHandoffToDevelop={onHandoffToDevelop}
      onResume={onResume}
      automation={automation}
      onOpenAppPage={onOpenAppPage}
      onSignIn={onSignIn}
      canSignInInApp={canSignInInApp}
      signInCommand={signInCommand}
    />
  );
}

export const ChatPaneHost = memo(ChatPaneHostInner);
