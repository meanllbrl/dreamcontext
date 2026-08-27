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

// ─── Query keys ───────────────────────────────────────────────────────────────

/**
 * Every query key that feeds a launcher surface (cards, graph, federation, and
 * the per-project connections lists). Any mutation that adds a project, draws or
 * or removes a wire must invalidate ALL of these so the
 * graph + lists refetch immediately — otherwise the new node/edge only appears
 * after an app restart.
 */
const LAUNCHER_QUERY_KEYS: readonly (readonly string[])[] = [
  ['vaults'],
  ['launcher-status'],
  ['launcher-federation-graph'],
  ['connections'],
];

/** Invalidate every launcher-feeding query so all launcher surfaces refetch. */
function invalidateLauncher(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const queryKey of LAUNCHER_QUERY_KEYS) {
    queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * The same launcher-wide refresh as a callable, for flows whose mutation happens
 * OUTSIDE a useMutation (e.g. a background clone job that registers a vault
 * server-side — the wizard learns about it from a status poll, not an onSuccess).
 */
export function useInvalidateLauncher(): () => void {
  const queryClient = useQueryClient();
  return () => invalidateLauncher(queryClient);
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
      invalidateLauncher(queryClient);
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
  /** Target agent platforms (e.g. ['claude']). Defaults to ['claude']. */
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
      invalidateLauncher(queryClient);
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

// ─── Clone from GitHub (wizard third mode) ────────────────────────────────────

/** One repo row in the wizard's GitHub picker. */
export interface GithubRepoSummary {
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch?: string;
  pushedAt?: string;
}

/**
 * The signed-in user's repos, newest-push first, filtered by `q` server-side.
 * Disabled until the caller says the picker is visible AND the user is signed
 * in — a 401 for a signed-out user is expected, not worth firing.
 */
export function useGithubRepos(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ['launcher-github-repos', q],
    queryFn: () =>
      api.get<{ repos: GithubRepoSummary[] }>(
        `/launcher/github/repos?q=${encodeURIComponent(q)}`,
      ),
    enabled,
    staleTime: 30_000,
  });
}

export interface ClonePayload {
  /** `owner/repo` or a full GitHub URL. */
  url: string;
  /** Absolute parent directory the clone lands under. */
  parentDir: string;
}

/** What a finished clone job hands back to the wizard. */
export interface CloneResult {
  /** Absolute path of the fresh clone. */
  path: string;
  /** Folder basename (= repo name). */
  name: string;
  /** True when the clone is already a dreamcontext project (registered server-side). */
  hasContext: boolean;
  /** The registered vault name when `hasContext` (may be suffixed on a collision). */
  vaultName?: string;
  cli?: CliInstallResult;
}

export interface CloneStatus {
  state: 'running' | 'done' | 'error' | 'unknown';
  /** git's live progress tail ("Receiving objects: 42%…"). */
  progress: string;
  result?: CloneResult;
  error?: string;
}

/** Start a background clone job; poll {@link getCloneStatus} with the returned id. */
export function useCloneGithubRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClonePayload) =>
      api.post<{ ok: true; cloneId: string }>('/launcher/clone', payload),
    onSuccess: () => {
      // A vault may appear when the job finishes; refetch once more from the
      // wizard's terminal poll, but refresh eagerly too so nothing goes stale.
      invalidateLauncher(queryClient);
    },
  });
}

/** Poll a background clone job (plain fetch — the wizard drives its own cadence). */
export function getCloneStatus(cloneId: string): Promise<CloneStatus> {
  return api.get<CloneStatus>(`/launcher/clone/status?id=${encodeURIComponent(cloneId)}`);
}

/** Abort a running background clone job. Idempotent. */
export function cancelClone(cloneId: string): Promise<{ ok: true; canceled: boolean }> {
  return api.post<{ ok: true; canceled: boolean }>('/launcher/clone/cancel', { id: cloneId });
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
  /** The vault ships an identity mark (`_dream_context/assets/logo.*`) — render it via
   *  `launcherLogoUrl(name)`. */
  logo: boolean;
  /** The logo file's mtime (ms), or null — rides the image URL as a cache-buster so a
   *  logo replaced from the launcher shows without a reload. */
  logoStamp: number | null;
  /**
   * ISO timestamp of the last launcher-initiated open, or null when never opened
   * (or registered before the field existed). The Space view turns this into
   * orbital radius — never treat a null as "just now" or cold projects would
   * jump to the centre.
   */
  lastOpenedAt: string | null;
}

