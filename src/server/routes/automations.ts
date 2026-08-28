import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import {
  getAutomation,
  listAutomations,
  readAutomationCache,
  readPattern,
  setAutomationEnabled,
  deriveFlowFromManifest,
} from '../../lib/automations/store.js';
import { resolveRunSession, readSessionDigest } from '../../lib/automations/session.js';
import { foreignRunEvidence } from '../../lib/automations/session-registry.js';
import {
  checkApproval,
  approveAutomation,
  listRegisteredProjects,
  registerProject,
  readDispatcherHeartbeat,
} from '../../lib/automations/registry.js';
import {
  inspectDispatcher,
  installDispatcher,
  uninstallDispatcher,
  type InstallCheck,
} from '../../lib/automations/launchd.js';
import {
  buildNotifierApp,
  inspectNotifier,
  notifyViaBundle,
  removeNotifierApp,
  NOTIFY_SOUND_OK,
} from '../../lib/automations/notifier.js';
import { formatSchedule } from '../../lib/automations/schedule.js';
import { allPendingQuestions, claimQuestion, pendingQuestion } from '../../lib/automations/hitl.js';
import { resumeWithAnswer } from '../../lib/automations/verdict.js';
import { queuedFire, type QueuedFire } from '../../lib/automations/queue.js';
import { ackAttention, attentionRuns, attentionWatermark } from '../../lib/automations/attention.js';
import { readAutomationSession } from '../../lib/automations/session-registry.js';
import { findTranscriptBySessionId } from '../../lib/transcript-locate.js';
import { readTelegramConfigForSlug, writeTelegramConfigForSlug } from '../../lib/automations/telegram.js';
import { startAutomationJob, currentAutomationJob } from '../automation-job.js';
import { AutomationError, type AutomationCache, type AutomationManifest, type AutomationQuestion, type FlowGraph } from '../../lib/automations/types.js';

/**
 * `/api/automations*` — the dashboard's read + "run now" + approve surface
 * over the same store/registry/runner engine the CLI uses, so behaviour never
 * drifts between CLI and UI (mirrors `routes/lab.ts`).
 *
 * Security is INHERITED from `index.ts`, never re-implemented here: the
 * network-auth gate for non-loopback binds, CORS preflight, and the CSRF block
 * on cross-site state-changing requests all run before a request reaches any
 * handler in this file.
 *
 * `handleAutomationsRunNow` accepts NO body at all — it never even reads the
 * request stream. The slug names an already-approved-or-not local manifest;
 * approval, the sleep-lock deferral, and the orphan guard are enforced INSIDE
 * `runAutomation` (via `startAutomationJob`). There is no path here, or
 * anywhere in the runner, that executes a prompt supplied over HTTP.
 */

interface AutomationSummary {
  slug: string;
  title: string;
  enabled: boolean;
  schedule: AutomationManifest['schedule'];
  scheduleLabel: string;
  model: string | null;
  timeoutMinutes: number;
  catchupHours: number;
  approved: boolean;
  approvalReason: string | null;
  cache: AutomationCacheSummary | null;
  review: AutomationManifest['review'];
  /** The question holding this automation, if any (either an unanswered
   *  approval-diff ask or an in-flow HITL stop) — the board badges off this.
   *  Repointed from the retired review-card store to `hitl.ts`'s question
   *  store; the field is named for what it now holds. */
  pendingQuestion: PendingQuestionSummary | null;
}

/**
 * The open question, as a CARD needs it — not just its id.
 *
 * This used to be a bare `pendingQuestionId: string | null`, which let the
 * board badge "waiting for your verdict" and nothing else: the question's own
 * words were reachable only from `GET /automations/questions`, which only
 * `ChatPane` calls — i.e. only AFTER the run's chat is open. So the one screen
 * that told you a verdict was owed could not tell you what was being asked,
 * and the screen that could was behind the thing you were trying to reach.
 *
 * `sessionId` is the other half, and it is the field that makes "open chat"
 * work at all: the conversation to resume is the one that ASKED, which is not
 * the newest history row. A gate that refuses without spawning records
 * `sessionId: null`, and it re-records on every tick, so by the time a human
 * looks the newest rows are all session-less refusals stacked on top of the
 * run that actually holds the question.
 */
interface PendingQuestionSummary {
  id: string;
  kind: 'approval' | 'flow-hitl';
  /** The scheduled fire the asking run answered for — the honest "when" for a
   *  chat opened from this question, since the asking run may no longer be in
   *  the bounded history at all. */
  runFiredAt: string;
  /** What the run is asking, in its own words. */
  question: string;
  /** The answers offered. Empty ⇒ free text. */
  choices: string[];
  /** The conversation that asked, when it is safe to offer. Null in two cases,
   *  and the caller must not conflate them with "no question":
   *   - an `'approval'` question — that session ran read-only and is discarded
   *     whether or not it is approved (`hitl.ts` forces the field null);
   *   - a question whose session THIS machine never bound — see
   *     `summarizeQuestion`. The question is still shown; only the resume is
   *     withheld. */
  sessionId: string | null;
  createdAt: string;
}

