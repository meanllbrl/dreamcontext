import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useAutomations, type AutomationSummary } from '../../../hooks/useAutomations';
import { useAgentModelConfig } from '../../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../../lib/agentComposer';
import { buildAppLink, routeAppLink } from '../../../lib/appLink';
import { useApi, useVault } from '../../../context/VaultContext';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { AgentDialog } from '../../agents/AgentDialog';
import { ChatPaneHost, type ChatSurfaceActions } from '../../sleepy/ChatPaneHost';
import type { ChatSession } from '../../sleepy/chatSession';
import { isValidRefFor } from '../widgetModel';
import { useWbText, useWhiteboardHost } from '../whiteboardHost';
import { agentCardState, lastLines, lineOpacity, oneLine, type AgentCardState, type CardItem, type SaidLine } from '../agentCardModel';
import { cardConversationId, type CardSpec } from '../boardAgentScratch';
import { showAgentInPanel, useAgentPanelOpen, useCardFlash, useDropTarget } from '../agentPanelState';
import { useAgentSession, useBoardAgents } from '../useBoardAgents';
import { WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';
import './agentWidget.css';

type Tx = (key: string, fallback: string) => string;

/**
 * An agent on the board (`agent` widget, ref = the automation slug): the agent's face (owner,
 * 2026-10-06: "card = identity, the conversation always in the panel"). It shows who the agent
 * is, its live state and the last lines of its conversation on this board, read-only; a click
 * opens the board's agent panel on it, where the conversation is (BoardAgentPanel.tsx). The card
 * the panel shows is marked, and the panel's Find its card flashes it.
 *
 * The conversation is the agent's ONE on this board (boardAgentScratch `homeCardId`), a
 * Chat-bridge session the panel opens, never the automation's thread. The card never opens it:
 * while none is live, its lines come from the remembered transcript on disk.
 *
 * A board element dragged over the card says where it will go; dropped, it lands as a chip in
 * the panel's composer for this agent (canvasGestures `dropOnAgentCard`).
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
  // The agent's one conversation on this board, the panel's: the card only reads it.
  const { spec, session, open } = useAgentSession(vault, board, agent);
  const lines = useCardLines(spec, session);
  const state = agentCardState({ approved: agent.approved, busy: !!session?.busy, asking: !!session?.asking });
  const panelOpen = useAgentPanelOpen(vault);
  const { agent: shown } = useBoardAgents(board);
  const inPanel = panelOpen && shown?.slug === slug;
  const target = useDropTarget(vault, board);
  const dropping = target?.kind === 'card' && target.elementId === elementId;
  const flashing = useCardFlash(vault, board, elementId);
  const talk = () => showAgentInPanel(vault, board, slug);

  // ── menu and dialog ─────────────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const openInAgents = useCallback(() => {
    const failed = () => host.toast(tx('whiteboard.agent.openFailed', 'Could not open the Agents page.'));
    if (!vault) { failed(); return; }
    void routeAppLink(buildAppLink({ kind: 'automation', vault, slug, file: null })).catch(failed);
  }, [vault, slug, host, tx]);
  const newConversation = useCallback(() => {
    showAgentInPanel(vault, board, slug);
    if (open('new')) host.toast(tx('whiteboard.agent.newConversationStarted', 'New conversation started.'));
  }, [vault, board, slug, open, host, tx]);

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

  const small = size === 's';
  let body: ReactNode;
  if (!agent.approved && !small) {
    body = <Blocked agent={agent} onReview={openInAgents} tx={tx} />;
  } else {
    body = (
      <div
        className="wb-agent-face"
        role="button"
        tabIndex={0}
        aria-label={tx('whiteboard.agent.talk', 'Talk to {name} in the panel').replace('{name}', agent.title)}
        onClick={talk}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); talk(); } }}
      >
        <div className="wb-agent-who">
          <AgentAvatar slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={small ? 28 : 44} />
          <span className="wb-agent-who-text">
            {inPanel
              ? <span className="wb-agent-in-panel">{tx('whiteboard.agent.inPanelMark', 'Open in the panel')}</span>
              : agent.cadenceLabel && <span className="wb-agent-cadence">{agent.cadenceLabel}</span>}
            {!small && agent.description && <span className="wb-agent-about">{oneLine(agent.description, 200)}</span>}
          </span>
        </div>
        <CardLines lines={small ? lines.slice(-1) : lines} name={agent.title} tx={tx} />
        {!small && (
          <div className="wb-agent-dropzone">
            {tx('whiteboard.agent.openHint', 'Drop here · Click to talk')}
          </div>
        )}
      </div>
    );
  }

  const classes = ['wb-agent', `wb-agent--${size}`];
  if (inPanel) classes.push('is-in-panel');
  if (dropping) classes.push('is-drop-target');
  if (flashing) classes.push('is-flashing');
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
      <div className={classes.join(' ')} data-agent={slug}>
        {body}
        {dropping && (
          <div className="wb-agent-drop-veil" aria-hidden="true">
            <span className="wb-agent-drop-label">
              {tx('whiteboard.agent.dropHere', 'Add to the chat with {name}').replace('{name}', agent.title)}
            </span>
            {target?.what && <span className="wb-agent-drop-what">{target.what}</span>}
          </div>
        )}
      </div>
      {editing && createPortal(
        <AgentDialog agent={agent} onClose={() => setEditing(false)} onToast={host.toast} />,
        document.body,
      )}
    </WidgetFrame>
  );
}

/** How many lines of the conversation the card shows. */
const CARD_LINES = 6;

/**
 * The conversation's last lines, read-only: the live session's while one is open, else the
 * remembered conversation's transcript (read from disk, no `claude` started for it), else none.
 */
function useCardLines(spec: CardSpec | null, session: ChatSession | null): SaidLine[] {
  const api = useApi();
  const remembered = spec && !session ? cardConversationId(spec) : null;
  const history = useQuery({
    queryKey: ['wb-agent-lines', spec?.vault, remembered],
    queryFn: async () => {
      const r = await api.get<{ items: CardItem[] }>(`/agent/chat-history?claudeId=${encodeURIComponent(remembered!)}`);
      return Array.isArray(r?.items) ? r.items : [];
    },
    enabled: !!remembered,
    staleTime: 15_000,
  });
  const items = session ? session.getModel().items : history.data ?? [];
  return lastLines(items, CARD_LINES);
}

function CardLines({ lines, name, tx }: { lines: readonly SaidLine[]; name: string; tx: Tx }) {
  // Read top-down from under the agent's name; when the lines outgrow the card, the newest stay
  // in view and the oldest go under a fade.
  const listRef = useRef<HTMLOListElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setClipped(el.scrollHeight > el.clientHeight + 1);
  });
  if (!lines.length) {
    return <p className="wb-agent-empty wb-agent-lines-empty">{tx('whiteboard.agent.noLines', 'No conversation yet. Click to start one in the panel.')}</p>;
  }
  const you = tx('whiteboard.agent.you', 'You');
  return (
    <ol ref={listRef} className={`wb-agent-lines${clipped ? ' is-clipped' : ''}`} aria-label={tx('whiteboard.agent.lastLines', 'Last lines')}>
      {lines.map((line, i) => (
        <li
          key={i}
          className={`wb-agent-line wb-agent-line--${line.who}`}
          style={{ opacity: lineOpacity(i, lines.length) }}
        >
          <span className="wb-agent-line-who">{line.who === 'you' ? you : name}</span>
          <span className="wb-agent-line-text">{oneLine(line.text, 280)}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The card's chat: the session's detached container homed in the card, and the chat pane
 * portaled into it (the notch's own mount). `bare`: the agent's envelope is the server's to
 * decide, so the composer offers no mode, permission or model switch.
 */
export function CardChat({ session, reopen, placeholder }: { session: ChatSession; reopen: () => void; placeholder: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (el && session.container.parentElement !== el) el.appendChild(session.container);
    // Hand the container back on the way out, so the next host never finds it held here.
    return () => { if (el && session.container.parentElement === el) el.removeChild(session.container); };
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

/** The state's one word, for the header and the panel's strip. */
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
export function Blocked({ agent, onReview, tx }: { agent: AutomationSummary; onReview: () => void; tx: Tx }) {
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
