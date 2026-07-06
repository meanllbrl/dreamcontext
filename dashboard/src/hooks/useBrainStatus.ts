import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Thin react-query layer over the M2 brain cloud-sync endpoints
 * (`src/server/routes/brain.ts` + `brain-auth.ts`). Every hook maps 1:1 to a
 * route — no business logic lives here, only fetch/cache wiring.
 */

// ─── Types (mirror the route response shapes exactly) ─────────────────────────

export type BrainSyncSource = 'explicit' | 'derived-github-connected' | 'derived-unconnected';
export type BrainMode = 'separate' | 'in-tree';

export interface BrainStatus {
  enabled: boolean;
  source: BrainSyncSource;
  mode: BrainMode;
  remote: string | null;
  hasRemote: boolean;
  mergeInProgress: boolean;
  pendingAgentMerge: boolean;
  pulledUpdates: number;
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
}

export interface BrainSyncResult {
  action: string;
  pulledUpdates: number;
  scrub: { blocks: ScrubBlock[]; warns: ScrubBlock[] };
  note?: string;
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

export function useRunBrainSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: 'pull-only' | 'auto' = 'pull-only') =>
      api.post<BrainSyncResult>('/brain/sync', { mode }),
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
