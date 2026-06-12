import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// ─── Types (duplicated client-side — can't import from src/lib) ───────────────

export type ConnectionDirection = 'out' | 'in' | 'both';
export type ConnectionStatus = 'active' | 'stale';

export interface Connection {
  vault: string;
  direction: ConnectionDirection;
  topics: string[] | null;
  last_synced_at: string | null;
  status: ConnectionStatus;
}

export interface Vault {
  name: string;
  path: string;
}

interface VaultsResponse {
  vaults: Vault[];
  /** Registered name of the current project's vault, or null if unregistered. */
  current: string | null;
}

interface ConnectionsResponse {
  connections: Connection[];
}

/** Strict POST body — only these fields are honoured server-side (strict-pick). */
export interface ConnectPayload {
  vault: string;
  direction: ConnectionDirection;
  topics?: string[] | null;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Registered vaults + which one is the current project. */
export function useVaults() {
  return useQuery({
    queryKey: ['vaults'],
    queryFn: () => api.get<VaultsResponse>('/vaults'),
  });
}

/** This vault's federation connections. */
export function useConnections() {
  return useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<ConnectionsResponse>('/connections'),
    select: (data) => data.connections,
  });
}

/** Add or upsert a connection (direction change / topics edit reuse this). */
export function useAddConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ConnectPayload) =>
      api.post<ConnectionsResponse>('/connections', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
  });
}

/** Remove a connection. NOTE: the api client's DELETE method is `api.del`. */
export function useRemoveConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vault: string) =>
      api.del<ConnectionsResponse>(`/connections/${encodeURIComponent(vault)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
  });
}
