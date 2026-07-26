import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Automations — the dashboard's read + "run now" + approve surface over
 * `/api/automations*` (T11, frozen). Mirrors `useLab.ts`'s shape: query hooks
 * for read state, mutation hooks that invalidate `['automations']` /
 * `['automations', slug]`. The run-now job (one per project, mirroring
 * `useSyncJob`/`tasks-sync-job`) polls its OWN query key since it isn't
 * slug-scoped.
 *
 * These types are hand-mirrored from `src/lib/automations/types.ts` and the
 * route handlers in `src/server/routes/automations.ts` / `src/server/automation-job.ts`
 * (frozen, read-only from here) — the dashboard has no import path into `src/`,
 * so the shapes are duplicated the same way `useLab.ts` duplicates lab's.
 */

export type RunStatus = 'ok' | 'failed' | 'timeout' | 'blocked' | 'deferred' | 'orphaned';
export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface AutomationSchedule {
  days: 'daily' | Weekday[];
  at: string;
}

/** Why `approved` is false — mirrors registry.ts's `ApprovalVerdict['reason']`. */
export type ApprovalReason = 'never-approved' | 'manifest-changed' | 'payload-format-changed';

export interface AutomationCacheSummary {
  status: RunStatus | null;
  lastRunAt: string | null;
  lastFireAt: string | null;
  durationMs: number | null;
  error: string | null;
  outputPath: string | null;
}

/** One row from GET /api/automations. */
export interface AutomationSummary {
  slug: string;
  title: string;
  enabled: boolean;
  schedule: AutomationSchedule | null;
  scheduleLabel: string;
  model: string | null;
  timeoutMinutes: number;
  catchupHours: number;
  approved: boolean;
  approvalReason: ApprovalReason | null;
  cache: AutomationCacheSummary | null;
}

/** One recorded run attempt (or non-attempt) — mirrors `RunEvent`. */
export interface AutomationRunEvent {
  firedAt: string;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  durationMs: number;
  outputPath: string | null;
  error: string | null;
  exitCode: number | null;
  sessionId: string | null;
  costUsd: number | null;
  numTurns: number | null;
  /** 0 does not mean "none occurred" on every status (e.g. an operator-killed
   *  run never collected telemetry) — never render this as a security signal. */
  permissionDenials: number;
}

/** The FULL cache record — unlike the list's trimmed `AutomationCacheSummary`,
 *  GET /api/automations/:slug sends the whole thing, history included. */
export interface AutomationCache {
  slug: string;
  lastRunAt: string | null;
  lastFireAt: string | null;
  status: RunStatus | null;
  durationMs: number | null;
  outputPath: string | null;
  error: string | null;
  exitCode: number | null;
  history: AutomationRunEvent[];
}

/** The exact five fields the approval hash covers — what `automation` on the
 *  detail response exposes for a full-field review (see `approve`'s CLI
 *  comment: the registry stores only a sha256, never prior values, so this is
 *  a full-field review every time, not an old-vs-new diff). */
export interface AutomationManifestDetail {
  slug: string;
  title: string;
  enabled: boolean;
  schedule: AutomationSchedule | null;
  scheduleLabel: string;
  model: string | null;
  timeoutMinutes: number;
  catchupHours: number;
  outputDir: string | null;
  prompt: string;
  outputInstructions: string;
}

export interface AutomationDetail {
  automation: AutomationManifestDetail;
  approved: boolean;
  approvalReason: ApprovalReason | null;
  cache: AutomationCache | null;
}

/** One completed-or-running run outcome — mirrors `RunOutcome`. */
export interface AutomationRunOutcome {
  slug: string;
  status: RunStatus;
  outputPath: string | null;
  error: string | null;
  durationMs: number;
  event: AutomationRunEvent | null;
  cache: AutomationCache | null;
  denials: number;
  costUsd: number | null;
}

/** The dashboard's "run now" job — one per project, mirrors `AutomationJobState`. */
export interface AutomationRunJob {
  id: string;
  slug: string;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  finishedAt: number | null;
  outcome: AutomationRunOutcome | null;
  error: string | null;
}

/** List every automation (for the board). Empty on an older backend / no route. */
export function useAutomations() {
  return useQuery({
    queryKey: ['automations'],
    queryFn: () => api.get<{ automations: AutomationSummary[] }>('/automations').then((r) => r.automations),
    retry: 0,
  });
}

/** Full manifest (all 5 hashed fields for review) + approval state + cache/history. */
export function useAutomation(slug: string | null) {
  return useQuery({
    queryKey: ['automations', slug],
    queryFn: () => api.get<AutomationDetail>(`/automations/${slug}`),
    enabled: !!slug,
    retry: 0,
  });
}

/** Poll the current "run now" job for this project. Fast while running (the
 *  sync-job precedent, `useTasks.ts`'s `useSyncJob`), idle otherwise — a
 *  headless `claude -p` run can take up to an hour, so idle polling must stop. */
export function useAutomationRunJob() {
  return useQuery({
    queryKey: ['automations-run-job'],
    queryFn: () => api.get<{ job: AutomationRunJob | null }>('/automations/runs').then((r) => r.job),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 800 : false),
    refetchOnWindowFocus: true,
  });
}

/** Start (or adopt) a "run now" job for one automation. Approval, the
 *  sleep-lock deferral, and the orphan guard are all enforced INSIDE the
 *  runner (server-side) — this mutation carries no prompt and no bypass. */
export function useRunAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ job: AutomationRunJob; started: boolean }>(`/automations/${slug}/run`, {}),
    onSuccess: (_data, slug) => {
      queryClient.invalidateQueries({ queryKey: ['automations-run-job'] });
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      queryClient.invalidateQueries({ queryKey: ['automations', slug] });
    },
  });
}

/** Approve the manifest as it currently stands (the same primitive the CLI's
 *  `approve -y` calls after the human reviews all five hashed fields in full —
 *  see `AutomationDetailPanel`, which renders that same review before this
 *  fires). */
export function useApproveAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ slug: string; approval: { manifestSha256: string; approvedAt: string; payloadVersion: string } }>(
        `/automations/${slug}/approve`,
        {},
      ),
    onSuccess: (_data, slug) => {
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      queryClient.invalidateQueries({ queryKey: ['automations', slug] });
    },
  });
}