interface StatusResponse {
  vaults: VaultStatus[];
  latestVersion: string;
}

/**
 * Per-project launcher status (exists / needs-update).
 *
 * `enabled` lets always-mounted consumers (the ⌘P switcher, present in every
 * window) opt OUT of the background poll until they're actually shown — without
 * it the query inherits the app-wide 15s refetch interval and hammers
 * `/api/launcher/status` in every vault window forever. The Launcher page passes
 * nothing (defaults to enabled) since it renders the list directly.
 */
export function useLauncherStatus(enabled = true) {
  return useQuery({
    queryKey: ['launcher-status'],
    queryFn: () => api.get<StatusResponse>('/launcher/status'),
    enabled,
  });
}

/**
 * SET a vault's logo from the launcher: the picked file's raw bytes go up (like
 * `uploadAgentFile`, not `api.post` — that helper JSON-encodes), the server magic-byte
 * verifies them and writes `_dream_context/assets/logo.<ext>`, and every launcher query
 * refetches so the new mark shows without a reload (`logoStamp` busts the image cache).
 */
export function useSetVaultLogo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, file }: { name: string; file: File }) => {
      const res = await fetch(`/api/launcher/logo?vault=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) {
        let message = `Could not set the logo (${res.status}).`;
        try {
          const err = await res.json() as { message?: string };
          if (err.message) message = err.message;
        } catch { /* non-JSON error body — keep the status-code message */ }
        throw new Error(message);
      }
      return await res.json() as { ok: true; logo: boolean; logoStamp: number | null };
    },
    onSuccess: () => {
      invalidateLauncher(queryClient);
    },
  });
}

/** Run `dreamcontext update` inside a project, then refresh status + graph. */
export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ ok: true; status: VaultStatus }>('/launcher/update', { name }),
    onSuccess: () => {
      invalidateLauncher(queryClient);
    },
  });
}

/** Outcome of an `Update all` run: which projects updated, and which refused. */
export interface UpdateAllResult {
  updated: string[];
  failed: { name: string; message: string }[];
}

/**
 * Run `dreamcontext update` across several projects, ONE AT A TIME.
 *
 * Sequential on purpose: each update spawns a CLI process that writes skills and
 * agents into a project, and firing ten of those at once turns a slow machine
 * into a stalled one. A project that fails does not abort the rest — the caller
 * gets the full picture and can retry just the stragglers.
 *
 * `onProgress` fires after each project so the button can count up instead of
 * sitting on a spinner for a minute.
 */
export function useUpdateAllProjects() {
  const queryClient = useQueryClient();
  return useMutation<UpdateAllResult, Error, { names: string[]; onProgress?: (done: number) => void }>({
    mutationFn: async ({ names, onProgress }) => {
      const result: UpdateAllResult = { updated: [], failed: [] };
      for (const name of names) {
        try {
          await api.post<{ ok: true; status: VaultStatus }>('/launcher/update', { name });
          result.updated.push(name);
        } catch (err) {
          result.failed.push({ name, message: err instanceof Error ? err.message : String(err) });
        }
        onProgress?.(result.updated.length + result.failed.length);
      }
      return result;
    },
    onSettled: () => {
      invalidateLauncher(queryClient);
    },
  });
}

/**
 * Stamp a project as just-opened so the Space view can order by recency. Fire
 * and forget: the open must never wait on (or fail because of) this write, so
 * errors are swallowed and only the status query is refreshed.
 */
export function useTouchVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ ok: true; touched: boolean }>('/launcher/touch', { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['launcher-status'] });
      queryClient.invalidateQueries({ queryKey: ['launcher-federation-graph'] });
    },
    onError: () => {
      /* recency is decoration — never surface this */
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
      invalidateLauncher(queryClient);
    },
  });
}

// ─── Federation graph (cross-vault "reads" network) ───────────────────────────

/** A directed "reads" edge: `source` reads `target`. */
export interface FederationEdge {
  source: string;
  target: string;
}

/** One vault's stored connection direction toward a peer (raw, for the graph). */
export interface FederationConnection {
  from: string;
  to: string;
  direction: 'out' | 'in' | 'both';
}

export interface FederationGraph {
  nodes: VaultStatus[];
  edges: FederationEdge[];
  connections: FederationConnection[];
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
      invalidateLauncher(queryClient);
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
      invalidateLauncher(queryClient);
    },
  });
}

