import { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import {
  getAutomation,
  listAutomations,
  readAutomationCache,
  readPattern,
  setAutomationEnabled,
  deriveFlowFromManifest,
  createAutomation,
  updateAutomation,
  removeAutomation,
  writeFlowSection,
  automationPhotosDir,
  photoRelPathFor,
  resolveAutomationPhoto,
  cadenceLabel,
  isSafeAutomationSlug,
} from '../../lib/automations/store.js';
import { resolveRunSession, readSessionDigest } from '../../lib/automations/session.js';
import { foreignRunEvidence } from '../../lib/automations/session-registry.js';
import {
  checkApproval,
  approveAutomation,
  listRegisteredProjects,
  registerProject,
  revokeApproval,
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
import { sniffImageType, EXT_BY_IMAGE_TYPE } from '../../lib/image-sniff.js';
import { allPendingQuestions, claimQuestion, pendingQuestion } from '../../lib/automations/hitl.js';
import { resumeWithAnswer } from '../../lib/automations/verdict.js';
import { queuedFire, type QueuedFire } from '../../lib/automations/queue.js';
import { ackAttention, attentionRuns, attentionWatermark } from '../../lib/automations/attention.js';
import { buildFeed, readRunAnswer, threadReplies, threadRootId } from '../../lib/automations/feed.js';
import {
  appendThreadEntry, listThreadRuns, markThreadRead, readThread, threadUnread,
} from '../../lib/automations/threads.js';
import { latestBoundSession, readAutomationSession } from '../../lib/automations/session-registry.js';
import { findTranscriptBySessionId } from '../../lib/transcript-locate.js';
import { readTelegramConfigForSlug, writeTelegramConfigForSlug } from '../../lib/automations/telegram.js';
import {
  startAutomationJob, currentAutomationJob, runningAutomationJobs,
  startAutomationReplyJob, currentReplyJob, reconcileReplyThreads,
} from '../automation-job.js';

/** The feed's hard ceiling. A channel is read from the bottom: a window past
 *  this is scrollback nobody reaches, and the poll that refreshes it every
 *  few seconds pays for every message it carries. */
const FEED_MAX_MESSAGES = 200;
/** What one line in the composer may carry. A generous paragraph, not a
 *  document — an ask is a sentence to an agent that already knows its job, and
 *  `THREAD_TEXT_MAX_CHARS` would truncate anything longer in the store anyway. */
const SAY_MAX_CHARS = 2000;
import {
  AutomationError,
  AUTOMATION_MODES,
  EFFORT_LEVELS,
  MAX_TIMEOUT_MINUTES,
  WEEKDAYS,
  type AutomationCache,
  type AutomationManifest,
  type AutomationMode,
  type AutomationQuestion,
  type EffortLevel,
  type FlowGraph,
  type Weekday,
  THREAD_TEXT_MAX_CHARS,
} from '../../lib/automations/types.js';

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
  /** See `AutomationMode` — `'call'` agents show no pause switch and are never
   *  fired by the dispatcher. */
  mode: AutomationMode;
  /** True when this agent has a photo that actually resolves and exists RIGHT
   *  NOW (`resolveAutomationPhoto`), not merely a `photo` string in its
   *  frontmatter. The card renders initials when this is false, so the manifest
   *  never gets to promise a picture the photo route would then refuse. The raw
   *  path is deliberately NOT on the wire: the client fetches the bytes from
   *  `GET /api/automations/:slug/photo` and has no use for a filesystem path. */
  hasPhoto: boolean;
  enabled: boolean;
  schedule: AutomationManifest['schedule'];
  scheduleLabel: string;
  /** What this agent DOES, in the owner's own words — its `## Prompt`, capped.
   *  The dialog writes the prompt from the plain-language description, so the
   *  prompt IS the description and there is no second field to drift from it. */
  description: string;
  /** `scheduleLabel` for a scheduled agent, 'When you call it' for an on-call
   *  one. One server-side string so the card, the profile popover and the CLI
   *  can never word an agent's cadence differently. */
  cadenceLabel: string;
  model: string | null;
  /** On the summary (not only the detail) because the Edit dialog prefills
   *  from the LIST — opening it must not have to fetch the manifest first, or
   *  the form flashes a default effort the owner never chose. */
  effort: AutomationManifest['effort'];
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
    mode: m.mode,
    hasPhoto: resolveAutomationPhoto(contextRoot, m.photo) !== null,
    description: m.prompt.trim().slice(0, DESCRIPTION_MAX_CHARS),
    cadenceLabel: cadenceLabel(m),
    model: m.model,
    effort: m.effort,
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
 * GET /api/automations/runs — poll the project's newest "run now" job (a running one
 * first). Slots are per agent now; the per-agent view rides on the feed (`runSlots`).
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

// ─── Create / edit / delete an agent, and its photo ──────────────────────────
//
// These are the FIRST routes in this file that write a manifest, so the
// security stance stated at the top of the file needs one addition rather than
// a restatement: nothing here lets a request choose a PATH. The slug is a
// client-supplied string, which is exactly why every one of these handlers
// runs it through `isSafeAutomationSlug` before it reaches a path join, and the
// photo's filename is derived from the uploaded bytes' magic number plus that
// validated slug — never from a filename, a content-type header, or anything
// else the client sends.
//
// The PROMPT is still never supplied over HTTP in the sense the file header
// means: a prompt written here lands in a manifest, and that manifest is then
// approved on THIS machine by the same `approveAutomation` primitive the CLI
// calls. A person sitting at this Mac authoring their own agent is the entire
// trust model — the tripwire exists to catch a manifest changing UNDER them
// (a teammate's sync, a hand edit), not to stop them writing one.

/** How much of an agent's prompt a card shows. Bounded because the list
 *  endpoint is polled and a prompt has no length limit — the dialog holds the
 *  whole thing, this is the preview. */
const DESCRIPTION_MAX_CHARS = 600;

/** An agent photo is a small square rendered at 56px at its largest. 4 MB is
 *  already absurdly generous for that and bounds what one manifest can pin
 *  into the brain directory. */
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A client-supplied mode, or `undefined` when absent. Throws on a value that
 *  is present and wrong, rather than silently falling back to `'sched'` — a
 *  dialog that sends garbage has a bug, and scheduling an agent the owner
 *  asked to be on-call is the wrong way to find out. */
function readMode(v: unknown): AutomationMode | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && (AUTOMATION_MODES as readonly string[]).includes(v)) return v as AutomationMode;
  throw new AutomationError(`Invalid mode — must be one of: ${AUTOMATION_MODES.join(', ')}.`);
}

