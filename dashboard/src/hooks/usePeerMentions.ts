import { useQuery } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import type { PeerMention } from '../lib/agentComposer';

/**
 * The connected projects this vault can address, for the composer's `@` menu.
 *
 * Fetched once per vault and held for the pane's life: the list changes only on
 * connect/disconnect, which the user does elsewhere, so re-fetching on every
 * keystroke (or every `@`) would spend a round-trip to learn nothing. The menu
 * opening instantly is the point — a picker that has to load is a picker the
 * user has already typed past.
 *
 * Never throws and never surfaces an error: no peers simply means no `@` menu,
 * which is the correct rendering for a project with no connections anyway.
 *
 * `enabled: false` skips the request entirely and stays at `[]` — for a caller that supplies
 * its own mention list (the agents channel's roster) or has no vault to ask about. Hooks cannot
 * be conditional, so the gate lives here rather than at the call site.
 */
export function usePeerMentions(enabled = true): PeerMention[] {
  const api = useApi();
  // ONE request per open, shared by every pane and composer of this vault (task: opening a
  // project is slow: eleven restored chats asked it 22 times). The query client is per vault,
  // so the key needs no vault id. Held for the window's life, as the effect it replaces held it.
  const { data } = useQuery({
    queryKey: ['peer-mentions'],
    queryFn: () => api.get<{ peers: PeerMention[] }>('/peer/peers')
      .then((r) => (Array.isArray(r?.peers) ? r.peers : []))
      .catch(() => [] as PeerMention[]),
    enabled,
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return enabled && data ? data : NO_PEERS;
}

const NO_PEERS: PeerMention[] = [];
