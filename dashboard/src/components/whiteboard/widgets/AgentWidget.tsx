import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAgents, findAgent, type AgentSummary } from '../../../hooks/useAgents';
import { useAgentModelConfig } from '../../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../../lib/agentComposer';
import { requestOpenAgents } from '../../../lib/openAgents';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { ChatPaneHost, type ChatSurfaceActions } from '../../sleepy/ChatPaneHost';
import type { ChatSession } from '../../sleepy/chatSession';
import { isValidRefFor } from '../widgetModel';
import { useWbText } from '../whiteboardHost';
import { oneLine, type AgentCardState } from '../agentCardModel';
import { WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';
import type { ChatFeed } from '../../sleepy/chat/chatFeed';
import './agentWidget.css';

type Tx = (key: string, fallback: string) => string;

/**
 * An agent on the board (`agent` widget, ref = the agent slug): the agent's face. It shows who
 * the agent is and whether it is approved; a click opens the member's own conversation (its AI
 * Team stage). The board's separate agent panel is gone (owner, 2026-11-18), and with it the
 * board's own conversation with the agent: the card shows no lines or live state of its own,
 * since nothing on the board feeds them any more (the screen tells the truth). The board's own
 * writing field (Quick edit, Ask Super) is where the board is worked on.
 *
 * WHO the card names is the agent roster's (`/api/agents`), the list Chat reads: an agent only
 * talked to has no automation, and its card must still find it. Editing who it is happens on
 * its own Agents page, so the card's menu opens that page rather than a dialog of its own.
 */
export function AgentWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const slug = isValidRefFor('agent', payload.ref) ? payload.ref : null;
  const { data: roster, isLoading } = useAgents();
  const agent = useMemo(() => findAgent(roster, slug), [roster, slug]);
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
  return <AgentCard key={agent.slug} agent={agent} active={active} size={size} tx={tx} />;
}

function AgentCard({ agent, active, size, tx }: {
  agent: AgentSummary;
  active: boolean;
  size: WidgetProps['size'];
  tx: Tx;
}) {
  const slug = agent.slug;

  // ── menu ────────────────────────────────────────────────────────────────────────────────────
  // Talking, editing, review and approval all live on the member's own stage: the card sends you there.
  const openInAgents = useCallback(() => requestOpenAgents({ slug }), [slug]);
  const talk = openInAgents;

  const menu = (
    <AgentCardMenu
      tx={tx}
      items={[{ label: tx('whiteboard.agent.openInAgents', 'Open in Agents'), run: openInAgents }]}
    />
  );

  const small = size === 's';
  let body: ReactNode;
  if (!agent.approvedForChat && !small) {
    body = <Blocked agent={agent} onReview={openInAgents} tx={tx} />;
  } else {
    body = (
      <div
        className="wb-agent-face"
        role="button"
        tabIndex={0}
        aria-label={tx('whiteboard.agent.talkTo', 'Talk to {name}').replace('{name}', agent.title)}
        onClick={talk}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); talk(); } }}
      >
        <div className="wb-agent-who">
          <AgentAvatar slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={small ? 28 : 44} of="agent" />
          <span className="wb-agent-who-text">
            {!small && agent.description && <span className="wb-agent-about">{oneLine(agent.description, 200)}</span>}
          </span>
        </div>
        {!small && (
          <div className="wb-agent-hint">
            {tx('whiteboard.agent.clickHint', 'Click to talk')}
          </div>
        )}
      </div>
    );
  }

  const classes = ['wb-agent', `wb-agent--${size}`];
  return (
    <WidgetFrame
      kind="agent"
      label={agent.title}
      title=""
      active={active}
      size={size}
      meta={agent.approvedForChat ? undefined : <StateWord state={{ kind: 'unapproved' }} tx={tx} />}
      actions={menu}
    >
      <div className={classes.join(' ')} data-agent={slug}>
        {body}
      </div>
    </WidgetFrame>
  );
}

/** The hosts showing each session, newest last. A session has ONE container, so one host draws
 *  it: the newest (the Super stage's team card over a kept-alive AI Team page); when it goes, the
 *  one before takes the container back. */
const hostClaims = new Map<ChatSession, symbol[]>();
const claimListeners = new Set<() => void>();
const subscribeClaims = (fn: () => void) => { claimListeners.add(fn); return () => { claimListeners.delete(fn); }; };
function useHostClaim(session: ChatSession): boolean {
  const [me] = useState(() => Symbol('host'));
  useLayoutEffect(() => {
    hostClaims.set(session, [...(hostClaims.get(session) ?? []), me]);
    for (const fn of [...claimListeners]) fn();
    return () => {
      const rest = (hostClaims.get(session) ?? []).filter((x) => x !== me);
      if (rest.length) hostClaims.set(session, rest); else hostClaims.delete(session);
      for (const fn of [...claimListeners]) fn();
    };
  }, [session, me]);
  return useSyncExternalStore(subscribeClaims, () => hostClaims.get(session)?.at(-1) === me);
}