function readEffort(v: unknown): EffortLevel | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)) return v as EffortLevel;
  throw new AutomationError(`Invalid effort — must be one of: ${EFFORT_LEVELS.join(', ')}.`);
}

/** `days` off the wire: `'daily'` or an array of weekdays. Every token is
 *  checked here so the error names the bad day rather than the whole schedule. */
function readDays(v: unknown): 'daily' | Weekday[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === 'daily') return 'daily';
  if (!Array.isArray(v)) throw new AutomationError('Invalid days — use "daily" or a list of weekdays.');
  const days = v.map((d) => String(d).trim().toLowerCase());
  const bad = days.filter((d) => !(WEEKDAYS as readonly string[]).includes(d));
  if (bad.length > 0) throw new AutomationError(`Invalid weekday(s): ${bad.join(', ')}.`);
  if (days.length === 0) throw new AutomationError('Pick at least one day, or switch the agent to on-call.');
  return days as Weekday[];
}

function readTimeout(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > MAX_TIMEOUT_MINUTES) {
    throw new AutomationError(`timeout_minutes must be between 1 and ${MAX_TIMEOUT_MINUTES}.`);
  }
  return n;
}

/**
 * Turn a title into a slug the store will accept.
 *
 * The result is still handed to `isSafeAutomationSlug` inside
 * `createAutomation` — this is a convenience, not the gate. It exists so the
 * dialog can send a title and let ONE implementation derive the slug, rather
 * than the browser and the server each having their own idea of what
 * "Daily insight digest" becomes and quietly disagreeing.
 */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Record approval of a just-written manifest on THIS machine.
 *
 * The exact pairing `automations create` uses (`registerProject` then
 * `approveAutomation`), and it is deliberately duplicated here rather than
 * pulled into the store: `updateAutomation` must not grant trust on its own
 * (see its doc comment), so the grant belongs to each local write SURFACE,
 * where a human is demonstrably present and the button says what it is doing.
 *
 * Registering the project is not incidental — a brand-new brain has no entry
 * in `~/.dreamcontext/automations.json`, so without it the dispatcher would
 * tick and never look here, and the owner's first agent would silently never
 * fire.
 */
function approveHere(contextRoot: string, manifest: AutomationManifest): void {
  const projectRoot = dirname(contextRoot);
  registerProject(projectRoot);
  approveAutomation(projectRoot, manifest, new Date());
}

