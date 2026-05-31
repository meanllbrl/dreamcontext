import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

// ─── Types (duplicated client-side — can't import from src/lib) ───────────────

export interface Vault {
  name: string;
  path: string;
}

interface VaultsResponse {
  vaults: Vault[];
  current: string | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVaults() {
  return useQuery({
    queryKey: ['vaults'],
    queryFn: () => api.get<VaultsResponse>('/vaults'),
  });
}
