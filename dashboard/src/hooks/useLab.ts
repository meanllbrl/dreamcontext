import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import type { FunnelCacheEntry, FunnelPrev } from '../components/lab/funnel/funnelModel';
import type { InsightSize, Render } from '../components/lab/chartRegistry';

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

/** The render list has ONE owner in the dashboard: the chart registry (which
 *  mirrors the engine's `RENDERS`, drift-tested). Re-exported here so every
 *  existing `import type { Render } from '../hooks/useLab'` keeps working. */
export type { InsightSize, Render };

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
  /** Manifest board-footprint override, or null (the render's default span wins). */
  size: InsightSize | null;
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
}

export interface PublicManifest {
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  group: string | null;
  render: Render;
  size: InsightSize | null;
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

/**
 * Every Lab query lives under the `['lab', …]` prefix, so ONE invalidation
 * reaches the board list AND the open insight.
 *
 * Invalidating both keys is not belt-and-braces — it costs a duplicate request.
 * `invalidateQueries` refetches with `cancelRefetch: true`, so the second call
 * ABORTS the fetch the first one started and issues another; the funnel
 * insight's response is the biggest in the app, and it was being fetched, killed
 * and re-fetched on every window change. Measured in `verify:lab-board`:
 * 2 × `GET /api/lab/:slug` per range change, now 1.
 */
function invalidateLab(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['lab'] });
}

/** List every insight (for the board). Empty on an older backend / no route. */
export function useLabInsights() {
  const api = useApi();
  return useQuery({
    queryKey: ['lab'],
    queryFn: () => api.get<{ insights: InsightSummary[] }>('/lab').then((r) => r.insights),
    retry: 0,
  });
}

/** Full manifest + cached series for one insight. */
export function useLabInsight(slug: string | null) {
  const api = useApi();
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
  const api = useApi();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ results: SyncResult[]; failed: SyncResult[] }>('/lab/sync', { slug, force: true }),
    onSuccess: () => invalidateLab(queryClient),
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
  const api = useApi();
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
  const api = useApi();
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
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, binding }: { slug: string; binding: Binding | null }) =>
      api.patch<{ insight: PublicManifest; unbound: string[]; seededCurrent: number | null }>(`/lab/${slug}/binding`, { binding }),
    onSuccess: () => {
      invalidateLab(queryClient);
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
  const api = useApi();
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
  const api = useApi();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.post<{ keys: CredentialKeyStatus[] }>('/lab/credentials', { key, value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lab-credentials'] });
      queryClient.invalidateQueries({ queryKey: ['lab'] });
    },
  });
}

/**
 * What an apply actually did. Reaching here at all means the value was SAVED — a
 * save failure rejects, so the caller's `onError` owns that case. `synced` says
 * whether the re-fetch that has to follow succeeded, and `error` carries the
 * adapter's own words when it did not.
 */
export interface ApplyTweaksResult {
  synced: boolean;
  error: string | null;
}

/**
 * Save tweak values for one insight AND re-fetch, as ONE mutation (#235).
 *
 * The chain was open-coded on four surfaces — card, detail panel, funnel
 * overview, funnel detail — and two of them drifted: `POST /lab/sync` answers
 * **200 with a populated `failed[]`** when the adapter throws, so an `onSuccess`
 * that never inspects the body reports "Custom range applied." over numbers from
 * the window the user just left. Fusing the two calls makes that divergence
 * unrepresentable: there is one success path and it has already read `results[0]`.
 *
 * It also removes the wasted pair of round trips. Invalidating after the PATCH
 * refetched the whole board plus the insight while the cache still held the OLD
 * window — two requests whose only visible effect was to paint the new range
 * label over the old numbers. Only the sync invalidates now.
 */
export function useApplyTweaks() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation<ApplyTweaksResult, Error, { slug: string; tweaks: Record<string, string> }>({
    mutationFn: async ({ slug, tweaks }) => {
      // A rejection here means the value never landed — the caller says "could
      // not save", not "saved but stale".
      await api.patch<{ insight: PublicManifest }>(`/lab/${slug}/tweaks`, { tweaks });
      const data = await api.post<{ results: SyncResult[]; failed: SyncResult[] }>(
        '/lab/sync',
        { slug, force: true },
      );
      const result = data.results[0];
      return result?.status === 'failed'
        ? { synced: false, error: result.error ?? 'unknown error' }
        : { synced: true, error: null };
    },
    // `onSettled`, not `onSuccess`: a rejection here can still mean the PATCH
    // landed and only the sync POST died on the wire, and the surface must not
    // keep rendering the pre-save tweak values. (A failed sync is not a
    // rejection — it resolves with `synced: false` — but it too rewrites the
    // cache, stamping `error`/`errorAt` while keeping the prior data.) The one
    // wasted refetch is the rejected-PATCH path, which is the rare one.
    onSettled: () => invalidateLab(queryClient),
  });
}