/** POST /api/automations — create an agent and approve it on this machine. */
export async function handleAutomationsCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'bad_body', 'Expected a JSON body.');
    return;
  }
  try {
    const title = (str(body.title) ?? '').trim();
    if (!title) throw new AutomationError('Give the agent a name.');
    const prompt = (str(body.prompt) ?? '').trim();
    if (!prompt) throw new AutomationError('Describe what the agent should do — that description is its prompt.');

    const mode = readMode(body.mode) ?? 'sched';
    const slug = (str(body.slug) ?? '').trim() || slugifyTitle(title);
    if (!isSafeAutomationSlug(slug)) {
      throw new AutomationError(`"${title}" does not make a usable name — try plain letters and numbers.`);
    }
    if (getAutomation(contextRoot, slug)) {
      throw new AutomationError(`An agent called "${slug}" already exists.`);
    }

    let manifest = createAutomation(contextRoot, {
      slug,
      title,
      mode,
      // The photo is uploaded SEPARATELY, after the manifest exists, because
      // its filename is `<slug>.<ext>` and the slug is only settled here. The
      // client posts the bytes to the photo route next; a failure there leaves
      // an agent with initials, never a half-written manifest.
      photo: null,
      days: readDays(body.days) ?? 'daily',
      at: str(body.at) ?? '09:00',
      model: str(body.model) ?? null,
      effort: readEffort(body.effort) ?? null,
      timeoutMinutes: readTimeout(body.timeoutMinutes),
      prompt,
    });
    // Same ordering as the CLI's create: the flow is derived and written
    // BEFORE approval, so the hash granted covers the exact manifest on disk.
    manifest = writeFlowSection(contextRoot, manifest.slug, deriveFlowFromManifest(manifest));
    approveHere(contextRoot, manifest);

    sendJson(res, 200, { automation: summarize(dirname(contextRoot), contextRoot, manifest) });
  } catch (err) {
    if (err instanceof AutomationError) {
      sendError(res, 400, 'invalid', err.message);
      return;
    }
    console.error('[automations] create failed', err);
    sendError(res, 500, 'create_failed', 'Failed to create the agent.');
  }
}

/**
 * POST /api/automations/:slug/update — edit an agent and RE-approve it here.
 *
 * Re-approval is the point of the button's wording ("Save and re-approve on
 * this Mac"): `prompt`, `model`, `effort` and `timeoutMinutes` are all
 * approval-hashed, so an edit necessarily changes the hash and would otherwise
 * leave the agent blocked until someone approved it by hand. The person who
 * just typed the new prompt is the person the tripwire would be asking.
 */
export async function handleAutomationsUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'bad_body', 'Expected a JSON body.');
    return;
  }
  try {
    if (!isSafeAutomationSlug(params.slug) || !getAutomation(contextRoot, params.slug)) {
      sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
      return;
    }
    const manifest = updateAutomation(contextRoot, params.slug, {
      title: str(body.title),
      mode: readMode(body.mode),
      days: readDays(body.days),
      at: str(body.at),
      model: body.model === undefined ? undefined : (str(body.model) ?? null),
      effort: readEffort(body.effort),
      timeoutMinutes: readTimeout(body.timeoutMinutes),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      prompt: str(body.prompt),
    });
    approveHere(contextRoot, manifest);
    sendJson(res, 200, { automation: summarize(dirname(contextRoot), contextRoot, manifest) });
  } catch (err) {
    if (err instanceof AutomationError) {
      sendError(res, 400, 'invalid', err.message);
      return;
    }
    console.error('[automations] update failed', err);
    sendError(res, 500, 'update_failed', 'Failed to save the agent.');
  }
}

/**
 * POST /api/automations/:slug/delete — remove the manifest, its cache, its
 * lock/sidecar and its photo, and revoke this machine's approval.
 *
 * POST rather than DELETE deliberately: `index.ts`'s cross-site write guard is
 * written against state-changing POSTs, and a verb that slips past a central
 * security check to read more nicely is a bad trade.
 *
 * Revoking approval is not tidiness. A slug can come BACK — re-created here, or
 * synced in from a teammate — and a stale grant keyed by that slug would mean
 * the new manifest arrived pre-trusted without anyone reading it.
 */
