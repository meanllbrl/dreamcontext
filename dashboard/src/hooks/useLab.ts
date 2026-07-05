import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

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

export type Render = 'number' | 'line' | 'pie' | 'raw';

export interface Binding {
  objective: string;
  value: string;
}

/** One row from GET /api/lab — summary for the board. */
export interface InsightSummary {
  slug: string;
  title: string;
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
}

export interface PublicManifest {
  slug: string;
  title: string;
  description: string | null;
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

/** Sync every insight. Returns the aggregate result so the caller can surface `failed[]`. */
export function useSyncAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (force: boolean = true) =>
      api.post<{ results: SyncResult[]; failed: SyncResult[] }>('/lab/sync', { all: true, force }),
    onSuccess: () => {
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
