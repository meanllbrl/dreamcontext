import { useQuery } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';

/** Mirrors `SpaceResult` in src/lib/graph-space.ts. */
export interface SpacePoint {
  /** Corpus identity `type/slug` — same key recall hits use. */
  id: string;
  /** Corpus type: knowledge, task, changelog, insight… */
  t: string;
  /** Title. */
  l: string;
  /** Vault-relative path. */
  p: string;
  /** Tags. */
  g: string[];
  /** Frontmatter status. */
  s?: string;
  /** One-line gist. */
  d: string;
  /** Matching link-graph node id, when there is one. */
  n?: string;
  /** Normalised to [-1, 1]. */
  x: number;
  y: number;
  /** Index into `clusters`. */
  c: number;
}

export interface SpaceCluster {
  id: number;
  label: string;
  x: number;
  y: number;
  size: number;
}

export type SpaceData =
  | { state: 'unavailable'; reason: 'no_embeddings' | 'too_few_docs' }
  | {
      state: 'ready';
      model: string;
      signature: string;
      computedAt: string;
      points: SpacePoint[];
      clusters: SpaceCluster[];
    };

/**
 * The precomputed 2D meaning-space layout. The first call after the embedding cache changes
 * makes the server run UMAP (a few seconds); every later call is a cached file read.
 */
export function useGraphSpace() {
  const api = useApi();
  return useQuery({
    queryKey: ['graph', 'space'],
    queryFn: () => api.get<SpaceData>('/graph/space'),
    staleTime: 5 * 60_000,
  });
}