export async function handleAutomationsDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    if (!isSafeAutomationSlug(params.slug) || !getAutomation(contextRoot, params.slug)) {
      sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
      return;
    }
    removeAutomation(contextRoot, params.slug);
    try {
      revokeApproval(dirname(contextRoot), params.slug);
    } catch (err) {
      // The manifest is already gone, which is the part that matters — a
      // registry that could not be rewritten must not turn a completed delete
      // into an error the user would retry against a slug that no longer exists.
      console.error('[automations] delete: could not revoke approval', err);
    }
    sendJson(res, 200, { ok: true, slug: params.slug });
  } catch (err) {
    if (err instanceof AutomationError) {
      sendError(res, 400, 'invalid', err.message);
      return;
    }
    console.error('[automations] delete failed', err);
    sendError(res, 500, 'delete_failed', 'Failed to delete the agent.');
  }
}

/**
 * POST /api/automations/:slug/photo — raw image bytes in, `<slug>.<ext>` out.
 *
 * Modelled on `/api/agent/drop`, and hardened the same way, because it is the
 * one place in this file where a request body becomes a FILE inside the brain:
 *
 *  - the body is capped PER CHUNK while streaming, so an oversized upload is
 *    refused mid-flight rather than buffered into memory first;
 *  - the type comes from MAGIC BYTES, never the `Content-Type` header — a
 *    header saying `image/png` over a shell script would otherwise write a
 *    `.png` that is not one;
 *  - SVG is not in the allow-list (`sniffImageType` has no SVG branch), for
 *    the reason stated in `agent-chat.ts`: an SVG can carry `<script>`, and
 *    this file IS served back to the dashboard;
 *  - the written path is `<photos dir>/<validated slug><derived ext>` — every
 *    component constructed here, none of it client-chosen.
 *
 * Writing the manifest's `photo` key is part of the same request: an uploaded
 * file no manifest points at would be a leak of disk with no owner.
 */
export async function handleAutomationsPhotoUpload(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const slug = params.slug;
  if (!isSafeAutomationSlug(slug) || !getAutomation(contextRoot, slug)) {
    sendError(res, 404, 'not_found', `Agent not found: ${slug}`);
    return;
  }

  const buf = await readCappedBody(req, res, MAX_PHOTO_BYTES);
  if (!buf) return; // 413 already sent, or the stream errored
  if (buf.length === 0) {
    sendError(res, 400, 'empty', 'No image data was received.');
    return;
  }

  const type = sniffImageType(buf);
  if (!type) {
    sendError(res, 415, 'unsupported_type', 'That file is not a PNG, JPEG, GIF or WebP image.');
    return;
  }

  try {
    const ext = EXT_BY_IMAGE_TYPE[type];
    const rel = photoRelPathFor(slug, ext);
    const dir = automationPhotosDir(contextRoot);
    mkdirSync(dir, { recursive: true });
    // An agent has exactly ONE photo file, so a new upload in a different
    // format must take the old one with it — otherwise `daily.png` lingers
    // after `daily.webp` replaces it, unreferenced and undeletable from the UI.
    for (const otherExt of Object.values(EXT_BY_IMAGE_TYPE)) {
      if (otherExt === ext) continue;
      try { unlinkSync(join(dir, `${slug}${otherExt}`)); } catch { /* never existed */ }
    }
    writeFileSync(join(dir, `${slug}${ext}`), buf);
    // `photo` is not approval-hashed, so this write cannot block the agent —
    // which is why it does not re-approve and does not need to.
    const manifest = updateAutomation(contextRoot, slug, { photo: rel });
    sendJson(res, 200, { automation: summarize(dirname(contextRoot), contextRoot, manifest) });
  } catch (err) {
    if (err instanceof AutomationError) {
      sendError(res, 400, 'invalid', err.message);
      return;
    }
    console.error('[automations] photo upload failed', err);
    sendError(res, 500, 'photo_failed', 'Failed to save the photo.');
  }
}

/**
 * GET /api/automations/:slug/photo — the bytes, or a 404.
 *
 * Reads through `resolveAutomationPhoto`, which is the ONLY reason this route
 * cannot be turned into an arbitrary file reader: the manifest is synced
 * markdown whose `photo` string a teammate or a hand edit controls, and that
 * gate refuses anything not sitting directly inside the photos directory. A
 * 404 here is what the card renders initials for.
 *
 * `no-store` because a photo is replaced in place at a stable URL — a cached
 * one would leave the owner looking at the picture they just changed.
 */
