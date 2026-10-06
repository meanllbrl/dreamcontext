import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useAutomations, type AutomationSummary } from '../../hooks/useAutomations';
import { readAgentSettings } from '../../lib/agentSettings';
import { useVault } from '../../context/VaultContext';
import type { ChatSession } from '../sleepy/chatSession';
import { boardAgentsOf, panelAgentOf, useBoardCards, usePanelPick, type BoardCard } from './agentPanelState';
import { homeCardId, openCardSession, peekCardSession, subscribeCardSession, type CardSpec } from './boardAgentScratch';

/** Every agent on `board` (home agents and agents with a card), and the one the panel shows. */
export function useBoardAgents(board: string | undefined): {
  agents: AutomationSummary[];
  agent: AutomationSummary | null;
  cards: readonly BoardCard[];
  isLoading: boolean;
} {
  const { vault } = useVault();
  const { data: automations, isLoading } = useAutomations();
  const cards = useBoardCards(vault, board);
  const agents = useMemo(() => (board ? boardAgentsOf(automations, board, cards) : []), [automations, board, cards]);
  const agent = panelAgentOf(agents, usePanelPick(vault, board));
  return { agents, agent, cards, isLoading };
}

/**
 * An agent's conversation on a board, as the panel and its cards read it: the live session (or
 * null before the panel first opens it) and the open. Only the panel opens; a card listens.
 */
export function useAgentSession(vault: string | null, board: string | undefined, agent: AutomationSummary | null) {
  const spec = useMemo<CardSpec | null>(
    () => (vault && board && agent ? { vault, board, elementId: homeCardId(agent.slug) } : null),
    [vault, board, agent?.slug], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (spec ? subscribeCardSession(spec, force) : undefined), [spec]);
  const session = spec ? peekCardSession(spec) : null;
  useEffect(() => (session ? session.subscribe(force) : undefined), [session]);
  const approved = !!agent?.approved;
  const slug = agent?.slug;
  const open = useCallback((how: 'continue' | 'new' | 'resume' = 'continue'): ChatSession | null => {
    if (!spec || !approved || !slug) return null;
    const { chatDefaultModel: model, chatDefaultEffort: effort } = readAgentSettings();
    return openCardSession({ ...spec, agent: slug, model, effort }, how);
  }, [spec, approved, slug]);
  return { spec, session, open };
}
