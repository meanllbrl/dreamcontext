import { useEffect, useRef } from 'react';
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
  | 'awaiting-review'
  /** The run did not happen because the MANIFEST changed and nobody has
   *  re-approved it — the tripwire, not the run's own work. Also not a fault.
   *
   *  This member was MISSING from this mirror while `RUN_STATUSES` in
   *  `src/lib/automations/types.ts` carried it, so a card holding this status
   *  fell through `statusWord`'s `default` and printed the raw enum
   *  `awaiting-approval` at a human. `automations-card-status-parity.test.ts`
   *  now reads the BACKEND list as its source of truth so this cannot recur. */
  | 'awaiting-approval';
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

/** How an agent is triggered — mirrors `AutomationMode` in
 *  `src/lib/automations/types.ts`. `'call'` has no schedule, is never fired by
 *  the dispatcher, and therefore shows no pause switch (pausing something that
 *  never fires on its own is a switch with nothing behind it). */
export type AutomationMode = 'sched' | 'call';

/** One row from GET /api/automations. */
export interface AutomationSummary {
  slug: string;
  title: string;
  mode: AutomationMode;
  /** The agent has a photo that RESOLVES right now — server-checked, not just
   *  a string in its frontmatter. False ⇒ render initials. */
  hasPhoto: boolean;
  /** The agent's `## Prompt`, capped server-side. What it does, in the owner's
   *  own words — the dialog writes this field, so there is no second
   *  description to drift from the prompt. */
  description: string;
  /** `scheduleLabel` for a scheduled agent, 'When you call it' for an on-call
   *  one. Computed server-side so no surface words a cadence differently. */
  cadenceLabel: string;
  enabled: boolean;
  schedule: AutomationSchedule | null;
  scheduleLabel: string;
  model: string | null;
  /** On the summary so the Edit dialog can prefill straight from the list
   *  rather than fetching the manifest and flashing a default first. */
  effort: 'low' | 'medium' | 'high' | null;
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
  pendingQuestion: PendingQuestionSummary | null;
}

/**
 * The open question as the BOARD receives it — mirrors the route's
 * `PendingQuestionSummary`. Carries the question's own words and the session
 * that asked, because an id alone made the card unable to do either of the two
 * things a waiting verdict needs: say what is being asked, and open the
 * conversation where it can be answered.
 *
 * `sessionId` is the asking run's conversation, which is NOT the newest row in
 * `cache.history` — the gate that holds this automation refuses without
 * spawning, so it records `sessionId: null` every time it is hit. Anything
 * resolving "the chat for this question" must come through here.
 */
export interface PendingQuestionSummary {
  id: string;
  kind: 'approval' | 'flow-hitl';
  /** The scheduled fire the asking run answered for. Used as the chat header's
   *  "when": the asking run may have been evicted from the bounded history, so
   *  this is the only surviving timestamp for it. */
  runFiredAt: string;
  /** What the run is asking, in its own words. */
  question: string;
  /** The answers offered. Empty ⇒ free text. */
  choices: string[];
  /** The conversation to reopen, when there is one it is safe to offer. Null
   *  for an `'approval'` question (that session ran read-only and is discarded
   *  either way), AND for any question whose session this machine never bound —
   *  a question record can arrive over brain sync, and a uuid from one is not a
   *  capability this machine granted. Either way the question still renders;
   *  only the "Answer in chat" route is withheld. */
  sessionId: string | null;
  createdAt: string;
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

/** Mirrors `ForeignRunEvidence` — runs in a SHARED automation's synced history
 *  that this machine's own session-binding store never recorded, i.e. runs
 *  that happened on some other machine. */
export interface AutomationForeignRuns {
  count: number;
  lastAt: string | null;
}

export interface AutomationDetail {
  automation: AutomationManifestDetail;
  approved: boolean;
  approvalReason: ApprovalReason | null;
  /** null ⇒ private manifest (no evidence either way), or an older backend.
   *  Rendered on the approve screen: approving a shared automation that
   *  already runs elsewhere runs it duplicated, and that must be consented to
   *  knowingly, never discovered later. */
  foreignRuns?: AutomationForeignRuns | null;
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
  /** The thread root this job's fire belongs to, when the job was started by
   *  the `#agents` composer. `null` for a plain "run now". */
  runId?: string | null;
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

/**
 * What the New agent / Edit agent dialog sends. Every field optional on the
 * edit path (it is a PATCH in spirit), so a dialog that knows nothing about
 * `catchup_hours`, `shared`, `review` or the flow can never blank them by
 * omitting them.
 */
export interface AgentDraft {
  title: string;
  prompt: string;
  mode: AutomationMode;
  days: 'daily' | Weekday[];
  at: string;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | null;
}

/**
 * Create an agent — writes the manifest and approves it ON THIS MACHINE, which
 * is why the dialog's button says exactly that. Invalidates the list, so the
 * new card appears without a refresh.
 */
export function useCreateAgent() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (draft: AgentDraft) =>
      api.post<{ automation: AutomationSummary }>('/automations', draft).then((r) => r.automation),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

/**
 * Edit an agent — re-hashes the manifest and RE-APPROVES it here, because
 * `prompt`, `model`, `effort` and `timeoutMinutes` are all approval-hashed and
 * an edit would otherwise leave the agent blocked until someone approved by
 * hand the change they had just typed.
 */
export function useUpdateAgent() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, draft }: { slug: string; draft: Partial<AgentDraft> }) =>
      api.post<{ automation: AutomationSummary }>(`/automations/${slug}/update`, draft).then((r) => r.automation),
    onSuccess: (_data, { slug }) => {
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      queryClient.invalidateQueries({ queryKey: ['automations', slug] });
    },
  });
}

