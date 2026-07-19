import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Thin react-query layer over the M2 brain cloud-sync endpoints
 * (`src/server/routes/brain.ts` + `brain-auth.ts`). Every hook maps 1:1 to a
 * route — no business logic lives here, only fetch/cache wiring.
 */

// ─── Types (mirror the route response shapes exactly) ─────────────────────────

export type BrainSyncSource = 'explicit' | 'derived-github-connected' | 'derived-unconnected';
export type BrainMode = 'in-tree' | 'full-repo';

/** What KIND of in-progress merge blocks sync — drives which sidebar banner shows. */
export type MergeKind = 'agent' | 'code' | 'user' | null;

export interface BrainStatus {
  enabled: boolean;
  source: BrainSyncSource;
  mode: BrainMode;
  remote: string | null;
  hasRemote: boolean;
  /** Code repo `origin` — display context only, NEVER the brain connection. */
  codeOrigin: string | null;
  mergeInProgress: boolean;
  /** `agent` = /dream-sync handoff, `code` = human's editor (full-repo), `user` = the user's own git merge. */
  mergeKind: MergeKind;
  /** full-repo code files a conflict left for the human (when mergeKind === 'code'). */
  codeConflicts: string[];
  pendingAgentMerge: boolean;
  pulledUpdates: number;
}

/** A classified sync failure with a concrete recovery affordance (never a generic "sync failed"). */
export interface SyncFailure {
  kind: 'auth' | 'no-token' | 'permission' | 'network' | 'push-rejected' | 'unknown';
  recovery: 'reconnect-github' | 'check-permissions' | 'wait-online' | 'retry' | 'manual';
  message: string;
  repo?: string;
}

export interface BrainSettings {
  enabled: boolean;
  source: BrainSyncSource;
  mode: BrainMode;
  autoSync: boolean;
  remote: string | null;
}

export interface AuthStatus {
  connected: boolean;
  login?: string;
  source: 'global' | 'env' | null;
  /**
   * The stored session is connected but GitHub last REJECTED its token (expired/
   * invalid) — the Settings chip flips to an invalid + "Reconnect" state. Read off
   * the same server-side flag the sync path writes, so it always agrees with the
   * sidebar's "sign-in expired" surface.
   */
  needsReconnect?: boolean;
  /**
   * Whether a real GitHub OAuth App is wired up. When false, the one-click
   * device flow is unavailable (placeholder client_id) and the UI steers users
   * to the personal-access-token path.
   */
  oauthConfigured?: boolean;
}

export interface ScrubBlock {
  file: string;
  line: number;
  rule: string;
  severity: string;
  excerpt: string;
}

export interface BrainSyncResult {
  action: string;
  pulledUpdates: number;
  scrub: { blocks: ScrubBlock[]; warns: ScrubBlock[] };
  note?: string;
  /** A dirty tree was auto-committed before the pull-only merge (item 7 transparency). */
  checkpointed?: boolean;
  /** The checkpoint commit sha — surfaced so the user can undo it (`git reset --soft <sha>^`). */
  checkpointSha?: string;
  /** full-repo code files a code-conflict left for the human. */
  codeConflicts?: string[];
  /** Set when `action === 'error'` (or a token-shaped no-remote) — the specific, recoverable failure. */
  failure?: SyncFailure;
}

export interface TeamVaultUpdate {
  name: string;
  enabled: boolean;
  mode: BrainMode;
  updates: number;
  pendingAgentMerge: boolean;
}

export interface TeamFetchVaultResult {
  name: string;
  action: string;
  pulledUpdates?: number;
  pendingAgentMerge?: boolean;
  skipped?: 'disabled' | 'in-tree';
  error?: string;
}

export interface DeviceStartResult {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult =
  | { status: 'authorized'; login?: string | null }
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; message?: string };

// ─── Query keys ───────────────────────────────────────────────────────────────

const BRAIN_KEYS = {
  status: ['brain-status'] as const,
  settings: ['brain-settings'] as const,
  authStatus: ['brain-auth-status'] as const,
  teamUpdates: ['brain-team-updates'] as const,
};

function invalidateBrain(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.status });
  queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.settings });
  queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.teamUpdates });
  // A sync updates the shared auth-validity flag; refresh the session chip so it
  // agrees with the sidebar sync surface (both read one source of truth).
  queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.authStatus });
}

// ─── Status / settings (vault-scoped — SW2 master switch) ────────────────────

/** Resolved brain-repo status for the active vault. Polls on the app's default 15s tick. */
export function useBrainStatus() {
  return useQuery({
    queryKey: BRAIN_KEYS.status,
    queryFn: () => api.get<BrainStatus>('/brain/status'),
  });
}

export function useBrainSettings() {
  return useQuery({
    queryKey: BRAIN_KEYS.settings,
    queryFn: () => api.get<BrainSettings>('/brain/settings'),
  });
}

/**
 * The single Cloud sync master toggle. Enabling turns on whole-project (`full-repo`)
 * sync — the server rejects with 400 `no_origin` if the project has no GitHub
 * `origin`. Disabling reverts to `in-tree` (commit-only).
 */
export function useUpdateBrainSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.post<BrainSettings>('/brain/settings', { enabled }),
    onSuccess: (data) => {
      queryClient.setQueryData(BRAIN_KEYS.settings, data);
      invalidateBrain(queryClient);
    },
  });
}

