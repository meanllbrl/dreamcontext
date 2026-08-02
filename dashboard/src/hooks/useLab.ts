import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { FunnelCacheEntry, FunnelPrev, FunnelSnapshot } from '../components/lab/funnel/funnelModel';

/** Tweak kinds. No `range` type — a relative range is an `enum` tweak keyed `range`. */
export type TweakType = 'enum' | 'date' | 'string';

export interface PublicTweak {
  key: string;
  type: TweakType;
  label: string | null;
  options: string[] | null;
  default: string | null;
  value: string | null;
}

export type Render = 'number' | 'line' | 'pie' | 'raw' | 'funnel';

export interface Binding {
  objective: string;
  value: string;
}

/** One row from GET /api/lab — summary for the board. */
export interface InsightSummary {
  slug: string;
  title: string;
  /** Top-level side-menu category (e.g. "Marketing"), or null. */
  category: string | null;
  group: string | null;
  render: Render;
  unit: string | null;
  binding: Binding | null;
  latest: number | null;
  fetchedAt: string | null;
  granularity: string | null;
  error: string | null;
  errorAt: string | null;
  ttlMinutes: number;
  staleMinutes: number | null;
  stale: boolean | null;
  tweaks: PublicTweak[];
}

export interface SeriesPoint { t: string; v: number }
export interface Series { name: string; points: SeriesPoint[] }

/** One entry in the bounded per-insight sync history (real runs only). */
export interface SyncEvent {
  at: string;
  status: 'ok' | 'failed';
  latest: number | null;
  granularity: string | null;
  error: string | null;
}

export interface InsightCache {
  slug: string;
  fetchedAt: string;
  tweaks: Record<string, string>;
  granularity: string;
  unit: string | null;
  series: Series[];
  latest: number | null;
  error: string | null;
  errorAt: string | null;
  scriptHash: string | null;
  /** Oldest→newest, bounded. Absent on caches written before history shipped. */
  history?: SyncEvent[];
  /** Funnel-set snapshot (`render: funnel` with a funnel-set payload only). */
  funnel?: FunnelCacheEntry;
  /** Bounded per-sync funnel snapshots (deltas/trends), oldest→newest. */
  funnelHistory?: FunnelSnapshot[];
}

export interface PublicManifest {
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  group: string | null;
  render: Render;
  unit: string | null;
  binding: Binding | null;
  credentials_used: string[];
  refresh: { ttl_minutes: number };
  adapter: 'http' | 'script' | null;
  method: 'GET' | 'POST' | null;
  tweaks: PublicTweak[];
}

export interface InsightDetail {
  insight: PublicManifest;
  meaning: string;
  resolvedTweaks: Record<string, string>;
  cache: InsightCache | null;
  /** Previous-period values (server-computed: adapter `prev` wins, else the
   *  best equal-length history snapshot). Null for non-funnel insights. */
  funnelPrev?: FunnelPrev | null;
}

export interface SyncResult {
  slug: string;
  status: 'ok' | 'fresh' | 'failed';
  latest?: number | null;
  granularity?: string;
  error?: string;
}

/** List every insight (for the board). Empty on an older backend / no route. */
export function useLabInsights() {
  return useQuery({
    queryKey: ['lab'],
    queryFn: () => api.get<{ insights: InsightSummary[] }>('/lab').then((r) => r.insights),
    retry: 0,
  });
}

/** Full manifest + cached series for one insight. */
export function useLabInsight(slug: string | null) {
  return useQuery({
    queryKey: ['lab', slug],
    queryFn: () => api.get<InsightDetail>(`/lab/${slug}`),
    enabled: !!slug,
    retry: 0,
  });
}

/** Sync one insight (always forces a refetch — the explicit user action). */
export function useSyncInsight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ results: SyncResult[]; failed: SyncResult[] }>('/lab/sync', { slug, force: true }),
    onSuccess: (_data, slug) => {
      queryClient.invalidateQueries({ queryKey: ['lab'] });
      queryClient.invalidateQueries({ queryKey: ['lab', slug] });
    },
  });
}