interface AutomationCacheSummary {
  status: AutomationCache['status'];
  lastRunAt: string | null;
  lastFireAt: string | null;
  durationMs: number | null;
  error: string | null;
  outputPath: string | null;
}

function cacheSummary(cache: AutomationCache | null): AutomationCacheSummary | null {
  if (!cache) return null;
  return {
    status: cache.status,
    lastRunAt: cache.lastRunAt,
    lastFireAt: cache.lastFireAt,
    durationMs: cache.durationMs,
    error: cache.error,
    outputPath: cache.outputPath,
  };
}

function summarize(projectRoot: string, contextRoot: string, m: AutomationManifest): AutomationSummary {
  const approval = checkApproval(projectRoot, m);
  return {
    slug: m.slug,
    title: m.title,
    enabled: m.enabled,
    schedule: m.schedule,
    scheduleLabel: formatSchedule(m.schedule),
    model: m.model,
    timeoutMinutes: m.timeoutMinutes,
    catchupHours: m.catchupHours,
    approved: approval.approved,
    approvalReason: approval.approved ? null : approval.reason,
    cache: cacheSummary(readAutomationCache(contextRoot, m.slug)),
    review: m.review,
    // Live-computed from the question store, NOT from `cache.status`, for the
    // same reason `approved` is live-computed rather than read off the last
    // attempt: `cache.status` reflects the last RUN, so it still reads
    // `awaiting-review`/`awaiting-approval` after a human answers and goes
    // stale until the next tick — and it reads `ok` on the run that CREATED
    // the question, which is the state most in need of a badge.
    pendingQuestion: summarizeQuestion(pendingQuestion(contextRoot, m.slug)),
  };
}

/**
 * Trim a stored question to what a card renders + reaches. Deliberately drops
 * `answer`/`answeredAt`/`steers`/`channelRefs`: a PENDING question has none of
 * them, and shipping empty fields invites a reader to bind to them.
 *
 * `sessionId` is withheld unless THIS machine's runner bound it. A question
 * record lives inside the brain and is kept out of git only by a `.gitignore`
 * line the runner re-ensures best-effort — see `attention.ts`'s `locallyBound`
 * for the full reasoning and for why the WS resume gate does not cover this
 * source. A pulled-in question file must not hand a client a resumable
 * `bypassPermissions` uuid, so the machine-local binding is checked before the
 * field is ever put on the wire. The question itself still renders: the reader
 * should see what a teammate's automation is asking; they just get no button
 * that resumes a conversation this machine never had.
 */
/**
 * A question's session id, but only when opening it would actually reach that
 * conversation. Two independent gates, both of which must hold:
 *
 *  - MACHINE-LOCAL BINDING TO THIS SLUG — a question record lives inside the
 *    brain and is kept out of git only by a best-effort `.gitignore` line, so a
 *    pulled-in one must never hand this client a resumable `bypassPermissions`
 *    uuid. The WS resume gate does not cover this source (it scans
 *    `automations/cache/*.json` only), so the check happens before the field
 *    goes on the wire — and it is `readAutomationSession(slug, …)`, not the
 *    gate's slug-agnostic `isAutomationBoundSession`. See `attention.ts`'s
 *    `locallyBound` for why discarding the slug admits a confused-deputy.
 *  - A TRANSCRIPT ON DISK — `--resume` against a missing transcript does not
 *    fail; it fresh-pins an empty conversation under the same uuid, which would
 *    open a blank chat claiming to be the run. See `attention.ts`'s
 *    `hasTranscript`.
 *
 * Withholding is not the same as having no question: the words still render, so
 * the reader sees what is being asked. They just get no button that cannot work.
 */
function offerableSession(slug: string, sessionId: string | null): string | null {
  if (!sessionId) return null;
  if (readAutomationSession(slug, sessionId) === null) return null;
  if (findTranscriptBySessionId([sessionId]) === null) return null;
  return sessionId;
}

function summarizeQuestion(q: AutomationQuestion | null): PendingQuestionSummary | null {
  if (!q) return null;
  return {
    id: q.id,
    kind: q.kind,
    runFiredAt: q.runFiredAt,
    question: q.question,
    choices: q.choices,
    sessionId: offerableSession(q.slug, q.sessionId),
    createdAt: q.createdAt,
  };
}

/** GET /api/automations — list every automation with its approval + cache state. */
export async function handleAutomationsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const projectRoot = dirname(contextRoot);
    const automations = listAutomations(contextRoot).map((m) => summarize(projectRoot, contextRoot, m));
    sendJson(res, 200, { automations });
  } catch {
    sendError(res, 500, 'list_failed', 'Failed to read automations.');
  }
}

