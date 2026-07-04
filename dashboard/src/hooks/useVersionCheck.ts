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
  /** Catalog packs not installed on disk — actionable via the Packs page. */
  newPacks?: string[];
  /** Currently installed CLI version (for the "vX → vY" badge message). */
  currentCli?: string;
  /** Latest published CLI version, or null when unknown/stale. */
  latestCli?: string | null;
  /**
   * True when a newer CLI is published. Reported independently of the prose
   * nudge suppression so the desktop badge can offer a one-click upgrade even
   * when the manual "run dreamcontext upgrade" text line is hidden.
   */
  cliOutdated?: boolean;
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
