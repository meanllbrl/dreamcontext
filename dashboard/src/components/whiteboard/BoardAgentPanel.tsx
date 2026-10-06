import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { AutomationSummary } from '../../hooks/useAutomations';
import { buildAppLink, routeAppLink } from '../../lib/appLink';
import { useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { AgentAvatar } from '../agents/AgentAvatar';
import { agentCardState } from './agentCardModel';
import {
  locateCard, registerPanelElement, setAgentPanelOpen, setPanelAgent, useDropTarget, type BoardCard,
} from './agentPanelState';
import { boardCardsAdopted, subscribeAdoption } from './boardAgentScratch';
import { useAgentSession, useBoardAgents } from './useBoardAgents';
import { AgentCardMenu, Blocked, CardChat, StateWord, stateText } from './widgets/AgentWidget';
import './BoardAgentPanel.css';

type Tx = (key: string, fallback: string) => string;

/**
 * The board's agents, in a panel on the right of the board (owner, 2026-10-05: "agent side
 * menu"; 2026-10-06: "card = identity, the conversation always in the panel"). It knows every
 * agent on the board: its home agents (whose manifest names the board) and every agent with a
 * card there, one avatar each along the top, each with ONE conversation on this board
 * (boardAgentScratch `homeCardId`). That conversation stays alive while the owner is on another
 * page: coming back shows it where it was. A card on the board is the agent's face: clicking it
 * opens the panel here, and Find its card points back at it.
 *
 * The panel is a drop target too: a board element dragged onto it lands as a chip in the shown
 * agent's composer (canvasGestures `dropOnAgentCard`).
 */
export function BoardAgentPanel({ board }: { board: string }) {
  const { t } = useI18n();
  const tx: Tx = (k, fallback) => { const v = t(k); return v === k ? fallback : v; };
  const { vault } = useVault();
  const { agents, agent, cards, isLoading } = useBoardAgents(board);
  const target = useDropTarget(vault, board);
  const dropping = target?.kind === 'panel';
  const close = () => setAgentPanelOpen(vault, false);
  const panelRef = useCallback((el: HTMLElement | null) => registerPanelElement(vault, el), [vault]);

  return (
    <aside
      ref={panelRef}
      className={`wb-agent-panel${dropping ? ' is-drop-target' : ''}`}
      aria-label={t('whiteboard.agentPanel.label')}
      data-agent={agent?.slug ?? ''}
    >
      <header className="wb-agent-panel-head">
        {agents.length > 0 ? (
          <div className="wb-agent-strip" role="tablist" aria-label={tx('whiteboard.agentPanel.agents', 'Agents on this board')}>
            {agents.map((a) => (
              <AgentTab
                key={a.slug}
                vault={vault}
                board={board}
                agent={a}
                selected={a.slug === agent?.slug}
                tx={tx}
              />
            ))}
          </div>
        ) : (
          <span className="wb-agent-panel-title">{t('whiteboard.agentPanel.title')}</span>
        )}
        <button type="button" className="wb-agent-panel-close" aria-label={t('whiteboard.agentPanel.close')} title={t('whiteboard.agentPanel.close')} onClick={close}>
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l6 6M9 3 3 9" />
          </svg>
        </button>
      </header>
      {agent && vault && (
        <PanelBar
          key={`${board}:${agent.slug}`}
          vault={vault}
          board={board}
          agent={agent}
          cards={cards.filter((c) => c.agent === agent.slug)}
          tx={tx}
        />
      )}
      <div className="wb-agent-panel-body" role="tabpanel">
        {agent && vault
          ? <PanelChat key={`${board}:${agent.slug}`} vault={vault} board={board} agent={agent} tx={tx} />
          : (
            <div className="wb-agent-idle">
              <p className="wb-agent-empty">
                {isLoading ? t('common.loading') : t('whiteboard.agentPanel.none')}
              </p>
            </div>
          )}
      </div>
      {dropping && agent && (
        <div className="wb-agent-drop-veil" aria-hidden="true">
          <span className="wb-agent-drop-label">
            {tx('whiteboard.agent.dropHere', 'Add to the chat with {name}').replace('{name}', agent.title)}
          </span>
          {target?.what && <span className="wb-agent-drop-what">{target.what}</span>}
        </div>
      )}
    </aside>
  );
}

/** One agent in the strip: its face and a dot for its state; a click shows its conversation. */
function AgentTab({ vault, board, agent, selected, tx }: {
  vault: string | null;
  board: string;
  agent: AutomationSummary;
  selected: boolean;
  tx: Tx;
}) {
  const { session } = useAgentSession(vault, board, agent);
  const state = agentCardState({ approved: agent.approved, busy: !!session?.busy, asking: !!session?.asking });
  const label = `${agent.title} · ${stateText(state, tx)}`;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={label}
      title={label}
      className={`wb-agent-tab${selected ? ' is-selected' : ''}`}
      data-agent={agent.slug}
      onClick={() => setPanelAgent(vault, board, agent.slug)}
    >
      <AgentAvatar slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={28} />
      <span className={`wb-agent-tab-dot wb-agent-tab-dot--${state.kind}`} aria-hidden="true" />
    </button>
  );
}

