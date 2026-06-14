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