// ─── Origin setup (create / attach a GitHub origin when the project has none) ─

/** READ-ONLY metadata for a candidate attach URL — reachability + name/visibility. */
export interface OriginPreview {
  reachable: boolean;
  fullName?: string;
  private?: boolean;
  defaultBranch?: string;
  empty?: boolean;
  reason?: string;
}

/** Result of create/attach — the wired remote plus the first-sync outcome. */
export interface OriginSetupResult {
  ok: boolean;
  remote: string;
  fullName?: string;
  private?: boolean;
  sync?: BrainSyncResult;
}

export interface CreateOriginArgs {
  /** Repo name; the server defaults to the project folder name when omitted/blank. */
  name?: string;
  /** PRIVATE by default; a public repo requires `confirmed: true`. */
  private?: boolean;
  confirmed?: boolean;
}

/** Preview a repo URL before attaching (no mutation). Returns `{ reachable, reason }`. */
export function usePreviewOrigin() {
  return useMutation({
    mutationFn: (url: string) => api.post<OriginPreview>('/brain/origin/preview', { url }),
  });
}

/** Create a new GitHub repo as the project's origin, then enable + first-sync. */
export function useCreateOrigin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateOriginArgs = {}) => api.post<OriginSetupResult>('/brain/origin/create', args),
    // Settled, not success: even when the request errors mid-flight, the repo may
    // already be created + wired server-side — refetch so the UI shows the truth.
    onSettled: () => invalidateBrain(queryClient),
  });
}

/** Attach an existing GitHub repo as the project's origin, then enable + first-sync. */
export function useAttachOrigin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api.post<OriginSetupResult>('/brain/origin/attach', { url }),
    onSettled: () => invalidateBrain(queryClient),
  });
}

/**
 * Re-point the existing origin at a DIFFERENT reachable repo (connected-card
 * "Change"). Preview-gated server-side; does NOT run a first sync (re-pointing at
 * an unrelated repo could trigger an unrelated-histories merge — the user syncs
 * when ready).
 */
export function useUpdateOrigin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api.post<OriginSetupResult>('/brain/origin/update', { url }),
    onSuccess: () => invalidateBrain(queryClient),
  });
}

/** Remove the origin + revert cloud sync to in-tree (connected-card "Disconnect"). */
export function useDetachOrigin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean; remote: null }>('/brain/origin/detach', {}),
    onSuccess: () => invalidateBrain(queryClient),
  });
}

// ─── GitHub sign-in (app-global — device flow + PAT fallback) ────────────────

export function useAuthStatus() {
  return useQuery({
    queryKey: BRAIN_KEYS.authStatus,
    queryFn: () => api.get<AuthStatus>('/brain/auth/status'),
  });
}

export function useDeviceStart() {
  return useMutation({
    mutationFn: () => api.post<DeviceStartResult>('/brain/auth/device/start', {}),
  });
}

/** One poll tick. The CALLER drives the loop timing off the server-returned interval. */
export function useDevicePoll() {
  return useMutation({
    mutationFn: (sessionId: string) => api.post<DevicePollResult>('/brain/auth/device/poll', { sessionId }),
  });
}

export function useSubmitPatToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.post<AuthStatus>('/brain/auth/token', { token }),
    onSuccess: (data) => queryClient.setQueryData(BRAIN_KEYS.authStatus, data),
  });
}

export function useLogoutGitHub() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AuthStatus>('/brain/auth/logout', {}),
    onSuccess: (data) => queryClient.setQueryData(BRAIN_KEYS.authStatus, data),
  });
}

export interface RunBrainSyncArgs {
  mode?: 'pull-only' | 'auto';
  /** The on-open auto-pull passes this from the "auto-checkpoint on open" preference. */
  noCheckpoint?: boolean;
}

export function useRunBrainSync() {
  const queryClient = useQueryClient();
  return useMutation({
    // Every dashboard-initiated sync is FOREGROUND (a human is watching): WARN
    // scrub hits stay non-blocking, only real secrets stop it.
    mutationFn: (args: RunBrainSyncArgs | 'pull-only' | 'auto' = 'pull-only') => {
      const { mode = 'pull-only', noCheckpoint = false } = typeof args === 'string' ? { mode: args } : args;
      return api.post<BrainSyncResult>('/brain/sync', { mode, foreground: true, noCheckpoint });
    },
    onSuccess: () => invalidateBrain(queryClient),
  });
}

/** One-click "add <path> to .gitignore" for a scrub-blocked local secret file (item 6). */
export function useAddScrubIgnore() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.post<{ ok: boolean; added: string[]; path: string }>('/brain/scrub/ignore', { path }),
    onSuccess: () => invalidateBrain(queryClient),
  });
}

// ─── Team updates (app-global — loops every registered vault, cache-only) ────

/** Cache-only — zero network in the request path. Polls on the default 15s tick. */
export function useTeamUpdates() {
  return useQuery({
    queryKey: BRAIN_KEYS.teamUpdates,
    queryFn: () => api.get<{ vaults: TeamVaultUpdate[] }>('/brain/team/updates'),
    select: (d) => d.vaults,
  });
}

/** "Check now" — an in-process pull-only sync across vaults (or one, if `vault` is given). */
export function useTeamFetch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vault?: string) =>
      api.post<{ results: TeamFetchVaultResult[] }>('/brain/team/fetch', vault ? { vault } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.teamUpdates });
      queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.status });
    },
  });
}