export async function handleAutomationsPhotoGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const manifest = isSafeAutomationSlug(params.slug) ? getAutomation(contextRoot, params.slug) : null;
    const abs = manifest ? resolveAutomationPhoto(contextRoot, manifest.photo) : null;
    if (!abs) {
      sendError(res, 404, 'no_photo', 'This agent has no photo.');
      return;
    }
    const ext = extname(abs).toLowerCase();
    const type = PHOTO_CONTENT_TYPE[ext];
    if (!type) {
      // A file with an extension outside the allow-list can only have arrived
      // by a hand edit — serve nothing rather than guess a content type.
      sendError(res, 404, 'no_photo', 'This agent has no photo.');
      return;
    }
    const bytes = readFileSync(abs);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
    });
    res.end(bytes);
  } catch {
    sendError(res, 404, 'no_photo', 'This agent has no photo.');
  }
}

/** The extensions this route will hand back, and as what. Derived from the
 *  same magic-byte allow-list the upload uses, so the two can never disagree
 *  about which types exist. */
const PHOTO_CONTENT_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_IMAGE_TYPE).map(([mime, ext]) => [ext, mime]),
);

/**
 * Stream a request body with a PER-CHUNK cap — the same shape as
 * `agent-drop.ts`'s reader and for the same reason: a
 * buffer-then-check would let an oversized upload allocate first and be
 * refused afterwards, which is not a cap at all.
 */
function readCappedBody(req: IncomingMessage, res: ServerResponse, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        sendError(res, 413, 'too_large', `The photo exceeds the ${Math.round(max / (1024 * 1024))} MB limit.`);
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
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

// ─── The channel ───────────────────────────────────────────────────────────

/**
 * GET /api/automations/threads — the whole `#agents` feed.
 *
 * One message per RUN across every agent, plus the per-slug unread counts the
 * filter chips and the sidebar badge read. MUST be registered before
 * `/api/automations/:slug` — `threads` would otherwise be captured as a slug,
 * the same rule `runs` and `questions` already follow.
 *
 * Reading this NEVER consumes unread. The watermark advances only through the
 * explicit ack below, for the reason `attention` splits the two: a poll that
 * marked things read would clear a badge for a window nobody was looking at.
 */
export async function handleAutomationsThreads(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    // THE RECONCILE CALL SITE. There is no "project opened" lifecycle in this server —
    // `contextRoot` is resolved per request — so the first threads-overview request for a
    // vault in a new process IS that vault's boot. Memoized per contextRoot inside, so the
    // 15-second poll pays for it exactly once; awaited so a restart's "outcome unknown"
    // note is already in the payload the client is about to render.
    await reconcileReplyThreads(contextRoot);
    const url = new URL(req.url ?? '', 'http://localhost');
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, FEED_MAX_MESSAGES) : FEED_MAX_MESSAGES;
    // THE RUN SLOTS ride on the feed, one per agent with a run in flight — started
    // from another tab, by "run now", or by an @mention — so the channel knows who is
    // busy without a second poll of its own. Only running jobs: a settled one is not a
    // reason to refuse anything. Scheduler fires and reply turns are not here; the
    // per-slug run lock settles those.
    const runSlots = Object.fromEntries(runningAutomationJobs(contextRoot).map((j) => [
      j.slug, { runId: j.runId ?? null, startedAt: j.startedAt },
    ]));
    sendJson(res, 200, { ...buildFeed(contextRoot, { limit }), runSlots });
  } catch {
    sendError(res, 500, 'feed_failed', 'Failed to read the agents channel.');
  }
}

/**
 * GET /api/automations/:slug/thread?run=<fired-at> — one run's thread, in id
 * order, for the panel that opens from a message.
 *
 * Omitting `run` returns the agent's whole channel — the CLI's `thread` verb
 * without a run, over HTTP.
 */