/** Under the strip: who the panel shows, its state, Find its card and the menu. */
function PanelBar({ vault, board, agent, cards, tx }: {
  vault: string;
  board: string;
  agent: AutomationSummary;
  cards: readonly BoardCard[];
  tx: Tx;
}) {
  const { session, open } = useAgentSession(vault, board, agent);
  const state = agentCardState({ approved: agent.approved, busy: !!session?.busy, asking: !!session?.asking });
  const openInAgents = () => { void routeAppLink(buildAppLink({ kind: 'automation', vault, slug: agent.slug, file: null })).catch(() => {}); };
  // An agent with several cards: each press points at the next one.
  const nextCard = useRef(0);
  const locate = () => {
    if (!cards.length) return;
    const card = cards[nextCard.current % cards.length]!;
    nextCard.current += 1;
    locateCard(vault, board, card.elementId);
  };
  const locateLabel = tx('whiteboard.agentPanel.locate', 'Find its card');
  return (
    <div className="wb-agent-panel-bar">
      <span className="wb-agent-panel-name" title={agent.title}>{agent.title}</span>
      <StateWord state={state} tx={tx} />
      <span className="wb-agent-panel-tools">
        {cards.length > 0 && (
          <button type="button" className="wb-agent-locate" onClick={locate} title={locateLabel}>
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
              <circle cx="7" cy="7" r="3.5" />
              <path d="M7 1v2.2M7 10.8V13M1 7h2.2M10.8 7H13" />
            </svg>
            <span>{locateLabel}</span>
          </button>
        )}
        <AgentCardMenu
          tx={tx}
          items={[
            { label: tx('whiteboard.agent.openInAgents', 'Open in Agents'), run: openInAgents },
            ...(agent.approved ? [{ label: tx('whiteboard.agent.newConversation', 'New conversation'), run: () => { open('new'); } }] : []),
          ]}
        />
      </span>
    </div>
  );
}

function PanelChat({ vault, board, agent, tx }: { vault: string; board: string; agent: AutomationSummary; tx: Tx }) {
  const { t } = useI18n();
  const { session, open } = useAgentSession(vault, board, agent);
  // Opening the panel on an agent is the activation: continue the live conversation, or resume
  // it. Not before the board's file is read: a card's conversation from before is handed to the
  // agent's board conversation first (adoptBoardCards), never shadowed by a fresh one.
  const adopted = useSyncExternalStore(subscribeAdoption, () => boardCardsAdopted(vault, board));
  useEffect(() => { if (!session && agent.approved && adopted) open(); }, [session, agent.approved, adopted, open]);
  if (!agent.approved) {
    const review = () => { void routeAppLink(buildAppLink({ kind: 'automation', vault, slug: agent.slug, file: null })).catch(() => {}); };
    return <Blocked agent={agent} onReview={review} tx={tx} />;
  }
  if (!session) return <div className="wb-agent-idle"><p className="wb-agent-empty">{t('common.loading')}</p></div>;
  return (
    <CardChat
      session={session}
      reopen={() => open('resume')}
      placeholder={tx('whiteboard.agent.placeholder', 'Message {name}…').replace('{name}', agent.title)}
    />
  );
}
