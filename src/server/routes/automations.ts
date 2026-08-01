import { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import {
  getAutomation,
  listAutomations,
  readAutomationCache,
  readPattern,
  setAutomationEnabled,
} from '../../lib/automations/store.js';
import { resolveRunSession, readSessionDigest } from '../../lib/automations/session.js';
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
import { startAutomationJob, currentAutomationJob } from '../automation-job.js';
import { AutomationError, type AutomationCache, type AutomationManifest } from '../../lib/automations/types.js';

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