/** Delete an agent — manifest, cache and photo, plus this machine's approval
 *  grant. Armed by a two-click confirm in the dialog footer, never a native
 *  `confirm()`. */
export function useDeleteAgent() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (slug: string) => api.post<{ ok: true; slug: string }>(`/automations/${slug}/delete`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

/**
 * Upload an agent's photo — RAW BYTES, never a base64 JSON envelope: the
 * server types the file by its magic bytes, and a string it had to decode
 * first would only get in the way of that.
 *
 * Runs AFTER the create/update that settles the slug, because the photo is
 * stored as `<slug>.<ext>`. A failure here leaves an agent with initials,
 * never a half-written manifest.
 */
export function useUploadAgentPhoto() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: ({ slug, bytes }: { slug: string; bytes: Blob }) =>
      api.postBytes<{ automation: AutomationSummary }>(`/automations/${slug}/photo`, bytes).then((r) => r.automation),
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

// ─── Runs needing attention (D7) ───────────────────────────────────────────

/** One run that wants a human — mirrors `AttentionRun` in
 *  `src/lib/automations/attention.ts`. `sessionId` is never null here: a run
 *  with no conversation is filtered out server-side rather than handed on to
 *  fail at the resume. */
export interface AttentionRun {
  slug: string;
  automationTitle: string;
  /** `question` — it stopped and asked. `failed` — it crashed or timed out and
   *  the transcript is the only place the cause is legible. */
  reason: 'question' | 'failed';
  sessionId: string;
  firedAt: string;
  /** When this became worth surfacing. The field the watermark compares. */
  at: string;
  status: RunStatus;
  error: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  outputPath: string | null;
}

/**
 * The runs this machine has not yet opened tabs for, oldest first.
 *
 * `enabled` is a real gate, not an optimisation: this query exists to feed the
 * agent surface, so on a build with Agents switched off (or without the claude
 * CLI) it must not poll at all — a poll whose results can never be acted on
 * would advance nothing and cost a request every interval forever.
 *
 * Polled at a much slower cadence than `useAutomationQuestions`' 5s: this
 * answers "what happened while I was away", which changes on the scale of a
 * scheduled fire, not of a keystroke. `refetchOnWindowFocus` is what actually
 * carries the app-open case.
 */
export function useAutomationAttention(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['automations-attention'],
    queryFn: () => api.get<{ runs: AttentionRun[]; watermark: string | null }>('/automations/attention'),
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    enabled,
    retry: 0,
  });
}

/** Mark everything up to `upTo` as shown. Called only once tabs are actually
 *  open — see `handleAutomationsAttentionAck` for why a read must not consume.
 *  The advance is monotonic server-side, so an out-of-order ack from a second
 *  window cannot rewind the mark. */
export function useAckAttention() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (upTo: string) => api.post<{ watermark: string | null }>('/automations/attention/ack', { upTo }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['automations-attention'] }); },
  });
}

