import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// ─── Types (duplicated client-side — can't import from src/lib) ───────────────

export type PlatformId = 'claude' | 'codex';

export interface SetupConfig {
  platforms: PlatformId[];
  packs: string[];
  multiProduct: false | string[];
  setupVersion: string;
}

interface ConfigResponse {
  config: SetupConfig | null;
}

interface ConfigUpdateResponse {
  config: SetupConfig;
}

/** Allowed PATCH fields — deliberately restricted to prevent allow-list bypass. */
export interface ConfigPatch {
  platforms?: PlatformId[];
  packs?: string[];
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ConfigResponse>('/config'),
    select: (data) => data.config,
  });
}

export function useUpdateConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: ConfigPatch) =>
      api.patch<ConfigUpdateResponse>('/config', patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });
}
