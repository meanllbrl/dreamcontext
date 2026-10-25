import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useAgents, type AgentSummary } from '../../hooks/useAgents';
import { readAgentSettings } from '../../lib/agentSettings';
import { useVault } from '../../context/VaultContext';
import type { ChatSession } from '../sleepy/chatSession';
import { boardAgentsOf, panelAgentOf, useBoardCards, usePanelPick, type BoardCard } from './agentPanelState';
import { homeCardId, openCardSession, peekCardSession, subscribeCardSession, type CardSpec } from './boardAgentScratch';

/**
 * Every agent on `board` (home agents and agents with a card), and the one the panel shows.
 * Read from the agent roster (`/api/agents`), the same list Chat's picker reads: an agent you
 * only talk to has no automation, and a board must still know its face.
 */
export function useBoardAgents(board: string | undefined): {
  agents: AgentSummary[];
  agent: AgentSummary | null;
  cards: readonly BoardCard[];
  isLoading: boolean;
} {
  const { vault } = useVault();
  const { data: roster, isLoading } = useAgents();
  const cards = useBoardCards(vault, board);
  // The panel talks only to agents this machine may talk to: a teammate's is read-only (B1-4).
  const own = useMemo(() => roster?.filter((a) => !a.readOnly), [roster]);
  const agents = useMemo(() => (board ? boardAgentsOf(own, board, cards) : []), [own, board, cards]);
  const agent = panelAgentOf(agents, usePanelPick(vault, board));
  return { agents, agent, cards, isLoading };
}

/**
 * An agent's conversation on a board, as the panel and its cards read it: the live session (or
 * null before the panel first opens it) and the open. Only the panel opens; a card listens.
 */
export function useAgentSession(vault: string | null, board: string | undefined, agent: AgentSummary | null) {
  const spec = useMemo<CardSpec | null>(
    () => (vault && board && agent ? { vault, board, elementId: homeCardId(agent.slug) } : null),
    [vault, board, agent?.slug], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (spec ? subscribeCardSession(spec, force) : undefined), [spec]);
  const session = spec ? peekCardSession(spec) : null;
  useEffect(() => (session ? session.subscribe(force) : undefined), [session]);
  // Card chat is CONVERSATION, so the chat verdict gates it, never the run one.
  const approved = !!agent?.approvedForChat;
  const slug = agent?.slug;
  const open = useCallback((how: 'continue' | 'new' | 'resume' = 'continue'): ChatSession | null => {
    if (!spec || !approved || !slug) return null;
    const { chatDefaultModel: model, chatDefaultEffort: effort } = readAgentSettings();
    return openCardSession({ ...spec, agent: slug, model, effort }, how);
  }, [spec, approved, slug]);
  return { spec, session, open };
}