// ─── The #agents channel ───────────────────────────────────────────────────
//
// Mirrors `FeedMessage` / `FeedResult` in `src/lib/automations/feed.ts` and the
// three thread routes in `src/server/routes/automations.ts` (frozen, read-only
// from here) — the dashboard has no import path into `src/`, so the shapes are
// duplicated the way every other block in this file duplicates its backend.

/** The STATUS WORD a message shows. A word, never a badge (K26/K40). */
export type FeedStatus = 'running' | 'done' | 'failed' | 'timeout' | 'needs-you' | 'skipped';

export interface FeedFile {
  /** Brain-relative — the server normalises an absolute cache path before it
   *  reaches here, so there is one spelling to open. */
  path: string;
  name: string;
}

export interface FeedMessage {
  /** `<slug>::<runId>`. Stable across polls: the React key AND the id the
   *  thread panel and the read ack are addressed by. */
  key: string;
  slug: string;
  title: string;
  hasPhoto: boolean;
  runId: string;
  at: string;
  status: FeedStatus;
  durationMs: number | null;
  costUsd: number | null;
  /** What the owner typed to call this agent, for a run that is an ASK rather
   *  than a scheduled fire. Renders ABOVE the agent's reply — one exchange,
   *  one message — and is never counted as a reply. */
  ask: { text: string; at: string } | null;
  text: string;
  /** `post` — the agent chose to say this. `result` — it said nothing and this
   *  is its document's opening line. `error` — it failed, and this is why. The
   *  reader is entitled to tell them apart, so the card does. */
  textFrom: 'post' | 'result' | 'error' | 'skipped' | 'none';
  files: FeedFile[];
  /** The BODY post's figures — `automations post --kv`. At most
   *  `THREAD_SUMMARY_MAX_ROWS` (6) rows; null when the post carried none. */
  summary: ThreadSummaryRow[] | null;
  /** The open question this run is stopped on. A JOIN against the question
   *  store, not a field on any thread entry — a question's state changes when
   *  it is answered, and an entry is append-only. Null when nothing is asked. */
  question: { id: string; text: string; choices: string[] } | null;
  /** Waiting on the reader: the `needs-you` status word, or an open question.
   *  What the "Needs you" chip counts — derived server-side so the chip and the
   *  rows can never disagree. */
  needsYou: boolean;
  /** Authored entries beyond the body. System rows are not replies. */
  replyCount: number;
  lastReplyAt: string | null;
  unread: boolean;
  newestId: string | null;
}

export interface AgentFeed {
  messages: FeedMessage[];
  unreadBySlug: Record<string, number>;
  unreadTotal: number;
  /** Project-wide count of messages waiting on the reader. THE chip count —
   *  never re-derived client-side, or two screens would disagree about one
   *  channel the way `unread` already proved they can. */
  needsYouTotal: number;
  agents: { slug: string; title: string; hasPhoto: boolean }[];
}

/** One row of a posted summary — a figure that moved, not prose. Mirrors
 *  `ThreadSummaryRow` in `src/lib/automations/types.ts`. */
export interface ThreadSummaryRow {
  key: string;
  value: string;
}

export interface ThreadEntry {
  id: string;
  runId: string;
  kind: 'system' | 'agent' | 'user';
  event?: 'started' | 'ok' | 'failed' | 'timeout' | 'asked' | 'replied' | 'skipped';
  at: string;
  text: string;
  files?: string[];
  /** Figures posted with `--kv`. Absent, never empty. */
  summary?: ThreadSummaryRow[];
  via: 'runner' | 'cli' | 'dashboard' | 'chat';
}

/**
 * The whole channel. Polled, because a badge that only moves on navigation is
 * a badge nobody trusts — an agent fires while you are looking at the page and
 * the message has to arrive on its own.
 *
 * Reading NEVER consumes unread server-side; the watermark moves only through
 * `useMarkThreadRead`, once a message has actually been on screen.
 */
export function useAgentFeed(
  /** True while a run this window started is still in flight. Fifteen seconds
   *  is the right cadence for catching up on work that happened while you were
   *  away; it is the wrong one for watching an agent you just called by hand,
   *  where the whole exchange can be over before the first poll lands. */
  live = false,
) {
  const api = useApi();
  return useQuery({
    queryKey: ['automations-feed'],
    queryFn: () => api.get<AgentFeed>('/automations/threads'),
    refetchInterval: live ? 2_000 : 15_000,
    refetchOnWindowFocus: true,
    retry: 0,
  });
}

