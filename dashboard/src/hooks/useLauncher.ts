import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Vault } from './useConnections';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A candidate project discovered under a root directory. */
export interface DiscoveredVault {
  name: string;
  path: string;
  registered: boolean;
}

interface DiscoverResponse {
  projects: DiscoveredVault[];
}

interface RegisterResponse {
  vaults: Vault[];
}

/** Strict register body — only these fields are honoured server-side. */
export interface RegisterPayload {
  name: string;
  path: string;
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Discover dreamcontext projects under an absolute root. Disabled until a root
 * is provided so it never fires with an empty query.
 */
export function useDiscover(root: string | null) {
  return useQuery({
    queryKey: ['launcher-discover', root],
    queryFn: () =>
      api.get<DiscoverResponse>(`/launcher/discover?root=${encodeURIComponent(root!)}`),
    enabled: !!root,
  });
}

/** Register a project directory as a vault; refreshes the vault list on success. */
export function useRegisterVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RegisterPayload) =>
      api.post<RegisterResponse>('/launcher/register', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vaults'] });
    },
  });
}

// ─── Onboarding (quiz) ────────────────────────────────────────────────────────

/** Quiz answers sent to POST /api/launcher/scaffold. */
export interface ScaffoldPayload {
  mode: 'new' | 'existing';
  name: string;
  description?: string;
  targetUser?: string;
  stack?: string;
  priority?: string;
  parentDir?: string;
  projectPath?: string;
  /** Target agent platforms (e.g. ['claude','codex']). Defaults to ['claude']. */
  platforms?: string[];
  /** Optional skill-pack names to install after setup. */
  packs?: string[];
}

/** Outcome of the best-effort global `dreamcontext` CLI install during scaffold. */
export interface CliInstallResult {
  status: 'present' | 'installed' | 'failed';
  message?: string;
}

export interface ScaffoldResponse {
  vault: Vault;
  vaults: Vault[];
  cli?: CliInstallResult;
}

/** Absolute paths the quiz prefills with (home + suggested ~/projects parent). */
export interface LauncherDefaults {
  home: string;
  defaultParent: string;
}

/** Home + default parent dir for the new-project quiz. */
export function useLauncherDefaults() {
  return useQuery({
    queryKey: ['launcher-defaults'],
    queryFn: () => api.get<LauncherDefaults>('/launcher/defaults'),
    staleTime: Infinity,
  });
}

/**
 * Create a new project or initialize an existing folder, then register it.
 * Refreshes the vault list on success.
 */
export function useScaffoldProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ScaffoldPayload) =>
      api.post<ScaffoldResponse>('/launcher/scaffold', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vaults'] });
    },
  });
}

// ─── Catalog (platforms + skill packs offered by the wizard) ──────────────────

export interface PlatformChoice {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
}

export interface PackChoice {
  name: string;
  description: string;
  tags: string[];
}

export interface LauncherCatalog {
  platforms: PlatformChoice[];
  packs: PackChoice[];
}

/** Platforms + optional skill packs the onboarding wizard offers. */
export function useLauncherCatalog() {
  return useQuery({
    queryKey: ['launcher-catalog'],
    queryFn: () => api.get<LauncherCatalog>('/launcher/catalog'),
    staleTime: Infinity,
  });
}

/** What the server can tell about a picked folder before the quiz runs. */
export interface FolderProbe {
  stack: string;
  hasContext: boolean;
  name: string;
}

/** Probe an existing folder: detected stack, whether it's already a vault, basename. */
export async function probeFolder(path: string): Promise<FolderProbe> {
  return api.get<FolderProbe>(`/launcher/detect?path=${encodeURIComponent(path)}`);
}

// ─── Project status (green / yellow / red) ────────────────────────────────────

/** Per-vault freshness for the launcher cards. */
export interface VaultStatus {
  name: string;
  path: string;
  /** Folder still on disk? RED + removable when false. */
  exists: boolean;
  /** The project's recorded setup version. */
  setupVersion: string;
  /** The running CLI version `update` would bring the project up to. */
  latestVersion: string;
  /** Folder exists AND setupVersion is behind latestVersion → YELLOW + Update. */
  needsUpdate: boolean;
  /** Federation read gate — peers may recall this vault when true. */
  shareable: boolean;
}

interface StatusResponse {
  vaults: VaultStatus[];
  latestVersion: string;
}

/** Per-project launcher status (exists / needs-update / shareable). */
export function useLauncherStatus() {
  return useQuery({
    queryKey: ['launcher-status'],
    queryFn: () => api.get<StatusResponse>('/launcher/status'),
  });
}

/** Run `dreamcontext update` inside a project, then refresh status + graph. */
export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ ok: true; status: VaultStatus }>('/launcher/update', { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['launcher-status'] });
      queryClient.invalidateQueries({ queryKey: ['launcher-federation-graph'] });
    },
  });
}

/** Remove a (typically deleted) project from the global registry. */
export function useUnregisterVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ removed: boolean; vaults: Vault[] }>('/launcher/unregister', { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vaults'] });
      queryClient.invalidateQueries({ queryKey: ['launcher-status'] });
      queryClient.invalidateQueries({ queryKey: ['launcher-federation-graph'] });
    },
  });
}

// ─── Federation graph (cross-vault "reads" network) ───────────────────────────

/** A directed "reads" edge: `source` reads `target`. */
export interface FederationEdge {
  source: string;
  target: string;
  /** Target has opted into being read (`shareable`); inert edge when false. */
  active: boolean;
}

export interface FederationGraph {
  nodes: VaultStatus[];
  edges: FederationEdge[];
  latestVersion: string;
}

/** The cross-vault relationship network for the launcher graph. */
export function useFederationGraph() {
  return useQuery({
    queryKey: ['launcher-federation-graph'],
    queryFn: () => api.get<FederationGraph>('/launcher/federation-graph'),
  });
}

/** Create a "reads" edge: `from` reads `to` (stored as an `out` connection on `from`). */
export function useCreateConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { from: string; to: string }) =>
      api.post<{ ok: true }>('/launcher/connection', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['launcher-federation-graph'] });
    },
  });
}

/** Remove the "reads" edge from `from` to `to`. */
export function useRemoveLauncherConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { from: string; to: string }) =>
      api.post<{ ok: true; removed: boolean }>('/launcher/connection/remove', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['launcher-federation-graph'] });
    },
  });
}

/** Flip a vault's `shareable` read gate from the launcher graph. */
export function useToggleShareable() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name: string; shareable: boolean }) =>
      api.post<{ ok: true }>('/launcher/shareable', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['launcher-federation-graph'] });
      queryClient.invalidateQueries({ queryKey: ['launcher-status'] });
    },
  });
}
