import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson, sendError } from '../middleware.js';
import { getAutomation, listAutomations, readAutomationCache } from '../../lib/automations/store.js';
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
        timeoutMinutes: manifest.timeoutMinutes,
        catchupHours: manifest.catchupHours,
        outputDir: manifest.outputDir,
        prompt: manifest.prompt,
        outputInstructions: manifest.outputInstructions,
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
 * human reviews the 5-field diff; rendering that diff is a dashboard-side
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