/**
 * The card's chat: the session's detached container homed in the card, and the chat pane
 * portaled into it (the notch's own mount). `bare`: the agent's envelope is the server's to
 * decide, so the composer offers no mode, permission or model switch.
 */
export function CardChat({ session, reopen, placeholder, pane = false, feed, aboveComposer, sendVia, readOnly, openPage }: {
  /** Where a page link goes when there is no surface around this chat (an app's frame). */
  openPage?: (page: string, id?: string | null) => void;
  session: ChatSession;
  reopen: () => void;
  placeholder: string;
  /** The agent's past sessions above the conversation (the AI Team stage). */
  feed?: ChatFeed;
  /** Drawn over the box (the AI Team stage: open questions, the run it continues). */
  aboveComposer?: ReactNode;
  /** The stage's box writes into a pinned run instead of this session. */
  sendVia?: (message: string) => boolean;
  /** No box at all: a member this machine reads and does not talk to. */
  readOnly?: 'silent';
  /** The full Chat pane (the AI Team page's conversation), not a board card's slim one: only the
   *  controls that cannot reach an agent-bound session stay out (ChatPane `agentBound`). */
  pane?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const owns = useHostClaim(session);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!owns) return undefined;
    if (el && session.container.parentElement !== el) el.appendChild(session.container);
    // Hand the container back on the way out, so the next host never finds it held here.
    return () => { if (el && session.container.parentElement === el) el.removeChild(session.container); };
  }, [session, owns]);

  const reopenRef = useRef(reopen);
  reopenRef.current = reopen;
  const openPageRef = useRef(openPage);
  openPageRef.current = openPage;
  const actions = useMemo<ChatSurfaceActions>(() => ({
    changeModel: (_sid, id) => session.setModel(id),
    changeEffort: (_sid, level) => session.setEffort(level),
    continueInTerminal: () => { /* a card has no terminal */ },
    resumeChat: () => reopenRef.current(),
    changePermissionMode: () => { /* fixed by the server for a card */ },
    changeMode: () => { /* a card speaks as its agent */ },
    changeAccount: () => { /* follows the default account */ },
    handoffToDevelop: () => { /* a card does not hand off */ },
    openAppPage: (page: string, id?: string | null) => { openPageRef.current?.(page, id); },
    signIn: async () => { /* sign in from a project chat */ },
  }), [session]);

  return (
    <div className={pane ? 'agent-chat-pane-host' : 'wb-agent-chat'} ref={hostRef}>
      {owns && createPortal(
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
          bare={!pane}
          agentBound={pane}
          idlePlaceholder={placeholder}
          feed={feed}
          aboveComposer={aboveComposer}
          sendVia={sendVia}
          readOnly={readOnly}
        />,
        session.container,
      )}
    </div>
  );
}

/** The state's one word, for the card's header. */
export function stateText(state: AgentCardState, tx: Tx): string {
  switch (state.kind) {
    case 'working': return tx('whiteboard.agent.workingNow', 'Working');
    case 'needs-you': return tx('whiteboard.agent.needsYou', 'Needs you');
    case 'unapproved': return tx('whiteboard.agent.unapproved', 'Not approved');
    default: return tx('whiteboard.agent.idle', 'Idle');
  }
}

export function StateWord({ state, tx }: { state: AgentCardState; tx: Tx }) {
  return <span className={`wb-agent-state wb-agent-state--${state.kind}`}>{stateText(state, tx)}</span>;
}

/** An unapproved agent: the server would refuse its card, so the reason and the one control
 *  that fixes it, in place of a chat. */
export function Blocked({ agent, onReview, tx }: { agent: Pick<AgentSummary, 'title'>; onReview: () => void; tx: Tx }) {
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

export function AgentCardMenu({ items, tx }: { items: { label: string; run: () => void }[]; tx: Tx }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLSpanElement>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);
  // ↑/↓ (and Home/End) walk the items, as a menu does.
  const onListKey = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
    const entries = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (!entries.length) return;
    const at = entries.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % entries.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + entries.length) % entries.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = entries.length - 1;
    else if (e.key === 'Tab') { close(false); return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
    entries[next]?.focus();
  };
  const label = tx('whiteboard.agent.menu', 'Agent actions');
  return (
    <span className="wb-agent-menu" ref={wrap}>
      <button
        ref={button}
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
        <span className="wb-agent-menu-list" role="menu" aria-label={label} ref={list} onKeyDown={onListKey}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="wb-agent-menu-item"
              onClick={() => { close(true); it.run(); }}
            >
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