/**
 * GET /api/automations/runs — poll the current "run now" job for this project
 * (one job per contextRoot, mirroring `GET /api/tasks/sync-jobs/current`).
 * MUST be registered before `/api/automations/:slug` — `runs` would otherwise
 * be captured as a slug.
 */
export async function handleAutomationsRunStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    sendJson(res, 200, { job: currentAutomationJob(contextRoot) });
  } catch {
    sendError(res, 500, 'run_status_failed', 'Failed to read the current run job.');
  }
}

/** GET /api/automations/:slug — full manifest + approval state + cache (incl. run history). */
export async function handleAutomationsShow(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const manifest = getAutomation(contextRoot, params.slug);
    if (!manifest) {
      sendError(res, 404, 'not_found', `Automation not found: ${params.slug}`);
      return;
    }
    const projectRoot = dirname(contextRoot);
    const approval = checkApproval(projectRoot, manifest);
    sendJson(res, 200, {
      automation: {
        slug: manifest.slug,
        title: manifest.title,
        enabled: manifest.enabled,
        schedule: manifest.schedule,
        scheduleLabel: formatSchedule(manifest.schedule),
        model: manifest.model,
        // `effort` belongs here for the same reason `model` does: this payload is
        // what the dashboard's full-field approval review renders, and approve MUST
        // show every APPROVAL_DIFF_FIELDS entry, never a subset — a reviewer who
        // cannot see a hashed field approves a manifest whose changed field is
        // invisible to them. Ordered between `model` and `timeoutMinutes` to mirror
        // canonicalApprovalPayload.
        effort: manifest.effort,
        timeoutMinutes: manifest.timeoutMinutes,
        catchupHours: manifest.catchupHours,
        outputDir: manifest.outputDir,
        // Hashed, so it rides here for exactly the reason `effort` does: a
        // reviewer approving from the dashboard must see every field the hash
        // covers. This one carries the most weight of any of them — it is the
        // switch that lets the run read notes it wrote itself.
        learning: manifest.learning,
        // Hashed too, and the one field on this list a reviewer is most likely
        // to be losing rather than gaining: `agent → off` on a synced manifest
        // means a human gate someone was relying on has been deleted.
        review: manifest.review,
        // Hashed, and it can carry the same loss in a different shape: deleting
        // a `hitl` node from the graph removes a human gate exactly as editing
        // `review` back to `off` does. Sent raw (null when the manifest has
        // none) — the canvas derives a display graph for that case itself, but
        // the REVIEW must show what was actually hashed, which is nothing.
        flow: manifest.flow,
        prompt: manifest.prompt,
        outputInstructions: manifest.outputInstructions,
        // NOT hashed and deliberately so (it changes every run), but shown:
        // "what has this automation learned" is unanswerable from the prompt
        // alone, and an unreviewable input the operator cannot even READ would
        // be the worst of both worlds.
        pattern: readPattern(manifest),
      },
      approved: approval.approved,
      approvalReason: approval.approved ? null : approval.reason,
      // Rides the same payload the approve screen renders, for the same reason
      // every hashed field does: the reviewer must see it BEFORE consenting. A
      // shared manifest whose synced history holds runs this machine never
      // performed is already running elsewhere, and approving it here runs it
      // duplicated. null ⇒ private manifest, no evidence either way.
      foreignRuns: foreignRunEvidence(contextRoot, manifest),
      cache: readAutomationCache(contextRoot, manifest.slug),
    });
  } catch {
    sendError(res, 500, 'show_failed', 'Failed to read the automation.');
  }
}

/**
 * GET /api/automations/:slug/session[?run=N] — what the headless claude session
 * for a run actually DID: its turns, tool calls, and failures.
 *
 * Read-only, and it reads a file OUTSIDE the project root
 * (`~/.claude/projects/…`) — but never a caller-supplied path. The only input
 * is `run`, an integer index into this automation's own recorded history; the
 * session id comes from that record, and the path is derived from the id by
 * scanning claude's own projects directory. There is no request field that can
 * name a file, so path traversal has no surface here to begin with.
 *
 * MUST be registered before `/api/automations/:slug` for the same reason
 * `runs` is — otherwise the sub-path is swallowed as a slug.
 */