/** One run's thread, for the panel. Polled only while open. */
export function useAgentThread(slug: string | null, runId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['automations', slug, 'thread', runId],
    queryFn: () =>
      api.get<{ slug: string; title: string; entries: ThreadEntry[] }>(
        `/automations/${slug}/thread?run=${encodeURIComponent(runId ?? '')}`,
      ),
    enabled: !!slug && !!runId,
    refetchInterval: 15_000,
    retry: 0,
  });
}

/**
 * Advance this machine's read mark. MONOTONIC server-side, so firing this for
 * a message the user scrolled past on the way to an older one cannot rewind
 * anything.
 *
 * Deliberately does NOT invalidate the feed on success: re-fetching would
 * re-render the list under the reader's eyes the moment a message is marked
 * read, and the New divider would jump. The next poll picks it up.
 */
export function useMarkThreadRead() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (v: { slug: string; upToId: string }) =>
      api.post<{ unread: { count: number } }>('/automations/threads/read', v),
    onSuccess: (_d, v) => {
      queryClient.invalidateQueries({ queryKey: ['automations', v.slug, 'thread'] });
    },
  });
}

/**
 * THE COMPOSER — call one agent by name with a message.
 *
 * Invalidates the feed on success, unlike `useMarkThreadRead` right above:
 * there the re-render would yank the list under someone reading, here it is
 * the entire point. The server writes the ask synchronously before it starts
 * the run, so the refetch this triggers already contains the message —
 * nothing optimistic, and nothing to reconcile if the run then refuses.
 */
export function useSayInChannel() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (v: { slug: string; text: string }) =>
      api.post<{
        /** `kind` says which of the two things the mention STARTED: a `run` is a
         *  fresh fire of a call-mode agent, a `reply` is a resume of a scheduled
         *  agent's latest session. Both land in the same channel; only the
         *  second has a turn to poll. */
        job: { id: string; slug?: string; status: string; kind: 'run' | 'reply' };
        started: boolean;
        runId: string;
        slug: string;
        mode: 'sched' | 'call';
      }>('/automations/threads/say', v),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automations-feed'] });
      queryClient.invalidateQueries({ queryKey: ['automations-run-job'] });
    },
  });
}

// ─── Replying in a run's thread ─────────────────────────────────────────────

/** One reply turn, as `GET /api/automations/reply-job/:id` reports it. Mirrors
 *  `ReplyJobState` in `src/server/automation-job.ts`. */