export async function handleAutomationsThreadGet(
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
    const runId = url.searchParams.get('run') ?? undefined;
    const entries = readThread(contextRoot, params.slug, { runId });
    // The open question this run is stopped on, JOINED here rather than stored on an
    // entry — `choices[]` and `state` live on the question file and would go stale the
    // moment it was answered. The panel renders it inline so answering happens in place
    // instead of sending the reader to another surface.
    const open = allPendingQuestions(contextRoot).find(
      (q) => q.slug === params.slug
        && q.kind === 'flow-hitl'
        && (runId === undefined || q.runFiredAt === runId),
    );
    // The run's whole document — the detail behind the one line the feed shows.
    // Only for a single run: the whole-channel read has no one document to attach.
    const answer = runId === undefined ? null : readRunAnswer(contextRoot, params.slug, runId);
    // THE SAME COUNT the feed row prints, from the same function — the panel's
    // divider and the thread line under the message cannot disagree. `rootId`
    // is the entry the panel draws as the root, so it is not listed again.
    const replies = runId === undefined ? null : threadReplies(entries, answer !== null);
    sendJson(res, 200, {
      slug: params.slug,
      title: manifest.title,
      runId: runId ?? null,
      entries,
      question: open ? { id: open.id, text: open.question, choices: open.choices } : null,
      answer,
      rootId: runId === undefined ? null : threadRootId(entries),
      replyCount: replies?.count ?? 0,
      lastReplyAt: replies?.lastAt ?? null,
      unread: threadUnread(contextRoot, params.slug),
    });
  } catch {
    sendError(res, 500, 'thread_failed', 'Failed to read that thread.');
  }
}

/**
 * POST /api/automations/threads/read — advance this machine's read watermark.
 *
 * Body is `{ slug, upToId }`. The advance is MONOTONIC inside
 * `markThreadRead`: an older id than the one on disk is ignored, so two
 * windows acking out of order cannot rewind the mark and re-badge messages the
 * user already read.
 *
 * Grants nothing and starts nothing — it only ever narrows what a future read
 * returns, which is why it needs no capability beyond being a local write.
 */
export async function handleAutomationsThreadRead(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const body = await parseJsonBody(req);
    const slug = typeof body?.slug === 'string' ? body.slug : '';
    const upToId = typeof body?.upToId === 'string' ? body.upToId : '';
    if (!slug || !upToId) {
      sendError(res, 400, 'bad_read', 'Body must be { slug, upToId }.');
      return;
    }
    if (!getAutomation(contextRoot, slug)) {
      sendError(res, 404, 'not_found', `Automation not found: ${slug}`);
      return;
    }
    markThreadRead(contextRoot, slug, upToId);
    sendJson(res, 200, { unread: threadUnread(contextRoot, slug) });
  } catch {
    sendError(res, 500, 'thread_read_failed', 'Failed to record the read mark.');
  }
}

/**
 * POST /api/automations/threads/say — the `#agents` composer. Call ONE agent
 * by name with a message, and post that message into the channel as the thing
 * its run answers.
 *
 * Body is `{ slug, text }`. MUST be registered before `/api/automations/:slug`
 * for the same reason `threads` is.
 *
 * THIS IS THE ONE PLACE A REQUEST BODY REACHES A RUN'S PROMPT, and the
 * sibling `POST /:slug/run` documents that it deliberately does not. The
 * difference is what the two carry: `run` replays stored, approved
 * configuration, so a body there would be an edit nobody reviewed, while this
 * route carries a sentence a person is typing right now — authorisation in the
 * present tense. `runAutomation` still re-checks approval, the sleep lock and
 * the orphan guard, and the ask lands in the prompt fenced and labelled as
 * speech (`buildAskBlock`), never as the job description.
 *
 * ORDER MATTERS AND THERE IS NO `await` INSIDE IT. The busy check, the thread
 * write and the job start run as one synchronous block, so nothing can slip a
 * second job in between and leave a question in the channel that nothing is
 * answering. The ask is written FIRST so it is the run's opening entry — the
 * feed keys the exchange on that, and it is also what makes the message appear
 * the instant the composer's request returns instead of on the next poll.
 */