export async function handleAutomationsSession(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const manifest = getAutomation(contextRoot, params.slug);
    if (!manifest) {
      sendError(res, 404, 'not_found', `Automation not found: ${params.slug}`);
      return;
    }
    const url = new URL(req.url ?? '', 'http://localhost');
    const rawRun = url.searchParams.get('run');
    const runNumber = rawRun === null ? undefined : Number(rawRun);
    if (runNumber !== undefined && (!Number.isInteger(runNumber) || runNumber < 1)) {
      sendError(res, 400, 'bad_run', 'run must be a positive integer (1 = most recent).');
      return;
    }
    const resolved = resolveRunSession(readAutomationCache(contextRoot, manifest.slug), { runNumber });
    if (!resolved) {
      sendJson(res, 200, { session: null });
      return;
    }
    // A missing transcript is a normal state, not an error: claude writes one
    // only once a session has produced a turn, and a run that never reached a
    // session has no id at all. The client renders the difference.
    const digest = resolved.transcriptPath ? readSessionDigest(resolved.transcriptPath) : null;
    sendJson(res, 200, {
      session: {
        runNumber: resolved.runNumber,
        firedAt: resolved.event.firedAt,
        status: resolved.event.status,
        error: resolved.event.error,
        costUsd: resolved.event.costUsd,
        numTurns: resolved.event.numTurns,
        permissionDenials: resolved.event.permissionDenials,
        outputPath: resolved.event.outputPath,
        sessionId: resolved.sessionId,
        transcriptPath: resolved.transcriptPath,
        items: digest?.items ?? [],
        toolCounts: digest?.toolCounts ?? {},
        toolCalls: digest?.toolCalls ?? 0,
        toolErrors: digest?.toolErrors ?? 0,
      },
    });
  } catch {
    sendError(res, 500, 'session_failed', 'Failed to read the run session.');
  }
}

/**
 * POST /api/automations/:slug/run — start (or adopt) a "run now" job. Reads
 * NOTHING from the request body — the automation's own manifest is the only
 * source of the prompt that will run, and `runAutomation` re-checks approval,
 * the sleep lock, and the orphan guard itself. A missing/unsafe slug 404s
 * before any job is created.
 */
export async function handleAutomationsRunNow(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const manifest = getAutomation(contextRoot, params.slug);
    if (!manifest) {
      sendError(res, 404, 'not_found', `Automation not found: ${params.slug}`);
      return;
    }
    const { job, started } = startAutomationJob(contextRoot, params.slug);
    sendJson(res, 200, { job, started });
  } catch {
    sendError(res, 500, 'run_failed', 'Failed to start the automation run.');
  }
}

/**
 * POST /api/automations/:slug/approve — record approval of the manifest as it
 * stands right now (the same primitive the CLI's `approve -y` calls after the
 * human reviews every hashed field; rendering that diff is a dashboard-side
 * concern against the fields already exposed by `GET /api/automations/:slug`).
 */
export async function handleAutomationsApprove(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const manifest = getAutomation(contextRoot, params.slug);
    if (!manifest) {
      sendError(res, 404, 'not_found', `Automation not found: ${params.slug}`);
      return;
    }
    const projectRoot = dirname(contextRoot);
    const entry = approveAutomation(projectRoot, manifest, new Date());
    sendJson(res, 200, { slug: manifest.slug, approval: entry });
  } catch {
    sendError(res, 500, 'approve_failed', 'Failed to approve the automation.');
  }
}

/**
 * POST /api/automations/:slug/enable | /disable — flip the manifest's own
 * `enabled` switch (the CLI's `automations enable|disable`, same primitive).
 *
 * `enabled` is deliberately NOT one of the approval-hashed fields, and this
 * write must keep it that way: `setAutomationEnabled` goes through
 * `updateFrontmatterFields`, which rewrites frontmatter only and never touches
 * the body — so `## Prompt` / `## Output instructions`, the two hashed body
 * sections, come back byte-identical and an approved automation stays
 * approved across a toggle. (The response re-summarizes through the same
 * `checkApproval` the list route uses, so a regression here would show up as
 * an automation that goes `blocked` the moment it is toggled.)
 *
 * Enabling is NOT a trust elevation: a disabled automation that is flipped on
 * still cannot run until it is approved on this machine, and still cannot fire
 * on a schedule until the dispatcher is installed.
 */
async function setEnabled(
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
  enabled: boolean,
): Promise<void> {
  const verb = enabled ? 'enable' : 'disable';
  try {
    if (!getAutomation(contextRoot, params.slug)) {
      sendError(res, 404, 'not_found', `Automation not found: ${params.slug}`);
      return;
    }
    const updated = setAutomationEnabled(contextRoot, params.slug, enabled);
    sendJson(res, 200, { automation: summarize(dirname(contextRoot), contextRoot, updated) });
  } catch (err) {
    if (err instanceof AutomationError) {
      sendError(res, 400, `${verb}_rejected`, err.message);
      return;
    }
    console.error(`[automations] ${verb} failed:`, err);
    sendError(res, 500, `${verb}_failed`, `Failed to ${verb} the automation.`);
  }
}

// ─── Flow graph ──────────────────────────────────────────────────────────────

/**
 * GET /api/automations/:slug/flow — the canvas source. An automation authored
 * with a `## Flow` block returns it verbatim (`derived: false`); one authored
 * before the flow feature existed (or that never added a block) gets a graph
 * DERIVED from its own schedule/model/review fields (`derived: true`) so the
 * canvas is never empty. `deriveFlowFromManifest` is pure and never writes —
 * the manifest's own `flow` stays `null` either way.
 */