export interface ReplyJobState {
  id: string;
  slug: string;
  runId: string;
  entryId: string;
  status: 'running' | 'ok' | 'refused' | 'failed';
  /** The server's own sentence on a non-ok settle — never a generic "failed". */
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** How this machine's reply turn ended, for the composer's one-line note.
 *  `unknown` is the SERVER-RESTART case and is terminal: the job is gone, so
 *  nothing will ever report its outcome to this client. */
export interface ReplyDelivery {
  status: 'running' | 'ok' | 'refused' | 'failed' | 'unknown';
  /** The server's sentence, or null for `ok`/`running`. `unknown` carries none
   *  — the copy for it is `t('agents.thread.unknown')`, rendered by the view so
   *  the Turkish survives (this module holds no user-facing prose). */
  reason: string | null;
}

/** Cache key the poller writes its terminal state into. Read it with
 *  {@link useReplyDelivery} — see that hook for why this is a cache entry and
 *  not a field on the mutation. */
function replyDeliveryKey(slug: string, runId: string): readonly unknown[] {
  return ['automations', slug, 'reply-delivery', runId];
}

/** How often the client asks the server whether a reply turn has settled. */
const REPLY_POLL_MS = 2_000;

/**
 * Consecutive failed polls before the client stops asking.
 *
 * A 404 is terminal on its own (the job is gone), but every OTHER failure — the server down,
 * the socket refused, a proxy hiccup — used to retry every 2s for as long as the tab lived,
 * with nothing to stop it. Five is enough to ride out a restart or a blip and small enough
 * that a genuinely unreachable server costs ten seconds rather than the session. A SUCCESSFUL
 * poll resets it, so a long turn punctuated by the odd failure still runs to its real end.
 */
const REPLY_POLL_MAX_ERRORS = 5;

/**
 * THE REPLY. Post into one run's thread and follow the turn it starts.
 *
 * The mutation itself resolves the moment the server has written the `user`
 * entry and started the job (202) — the turn that answers it can take as long
 * as the automation's timeout, so the reply is a JOB and this polls it.
 *
 * WHY THE OUTCOME LANDS IN THE QUERY CACHE rather than on this mutation: the
 * mutation settles at 202, long before the turn does, so its own `data` can
 * never describe the outcome. The poll writes into
 * `['automations', slug, 'reply-delivery', runId]`, which {@link useReplyDelivery}
 * reads — that keeps the signature frozen for the surfaces coded against it
 * while giving the composer somewhere honest to read the result from.
 *
 * A 404 IS TERMINAL, NOT A RETRY. It means the server restarted while the turn
 * was running, so nothing on this machine will ever report the outcome: the
 * poller stops, the delivery reads `unknown`, and the thread is closed later by
 * the server's own reconciliation. Deliberately no re-send — a re-send would
 * deliver the same instruction twice.
 */
export function useReplyToAgentThread() {
  const queryClient = useQueryClient();
  const api = useApi();
  /**
   * The poll chain's own lifetime. `setTimeout` outlives the component that armed it, so
   * without these a user who navigates away mid-turn leaves a request loop running against a
   * cache nothing reads — and on a failing server, running for as long as the tab is open.
   * The timer handle is tracked so the cleanup can cancel the one that is pending, and the
   * flag stops the in-flight request from arming the next one after unmount.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  return useMutation<
    { entry: ThreadEntry; job: { id: string; status: string } },
    Error,
    { slug: string; runId: string; text: string }
  >({
    mutationFn: ({ slug, runId, text }) =>
      api.post<{ entry: ThreadEntry; job: { id: string; status: string } }>(
        `/automations/${slug}/thread/reply`,
        { text, runId },
      ),
    onSuccess: (data, { slug, runId }) => {
      // The `user` entry is already on disk, so the thread can show it now.
      queryClient.invalidateQueries({ queryKey: ['automations', slug, 'thread'] });
      queryClient.setQueryData<ReplyDelivery>(replyDeliveryKey(slug, runId), {
        status: 'running',
        reason: null,
      });

      const settle = (delivery: ReplyDelivery) => {
        queryClient.setQueryData<ReplyDelivery>(replyDeliveryKey(slug, runId), delivery);
        queryClient.invalidateQueries({ queryKey: ['automations', slug, 'thread'] });
        queryClient.invalidateQueries({ queryKey: ['automations-feed'] });
      };

      /** Arm the next tick, unless this hook's component has gone. */
      const again = (poll: () => void) => {
        if (!alive.current) return;
        timer.current = setTimeout(poll, REPLY_POLL_MS);
      };

      /** Consecutive failures. Reset by any answered poll — see the constant. */
      let errors = 0;

      const poll = async (): Promise<void> => {
        // The timer fired, so nothing is pending until the next `again`.
        timer.current = null;
        if (!alive.current) return;
        try {
          const { job } = await api.get<{ job: ReplyJobState }>(`/automations/reply-job/${data.job.id}`);
          errors = 0;
          if (job.status === 'running') {
            again(() => { void poll(); });
            return;
          }
          settle({ status: job.status, reason: job.reason });
        } catch (err) {
          // 404 — the job is gone with the process that owned it. Terminal.
          if ((err as { status?: number }).status === 404) {
            settle({ status: 'unknown', reason: null });
            return;
          }
          // Any OTHER failure is this one request, not the job — so try again
          // rather than declaring an outcome we did not observe. But only up to
          // the budget: past it the server is not answering, and an unbounded
          // retry would keep asking for as long as the tab is open. Settling as
          // `unknown` is the honest report — the turn may well have finished,
          // and this client can no longer find out.
          if (++errors >= REPLY_POLL_MAX_ERRORS) {
            settle({ status: 'unknown', reason: null });
            return;
          }
          again(() => { void poll(); });
        }
      };
      again(() => { void poll(); });
    },
  });
}

/** Read how the reply turn for `runId` ended. Undefined until one is sent. */
export function useReplyDelivery(slug: string | null, runId: string | null) {
  return useQuery<ReplyDelivery>({
    queryKey: replyDeliveryKey(slug ?? '', runId ?? ''),
    // Written by the poller in `useReplyToAgentThread`, never fetched: there is
    // no endpoint for "how did the last reply go", only for one job by id.
    queryFn: () => ({ status: 'running', reason: null }),
    enabled: false,
  });
}
