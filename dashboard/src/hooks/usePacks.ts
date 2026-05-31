import { useQuery } from '@tanstack/react-query';
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
}

export interface CatalogStandalone {
  name: string;
  file: string;
  description: string;
  tags: string[];
  alwaysApply: boolean;
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
