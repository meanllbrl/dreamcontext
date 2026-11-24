import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { getReadiness } from '../../lib/onboarding/readiness.js';
import { listPendingGitInits, runPendingGitInits } from '../../lib/onboarding/pending-git.js';
import { FIX_IDS, type CheckId, type FixId, type ReadinessReport, type Surface } from '../../lib/onboarding/types.js';
import { activeRunFor, cancelRun, getRun, serverProbeContext, startFixRun } from '../install-runs.js';
import { isLoopback, isLoopbackHostHeader, requireLocalDesktop, requireLocalRead, requireOwnerWindow } from './agent-spawn-shared.js';
import { hasOwnerKey } from '../owner-key.js';
import { isAgentId, setPickedAgents, type AgentId } from '../../lib/agent-pick.js';
import { probeGhImport, requestedGithubScopes, type GhExec } from '../../lib/onboarding/github.js';
import { defaultFixDeps, shellFacts } from '../../lib/onboarding/fixes.js';
import { ptyPresent } from './agent-terminal.js';

/**
 * The first-run onboarding routes (plan §3, HTTP):
 *  - `GET  /api/onboarding/readiness[?fresh=1]`: the machine report. Local read.
 *  - `POST /api/onboarding/fix { fix }`: start one fix as a background run. Local desktop.
 *  - `POST /api/onboarding/fix/cancel { runId }`: stop it. Local desktop.
 * Progress is polled through the shared `/api/agent/install/status?id=`.
 * Vault-agnostic (there is no project yet) and never reachable from the phone.
 */

/** The check whose row each fix belongs to: where `blocked` and `manual` are read from. */
const FIX_CHECK: Readonly<Record<FixId, CheckId>> = {
  'node-shell-path': 'node',
  'cli-install': 'cli',
  'cli-shell-path': 'cli',
  'claude-install': 'claude',
  'claude-path': 'claude',
  'claude-signin': 'claude-auth',
  'codex-install': 'codex',
  'codex-update': 'codex',
  'codex-signin': 'codex-auth',
  'git-install': 'git',
  'gh-install': 'gh',
  'github-signin': 'github',
  'gh-signin': 'gh',
  'pty-install': 'terminal',
  // No row of its own: what can block these is the Node they run on.
  'antigravity-install': 'node',
  'antigravity-signin': 'node',
};

function isFixId(v: unknown): v is FixId {
  return typeof v === 'string' && (FIX_IDS as readonly string[]).includes(v);
}

/** Fixes run on the desktop surface; a browser tab only reads (its rows show the Terminal line). */
function surfaceOf(req: IncomingMessage): Surface {
  return isDesktop() && isLoopback(req) && isLoopbackHostHeader(req) ? 'desktop' : 'browser';
}

/** Report-driven refusal for one fix, or null when it may run. */
export function fixRefusal(
  report: ReadinessReport,
  fix: FixId,
): { status: 409; body: { error: 'blocked'; message: string; blockedBy: CheckId[] } }
  | { status: 422; body: { error: 'manual_only'; message: string; manual: string } }
  | null {
  const check = report.checks.find((c) => c.id === FIX_CHECK[fix]);
  if (!check) return null;
  if (check.status === 'blocked') {
    return {
      status: 409,
      body: { error: 'blocked', message: 'Something this needs is not set up yet.', blockedBy: check.blockedBy ?? [] },
    };
  }
  if (check.fix?.id === fix && (check.fix.kind === 'manual' || !check.fix.runnable)) {
    return {
      status: 422,
      body: { error: 'manual_only', message: 'This step has to be done by hand on this computer.', manual: check.fix.manual ?? '' },
    };
  }
  return null;
}

/**
 * Run the leftover pending `git init`s when the report says git is usable. The fallback
 * path: a `git-install` run that ends ok already did this from its completion hook. Rides
 * the readiness rate (the report is memoised), and is a cheap file read when nothing waits.
 */
function runLeftoverGitInits(report: ReadinessReport): void {
  const git = report.checks.find((c) => c.id === 'git');
  if (git?.status !== 'ok') return;
  try {
    if (listPendingGitInits().length > 0) runPendingGitInits();
  } catch (err) {
    console.error('[onboarding] pending git init from the readiness route failed:', err);
  }
}

/** GET /api/onboarding/readiness[?fresh=1] */
export async function handleOnboardingReadiness(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireLocalRead(req, res)) return;
  const url = new URL(req.url || '/', 'http://localhost');
  const fresh = url.searchParams.get('fresh') === '1';
  const surface = surfaceOf(req);
  try {
    const report = await getReadiness(serverProbeContext(surface, ptyPresent), { fresh });
    runLeftoverGitInits(report);
    sendJson(res, 200, report);
  } catch (err) {
    console.error('[onboarding] readiness probe failed:', err);
    sendError(res, 500, 'probe_failed', 'Could not check this computer.');
  }
}

