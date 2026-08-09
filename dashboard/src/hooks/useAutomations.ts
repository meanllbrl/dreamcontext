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

export type RunStatus =
  | 'ok'
  | 'failed'
  | 'timeout'
  | 'blocked'
  | 'deferred'
  | 'orphaned'
  /** The run did not happen because a proposal is unanswered. Unlike every
   *  other non-`ok` status here it is NOT a fault — it is the scheduler waiting
   *  on the human — so it must never be badged as an error. */
  | 'awaiting-review';
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
  review: 'off' | 'agent' | 'output';
  /** The card currently holding this automation. Live-computed server-side from
   *  the card store, never from `cache.status` — that reflects the last RUN, so
   *  it reads `ok` on the very run that created the card and stays
   *  `awaiting-review` after a human answers. */
  pendingReviewCardId: string | null;
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

/** What an automation has LEARNED — mirrors `AutomationPattern`. Not hashed
 *  (it changes every run by design), but rendered: an input the operator
 *  cannot read would be the worst of both worlds. */
export interface AutomationPattern {
  playbook: string;
  lessons: { date: string; text: string }[];
}

/** All SEVEN fields the approval hash covers (`APPROVAL_DIFF_FIELDS`) — what
 *  `automation` on the detail response exposes for a full-field review (see
 *  `approve`'s CLI comment: the registry stores only a sha256, never prior
 *  values, so this is a full-field review every time, not an old-vs-new diff).
 *  Every hashed field MUST appear here and be rendered: a field the reviewer
 *  cannot see is a field that changes the hash invisibly. */
export interface AutomationManifestDetail {
  slug: string;
  title: string;
  enabled: boolean;
  schedule: AutomationSchedule | null;
  scheduleLabel: string;
  model: string | null;
  /** Hashed alongside `model` — both are execution-envelope levers on an
   *  already-approved prompt. `null` ⇒ `claude` picks its own default. */
  effort: string | null;
  timeoutMinutes: number;
  catchupHours: number;
  outputDir: string | null;
  /** Hashed, and the heaviest of the eight to approve knowingly: it admits the
   *  automation's own self-written pattern into the run's input. */
  learning: boolean;
  /** Hashed. Does this automation stop and ask a human before its work takes
   *  effect — `off` (never), `agent` (the run decides), `output` (always, on
   *  the output document). The direction to read carefully is a mode being
   *  REMOVED: that is a gate someone deleted. */
  review: 'off' | 'agent' | 'output';
  prompt: string;
  outputInstructions: string;
  pattern: AutomationPattern;
}

/** One item of a run's replayed session — mirrors `ChatHistoryItem`. */
export interface AutomationSessionItem {
  kind: 'user' | 'text' | 'thinking' | 'tool';
  text?: string;
  name?: string;
  input?: unknown;
  status?: 'done' | 'error';
}