export async function handleAutomationsSay(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const body = await parseJsonBody(req);
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!slug || !text) {
      sendError(res, 400, 'bad_say', 'Body must be { slug, text }.');
      return;
    }
    if (text.length > SAY_MAX_CHARS) {
      sendError(res, 400, 'say_too_long', `Keep it under ${SAY_MAX_CHARS} characters.`);
      return;
    }
    const manifest = getAutomation(contextRoot, slug);
    if (!manifest) {
      sendError(res, 404, 'not_found', `Automation not found: ${slug}`);
      return;
    }
    if (!manifest.enabled) {
      sendError(res, 409, 'say_disabled', `${manifest.title} is turned off. Turn it on to call it.`);
      return;
    }
    // Checked HERE as well as inside the runner, and not as a duplicate: the
    // runner's check stops the run, this one stops the MESSAGE. Without it an
    // unapproved agent leaves the owner's words sitting in the channel under
    // an answer that is only ever going to be "it is not approved".
    const projectRoot = dirname(contextRoot);
    if (!checkApproval(projectRoot, manifest).approved) {
      sendError(
        res, 409, 'say_unapproved',
        `${manifest.title} is not approved on this machine yet. Approve it, then ask again.`,
      );
      return;
    }
    // ── synchronous from here to the job start ──
    // Per AGENT: only a second run of THIS agent is refused — it would write into the same
    // thread and resume the same session. Another agent's run is no reason to wait.
    const busy = currentAutomationJob(contextRoot, slug);
    if (busy?.status === 'running') {
      sendError(
        res, 409, 'say_busy',
        `${manifest.title} is still running. Try again when it finishes.`,
      );
      return;
    }
    const fireAt = new Date();
    const runId = fireAt.toISOString();

    // A SCHEDULED agent that has already run on this machine is TALKED TO, not re-run:
    // @mentioning it resumes the session its last run left behind, which is the whole
    // promise of the channel. A `call` agent — and a `sched` one with nothing bound here
    // yet — falls through to the run path below, because there is no conversation to
    // continue.
    //
    // The ask is still written FIRST and is still `ordered[0]`, so the feed's own
    // ask/answer grouping is untouched; only what the ask STARTS changes. The reply gets
    // this FRESH runId rather than the run it resumes, so the exchange is its own message
    // with the human's words at its head.
    //
    // No `pendingQuestion` pre-check here, deliberately: `resumeWithMessage` owns that
    // guard, and its refusal reaches the channel within seconds as a `system:failed`
    // entry carrying its own sentence. A second copy of the check here would drift from
    // the one that actually decides.
    if (manifest.mode === 'sched' && latestBoundSession(slug)) {
      const entry = appendThreadEntry(contextRoot, slug, {
        runId, kind: 'user', text, via: 'dashboard', now: fireAt,
      });
      const replyJob = startAutomationReplyJob(contextRoot, slug, {
        runId, text, entryId: entry.id,
      });
      sendJson(res, 200, {
        job: { id: replyJob.id, status: replyJob.status, kind: 'reply' },
        started: true, runId, slug, mode: 'sched',
      });
      return;
    }

    appendThreadEntry(contextRoot, slug, { runId, kind: 'user', text, via: 'dashboard', now: fireAt });
    const { job, started } = startAutomationJob(contextRoot, slug, { text, fireAt });
    // Unreachable given the busy check above (nothing can interleave between
    // them), and handled anyway: the ask is already on disk at this point, so
    // a job that was NOT started would leave it in the channel with nothing
    // coming. Belt and braces, because the cost of being wrong is a message
    // that reads "running" for ever.
    if (!started) {
      appendThreadEntry(contextRoot, slug, {
        runId, kind: 'system', event: 'skipped', via: 'dashboard',
        text: 'It did not run. This agent was already running.',
      });
    }
    sendJson(res, 200, { job: { ...job, kind: 'run' }, started, runId, slug, mode: manifest.mode });
  } catch (err) {
    if (err instanceof AutomationError) {
      sendError(res, 400, 'say_refused', err.message);
      return;
    }
    sendError(res, 500, 'say_failed', 'Failed to send that to the channel.');
  }
}

/**
 * POST /api/automations/:slug/thread/reply — a human's reply into one run's own session.
 *
 * Body is `{ text, runId }`. Answers `202 { entry, job }` and lets the client poll
 * `reply-job/:id`: the resume spawns a detached child that may run for the automation's
 * whole timeout, and holding an HTTP socket open for that is not a thing to do.
 *
 * THE ORDER OF THE REFUSALS IS LOAD-BEARING, and the first three are not decoration:
 * `resumeWithMessage` re-checks neither `enabled` nor APPROVAL, and what it spawns is a
 * `bypassPermissions` child on an approved manifest's session. So a reply to an agent
 * whose approval has since been revoked would otherwise run with the authority of the
 * approval it no longer has. The same two rungs guard `handleAutomationsSay` above, for
 * the same reason and in the same order.
 *
 * Every refusal after those carries the SERVER'S OWN SENTENCE — the strings in
 * `verdict.ts` are already written for a human to read, and a generic "failed" here would
 * be strictly less true.
 */
