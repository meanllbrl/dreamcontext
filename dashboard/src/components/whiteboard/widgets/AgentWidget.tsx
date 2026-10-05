import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAutomations, type AutomationSummary } from '../../../hooks/useAutomations';
import { useAgentModelConfig } from '../../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../../lib/agentComposer';
import { readAgentSettings } from '../../../lib/agentSettings';
import { buildAppLink, routeAppLink } from '../../../lib/appLink';
import { useVault } from '../../../context/VaultContext';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { AgentDialog } from '../../agents/AgentDialog';
import { ChatPaneHost, type ChatSurfaceActions } from '../../sleepy/ChatPaneHost';
import type { ChatSession } from '../../sleepy/chatSession';
import { isValidRefFor } from '../widgetModel';
import { useWbText, useWhiteboardHost } from '../whiteboardHost';
import { agentCardState, lastSaid, oneLine, type AgentCardState } from '../agentCardModel';
import {
  cardHasConversation, openCardSession, peekCardSession, subscribeCardSession, type CardSpec,
} from '../boardAgentScratch';
import { WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';
import './agentWidget.css';

type Tx = (key: string, fallback: string) => string;

/**
 * An agent on the board (`agent` widget, ref = the automation slug): a conversation of the
 * board's own with that agent, like the notch Assistant (owner, 2026-10-05).
 *
 * The card is a Chat-bridge session opened with the card's agent and board
 * (boardAgentScratch.ts `openCardSession`), never the automation's thread: nothing said here
 * reaches the Agents channel. The server gives it the agent's approved identity and, for a
 * home-board agent, its board scope; every message reaches the agent with the board's current
 * content beside it (lib/whiteboards/card-chat.ts). New conversation starts a fresh session.
 *
 * The session opens on the card's first activation, never on board open: one `claude` process
 * per card on every board visit would be the cost. S shows who it is, its state and the last
 * thing said; M and up the chat itself, from the chat's own atoms (ChatPaneHost).
 *
 * Typing in the composer never reaches Excalidraw's tool shortcuts: its field is a textarea, and
 * Excalidraw's own key handler returns early for one.
 */
export function AgentWidget({ elementId, payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const host = useWhiteboardHost();
  const slug = isValidRefFor('agent', payload.ref) ? payload.ref : null;
  const { data: automations, isLoading } = useAutomations();
  const agent = useMemo(() => (automations ?? []).find((a) => a.slug === slug) ?? null, [automations, slug]);
  const fallbackTitle = payload.title || slug || tx('whiteboard.kind.agent', 'Agent');

  if (!slug) {
    return (
      <WidgetFrame kind="agent" title={fallbackTitle} active={active} size={size}>
        <WidgetNotice tone="missing">{tx('whiteboard.widget.badRef', 'This widget has no valid reference.')}</WidgetNotice>
      </WidgetFrame>
    );
  }
  if (!agent) {
    return (
      <WidgetFrame kind="agent" title={fallbackTitle} active={active} size={size}>
        {isLoading
          ? <WidgetNotice tone="loading">{tx('whiteboard.agent.loading', 'Loading the agent…')}</WidgetNotice>
          : (
            <WidgetNotice tone="missing">
              {tx('whiteboard.agent.missing', 'No agent named {slug} in this project. Removing this card never deletes an agent.').replace('{slug}', slug)}
            </WidgetNotice>
          )}
      </WidgetFrame>
    );
  }
  return <AgentCard key={agent.slug} elementId={elementId} agent={agent} active={active} size={size} board={host.boardSlug} tx={tx} />;
}

function AgentCard({ elementId, agent, active, size, board, tx }: {
  elementId: string;
  agent: AutomationSummary;
  active: boolean;
  size: WidgetProps['size'];
  board: string | undefined;
  tx: Tx;
}) {
  const host = useWhiteboardHost();
  const { vault } = useVault();
  const slug = agent.slug;
  const spec = useMemo<CardSpec | null>(
    () => (vault && board ? { vault, board, elementId } : null),
    [vault, board, elementId],
  );

  // The card's session, from the module store: it outlives this component (Excalidraw remounts
  // an embeddable on every scroll), so the component only listens to it.
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (spec ? subscribeCardSession(spec, force) : undefined), [spec]);
  const session = spec ? peekCardSession(spec) : null;
  useEffect(() => (session ? session.subscribe(force) : undefined), [session]);

  const open = useCallback((how: 'continue' | 'new' | 'resume' = 'continue'): ChatSession | null => {
    if (!spec || !agent.approved) return null;
    const { chatDefaultModel: model, chatDefaultEffort: effort } = readAgentSettings();
    return openCardSession({ ...spec, agent: slug, model, effort }, how);
  }, [spec, agent.approved, slug]);

  // Lazy: the first activation of an M+ card opens (or resumes) its conversation.
  const small = size === 's';
  useEffect(() => {
    if (active && !small && !session) open();
  }, [active, small, session, open]);

  const state = agentCardState({ approved: agent.approved, busy: !!session?.busy, asking: !!session?.asking });

  // ── menu and dialog ─────────────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const openInAgents = useCallback(() => {
    const failed = () => host.toast(tx('whiteboard.agent.openFailed', 'Could not open the Agents page.'));
    if (!vault) { failed(); return; }
    void routeAppLink(buildAppLink({ kind: 'automation', vault, slug, file: null })).catch(failed);
  }, [vault, slug, host, tx]);
  const newConversation = useCallback(() => {
    if (open('new')) host.toast(tx('whiteboard.agent.newConversationStarted', 'New conversation started.'));
  }, [open, host, tx]);

  const menu = (
    <AgentCardMenu
      tx={tx}
      items={[
        { label: tx('whiteboard.agent.edit', 'Edit agent'), run: () => setEditing(true) },
        { label: tx('whiteboard.agent.openInAgents', 'Open in Agents'), run: openInAgents },
        ...(agent.approved
          ? [{ label: tx('whiteboard.agent.newConversation', 'New conversation'), run: newConversation }]
          : []),
      ]}
    />
  );

  let body: ReactNode;
  if (small) {
    body = <SmallBody agent={agent} session={session} tx={tx} />;
  } else if (!agent.approved) {
    body = <Blocked agent={agent} onReview={openInAgents} tx={tx} />;
  } else if (!session || !spec) {
    body = (
      <div className="wb-agent-idle">
        <AgentAvatar slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={32} />
        <p className="wb-agent-empty">
          {(spec && cardHasConversation(spec)
            ? tx('whiteboard.agent.continueHint', 'Click to continue your conversation with {name}.')
            : tx('whiteboard.agent.startHint', 'Click to talk to {name} about this board.')).replace('{name}', agent.title)}
        </p>
      </div>
    );
  } else {
    body = (
      <CardChat
        session={session}
        reopen={() => open('resume')}
        placeholder={tx('whiteboard.agent.placeholder', 'Message {name}…').replace('{name}', agent.title)}
      />
    );
  }

  return (
    <WidgetFrame
      kind="agent"
      label={agent.title}
      title=""
      active={active}
      size={size}
      meta={<StateWord state={state} tx={tx} />}
      actions={menu}
    >
      <div className={`wb-agent wb-agent--${size}`}>{body}</div>
      {editing && createPortal(
        <AgentDialog agent={agent} onClose={() => setEditing(false)} onToast={host.toast} />,
        document.body,
      )}
    </WidgetFrame>
  );
}