export async function handleAutomationsFlow(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const manifest = getAutomation(contextRoot, params.slug);
    if (!manifest) {
      sendError(res, 404, 'not_found', `Automation not found: ${params.slug}`);
      return;
    }
    const flow: FlowGraph = manifest.flow ?? deriveFlowFromManifest(manifest);
    sendJson(res, 200, { flow, derived: manifest.flow === null });
  } catch {
    sendError(res, 500, 'flow_failed', 'Failed to read the automation flow.');
  }
}

// ─── Questions (human-in-the-loop) ──────────────────────────────────────────

/**
 * GET /api/automations/questions — every question awaiting an answer, across
 * all automations, oldest first. Deliberately project-wide (unlike the
 * `:slug`-gated routes below): the board's question is "what am I holding
 * up?", not "does this particular automation have one open" — this is the
 * dashboard's own board, not a per-automation bot.
 */
export async function handleAutomationsQuestionsList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    sendJson(res, 200, { questions: allPendingQuestions(contextRoot) });
  } catch {
    sendError(res, 500, 'questions_list_failed', 'Failed to read the questions queue.');
  }
}

/** Case/whitespace-insensitive decisions an `'approval'` question accepts.
 *  Deliberately a CLOSED set — see the doc comment on the branch below for why
 *  free text is never enough here, unlike `'flow-hitl'`. */
const APPROVAL_DECISIONS = { approve: true, yes: true, reject: false, no: false } as const;

/**
 * POST /api/automations/questions/:id — answer one question.
 *
 * Body is `{ answer: string }`. Branches on `question.kind` (S1), and the two
 * branches are NOT interchangeable — deliberately not just in WHAT they do,
 * but in WHAT COUNTS AS AN ANSWER:
 *
 *  - `'approval'` — the manifest changed since it was last approved, and the
 *    question is asking whether to trust it as it now stands. This is the
 *    sha256 tripwire's own gate wearing a dashboard face, so it takes an
 *    EXPLICIT decision (`approve`/`yes`/`reject`/`no`, case/whitespace
 *    insensitive) and nothing else — free text is rejected with a 400, never
 *    interpreted. The alternative (treat any non-empty string as consent)
 *    would convert "no, this looks wrong" into an approval: worse than no
 *    gate at all, because the human believes they refused. Approving NEVER
 *    resumes the asking session (that session ran read-only and is discarded
 *    either way) — it calls `approveAutomation` and starts a FRESH run
 *    through `startAutomationJob`, the exact same primitive `POST /:slug/run`
 *    uses, so there is exactly one spawn path for a dashboard-initiated run,
 *    not two. Rejecting claims and records the decision (so the question
 *    stops being pending and the same diff is not re-asked forever) but
 *    approves nothing and starts nothing — the manifest stays exactly as
 *    unapproved as it was, and the automation's own approval gate (not this
 *    route) decides what happens on the next fire. `claimQuestion` gates the
 *    race either way (two taps a second apart must not double-decide).
 *  - `'flow-hitl'` — an already-approved run stopped mid-flight to ask a
 *    question ABOUT ITS OWN WORK, not about whether to trust it, so free text
 *    is the correct and only shape of answer. `resumeWithAnswer` is the one
 *    path every channel (HTTP, CLI, Telegram) uses for this, and it re-checks
 *    the kind itself before touching anything — this route's branch is a
 *    nicer early exit for the wrong kind, not the defense. Do not fold this
 *    branch back into the one above: the two kinds disagree about whether
 *    prose is ever an acceptable answer, and that disagreement is the point.
 */
export async function handleAutomationsQuestionAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const question = allPendingQuestions(contextRoot).find((q) => q.id === params.id);
    if (!question) {
      sendError(res, 404, 'not_found', 'That question is not open — it may have been answered elsewhere.');
      return;
    }
    const body = await parseJsonBody(req);
    const answer = typeof body?.answer === 'string' ? body.answer : '';
    if (!answer.trim()) {
      sendError(res, 400, 'bad_request', 'answer must be a non-empty string.');
      return;
    }

    if (question.kind === 'approval') {
      const manifest = getAutomation(contextRoot, question.slug);
      if (!manifest) {
        sendError(res, 404, 'not_found', `Automation not found: ${question.slug}`);
        return;
      }
      const decision = answer.trim().toLowerCase() as keyof typeof APPROVAL_DECISIONS;
      if (!(decision in APPROVAL_DECISIONS)) {
        sendError(
          res,
          400,
          'bad_request',
          `An approval question takes an explicit decision, not free text — answer must be one of: ${Object.keys(APPROVAL_DECISIONS).join(', ')}.`,
        );
        return;
      }
      const claim = claimQuestion(contextRoot, question, answer, 'dashboard');
      if (!claim.claimed) {
        sendError(res, 409, 'refused', claim.reason);
        return;
      }
      if (!APPROVAL_DECISIONS[decision]) {
        // REJECTED. Recorded and done — no approval, no run. The manifest is
        // left exactly as unapproved as it was; the next fire refuses through
        // the SAME sha256 tripwire, never through a side door opened here.
        sendJson(res, 200, { question: claim.question, status: 'ok', error: null, result: null, approved: false });
        return;
      }
      // APPROVED. The exact primitive `handleAutomationsApprove` uses, then
      // the exact primitive `handleAutomationsRunNow` uses — never a second
      // spawn path.
      approveAutomation(dirname(contextRoot), manifest, new Date());
      const { job, started } = startAutomationJob(contextRoot, question.slug);
      sendJson(res, 200, {
        question: claim.question,
        status: 'ok',
        error: null,
        result: null,
        approved: true,
        job,
        started,
      });
      return;
    }

    const outcome = await resumeWithAnswer(contextRoot, question, answer, 'dashboard');
    if (outcome.status === 'refused') {
      // 409, not 500: the question was answered elsewhere, or cannot be
      // answered this way. That is a legitimate state the UI must render.
      sendError(res, 409, 'refused', outcome.error ?? 'that question could not be answered');
      return;
    }
    sendJson(res, 200, {
      question: outcome.question,
      status: outcome.status,
      error: outcome.error,
      result: outcome.result,
    });
  } catch (err) {
    console.error('[automations] question answer failed:', err);
    sendError(res, 500, 'question_failed', 'Failed to answer the question.');
  }
}

