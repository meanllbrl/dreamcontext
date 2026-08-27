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
 *
 * `enabled: false` skips the request entirely and stays at `[]` — for a caller that supplies
 * its own mention list (the meeting room's roster) or has no vault to ask about. Hooks cannot
 * be conditional, so the gate lives here rather than at the call site.
 */
export function usePeerMentions(enabled = true): PeerMention[] {
  const api = useApi();
  const [peers, setPeers] = useState<PeerMention[]>([]);

  useEffect(() => {
    if (!enabled) return;
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
  }, [api, enabled]);

  return peers;
}