/**
 * The card's chat: the session's detached container homed in the card, and the chat pane
 * portaled into it (the notch's own mount). `bare`: the agent's envelope is the server's to
 * decide, so the composer offers no mode, permission or model switch.
 */
function CardChat({ session, reopen, placeholder }: { session: ChatSession; reopen: () => void; placeholder: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (el && session.container.parentElement !== el) el.appendChild(session.container);
  }, [session]);

  const reopenRef = useRef(reopen);
  reopenRef.current = reopen;
  const actions = useMemo<ChatSurfaceActions>(() => ({
    changeModel: (_sid, id) => session.setModel(id),
    changeEffort: (_sid, level) => session.setEffort(level),
    continueInTerminal: () => { /* a card has no terminal */ },
    resumeChat: () => reopenRef.current(),
    changePermissionMode: () => { /* fixed by the server for a card */ },
    changeMode: () => { /* a card speaks as its agent */ },
    changeAccount: () => { /* follows the default account */ },
    handoffToDevelop: () => { /* a card does not hand off */ },
    openAppPage: () => { /* opened from the Agents page or the tab */ },
    signIn: async () => { /* sign in from a project chat */ },
  }), [session]);

  return (
    <div className="wb-agent-chat" ref={hostRef}>
      {createPortal(
        <ChatPaneHost
          session={session}
          actions={actions}
          modelConfig={modelConfig}
          model={session.model || modelConfig.defaultModel}
          effort={session.effort || modelConfig.defaultEffort}
          mode={session.mode}
          permissionMode="auto"
          canSignInInApp={false}
          signInCommand="claude auth login"
          bare
          idlePlaceholder={placeholder}
        />,
        session.container,
      )}
    </div>
  );
}

function StateWord({ state, tx }: { state: AgentCardState; tx: Tx }) {
  let text: string;
  switch (state.kind) {
    case 'working': text = tx('whiteboard.agent.workingNow', 'Working'); break;
    case 'needs-you': text = tx('whiteboard.agent.needsYou', 'Needs you'); break;
    case 'unapproved': text = tx('whiteboard.agent.unapproved', 'Not approved'); break;
    default: text = tx('whiteboard.agent.idle', 'Idle');
  }
  return <span className={`wb-agent-state wb-agent-state--${state.kind}`}>{text}</span>;
}

function SmallBody({ agent, session, tx }: { agent: AutomationSummary; session: ChatSession | null; tx: Tx }) {
  const line = session ? lastSaid(session.getModel().items) : null;
  return (
    <div className="wb-agent-small">
      <AgentAvatar slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={32} />
      <p className="wb-agent-small-line">
        {line
          ? `${line.who === 'you' ? `${tx('whiteboard.agent.you', 'You')}: ` : ''}${oneLine(line.text)}`
          : tx('whiteboard.agent.emptySmall', 'No messages yet.')}
      </p>
    </div>
  );
}

/** An unapproved agent: the server would refuse its card, so the reason and the one control
 *  that fixes it, in place of a chat. */
function Blocked({ agent, onReview, tx }: { agent: AutomationSummary; onReview: () => void; tx: Tx }) {
  return (
    <p className="wb-agent-blocked">
      <span>
        {tx('whiteboard.agent.blockedUnapproved', '{name} is not approved on this machine yet.').replace('{name}', agent.title)}
      </span>
      <button type="button" className="wb-widget-btn" onClick={onReview}>
        {tx('whiteboard.agent.review', 'Review in Agents')}
      </button>
    </p>
  );
}

function AgentCardMenu({ items, tx }: { items: { label: string; run: () => void }[]; tx: Tx }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const label = tx('whiteboard.agent.menu', 'Agent actions');
  return (
    <span className="wb-agent-menu" ref={wrap}>
      <button
        type="button"
        className="wb-widget-btn wb-agent-menu-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <span className="wb-agent-menu-list" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="wb-agent-menu-item"
              onClick={() => { setOpen(false); it.run(); }}
            >
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
