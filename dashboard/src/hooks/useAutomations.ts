import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';

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
  /** The question currently holding this automation, if any (either an
   *  unanswered approval-diff ask or an in-flow HITL stop). Live-computed
   *  server-side from the question store, never from `cache.status` — that
   *  reflects the last RUN, so it reads `ok` on the very run that created the
   *  question and stays `awaiting-review` after a human answers. Repointed
   *  from the retired review-card store; the field is named for what it now
   *  holds. */
  pendingQuestionId: string | null;
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

/**
 * The flow graph — mirrors `FlowGraph` in `src/lib/automations/types.ts`.
 *
 * `kind` is a plain `string`, NOT a union, and that is deliberate on both sides
 * of the wire: adding a connector must never require editing a type here and
 * recompiling. An unrecognised kind renders as a visibly unknown node rather
 * than being dropped — a diagram that silently omits a node lies about what the
 * automation does.
 */
export interface AutomationFlowNode {
  id: string;
  kind: string;
  label?: string;
  config?: Record<string, unknown>;
}

export interface AutomationFlowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface AutomationFlowGraph {
  version: 'automation-flow/v1';
  nodes: AutomationFlowNode[];
  edges: AutomationFlowEdge[];
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
  /** Hashed. The ordered graph the run executes — `trigger → agent → hitl →
   *  report`. `null` when the manifest has no `## Flow` section, which is what
   *  every automation written before the section existed reads as, and what
   *  keeps their approvals byte-identical across the upgrade.
   *
   *  Read carefully in the same direction as `review`: a `hitl` node that has
   *  DISAPPEARED is a human gate someone deleted. */
  flow: AutomationFlowGraph | null;
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
  const api = useApi();
  return useQuery({
    queryKey: ['automations'],
    queryFn: () => api.get<{ automations: AutomationSummary[] }>('/automations').then((r) => r.automations),
    retry: 0,
  });
}

/** Full manifest (every hashed field for review) + approval state + cache/history. */
export function useAutomation(slug: string | null) {
  const api = useApi();
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
  const api = useApi();
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
  const api = useApi();
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
  const api = useApi();
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
  const api = useApi();
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
  const api = useApi();
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
  const api = useApi();
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
  const api = useApi();
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
  const api = useApi();
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

// ─── Flow graph ──────────────────────────────────────────────────────────────

/**
 * GET /api/automations/:slug/flow — mirrors `handleAutomationsFlow`. An
 * automation authored with a `## Flow` block returns it verbatim
 * (`derived: false`); one authored before the flow feature existed gets a
 * graph DERIVED from its own schedule/model/review fields (`derived: true`)
 * so the canvas is never empty. `flow` itself is never null on the wire.
 */
export interface AutomationFlowResponse {
  flow: AutomationFlowGraph;
  derived: boolean;
}

export function useAutomationFlow(slug: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['automations', slug, 'flow'],
    queryFn: () => api.get<AutomationFlowResponse>(`/automations/${slug}/flow`),
    enabled: !!slug,
    retry: 0,
  });
}

// ─── Questions (human-in-the-loop) ──────────────────────────────────────────

/** One correction a human gave a pending question, with what it taught —
 *  mirrors `QuestionSteer` in `src/lib/automations/types.ts`. */
export interface QuestionSteer {
  at: string;
  via: string;
  /** The human's words, verbatim. Never emitted as a command — it reaches a
   *  resumed session only as an instruction ordered after the answer. */
  text: string;
  lesson: string | null;
}

/**
 * A question awaiting (or having received) a human's answer — mirrors
 * `AutomationQuestion` in `src/lib/automations/types.ts`.
 *
 * `kind` is a SECURITY DISCRIMINATOR, not ergonomics: `'approval'` is the
 * sha256 approval tripwire wearing a dashboard face (the manifest changed
 * since it was last approved), while `'flow-hitl'` is an already-approved run
 * asking mid-flight about its own work. `useAnswerQuestion`'s input type
 * branches on this field so the two can never be answered with the wrong
 * shape — see that hook's doc comment.
 */
export interface AutomationQuestion {
  id: string;
  slug: string;
  /** The scheduled fire the asking run answered for. */
  runFiredAt: string;
  /** null ⇒ the run produced no session id (only possible for `'approval'`),
   *  so the question can be closed but never resumed. */
  sessionId: string | null;
  kind: 'approval' | 'flow-hitl';
  channel: 'chat' | 'telegram';
  /** What the human is being asked, in the run's own words. */
  question: string;
  /** The answers offered. Empty ⇒ free text. */
  choices: string[];
  state: 'pending' | 'answered' | 'expired';
  answeredAt: string | null;
  answeredVia: string | null;
  /** What the human chose or typed, verbatim. */
  answer: string | null;
  resolutionNote: string | null;
  resolutionError: string | null;
  /** Newest LAST — a steer trail reads as a conversation. */
  steers: QuestionSteer[];
  channelRefs: Record<string, string>;
  createdAt: string;
}

