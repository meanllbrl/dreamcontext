import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface ServerHealth {
  ok: boolean;
  version?: string;
  /**
   * Set to the newer on-disk version when an upgrade landed under the running
   * desktop server (else null/undefined). Drives the automatic app relaunch so a
   * desktop app never serves a stale bundle after `dreamcontext upgrade`/`npm i -g`.
   */
  upgradeReady?: string | null;
}

/**
 * The /health version handshake — the ONE definition of the query (key, fn, tuning)
 * and of the staleness policy, shared by every consumer (StaleServerBanner, the
 * agent surface's sleep auto-submit). Two inline copies under the same react-query
 * cache key would have to stay byte-compatible forever; centralizing here makes
 * drift structurally impossible.
 *
 * `serverCurrent` is true ONLY when health has loaded AND the server's version
 * matches this bundle. Unknown (query in flight or errored) counts as NOT current:
 * every consumer's degraded path works against any server version (the banner just
 * doesn't show; the sleep prompt falls back to client-side typing), whereas assuming
 * "current" against a genuinely stale server silently drops functionality — e.g. a
 * `&prompt=` param the old server ignores while the client has disarmed its fallback.
 */
export function useServerHealth(): { health: ServerHealth | undefined; serverCurrent: boolean } {
  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<ServerHealth>('/health'),
    staleTime: 60_000,
    retry: 1,
  });
  return { health, serverCurrent: health?.version === __DC_VERSION__ };
}
