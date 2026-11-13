import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { pollMs } from '../../../lib/windowActivity';
import { phoneAllows } from '../../../lib/phoneSurface';

/**
 * The app cards (install, publish, update, logo) waiting for the owner in this project, for the
 * Super Agent's screen (owner 2026-11-13: the Super said "press Onayla on the cards" and no card
 * was in front of him). Read from the server's own requests (`GET /api/apps/requests/waiting`), so
 * a card is here whoever asked (the Super, one of its jobs, any chat) and whether or not the agent
 * put its block in a reply. Proposal ids only: they read the card, never a grant.
 */
export function useWaitingAppCards(enabled: boolean): string[] {
  const api = useApi();
  // Laptop-only, like the card's own routes: on the phone, Telegram carries the buttons.
  const here = phoneAllows('GET', '/api/apps/requests/waiting');
  const q = useQuery({
    queryKey: ['apps', 'requests', 'waiting'],
    queryFn: () => api.get<{ cards?: unknown }>('/apps/requests/waiting').then((r) => (Array.isArray(r.cards) ? r.cards.filter((x): x is string => typeof x === 'string') : [])),
    enabled: enabled && here,
    retry: 0,
    refetchInterval: () => pollMs(2000),
  });
  return q.data ?? EMPTY;
}

const EMPTY: string[] = [];