/**
 * Every question awaiting an answer, across every automation, oldest first —
 * mirrors `handleAutomationsQuestionsList`. Polled, for the reason the
 * retired review queue was: a question can be answered from Telegram or the
 * CLI while this is open, and a stale list would keep offering controls for a
 * question someone already answered elsewhere. The engine's claim lock makes
 * that safe either way, but showing it is better than catching it.
 */
export function useAutomationQuestions() {
  const api = useApi();
  return useQuery({
    queryKey: ['automations-questions'],
    queryFn: () => api.get<{ questions: AutomationQuestion[] }>('/automations/questions').then((r) => r.questions),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    retry: 0,
  });
}

/**
 * The input to `useAnswerQuestion` — a discriminated union on `kind`, on
 * purpose. Mirrors `handleAutomationsQuestionAnswer`'s own split: an
 * `'approval'` question takes an EXPLICIT `'approve' | 'reject'` decision and
 * nothing else (the server 400s on free text — a human typing "no, this looks
 * wrong" must never be read as consent), while a `'flow-hitl'` question is an
 * already-approved run asking about its own work, so free `answer` text is
 * the correct and only shape. Typing this as a union makes sending the wrong
 * shape to the wrong kind a compile error, not a 400 the caller has to catch.
 */
export type AnswerQuestionInput =
  | { id: string; kind: 'approval'; decision: 'approve' | 'reject' }
  | { id: string; kind: 'flow-hitl'; answer: string };

/** What answering an `'approval'` question produced — mirrors the route's
 *  approval branch. Never resumes the asking session (it is discarded either
 *  way, approved or not); `job`/`started` are present only when `approved` —
 *  the exact primitive `useRunAutomation` posts to, so there is one spawn
 *  path for a dashboard-initiated run, not two. */
export interface ApprovalAnswerResult {
  question: AutomationQuestion;
  status: 'ok';
  error: null;
  result: null;
  approved: boolean;
  job?: AutomationRunJob;
  started?: boolean;
}

/** What answering a `'flow-hitl'` question produced — mirrors `QuestionOutcome`. */
export interface FlowHitlAnswerResult {
  question: AutomationQuestion;
  status: 'ok' | 'failed' | 'timeout' | 'not-spawned' | 'refused';
  error: string | null;
  result: string | null;
}

export type AnswerQuestionResult = ApprovalAnswerResult | FlowHitlAnswerResult;

/** Answer one question — mirrors `handleAutomationsQuestionAnswer`. See
 *  `AnswerQuestionInput` for why the two kinds are not interchangeable. */
export function useAnswerQuestion() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (input: AnswerQuestionInput) =>
      api.post<AnswerQuestionResult>(`/automations/questions/${input.id}`, {
        answer: input.kind === 'approval' ? input.decision : input.answer,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['automations-questions'] });
      // The gate lifts (or the run resumes) the moment a question resolves, so
      // the board's per-automation state — `pendingQuestionId`, `approved` —
      // is stale too.
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      queryClient.invalidateQueries({ queryKey: ['automations', data.question.slug] });
    },
  });
}

// ─── Per-automation Telegram ────────────────────────────────────────────────

/** What the dashboard needs to answer "is Telegram set up for this
 *  automation, and where does it reply" — mirrors `TelegramConfigView` in
 *  `src/server/routes/automations.ts`. Deliberately has NO token field: the
 *  bot token is a capability (it can resume a `bypassPermissions` session)
 *  and never leaves the server process. */
export interface TelegramConfigView {
  configured: boolean;
  chatId: string | null;
}

export function useAutomationTelegram(slug: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['automations', slug, 'telegram'],
    queryFn: () =>
      api.get<{ telegram: TelegramConfigView }>(`/automations/${slug}/telegram`).then((r) => r.telegram),
    enabled: !!slug,
    retry: 0,
  });
}

/** Set (or replace) one automation's Telegram bot credentials. The response
 *  echoes the same presence-only shape the read hook returns — the token that
 *  was just written is never read back over HTTP. */
export function useSetAutomationTelegram() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, botToken, chatId }: { slug: string; botToken: string; chatId: string }) =>
      api
        .post<{ telegram: TelegramConfigView }>(`/automations/${slug}/telegram`, { botToken, chatId })
        .then((r) => r.telegram),
    onSuccess: (_data, { slug }) => {
      queryClient.invalidateQueries({ queryKey: ['automations', slug, 'telegram'] });
    },
  });
}