// ─── Per-automation Telegram config ─────────────────────────────────────────

/** What the dashboard needs to answer "is Telegram set up for this
 *  automation, and where does it reply" — never the bot token itself, the
 *  same shape discipline `GET /api/lab/credentials` uses for lab secrets. */
interface TelegramConfigView {
  configured: boolean;
  chatId: string | null;
}

function telegramView(cfg: ReturnType<typeof readTelegramConfigForSlug>): TelegramConfigView {
  return cfg ? { configured: true, chatId: cfg.chatId } : { configured: false, chatId: null };
}

/** GET /api/automations/:slug/telegram — presence + chat id only. The bot
 *  token is a capability (it can resume a `bypassPermissions` session) and
 *  never leaves this process. */
export async function handleAutomationsTelegramGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    if (!getAutomation(contextRoot, params.slug)) {
      sendError(res, 404, 'not_found', `Automation not found: ${params.slug}`);
      return;
    }
    sendJson(res, 200, { telegram: telegramView(readTelegramConfigForSlug(params.slug)) });
  } catch {
    sendError(res, 500, 'telegram_status_failed', 'Failed to read the Telegram configuration.');
  }
}

/**
 * POST /api/automations/:slug/telegram — set (or replace) this automation's
 * bot credentials. Body is `{ botToken: string, chatId: string }`; both are
 * required non-empty strings. The response echoes the same presence-only
 * shape the GET route returns — the token that was just written is never
 * read back over HTTP.
 *
 * The `offset` (getUpdates cursor) is carried over from any existing config
 * rather than reset to 0: re-saving the same bot must not replay updates it
 * already processed. A genuinely new bot (no prior config) starts at 0.
 */
export async function handleAutomationsTelegramSet(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    if (!getAutomation(contextRoot, params.slug)) {
      sendError(res, 404, 'not_found', `Automation not found: ${params.slug}`);
      return;
    }
    const body = await parseJsonBody(req);
    const botToken = typeof body?.botToken === 'string' ? body.botToken.trim() : '';
    const chatId = typeof body?.chatId === 'string' ? body.chatId.trim() : '';
    if (!botToken || !chatId) {
      sendError(res, 400, 'invalid_body', 'Request body must be { botToken, chatId } with non-empty strings.');
      return;
    }
    const existing = readTelegramConfigForSlug(params.slug);
    writeTelegramConfigForSlug(params.slug, { botToken, chatId, offset: existing?.offset ?? 0 });
    sendJson(res, 200, { telegram: telegramView(readTelegramConfigForSlug(params.slug)) });
  } catch (err) {
    if (err instanceof AutomationError) {
      sendError(res, 400, 'telegram_rejected', err.message);
      return;
    }
    console.error('[automations] telegram set failed:', err);
    sendError(res, 500, 'telegram_failed', 'Failed to store the Telegram configuration.');
  }
}

// ─── Queue (machine-local, deferred fires) ──────────────────────────────────

/**
 * GET /api/automations/queue — every fire waiting for this project's lock to
 * clear (D9). Read-only: `queuedFire` is a lookup, never `drainQueue`, which
 * would clear entries a GET must not have the side effect of consuming.
 */
export async function handleAutomationsQueue(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const projectRoot = dirname(contextRoot);
    const queue = listAutomations(contextRoot)
      .map((m) => queuedFire(projectRoot, m.slug))
      .filter((q): q is QueuedFire => q !== null);
    sendJson(res, 200, { queue });
  } catch {
    sendError(res, 500, 'queue_failed', 'Failed to read the automations queue.');
  }
}

export async function handleAutomationsEnable(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  await setEnabled(res, params, contextRoot, true);
}

export async function handleAutomationsDisable(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  await setEnabled(res, params, contextRoot, false);
}

