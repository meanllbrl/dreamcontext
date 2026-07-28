import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson, sendError } from '../middleware.js';
import { getAutomation, listAutomations, readAutomationCache, readPattern } from '../../lib/automations/store.js';
import { resolveRunSession, readSessionDigest } from '../../lib/automations/session.js';
import { checkApproval, approveAutomation } from '../../lib/automations/registry.js';
import { formatSchedule } from '../../lib/automations/schedule.js';
import { startAutomationJob, currentAutomationJob } from '../automation-job.js';
import type { AutomationCache, AutomationManifest } from '../../lib/automations/types.js';

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