/** POST /api/onboarding/fix { fix } */
export async function handleOnboardingFix(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const body = await parseJsonBody(req);
  const fix = body?.fix;
  if (!isFixId(fix)) {
    sendError(res, 400, 'bad_fix', 'Body must be { fix } with a known fix id.');
    return;
  }
  const running = activeRunFor(fix);
  if (running) {
    sendJson(res, 409, { error: 'in_progress', message: 'This step is already running.', runId: running });
    return;
  }
  const ctx = serverProbeContext('desktop', ptyPresent);
  let report: ReadinessReport;
  try {
    report = await getReadiness(ctx);
  } catch (err) {
    console.error('[onboarding] readiness probe before a fix failed:', err);
    sendError(res, 500, 'probe_failed', 'Could not check this computer.');
    return;
  }
  const refusal = fixRefusal(report, fix);
  if (refusal) {
    sendJson(res, refusal.status, refusal.body);
    return;
  }
  // "Use another account" (C12): the GitHub sign-in skips the `gh` import. Read only for that fix.
  const deviceOnly = fix === 'github-signin' && body?.deviceOnly === true;
  const { runId, existing } = startFixRun(fix, ctx, deviceOnly ? { fixOptions: { deviceOnly: true } } : {});
  if (existing) {
    sendJson(res, 409, { error: 'in_progress', message: 'This step is already running.', runId });
    return;
  }
  sendJson(res, 200, { ok: true, runId });
}

/** POST /api/onboarding/fix/cancel { runId } */
export async function handleOnboardingFixCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const body = await parseJsonBody(req);
  const runId = typeof body?.runId === 'string' ? body.runId : '';
  if (!runId || !getRun(runId)) {
    sendJson(res, 200, { ok: true, canceled: false });
    return;
  }
  sendJson(res, 200, { ok: true, canceled: cancelRun(runId) });
}

/**
 * POST /api/onboarding/agents { picked: AgentId[] }: the first screen's agent pick ("Continue
 * with Claude" writes `["claude"]`, the Codex or Antigravity choice writes that one). The only
 * writer is `setPickedAgents()`; no other body field is read. Owner window AND the shell's
 * owner key: a no-Origin loopback `curl` passes the window check but not the key.
 */
export async function handleOnboardingAgents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireOwnerWindow(req, res)) return;
  if (!hasOwnerKey(req)) {
    sendError(res, 403, 'forbidden', 'Only this app\'s own window can do this.');
    return;
  }
  const body = await parseJsonBody(req);
  const raw = body?.picked;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isAgentId)) {
    sendError(res, 400, 'bad_pick', 'Body must be { picked } with at least one of claude, codex, antigravity.');
    return;
  }
  try {
    const picked: AgentId[] = setPickedAgents(raw);
    sendJson(res, 200, { ok: true, picked });
  } catch (err) {
    sendError(res, 400, 'bad_pick', (err as Error).message);
  }
}

/**
 * GET /api/onboarding/github-probe: what the clone flow's sign-in step shows (C12). `login`:
 * a `gh` sign-in this app would import (its scopes inside the D7 set), shown as "Continue as
 * <login>"; null when there is none. `scopes`: the list the sign-in requests, for the
 * permission line. Reads only; the token is never read here (the import is the click).
 */
export async function handleOnboardingGithubProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const scopes = requestedGithubScopes();
  try {
    const ctx = serverProbeContext('desktop', ptyPresent);
    const facts = await shellFacts(ctx);
    const ghPath = defaultFixDeps.ghPath(ctx.home, facts);
    if (!ghPath) {
      sendJson(res, 200, { login: null, scopes });
      return;
    }
    const childEnv = { ...process.env };
    delete childEnv.GH_TOKEN;
    delete childEnv.GITHUB_TOKEN;
    const ac = new AbortController();
    const sink = { output() {}, progress() {}, awaiting() {}, deviceCode() {}, onCancel() {} };
    const gh: GhExec = (args, o) => defaultFixDeps.run(ghPath, args, { timeoutMs: o.timeoutMs, env: childEnv }, sink, ac.signal);
    const probe = await probeGhImport(gh, ctx.home);
    sendJson(res, 200, { login: probe ? (probe.login ?? '') : null, scopes });
  } catch (err) {
    console.error('[onboarding] GitHub probe failed:', err);
    sendJson(res, 200, { login: null, scopes });
  }
}