// ─── Dispatcher (the machine-local scheduler switch) ─────────────────────────

/**
 * What the dashboard needs to answer one question — "is the scheduler on for
 * this machine, and does it cover this project?" — plus the two states that
 * make an installed dispatcher a liar: a STALE install (the CLI moved, so the
 * baked wrapper points somewhere else) and a project that was never registered
 * (manifests exist, the dispatcher ticks, but never looks here — the shape a
 * teammate-synced `automations/` directory arrives in).
 */
interface DispatcherView {
  /** macOS-only in v1; Linux cron is a later backend behind the same seam. */
  supported: boolean;
  platform: string;
  /** Both halves on disk AND booted into launchd — anything less never fires. */
  installed: boolean;
  /** Installed AND byte-current: re-rendering now would reproduce both files. */
  current: boolean;
  bootstrapped: boolean;
  plistPresent: boolean;
  plistCurrent: boolean;
  wrapperPresent: boolean;
  wrapperCurrent: boolean;
  /** The dispatcher would run a DIFFERENT `dreamcontext` than this server. */
  mismatch: boolean;
  resolvedBin: string | null;
  runningBin: string | null;
  logPath: string;
  logSizeBytes: number;
  /** Is THIS project in the machine-local registry the dispatcher walks? */
  projectRegistered: boolean;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  notifier: { supported: boolean; present: boolean; current: boolean };
}

function dispatcherView(check: InstallCheck, contextRoot: string): DispatcherView {
  const installed = check.plistPresent && check.wrapperPresent && check.bootstrapped;
  const notifier = inspectNotifier();
  const heartbeat = readDispatcherHeartbeat();
  return {
    supported: process.platform === 'darwin',
    platform: process.platform,
    installed,
    current: installed && check.plistCurrent && check.wrapperCurrent,
    bootstrapped: check.bootstrapped,
    plistPresent: check.plistPresent,
    plistCurrent: check.plistCurrent,
    wrapperPresent: check.wrapperPresent,
    wrapperCurrent: check.wrapperCurrent,
    mismatch: check.mismatch,
    resolvedBin: check.resolved.bin,
    runningBin: check.runningBin,
    logPath: check.logPath,
    logSizeBytes: check.logSizeBytes,
    projectRegistered: listRegisteredProjects().includes(dirname(contextRoot)),
    lastTickStartedAt: heartbeat.lastTickStartedAt,
    lastTickCompletedAt: heartbeat.lastTickCompletedAt,
    notifier: {
      supported: notifier.supported,
      present: notifier.bundlePresent,
      current: notifier.bundlePresent && notifier.scriptCurrent,
    },
  };
}

/**
 * GET /api/automations/dispatcher — read-only scheduler state. Writes nothing
 * (`inspectDispatcher` is the same read-only primitive `install --check` uses).
 *
 * MUST be registered before `/api/automations/:slug` for the same reason
 * `/runs` is — a literal sub-path registered after a param route is swallowed
 * by it.
 */
export async function handleAutomationsDispatcherStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    sendJson(res, 200, { dispatcher: dispatcherView(await inspectDispatcher(), contextRoot) });
  } catch (err) {
    console.error('[automations] dispatcher status failed:', err);
    sendError(res, 500, 'dispatcher_status_failed', 'Failed to inspect the automations dispatcher.');
  }
}

/**
 * POST /api/automations/dispatcher/install — turn the scheduler on for this
 * machine. The dashboard half of `dreamcontext automations install`.
 *
 * This does NOT weaken the feature's "ships completely disabled, opt-in only"
 * stance — it adds a second surface for the SAME explicit human opt-in, and
 * nothing about what runs changes: every automation still needs its own
 * machine-local SHA256 approval before the dispatcher will execute it, and the
 * approval tripwire, sleep deference and orphan guard all still live inside
 * the runner. What this route can do is exactly what a user sitting at the CLI
 * can do; it accepts no path, no prompt and no schedule from the request.
 *
 * The only body field is `force`, which mirrors `install --force`: it overrides
 * a resolution MISMATCH (the dispatcher would bake in a different
 * `dreamcontext` than the one serving this request). Without it, a mismatch
 * writes nothing and comes back as a warning for the human to decide on —
 * the same soft refusal the CLI gives.
 *
 * `registerProject` is called here but NOT by the CLI's `install`, deliberately:
 * the CLI registers at `automations create`, which is the only way a manifest
 * reaches disk through it. A dashboard user can be looking at manifests that
 * arrived over brain sync from a teammate, where nothing local ever registered
 * this project — so the dispatcher would tick forever and never look here.
 * Registration is idempotent and carries no execution rights of its own.
 */
