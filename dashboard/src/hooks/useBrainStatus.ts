import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Thin react-query layer over the M2 brain cloud-sync endpoints
 * (`src/server/routes/brain.ts` + `brain-auth.ts`). Every hook maps 1:1 to a
 * route — no business logic lives here, only fetch/cache wiring.
 */

// ─── Types (mirror the route response shapes exactly) ─────────────────────────

export type BrainSyncSource = 'explicit' | 'derived-github-connected' | 'derived-unconnected';
export type BrainMode = 'separate' | 'in-tree' | 'full-repo';

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
  kind: 'auth' | 'permission' | 'network' | 'push-rejected' | 'unknown';
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
   * Whether a real GitHub OAuth App is wired up. When false, the one-click
   * device flow is unavailable (placeholder client_id) and the UI steers users
   * to the personal-access-token path.
   */
  oauthConfigured?: boolean;
}

export interface DiscoveredRepo {
  fullName: string;
  htmlUrl: string;
  private: boolean;
}

export interface ScrubBlock {
  file: string;
  line: number;
  rule: string;
  severity: string;
  excerpt: string;
}

export interface CreateBrainResult {
  ok: boolean;
  remote?: string;
  blocked?: boolean;
  scrub?: { blocks: ScrubBlock[] };
}

export interface AttachPreviewResult {
  reachable: boolean;
  fullName?: string;
  private?: boolean;
  isBrainRepo?: boolean;
  defaultBranch?: string;
  reason?: string;
}

export interface AttachResult {
  ok: boolean;
  reason?: string;
  /** Empty-remote first-commit outcome: pushed / blocked-scrub / skipped (unreachable). Absent when the remote already had content. */
  bootstrap?: 'pushed' | 'blocked-scrub' | 'skipped';
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
  discover: ['brain-discover'] as const,
  teamUpdates: ['brain-team-updates'] as const,
};

function invalidateBrain(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.status });
  queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.settings });
  queryClient.invalidateQueries({ queryKey: BRAIN_KEYS.teamUpdates });
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

/** SW2 — flip the Cloud sync master toggle. */
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

// ─── Discover / create / attach (vault-scoped) ────────────────────────────────

/** `enabled` gates the request — discovery hits GitHub, so only fire it on demand. */
export function useDiscoverBrainRepos(enabled: boolean) {
  return useQuery({
    queryKey: BRAIN_KEYS.discover,
    queryFn: () => api.get<{ repos: DiscoveredRepo[] }>('/brain/discover'),
    select: (d) => d.repos,
    enabled,
    retry: false,
  });
}

export interface CreateBrainPayload {
  name: string;
  public?: boolean;
  confirmed?: boolean;
  codeRepo?: string;
}

export function useCreateBrainRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateBrainPayload) => api.post<CreateBrainResult>('/brain/create', payload),
    onSuccess: () => invalidateBrain(queryClient),
  });
}

/** READ-ONLY — the S6 trust preview. Never mutates. */
export function useAttachPreview() {
  return useMutation({
    mutationFn: (url: string) => api.post<AttachPreviewResult>('/brain/attach-preview', { url }),
  });
}

export function useAttachBrainRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { url: string; confirmed: boolean }) =>
      api.post<AttachResult>('/brain/attach', payload),
    onSuccess: () => invalidateBrain(queryClient),
  });
}

/** Clears the brain-repo connection (config remote + the separate repo's origin). */
export function useDisconnectBrainRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/brain/disconnect', {}),
    onSuccess: () => invalidateBrain(queryClient),
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

/**
 * Switch what cloud sync covers: `full-repo` (the whole project folder → the
 * project's own origin) or `brain` (brain-only). Server validates that
 * full-repo has a GitHub origin to push to.
 */
export function useSetBrainScope() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scope: 'full-repo' | 'brain') =>
      api.post<BrainSettings>('/brain/scope', { scope }),
    onSuccess: (data) => {
      queryClient.setQueryData(BRAIN_KEYS.settings, data);
      invalidateBrain(queryClient);
    },
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
