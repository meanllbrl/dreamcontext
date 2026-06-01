import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// ─── Types (duplicated client-side — can't import from src/lib) ───────────────

export interface CatalogSubSkill {
  name: string;
  file: string;
  description: string;
  hasReferences?: boolean;
}

export interface CatalogPack {
  name: string;
  description: string;
  tags: string[];
  alwaysApply: boolean;
  base: string;
  subSkills: CatalogSubSkill[];
  relatedAgents?: string[];
  crossPackDeps?: string[];
  /** True when this pack's SKILL.md exists on disk (server computes from the filesystem). */
  installed: boolean;
}

export interface CatalogStandalone {
  name: string;
  file: string;
  description: string;
  tags: string[];
  alwaysApply: boolean;
  /** True when this skill's SKILL.md exists on disk. */
  installed: boolean;
}

interface PacksResponse {
  packs: CatalogPack[];
  standalone: CatalogStandalone[];
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePacks() {
  return useQuery({
    queryKey: ['packs'],
    queryFn: () => api.get<PacksResponse>('/packs'),
  });
}

interface InstallResponse {
  name: string;
  installed: string[];
  warnings: string[];
  platforms: string[];
}

interface UninstallResponse {
  name: string;
  removed: string[];
  skipped: string[];
  warnings: string[];
  platforms: string[];
}

/** Install a pack/standalone skill, then refresh the packs list so pills flip. */
export function useInstallPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<InstallResponse>(`/packs/${encodeURIComponent(name)}/install`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packs'] });
    },
  });
}

/** Uninstall a pack/standalone skill, then refresh the packs list. */
export function useUninstallPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.del<UninstallResponse>(`/packs/${encodeURIComponent(name)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packs'] });
    },
  });
}