export async function handleAutomationsThreadReply(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  try {
    const slug = params.slug;
    const manifest = getAutomation(contextRoot, slug);
    if (!manifest) {
      sendError(res, 404, 'not_found', `Automation not found: ${slug}`);
      return;
    }
    if (!manifest.enabled) {
      sendError(res, 409, 'reply_disabled', `${manifest.title} is turned off. Turn it on to reply.`);
      return;
    }
    if (!checkApproval(dirname(contextRoot), manifest).approved) {
      sendError(
        res, 409, 'reply_unapproved',
        `${manifest.title} is not approved on this machine yet. Approve it, then reply again.`,
      );
      return;
    }

    const body = await parseJsonBody(req);
    const text = typeof body?.text === 'string' ? body.text.replace(/\0/g, '').trim() : '';
    if (!text) {
      sendError(res, 400, 'bad_text', 'A reply needs something to say.');
      return;
    }
    if (text.length > THREAD_TEXT_MAX_CHARS) {
      sendError(res, 400, 'bad_text', `Keep it under ${THREAD_TEXT_MAX_CHARS} characters.`);
      return;
    }

    // `runId` becomes BOTH a thread grouping key and a `DREAMCONTEXT_AUTOMATION_RUN` env
    // value on a bypassPermissions child, so it is validated for shape AND for identity.
    const runId = typeof body?.runId === 'string' ? body.runId.trim() : '';
    const parsed = new Date(runId);
    if (!runId || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== runId) {
      sendError(res, 400, 'bad_run', 'That run id is not a timestamp this channel wrote.');
      return;
    }
    // NEWEST RUN ONLY, and this is a correctness rule rather than a convenience one:
    // `latestBoundSession` below resolves the LATEST session for the slug regardless of
    // which run the caller names. Accepting an older run would file the human's words
    // under that run's thread while they actually reached a different conversation — a
    // thread that lies about which exchange it is. The UI only ever offers Reply on the
    // newest run, so in practice this fires when a scheduled fire or someone's @mention
    // opened a newer run while the panel was sitting open.
    const newest = listThreadRuns(contextRoot, slug, 1)[0]?.runId ?? null;
    if (newest !== runId) {
      sendError(res, 409, 'stale_run', 'This conversation moved on. Reply on the newest run.');
      return;
    }

    // THE MACHINE-LOCAL BINDING IS THE AUTHORITY. Null means no run on THIS machine ever
    // produced a session, so nothing here could carry the reply — and a reply that will
    // never execute must not be left in the channel looking delivered.
    if (!latestBoundSession(slug)) {
      sendError(
        res, 409, 'not_bound',
        `${manifest.title} has no session to talk to yet. It needs one finished run on this machine first.`,
      );
      return;
    }
    if (pendingQuestion(contextRoot, slug)) {
      sendError(
        res, 409, 'question_pending',
        `${manifest.title} is waiting for your answer to its own question, so answer that first.`,
      );
      return;
    }
    // The cheap half of the lock story: when a run is visibly in flight we refuse up
    // front and write NOTHING, so the common case costs the user a retry instead of an
    // entry in the channel marked undelivered. The lock can still be taken between here
    // and the resume — that residual race settles inside the job, which appends its own
    // "not delivered" entry with the lock's own reason.
    const busy = currentAutomationJob(contextRoot, slug);
    if (busy?.status === 'running') {
      sendError(
        res, 409, 'busy',
        `${manifest.title} is still running. Try again when it finishes.`,
      );
      return;
    }

    const entry = appendThreadEntry(contextRoot, slug, { runId, kind: 'user', text, via: 'dashboard' });
    const job = startAutomationReplyJob(contextRoot, slug, { runId, text, entryId: entry.id });
    sendJson(res, 202, { entry, job: { id: job.id, status: job.status } });
  } catch (err) {
    if (err instanceof AutomationError) {
      sendError(res, 400, 'reply_refused', err.message);
      return;
    }
    sendError(res, 500, 'reply_failed', 'Failed to deliver that reply.');
  }
}

/**
 * GET /api/automations/reply-job/:id — poll one reply turn.
 *
 * A 404 is TERMINAL for the client, not a retry: it means this server no longer knows
 * the job, which happens when the process restarted mid-reply. The poller stops and says
 * delivery is unknown rather than spinning against an id nothing will ever answer; the
 * thread itself is closed by reconciliation on the next overview request.
 *
 * MUST be registered above `/api/automations/:slug` — `reply-job` would otherwise be
 * captured as a slug, the same ordering rule `runs`, `questions` and `threads` follow.
 */
export async function handleAutomationsReplyJob(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  _contextRoot: string,
): Promise<void> {
  const job = currentReplyJob(params.id ?? '');
  if (!job) {
    sendError(res, 404, 'job_unknown', 'That reply is no longer being tracked on this machine.');
    return;
  }
  sendJson(res, 200, { job });
}
