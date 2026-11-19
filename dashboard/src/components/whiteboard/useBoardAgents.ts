import { useEffect, useMemo, useReducer } from 'react';
import type { AgentSummary } from '../../hooks/useAgents';
import { homeCardId, peekCardSession, subscribeCardSession, type CardSpec } from './boardAgentScratch';

/**
 * An agent's conversation on a board, as its card reads it: the live session while one is open
 * (else null; the card then reads the remembered transcript). The card never opens one.
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
  return { spec, session };
}
