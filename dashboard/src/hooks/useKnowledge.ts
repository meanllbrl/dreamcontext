import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface KnowledgeEntry {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  date: string;
  pinned: boolean;
  content: string;
}

interface KnowledgeListResponse {
  entries: KnowledgeEntry[];
}

interface KnowledgeResponse {
  entry: KnowledgeEntry;
}

export function useKnowledgeList() {
  return useQuery({
    queryKey: ['knowledge'],
    queryFn: () => api.get<KnowledgeListResponse>('/knowledge'),
    select: (data) => data.entries,
  });
}

export function useKnowledge(slug: string) {
  return useQuery({
    queryKey: ['knowledge', slug],
    queryFn: () => api.get<KnowledgeResponse>(`/knowledge/${slug}`),
    select: (data) => data.entry,
    enabled: !!slug,
    // The open document must NOT ride the global 15s poll: re-fetching its body
    // would re-export the Excalidraw board mid-interaction (a visible "reload").
    // The list still polls; reopen or the header refresh button pulls fresh content.
    staleTime: Infinity,
    refetchInterval: false,
  });
}

/** fileId (sha1) → resolved image data URL, for an Excalidraw board's embedded images. */
export type KnowledgeAssetFiles = Record<string, { mimeType: string; dataURL: string }>;

interface KnowledgeAssetsResponse {
  files: KnowledgeAssetFiles;
}

/**
 * Resolve an Excalidraw board's embedded images (Obsidian stores them as external
 * wikilinks, not base64 in the scene). Fetched once at near-lossless quality and
 * kept: `staleTime: Infinity` + no interval means the base64 payload does NOT ride
 * the global 15s refetch — images only change when the board is reopened.
 */
export function useKnowledgeAssets(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: ['knowledge-assets', slug],
    queryFn: () => api.get<KnowledgeAssetsResponse>(`/knowledge-assets/${slug}`),
    select: (data) => data.files,
    enabled: enabled && !!slug,
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
}

export function useToggleKnowledgePin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, pinned }: { slug: string; pinned: boolean }) =>
      api.patch<KnowledgeResponse>(`/knowledge/${slug}`, { pinned }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
  });
}