export async function handleAutomationsDispatcherInstall(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const body = await parseJsonBody(req);
    const force = body?.force === true;
    const result = await installDispatcher({ force });

    // `installed` is read off the same view the response embeds, so the flag can
    // never contradict the state next to it — and it means "this will actually
    // fire", not "some bytes were written". Two paths write files and still fire
    // nothing: the soft mismatch refusal (writes nothing at all) and a
    // `launchctl bootstrap` that failed after both files landed. Both must come
    // back as NOT installed, with the reason in `warnings`.
    const view = dispatcherView(result.check, contextRoot);
    const installed = view.installed;
    if (installed) registerProject(dirname(contextRoot));

    // The notifier rides install for the same reason it does in the CLI:
    // building a bundle means osacompile + codesign + lsregister, which has no
    // business running while an automation is trying to finish. A failure is
    // never fatal — runs fall back to a generic system icon and still notify.
    let notifierBuilt = false;
    let notifierReason: string | null = null;
    if (installed) {
      const built = buildNotifierApp();
      notifierBuilt = built.built;
      notifierReason = built.built ? null : built.reason;
      if (built.built) {
        // Prime macOS's permission prompt NOW, while a human is at the screen
        // and has just clicked something. macOS does not error on an
        // unauthorised notification — it files it away invisibly, so without
        // this the first real failure of an unattended run is a notification
        // that never appears and never explains itself.
        notifyViaBundle('dreamcontext', 'Notifications are set up. Allow them if macOS just asked.', undefined, {
          sound: NOTIFY_SOUND_OK,
        });
      }
    }

    sendJson(res, 200, {
      installed,
      method: result.method,
      warnings: result.warnings,
      notifier: { built: notifierBuilt, reason: notifierReason },
      dispatcher: view,
    });
  } catch (err) {
    if (err instanceof AutomationError) {
      // Unsupported platform / unresolvable CLI — a refusal with a reason the
      // user can act on, not a server fault.
      sendError(res, 400, 'install_rejected', err.message);
      return;
    }
    console.error('[automations] dispatcher install failed:', err);
    sendError(res, 500, 'install_failed', 'Failed to install the automations dispatcher.');
  }
}

/**
 * POST /api/automations/dispatcher/uninstall — turn the scheduler back off.
 * Boots the agent out and deletes the plist + wrapper; approvals, manifests and
 * run history are all left untouched (uninstall removes the scheduler, not the
 * automations), exactly as the CLI verb does.
 */
export async function handleAutomationsDispatcherUninstall(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const result = await uninstallDispatcher();
    const notifier = removeNotifierApp();
    sendJson(res, 200, {
      bootedOut: result.bootedOut,
      removedPlist: result.removedPlist,
      removedWrapper: result.removedWrapper,
      removedNotifier: notifier.removedBundle,
      dispatcher: dispatcherView(await inspectDispatcher(), contextRoot),
    });
  } catch (err) {
    if (err instanceof AutomationError) {
      sendError(res, 400, 'uninstall_rejected', err.message);
      return;
    }
    console.error('[automations] dispatcher uninstall failed:', err);
    sendError(res, 500, 'uninstall_failed', 'Failed to remove the automations dispatcher.');
  }
}


/**
 * GET /api/automations/attention — the runs that want a human and have not
 * been shown on this machine yet, oldest first, plus the current watermark.
 *
 * READ-ONLY BY DESIGN. It does not advance the watermark; `POST .../ack` does,
 * once the client has actually opened the tabs. A read that consumed would
 * lose the entire window whenever the app was closed or refreshed mid-open,
 * which is the exact moment this exists to cover.
 *
 * Project-wide, like `/questions` and for the same reason: the question a user
 * has when their app opens is "what happened overnight", not "did this one
 * automation need me".
 */
export async function handleAutomationsAttention(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const projectRoot = dirname(contextRoot);
    const since = attentionWatermark(projectRoot);
    sendJson(res, 200, { runs: attentionRuns(contextRoot, since), watermark: since });
  } catch {
    sendError(res, 500, 'attention_failed', 'Failed to read runs needing attention.');
  }
}

/**
 * POST /api/automations/attention/ack — mark everything up to `upTo` as shown.
 *
 * Body is `{ upTo: string }` (an ISO timestamp, normally the newest `at` the
 * client just opened). The advance is MONOTONIC inside `ackAttention`: an
 * older mark than the one on disk is ignored, so two windows acking out of
 * order cannot rewind the watermark and re-open tabs the user already dealt
 * with.
 *
 * This grants nothing and starts nothing — it only ever narrows what a future
 * read returns.
 */
export async function handleAutomationsAttentionAck(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const body = await parseJsonBody(req);
    const upTo = typeof body?.upTo === 'string' ? body.upTo : '';
    if (!upTo || !Number.isFinite(Date.parse(upTo))) {
      sendError(res, 400, 'bad_watermark', 'Body must be { upTo: <ISO timestamp> }.');
      return;
    }
    const projectRoot = dirname(contextRoot);
    ackAttention(projectRoot, upTo);
    sendJson(res, 200, { watermark: attentionWatermark(projectRoot) });
  } catch {
    sendError(res, 500, 'attention_ack_failed', 'Failed to record the watermark.');
  }
}
