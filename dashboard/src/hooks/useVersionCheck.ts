import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

// ─── Types (duplicated client-side — can't import from src/lib) ───────────────

export interface VersionCache {
  checkedAt: number;
  latestCli: string | null;
  availablePacks: string[];
  ttlHours: number;
}

export interface VersionCheck {
  cache: VersionCache | null;
  fresh: boolean;
  nudge: string | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Query GET /api/version-check.
 *
 * Cache-only contract: the server never makes network calls in this request path —
 * it reads from a local cache file written out-of-band (hook/CLI). This means the
 * nudge value is stable within a session and won't change unless the cache file is
 * refreshed externally. For most use-cases no `refetchInterval` is needed, but one
 * could be added if live polling is desired in the future.
 */
export function useVersionCheck() {
  return useQuery({
    queryKey: ['version-check'],
    queryFn: () => api.get<VersionCheck>('/version-check'),
  });
}
