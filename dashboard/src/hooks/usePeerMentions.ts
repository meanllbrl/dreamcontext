import { useEffect, useState } from 'react';
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
 */
export function usePeerMentions(): PeerMention[] {
  const api = useApi();
  const [peers, setPeers] = useState<PeerMention[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .get<{ peers: PeerMention[] }>('/peer/peers')
      .then((r) => {
        if (alive) setPeers(Array.isArray(r?.peers) ? r.peers : []);
      })
      .catch(() => {
        if (alive) setPeers([]);
      });
    return () => {
      alive = false;
    };
  }, [api]);

  return peers;
}
