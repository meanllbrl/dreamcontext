import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// ─── Types (duplicated client-side — can't import from src/lib) ───────────────

export interface Vault {
  name: string;
  path: string;
}

export interface VaultsResponse {
  vaults: Vault[];
  current: string | null;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useVaults() {
  return useQuery({
    queryKey: ['vaults'],
    queryFn: () => api.get<VaultsResponse>('/vaults'),
  });
}

export function useAddVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; path: string }) =>
      api.post<VaultsResponse>('/vaults', v),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vaults'] });
    },
  });
}

export function useRemoveVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.del<VaultsResponse>(`/vaults/${encodeURIComponent(name)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vaults'] });
    },
  });
}
