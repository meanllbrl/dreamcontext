import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/** Mirrors EmbedModelState in src/lib/embeddings/embedder.ts. */
export type EmbedModelState = 'not_downloaded' | 'downloading' | 'ready' | 'error';

export interface EmbedModelFileProgress {
  file: string;
  status: string;
  loaded: number;
  total: number;
  progress: number;
}

/** Mirrors EmbedModelStatus in src/lib/embeddings/embedder.ts. */
export interface EmbedModelStatus {
  model: string;
  state: EmbedModelState;
  downloaded: boolean;
  packageInstalled: boolean;
  progress: number;
  loadedBytes: number;
  totalBytes: number;
  files: EmbedModelFileProgress[];
  error: string | null;
  errorCode: 'package_missing' | 'download_failed' | null;
}

/**
 * The embedding model's download/readiness status (`GET /api/embeddings/status`),
 * backing the Hybrid recall card. Polls every 1.5s WHILE a download is in flight so
 * the progress bar advances live, then idles once the model is ready/failed. The
 * caller passes `enabled` (true only while the Hybrid card is visible) to avoid
 * polling for users who never touch Hybrid mode.
 */
export function useEmbeddingModelStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['embedding-model-status'],
    queryFn: () => api.get<EmbedModelStatus>('/embeddings/status'),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'downloading' ? 1_500 : false,
  });
}

/**
 * Start (or retry) the one-time model download (`POST /api/embeddings/download`).
 * Idempotent server-side. On success we seed the status cache with the returned
 * snapshot so the card flips to "Downloading…" immediately, then polling takes over.
 */
export function useDownloadEmbeddingModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EmbedModelStatus & { ok: boolean }>('/embeddings/download', {}),
    onSuccess: (data) => queryClient.setQueryData(['embedding-model-status'], data),
  });
}

// ── Per-vault embedding index (the second half of "hybrid ready") ─────────────

/** Mirrors IndexState in src/server/routes/embeddings.ts. */
export type EmbedIndexState = 'not_built' | 'building' | 'ready' | 'error';

export interface EmbedIndexStatus {
  state: EmbedIndexState;
  progress: number;
  done: number;
  total: number;
  chunks: number;
  error: string | null;
}

/**
 * This vault's embedding-index readiness (`GET /api/embeddings/index/status`).
 * Polls every 1.5s WHILE a build is in flight so the progress bar advances, then
 * idles. Enabled only while the Hybrid card is visible.
 */
export function useEmbeddingIndexStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['embedding-index-status'],
    queryFn: () => api.get<EmbedIndexStatus>('/embeddings/index/status'),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'building' ? 1_500 : false,
  });
}

/**
 * Build (or refresh) this vault's embedding index (`POST /api/embeddings/index`).
 * Idempotent server-side. On success we seed the status cache so the card flips
 * to "Building…" immediately, then polling takes over.
 */
export function useBuildEmbeddingIndex() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EmbedIndexStatus & { ok: boolean }>('/embeddings/index', {}),
    onSuccess: (data) => queryClient.setQueryData(['embedding-index-status'], data),
  });
}