/** GET /api/automations/:slug/session — what the headless run actually did. */
export interface AutomationSession {
  runNumber: number;
  firedAt: string;
  status: RunStatus;
  error: string | null;
  costUsd: number | null;
  numTurns: number | null;
  permissionDenials: number;
  outputPath: string | null;
  sessionId: string | null;
  /** Null when claude never wrote one, or it was pruned — a normal state. */
  transcriptPath: string | null;
  items: AutomationSessionItem[];
  toolCounts: Record<string, number>;
  toolCalls: number;
  toolErrors: number;
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

/** Full manifest (every hashed field for review) + approval state + cache/history. */
export function useAutomation(slug: string | null) {
  return useQuery({
    queryKey: ['automations', slug],
    queryFn: () => api.get<AutomationDetail>(`/automations/${slug}`),
    enabled: !!slug,
    retry: 0,
  });
}

/**
 * The claude session one run actually had — its turns, tool calls and
 * failures. `runNumber` is 1-based, newest first; null closes the drill-in.
 *
 * Not polled: a finished run's transcript never changes, and this reads a
 * multi-hundred-KB file off disk. `staleTime: Infinity` makes reopening the
 * same run free.
 */
export function useAutomationSession(slug: string | null, runNumber: number | null) {
  return useQuery({
    queryKey: ['automations', slug, 'session', runNumber],
    queryFn: () =>
      api
        .get<{ session: AutomationSession | null }>(`/automations/${slug}/session?run=${runNumber}`)
        .then((r) => r.session),
    enabled: !!slug && runNumber !== null,
    staleTime: Infinity,
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

/**
 * The machine-local scheduler's state — mirrors `DispatcherView` in
 * `src/server/routes/automations.ts`. Read-only; polled slowly so an install
 * done from the CLI in another window shows up here without a refresh.
 */
export interface AutomationDispatcher {
  supported: boolean;
  platform: string;
  /** Both files on disk AND booted into launchd — anything less never fires. */
  installed: boolean;
  /** Installed AND byte-current (a moved CLI leaves a stale wrapper behind). */
  current: boolean;
  bootstrapped: boolean;
  plistPresent: boolean;
  plistCurrent: boolean;
  wrapperPresent: boolean;
  wrapperCurrent: boolean;
  mismatch: boolean;
  resolvedBin: string | null;
  runningBin: string | null;
  logPath: string;
  logSizeBytes: number;
  /** Manifests can exist here (brain sync) with this project never registered. */
  projectRegistered: boolean;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  notifier: { supported: boolean; present: boolean; current: boolean };
}

export interface DispatcherInstallResult {
  installed: boolean;
  method: 'bootstrap' | 'load' | 'none';
  /** A resolution mismatch refuses SOFTLY: nothing written, reason in here. */
  warnings: string[];
  notifier: { built: boolean; reason: string | null };
  dispatcher: AutomationDispatcher;
}

export function useAutomationDispatcher() {
  return useQuery({
    queryKey: ['automations-dispatcher'],
    queryFn: () => api.get<{ dispatcher: AutomationDispatcher }>('/automations/dispatcher').then((r) => r.dispatcher),
    // `launchctl print` is a subprocess per call — poll on the minute, not the
    // second. Focus refetch covers "I just installed it from the CLI".
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 0,
  });
}

/**
 * Turn the scheduler on for this machine — the dashboard half of
 * `dreamcontext automations install`. `force` overrides a resolution mismatch,
 * exactly as `--force` does; without it a mismatch writes nothing and comes
 * back in `warnings` for the human to decide on.
 *
 * Installing the dispatcher does NOT make anything run: each automation still
 * needs its own machine-local approval before the scheduler will execute it.
 */
export function useInstallDispatcher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: { force?: boolean } = {}) =>
      api.post<DispatcherInstallResult>('/automations/dispatcher/install', { force: opts.force === true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automations-dispatcher'] });
      queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

/** Turn the scheduler back off. Manifests, approvals and run history all stay. */
export function useUninstallDispatcher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ bootedOut: boolean; removedNotifier: boolean; dispatcher: AutomationDispatcher }>(
        '/automations/dispatcher/uninstall',
        {},
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automations-dispatcher'] });
      queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

/** Flip one automation's own `enabled` switch (CLI `automations enable|disable`).
 *  Not approval-relevant: `enabled` is not a hashed field, so a toggle never
 *  blocks an already-approved automation. */
export function useSetAutomationEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, enabled }: { slug: string; enabled: boolean }) =>
      api.post<{ automation: AutomationSummary }>(`/automations/${slug}/${enabled ? 'enable' : 'disable'}`, {}),
    onSuccess: (_data, { slug }) => {
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      queryClient.invalidateQueries({ queryKey: ['automations', slug] });
    },
  });
}

/** Approve the manifest as it currently stands (the same primitive the CLI's
 *  `approve -y` calls after the human reviews every hashed field in full —
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

// ─── Review cards ───────────────────────────────────────────────────────────

/** One correction a human gave a pending card, with what it taught. */
export interface ReviewSteer {
  at: string;
  via: string;
  /** The human's words, verbatim. Never emitted — it is an instruction to the
   *  agent, which is why the card body next to it is the agent's rewrite. */
  text: string;
  lesson: string | null;
}

/** Mirrors `ReviewCard` in `src/lib/automations/types.ts`. */
export interface ReviewCard {
  id: string;
  slug: string;
  runFiredAt: string;
  /** null ⇒ the proposing run left no session to reply to. Such a card can be
   *  discarded but never approved or corrected, and the UI must say so rather
   *  than offering buttons that cannot work. */
  sessionId: string | null;
  kind: 'output' | 'agent';
  title: string;
  summary: string;
  body: string;
  stagedPath: string | null;
  state: 'pending' | 'approved' | 'discarded' | 'dropped';
  steers: ReviewSteer[];
  createdAt: string;
  resolvedAt: string | null;
  resolvedVia: string | null;
  resolutionNote: string | null;
  resolutionError: string | null;
  channelRefs: Record<string, string>;
}

/**
 * Everything awaiting a verdict, across every automation.
 *
 * Polled, unlike most reads here, and for a specific reason: a card can be
 * answered from Telegram or the CLI while this page is open, and a queue that
 * still offers buttons for a card someone already approved invites a second
 * verdict on a decision already made. The engine's claim lock makes that safe,
 * but showing it is better than catching it.
 */
export function useReviewQueue() {
  return useQuery({
    queryKey: ['automations-review'],
    queryFn: () => api.get<{ cards: ReviewCard[] }>('/automations/review').then((r) => r.cards),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    retry: 0,
  });
}

export interface ReviewAnswerResult {
  card: ReviewCard;
  status: 'ok' | 'failed' | 'timeout' | 'not-spawned' | 'refused';
  error: string | null;
  result: string | null;
  lesson: string | null;
}

/**
 * Answer a card: a verdict, or a correction in words.
 *
 * A correction leaves the card PENDING — it is rewritten and comes back for the
 * same three buttons. Nothing here carries a session id or a prompt; the card
 * already names the conversation the server resumes.
 */
export function useAnswerReviewCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, verdict, steer }: { id: string; verdict?: 'approve' | 'discard' | 'drop'; steer?: string }) =>
      api.post<ReviewAnswerResult>(`/automations/review/${id}`, verdict ? { verdict } : { steer }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automations-review'] });
      // The gate lifts the moment a card resolves, so the board's per-automation
      // state is stale too.
      queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}
