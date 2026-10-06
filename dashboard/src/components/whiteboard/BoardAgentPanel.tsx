import { useCallback, useEffect, useMemo, useReducer, useSyncExternalStore } from 'react';
import { useAutomations, type AutomationSummary } from '../../hooks/useAutomations';
import { readAgentSettings } from '../../lib/agentSettings';
import { buildAppLink, routeAppLink } from '../../lib/appLink';
import { useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { AgentAvatar } from '../agents/AgentAvatar';
import type { ChatSession } from '../sleepy/chatSession';
import { agentCardState } from './agentCardModel';
import { homeAgentsOf, panelAgentOf, setAgentPanelOpen, setPanelAgent, usePanelPick } from './agentPanelState';
import {
  boardCardsAdopted, homeCardId, openCardSession, peekCardSession, subscribeCardSession, subscribeHomeCards, type CardSpec,
} from './boardAgentScratch';
import { AgentCardMenu, Blocked, CardChat, StateWord } from './widgets/AgentWidget';
import './BoardAgentPanel.css';

/**
 * The board's agent, in a panel on the right of the board (owner, 2026-10-05: "agent side
 * menu"). It is the board's HOME agent (the one whose manifest names this board), in the same
 * conversation as its card on the canvas (boardAgentScratch `homeCardId`), and that
 * conversation stays alive while the owner is on another page: coming back shows it where it
 * was. Switching boards switches to that board's agent. A board with several home agents gets
 * a picker; one with none says how to add one.
 */
export function BoardAgentPanel({ board }: { board: string }) {
  const { t } = useI18n();
  const { vault } = useVault();
  const { data: automations, isLoading } = useAutomations();
  const agents = useMemo(() => homeAgentsOf(automations, board), [automations, board]);
  const agent = panelAgentOf(agents, usePanelPick(vault, board));
  const close = () => setAgentPanelOpen(vault, false);

  return (
    <aside className="wb-agent-panel" aria-label={t('whiteboard.agentPanel.label')}>
      <header className="wb-agent-panel-head">
        {agent && <AgentAvatar slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={24} />}
        {agents.length > 1 ? (
          <select
            className="wb-agent-panel-pick"
            value={agent?.slug ?? ''}
            aria-label={t('whiteboard.agentPanel.pick')}
            onChange={(e) => setPanelAgent(vault, board, e.target.value)}
          >
            {agents.map((a) => <option key={a.slug} value={a.slug}>{a.title}</option>)}
          </select>
        ) : (
          <span className="wb-agent-panel-title">{agent?.title ?? t('whiteboard.agentPanel.title')}</span>
        )}
        {agent && vault && <PanelControls key={`${board}:${agent.slug}`} vault={vault} board={board} agent={agent} />}
        <button type="button" className="wb-agent-panel-close" aria-label={t('whiteboard.agentPanel.close')} title={t('whiteboard.agentPanel.close')} onClick={close}>
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l6 6M9 3 3 9" />
          </svg>
        </button>
      </header>
      <div className="wb-agent-panel-body">
        {agent && vault
          ? <PanelChat key={`${board}:${agent.slug}`} vault={vault} board={board} agent={agent} />
          : (
            <div className="wb-agent-idle">
              <p className="wb-agent-empty">
                {isLoading ? t('common.loading') : t('whiteboard.agentPanel.none')}
              </p>
            </div>
          )}
      </div>
    </aside>
  );
}

function useHomeSession(vault: string, board: string, agent: AutomationSummary) {
  const spec = useMemo<CardSpec>(() => ({ vault, board, elementId: homeCardId(agent.slug) }), [vault, board, agent.slug]);
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeCardSession(spec, force), [spec]);
  const session = peekCardSession(spec);
  useEffect(() => (session ? session.subscribe(force) : undefined), [session]);
  const open = useCallback((how: 'continue' | 'new' | 'resume' = 'continue'): ChatSession | null => {
    if (!agent.approved) return null;
    const { chatDefaultModel: model, chatDefaultEffort: effort } = readAgentSettings();
    return openCardSession({ ...spec, agent: agent.slug, model, effort }, how);
  }, [spec, agent.approved, agent.slug]);
  return { session, open };
}

function PanelControls({ vault, board, agent }: { vault: string; board: string; agent: AutomationSummary }) {
  const { t } = useI18n();
  const { session, open } = useHomeSession(vault, board, agent);
  const state = agentCardState({ approved: agent.approved, busy: !!session?.busy, asking: !!session?.asking });
  const tx = (key: string, fallback: string) => { const v = t(key); return v === key ? fallback : v; };
  const openInAgents = () => { void routeAppLink(buildAppLink({ kind: 'automation', vault, slug: agent.slug, file: null })).catch(() => {}); };
  return (
    <>
      <StateWord state={state} tx={tx} />
      <AgentCardMenu
        tx={tx}
        items={[
          { label: tx('whiteboard.agent.openInAgents', 'Open in Agents'), run: openInAgents },
          ...(agent.approved ? [{ label: tx('whiteboard.agent.newConversation', 'New conversation'), run: () => { open('new'); } }] : []),
        ]}
      />
    </>
  );
}

function PanelChat({ vault, board, agent }: { vault: string; board: string; agent: AutomationSummary }) {
  const { t } = useI18n();
  const { session, open } = useHomeSession(vault, board, agent);
  const tx = (key: string, fallback: string) => { const v = t(key); return v === key ? fallback : v; };
  // Opening the panel is the activation: continue the live conversation, or resume it. Not
  // before the board's file is read: a card's conversation from before the panel is handed
  // to the home one first (adoptBoardCards), never shadowed by a fresh one.
  const adopted = useSyncExternalStore(subscribeHomeCards, () => boardCardsAdopted(vault, board));
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