/**
 * A server-owned bulk sync of every insight.
 *
 * Bulk sync is NOT a request/response call. A full board runs for minutes and
 * the server destroys any socket idle for 30s, so holding the request open used
 * to kill the run mid-flight — the board never refetched and half the tiles kept
 * their stale numbers. The job lives in the server process instead: it survives
 * navigation, reports live progress, and this poll re-adopts it on return.
 */
export interface LabSyncJob {
  id: string;
  status: 'running' | 'success' | 'error';
  done: number;
  total: number;
  attempt: number;
  startedAt: number;
  finishedAt: number | null;
  results: SyncResult[];
  failed: string[];
  error: string | null;
}

export function useLabSyncJob() {
  return useQuery({
    queryKey: ['lab-sync-job'],
    queryFn: () => api.get<{ job: LabSyncJob | null }>('/lab/sync-jobs/current'),
    select: (d) => d.job,
    // Poll fast while a job runs so the counter is live; idle otherwise.
    refetchInterval: (query) => (query.state.data?.job?.status === 'running' ? 800 : false),
    refetchOnWindowFocus: true,
    retry: 0,
  });
}

/** Start (or adopt) the bulk sync job. Returns immediately — watch `useLabSyncJob`. */
export function useStartLabSyncJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (force: boolean = true) =>
      api.post<{ job: LabSyncJob; started: boolean }>('/lab/sync-jobs', { force }),
    onSuccess: (d) => {
      // Seed the poll cache so the progress chip appears immediately (no 800ms gap).
      queryClient.setQueryData(['lab-sync-job'], { job: d.job });
      queryClient.invalidateQueries({ queryKey: ['lab-sync-job'] });
    },
  });
}

/** Connect (binding) or disconnect (null) an insight to an objective's Key Result.
 *  The server enforces one feeder per objective (`unbound[]`) and seeds
 *  `metric.current` from the cached latest (`seededCurrent`), so objectives and
 *  roadmap queries are invalidated too. */
export function useUpdateBinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, binding }: { slug: string; binding: Binding | null }) =>
      api.patch<{ insight: PublicManifest; unbound: string[]; seededCurrent: number | null }>(`/lab/${slug}/binding`, { binding }),
    onSuccess: (_data, { slug }) => {
      queryClient.invalidateQueries({ queryKey: ['lab'] });
      queryClient.invalidateQueries({ queryKey: ['lab', slug] });
      queryClient.invalidateQueries({ queryKey: ['objectives'] });
      queryClient.invalidateQueries({ queryKey: ['roadmap'] });
    },
  });
}

/** One row from GET /api/lab/credentials — key NAMES + presence only, never values. */
export interface CredentialKeyStatus {
  key: string;
  present: boolean;
  usedBy: string[];
}

/** Required-credential status for the board's missing-credentials banner. */
export function useLabCredentials() {
  return useQuery({
    queryKey: ['lab-credentials'],
    queryFn: () => api.get<{ keys: CredentialKeyStatus[] }>('/lab/credentials').then((r) => r.keys),
    retry: 0,
  });
}

/** Store one credential (the value is never echoed back by the server).
 *  Invalidates the credentials status AND the insights list — a fixed key can
 *  unblock syncs, so the board's error badges may change too. */
export function useSetLabCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.post<{ keys: CredentialKeyStatus[] }>('/lab/credentials', { key, value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lab-credentials'] });
      queryClient.invalidateQueries({ queryKey: ['lab'] });
    },
  });
}

/** Persist edited tweak values for one insight. */
export function useUpdateTweaks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, tweaks }: { slug: string; tweaks: Record<string, string> }) =>
      api.patch<{ insight: PublicManifest }>(`/lab/${slug}/tweaks`, { tweaks }),
    onSuccess: (_data, { slug }) => {
      queryClient.invalidateQueries({ queryKey: ['lab'] });
      queryClient.invalidateQueries({ queryKey: ['lab', slug] });
    },
  });
}
