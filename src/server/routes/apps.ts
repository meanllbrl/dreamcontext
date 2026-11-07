/**
 * `/api/apps/*`: the dreamcontext Apps control surface (dreamcontext-apps plan r19, W2).
 *
 * Every route is `requireLocalDesktop` (desktop app, this machine, loopback Host), except a
 * phone socket's `GET /api/apps`, which gets a filtered list with no paths. `launch-window`
 * and `running` are vault-agnostic: the RUNNER calls them, with the launch token from
 * `~/.dreamcontext/desktop-server.json`.
 *
 *   GET    /api/apps                  this project's apps + status
 *   POST   /api/apps/launch-window    runner: Bearer launchToken, {projectRoot, slug} → url + runnerToken
 *   GET    /api/apps/running          {count} of heartbeating windows (the shell's exit check)
 *   POST   /api/apps/:slug/launch     open (or focus) the window; {owner:true} clears an owner Stop
 *   POST   /api/apps/:slug/stop       owner Stop: backend down, `stoppedByOwner` kept
 *   GET    /api/apps/:slug/status     status + actions/schedules summary
 *   GET    /api/apps/:slug/logs       the redacted log tail
 *   POST   /api/apps/:slug/snapshot   a PNG of the OPEN window (never opens one)
 *   POST   /api/apps/:slug/call       one request to the backend (call lease, sink, 256 KB)
 *   DELETE /api/apps/:slug            unregister; bundle, shots and data pins go, code stays
 *   GET    /api/apps/:slug/chats      the app's conversations (embed proof), newest first
 *   POST   /api/apps/:slug/chats/close  {id}: off the open row, kept in the history (embed proof)
 *   POST   /api/apps/:slug/chats/title  {id, title} (embed proof)
 *
 * DC_TOKEN and the gateway secret never leave through any route, and are never written to disk.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isSameOriginAsHost } from '../remote-access.js';
import { requireLocalDesktop } from './agent-spawn-shared.js';
import { isPhoneSocket } from '../phone-origin.js';
import { holdOpen } from '../hold-open.js';
import { trackChild } from '../lifecycle.js';
import { claimOwnedPort } from '../owned-ports.js';
import { launchTokenMatches, shellBundleId } from '../desktop-server-file.js';
import { closeGateway, existingGateway, gatewayFor, runningWindowCount } from '../apps/gateway.js';
import { readLauncherTheme } from './launcher.js';
import { getApp, listApps, real, unregisterApp, updateApp, type AppRecord } from '../../lib/apps/registry.js';
import { existingRuntime, forgetRuntime, runtimeFor, type AppRuntime, GATEWAY_SECRET_HEADER } from '../../lib/apps/supervisor.js';
import { readManifest, ACTION_METHODS, effectOf, toolTimeoutSec, type AppAction, type ToolEffect } from '../../lib/apps/manifest.js';
import { decodeClaim, RUN_HEADER, type CallClaim } from '../../lib/apps/call-claim.js';
import { handedOverChildRoot, isSuperChild, isSuperSessionId } from '../../lib/super/store.js';
import { getAutomation } from '../../lib/automations/store.js';
import { jobStartedByOwner } from '../automation-job.js';
import { safeAppPath } from '../../lib/apps/safe-path.js';
import { appBundlePath, bundleIsStale, bundlePid, bundleRunState, ensureAppBundle, mayBuildBundle, mayRetireRunner, removeAppBundle, runnerBundleId, shellRunnerPath, shouldRefreshIdleBundle, type BundleInput } from '../../lib/apps/bundle.js';
import { removeShots, pruneShots } from '../../lib/apps/shots.js';
import { notifierIconPath, notifyViaBundle } from '../../lib/automations/notifier.js';
import { autoUpdateOne, checkUpdate } from '../../lib/apps/share/update.js';
import { shareStatus } from './apps-share.js';
import { iconIssue, servableIcon } from '../../lib/apps/icon.js';
import { icnsToPng } from '../../lib/apps/icns-raster.js';
import { sendPhotoFile } from './automations.js';
import { configureGatewayW3 } from '../apps/gateway-w3.js';
import { spendLinkNonce } from '../apps/link-nonces.js';
import { getRunTarget } from '../../lib/automations/store.js';
import { checkApproval } from '../../lib/automations/registry.js';
import { resolveEmbedToken, type EmbedGrant } from '../apps/embed-token.js';
import { resolveAppAgent } from '../../lib/apps/assistant.js';
import { appChatRoot, closeAppChat, listAppChats, lookupAppChat, newestAppChat, stampAppRemoved, titleAppChat } from '../../lib/apps/chat-store.js';
import { stopLiveChat } from './agent-chat-live.js';
import { claudeConversationExists, isSameOriginStrict } from './agent-spawn-shared.js';
import { appRunBrief } from '../../lib/apps/brief.js';
import { appOthers } from '../../lib/apps/others.js';
import { migrateAppData } from '../../lib/apps/data-dir.js';
import { listVaults } from '../../lib/vaults.js';
import { sayFromApp } from './automations.js';
import { inspectDispatcher } from '../../lib/automations/launchd.js';
import { inspectNotifier } from '../../lib/automations/notifier.js';
import { readScheduleState, scheduleViews, setScheduleEnabled } from '../../lib/apps/schedule.js';
import { closeMcpClients, resolveMcpDefinition, readPins, writePin, removePins } from '../../lib/apps/mcp-bridge.js';
import { reviewMcpDefinition, describeChange, mcpHash } from '../../lib/apps/mcp-review.js';
import { createProposal } from '../../lib/assistant/proposals.js';

type Params = Record<string, string>;
const CALL_MAX_BYTES = 256 * 1024;
const LAUNCH_WAIT_MS = 20_000;

let home = homedir();
/** Is this bundle's process running? The OS's answer; null = could not ask (the lease decides). */
let probeBundle: (bundleId: string) => boolean | null = bundleRunState;
/** Tests stand in for the OS. */
export function setBundleProbeForTests(p: (bundleId: string) => boolean | null): void {
  probeBundle = p;
}
/** Tests point the apps store at a scratch home. */
export function setAppsHomeForTests(h: string): void {
  home = h;
  probeBundle = () => null; // a scratch home has no real bundles to ask the OS about
  configureGatewayW3({ home: h, loginPath });
}

// ─── shared plumbing ────────────────────────────────────────────────────────────────

let loginPathCache: Promise<string> | null = null;
/** The owner's login-shell PATH (a Dock-launched server has none), resolved once. */
function loginPath(): Promise<string> {
  if (!loginPathCache) {
    loginPathCache = new Promise((resolve) => {
      // Windows has no login shell to ask (a Git Bash $SHELL would answer a POSIX ':' PATH).
      if (process.platform === 'win32') { resolve(process.env.PATH ?? ''); return; }
      const shell = process.env.SHELL || '/bin/zsh';
      execFile(shell, ['-ilc', 'printf "%s" "$PATH"'], { timeout: 10_000 }, (err, stdout) => {
        const p = String(stdout ?? '').trim().split('\n').pop() ?? '';
        resolve(!err && p.includes('/') ? p : (process.env.PATH ?? '/usr/bin:/bin'));
      });
    });
  }
  return loginPathCache;
}

function runtime(rec: AppRecord): AppRuntime {
  return runtimeFor(rec, {
    home,
    loginPath,
    trackChild: (kill) => trackChild(kill),
    claimPort: (port) => claimOwnedPort(port),
  });
}

/** Host names this loopback listener by its own number: a rebinding page's Host is its own name. */
function isLoopbackHostRequest(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '');
  return /^(127\.0\.0\.1|localhost):\d+$/.test(host) && !isPhoneSocket(req) && ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress ?? '');
}

export const projectRootOf = (contextRoot: string) => (basename(contextRoot) === '_dream_context' ? dirname(contextRoot) : contextRoot);

/** The apps store's home (a scratch one in tests). */
export function appsHomeDir(): string {
  return home;
}

function findApp(contextRoot: string, slug: string, res: ServerResponse): AppRecord | null {
  const rec = getApp(home, projectRootOf(contextRoot), slug);
  if (!rec) {
    sendError(res, 404, 'app_not_found', `No app "${slug}" in this project (dreamcontext apps list).`);
    return null;
  }
  return rec;
}

/** Wait for running/error, at most `ms`. */
async function settle(rt: AppRuntime, ms: number): Promise<void> {
  await Promise.race([rt.ensureRunning(), new Promise((r) => setTimeout(r, ms))]);
}

/** A closed app whose icon or name changed: rebuilt now, so a Dock click starts the new bundle. */
function refreshIdleBundles(): void {
  const runner = shellRunnerPath();
  if (!runner) return;
  for (const rec of listApps(home)) {
    const input = bundleInput(rec, runner);
    const bundleExists = existsSync(appBundlePath(home, rec.slug, rec.hash));
    if (!bundleExists || !bundleIsStale(input)) continue;
    if (shouldRefreshIdleBundle({ bundleExists, stale: true, processRunning: probeBundle(runnerBundleId(rec.hash)) })) ensureAppBundle(input);
  }
}

/**
 * Server start, before any backend: the data of every app of THIS server's projects moves from
 * `~/.dreamcontext/apps/data/<hash>/` into the brain (plan-veri K1). Another server's projects
 * are not touched (its backend may still hold the old folder); a refusal is shown when that app
 * starts, which retries the move.
 */
function migrateOpenProjectsData(): void {
  let roots: Set<string>;
  try { roots = new Set(listVaults(home).map((v) => real(v.path))); } catch { return; }
  for (const rec of listApps(home)) {
    if (!roots.has(rec.projectRoot)) continue;
    try {
      const r = migrateAppData(home, rec);
      if (r.status === 'moved') console.log(`  dreamcontext Apps: ${rec.slug} data moved into ${r.to}`);
      else if (r.status === 'refused') console.log(`  dreamcontext Apps: ${rec.slug} data not moved (${r.code})`);
    } catch { /* the app's own start retries */ }
  }
}

let sweeper: NodeJS.Timeout | null = null;
/** Lease sweeping + shot pruning, every 5 s while the server runs. */
export function startAppsSweeper(): () => void {
  if (sweeper) return () => {};
  configureGatewayW3({ home, loginPath });
  migrateOpenProjectsData();
  pruneShots(home);
  let ticks = 0;
  sweeper = setInterval(() => {
    for (const rec of listApps(home)) {
      const rt = existingRuntime(rec.hash);
      if (rt && rt.sweep()) {
        rt.log.push('[dreamcontext] no window and no call: backend stopped');
        void closeMcpClients(rt.hash);
      }
    }
    if (++ticks % 3 === 0) { try { refreshIdleBundles(); } catch { /* the next open builds it */ } }
    // Installed apps: a check two minutes after start, then every 6 hours (plan r2 K4).
    if (ticks === 24 || ticks % 4320 === 0) void shareSweep();
    if (ticks % 60 === 0) pruneShots(home);
  }, 5000);
  sweeper.unref();
  return () => { if (sweeper) clearInterval(sweeper); sweeper = null; };
}

let shareSweeping = false;
/** Check every installed app that follows its original; apply the ones the owner set to auto-update. */
async function shareSweep(): Promise<void> {
  if (shareSweeping) return;
  shareSweeping = true;
  try {
    for (const rec of listApps(home)) {
      if (rec.origin !== 'installed' || rec.source?.mode !== 'following') continue;
      try {
        const applied = await autoUpdateOne(home, rec);
        if (applied) {
          const next = getApp(home, rec.projectRoot, rec.slug);
          if (next) refreshAppRuntime(next);
          notifyViaBundle(`${rec.name} updated`, `Version ${applied.sha.slice(0, 7)} from ${rec.source.fullName}. Undo it on its card in Apps.`, home);
        } else if (!rec.source.autoUpdate) {
          await checkUpdate(home, rec);
        }
      } catch { /* the next sweep tries again */ }
    }
  } finally {
    shareSweeping = false;
  }
}

/** What this app's bundle is built from right now. */
function bundleInput(rec: AppRecord, runnerPath: string): BundleInput {
  const m = readManifest(rec.root);
  const icon = m.ok ? m.manifest.icon : null;
  return {
    home, projectRoot: rec.projectRoot, vault: rec.vault, slug: rec.slug, name: m.ok ? m.manifest.name : rec.name,
    // An app born with the logo as its icon gets its own letter in the Dock; its manifest stays.
    iconPath: iconIssue(icon, notifierIconPath())?.code === 'dreamcontext_logo' ? null : icon,
    runnerPath, appBundleId: shellBundleId(),
  };
}

/** Windows open now: the leases, corrected by the OS when it says the runner process is gone. */
function liveWindowsOf(rec: AppRecord, rt: AppRuntime): number {
  if (rt.liveWindows() > 0 && probeBundle(runnerBundleId(rec.hash)) === false) rt.clearWindows();
  return rt.liveWindows();
}

/**
 * The owner stopped the app and opens it again, and the bundle changed meanwhile (a new icon):
 * the runner sits on its Stopped screen with nothing to lose, so it ends here and the next
 * open starts the new bundle. A window that is working is never ended for this.
 */
async function retireStoppedWindow(rec: AppRecord, rt: AppRuntime): Promise<void> {
  const runner = shellRunnerPath();
  const id = runnerBundleId(rec.hash);
  if (!runner || !mayRetireRunner({ stoppedByOwner: true, processRunning: probeBundle(id), stale: bundleIsStale(bundleInput(rec, runner)) })) return;
  const pid = bundlePid(id);
  if (!pid) return;
  try { process.kill(pid); } catch { return; }
  for (let i = 0; i < 30 && probeBundle(id) !== false; i++) await new Promise((r) => setTimeout(r, 100));
  rt.clearWindows();
}

/** Open the app's bundle (or bring its window forward). The single focus path. */
export function focusApp(rec: AppRecord, opts: { runnerAlive: boolean }): { ok: true; path: string } | { ok: false; code: string; message: string } {
  const runner = shellRunnerPath();
  const path = appBundlePath(home, rec.slug, rec.hash);
  // A live window: never rebuild the bundle under it, only bring it forward.
  if (mayBuildBundle({ processRunning: probeBundle(runnerBundleId(rec.hash)), leaseAlive: opts.runnerAlive, bundleExists: existsSync(path) })) {
    if (!runner) return { ok: false, code: 'runner_missing', message: 'This dreamcontext app has no app runner: update the desktop app.' };
    const built = ensureAppBundle(bundleInput(rec, runner));
    if (!built.ok) return { ok: false, code: 'bundle_failed', message: built.reason };
  }
  execFile('/usr/bin/open', [path], { timeout: 10_000 }, () => { /* the window reports itself through its heartbeat */ });
  return { ok: true, path };
}

/** Can the app's member take a message? The card says so before a message comes back refused. */
function memberState(rec: AppRecord, member: string): 'ready' | 'needs_approval' | 'missing' {
  try {
    const target = getRunTarget(join(rec.projectRoot, '_dream_context'), member, 'agent');
    if (!target) return 'missing';
    return checkApproval(rec.projectRoot, target, home, 'run').approved ? 'ready' : 'needs_approval';
  } catch {
    return 'missing';
  }
}

/** Who talks in this app, for the card and the frame. */
export const findAppFor = (contextRoot: string, slug: string, res: ServerResponse): AppRecord | null => findApp(contextRoot, slug, res);

/** Stop everything an app runs before its folder moves (uninstall). The record stays. */
export async function retireAppRuntime(rec: AppRecord): Promise<void> {
  for (const id of stampAppRemoved(rec.hash, home)) void stopLiveChat(id).catch(() => { /* already gone */ });
  forgetRuntime(rec.hash);
  await closeMcpClients(rec.hash);
  await closeGateway(rec.hash);
  removeAppBundle(home, rec.slug, rec.hash);
  removeShots(home, rec.hash);
  removePins(home, rec.hash);
}

/** The runtime reads the new record (settings, an update): an app in error starts over. */
export function refreshAppRuntime(rec: AppRecord): void {
  const rt = existingRuntime(rec.hash);
  if (!rt) return;
  rt.setRecord(rec);
  if (rt.status().state === 'error' && !rec.stoppedByOwner) void rt.ensureRunning();
}

function assistantOf(rec: AppRecord): 'own' | 'member' | 'none' {
  const m = readManifest(rec.root);
  return resolveAppAgent(m.ok ? m.manifest : null, null).kind;
}

function publicStatus(rec: AppRecord): Record<string, unknown> {
  const rt = existingRuntime(rec.hash);
  if (rt) liveWindowsOf(rec, rt);
  const m = readManifest(rec.root);
  const st = rt?.status();
  return {
    slug: rec.slug,
    name: m.ok ? m.manifest.name : rec.name,
    vault: rec.vault,
    state: rec.stoppedByOwner ? 'stopped' : (st?.state ?? 'stopped'),
    stoppedByOwner: !!rec.stoppedByOwner,
    rev: st?.rev ?? 0,
    lastError: st?.lastError ?? (m.ok ? null : m.errors.map((e) => `${e.field}: ${e.problem}`).join('; ')),
    warnings: st?.warnings ?? [],
    windows: st?.windows ?? 0,
    hasBackend: m.ok ? !!m.manifest.backend : false,
    unguarded: m.ok ? !!m.manifest.backend?.unguarded : false,
    portFallback: st?.portFallback ?? false,
    agent: m.ok ? m.manifest.agent?.member ?? null : null,
    agentState: m.ok && m.manifest.agent?.member ? memberState(rec, m.manifest.agent.member) : null,
    assistant: assistantOf(rec),
    // Only what /icon can serve: a true on an .icns draws a broken image on the card.
    hasIcon: m.ok ? servableIcon(m.manifest.icon) !== null : false,
    iconIssue: m.ok ? iconIssue(m.manifest.icon, notifierIconPath()) : null,
    actions: m.ok ? m.manifest.actions.map((a) => ({ id: a.id, title: a.title, method: a.method, path: a.path, effect: effectOf(a), ...(a.input ? { input: a.input } : {}), ...(a.output ? { output: a.output } : {}), ...(a.danger ? { danger: true } : {}) })) : [],
    // The card's "N tools · M change" and its drift mark (app-araclari §5). `unknown` until the
    // backend answered health once in this server.
    tools: m.ok ? { count: m.manifest.actions.length, change: m.manifest.actions.filter((a) => effectOf(a) === 'change').length, audit: st?.tools?.state ?? 'unknown', missing: st?.tools?.missing ?? [] } : null,
    schedules: m.ok ? scheduleViews(home, rec) : [],
    mcp: m.ok ? mcpStates(rec, m.manifest.mcp) : [],
    ...shareStatus(rec),
  };
}

const SETUP_CACHE_MS = 15_000;
let setupCache: { at: number; value: { scheduler: boolean; notifications: boolean } } | null = null;

/** What a schedule and a banner need on this Mac: the card offers each one it lacks. */
async function appSetup(): Promise<{ scheduler: boolean; notifications: boolean }> {
  // The page polls every 3 s, and the dispatcher check spawns `launchctl`.
  if (setupCache && Date.now() - setupCache.at < SETUP_CACHE_MS) return setupCache.value;
  const check = await inspectDispatcher({ home }).catch(() => null);
  const notifier = inspectNotifier(home);
  const value = {
    scheduler: !!check && check.plistPresent && check.wrapperPresent && check.bootstrapped,
    notifications: notifier.bundlePresent && notifier.scriptCurrent,
  };
  setupCache = { at: Date.now(), value };
  return value;
}

// ─── the Assistant's app verbs (src/server/routes/assistant.ts holds the gate) ───────

/** Every app of one project, as the Assistant reads them. Names and titles are project text. */
export function appsOfProject(projectRoot: string): Array<{ slug: string; name: string; state: string; windows: number; actions: Array<{ id: string; title: string; method: string; path: string; danger: boolean }> }> {
  return listApps(home, projectRoot).map((rec) => {
    const st = publicStatus(rec) as { name: string; state: string; windows?: number };
    const m = readManifest(rec.root);
    return {
      slug: rec.slug, name: st.name, state: st.state, windows: st.windows ?? 0,
      actions: m.ok ? m.manifest.actions.map((a) => ({ id: a.id, title: a.title, method: a.method, path: a.path, danger: !!a.danger })) : [],
    };
  });
}

/** Open the app, or bring it forward: what `apps open` does. `state` is an enum, never project text. */
export async function openAppForAssistant(projectRoot: string, slug: string): Promise<{ ok: boolean; state: string; code?: string }> {
  const rec0 = getApp(home, projectRoot, slug);
  if (!rec0) return { ok: false, state: 'stopped', code: 'app_not_found' };
  if (process.platform !== 'darwin') return { ok: false, state: 'stopped', code: 'mac_only' };
  const rec = rec0.stoppedByOwner ? updateApp(home, rec0.projectRoot, rec0.slug, { stoppedByOwner: false }) ?? rec0 : rec0;
  const rt = runtime(rec);
  await gatewayFor(rt);
  if (rec0.stoppedByOwner) await retireStoppedWindow(rec, rt);
  const f = focusApp(rec, { runnerAlive: liveWindowsOf(rec, rt) > 0 });
  if (!f.ok) return { ok: false, state: rt.status().state, code: f.code };
  return { ok: true, state: rt.status().state };
}

/** One manifest action, resolved now: the Assistant freezes this at proposal time. */
export function resolveAppAction(projectRoot: string, slug: string, id: string): { method: string; path: string; title: string; danger: boolean } | null {
  const rec = getApp(home, projectRoot, slug);
  const m = rec ? readManifest(rec.root) : null;
  if (!m || !m.ok) return null;
  const a = m.manifest.actions.find((x) => x.id === id);
  return a ? { method: a.method, path: a.path, title: a.title, danger: !!a.danger } : null;
}

/** Run one action with its input: query for GET, JSON body otherwise, as `apps do` does. */
export async function runAppAction(projectRoot: string, slug: string, action: { method: string; path: string; id?: string }, input: unknown): Promise<BackendCall> {
  const rec = getApp(home, projectRoot, slug);
  if (!rec) return { ok: false, http: 404, code: 'app_not_found', message: 'app_not_found' };
  if (rec.stoppedByOwner) return { ok: false, http: 409, code: 'app_stopped', message: 'app_stopped' };
  let path = action.path;
  let body: unknown;
  if (action.method === 'GET' && input && typeof input === 'object') {
    const qs = new URLSearchParams(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, String(v)])).toString();
    if (qs) path += (path.includes('?') ? '&' : '?') + qs;
  } else if (input !== undefined) body = input;
  const safe = safeAppPath(path);
  if (!safe.ok) return { ok: false, http: 400, code: 'bad_path', message: 'bad_path' };
  // Reached only through the Assistant's `gated(...)`: an approved proposal or the owner's own
  // autonomy setting, so it is the owner's confirm (plan §4.1). The gate still runs: one door.
  const m = readManifest(rec.root);
  const verdict = gateAppCall(join(projectRoot, '_dream_context'), rec, m.ok ? m.manifest.actions : [], { method: action.method, path: safe.path, confirm: true, claim: { class: 'owner' }, ...(action.id ? { tool: action.id } : {}) }, { home });
  if (!verdict.ok) return { ok: false, http: verdict.http, code: verdict.code, message: verdict.message };
  return callBackend(rec, action.method, safe.path, body, verdict.timeoutMs);
}

/** A window's own picture. Never opens anything: no window, no picture. */
export async function shootAppWindow(projectRoot: string, slug: string): Promise<{ ok: true; file: string } | { ok: false; code: string }> {
  const rec = getApp(home, projectRoot, slug);
  if (!rec) return { ok: false, code: 'app_not_found' };
  const gw = await existingGateway(rec.hash);
  if (!gw || gw.runtime.liveWindows() === 0) return { ok: false, code: 'app_not_open' };
  const r = await gw.requestSnapshot();
  return 'error' in r ? { ok: false, code: r.error } : { ok: true, file: r.file };
}

// ─── routes ─────────────────────────────────────────────────────────────────────────

export async function handleAppsList(req: IncomingMessage, res: ServerResponse, _p: Params, contextRoot: string): Promise<void> {
  if (isPhoneSocket(req)) {
    // The phone sees what exists (no paths, no logs); it cannot launch a Mac window.
    const apps = listApps(home, projectRootOf(contextRoot)).map((a) => {
      const s = publicStatus(a);
      return { slug: s.slug, name: s.name, state: s.state, agent: s.agent, hasIcon: s.hasIcon };
    });
    sendJson(res, 200, { apps, macOnly: true });
    return;
  }
  if (!requireLocalDesktop(req, res)) return;
  const registered = listApps(home, projectRootOf(contextRoot));
  const apps = registered.map((a) => ({ ...publicStatus(a), root: a.root }));
  // A teammate's app (its knowledge note, no app here) and a removed app's data (plan-veri K5).
  const others = appOthers(projectRootOf(contextRoot), new Set(registered.map((a) => a.slug)));
  sendJson(res, 200, { apps, others, platform: process.platform, runner: !!shellRunnerPath(), setup: await appSetup() });
}

export async function handleAppsLaunchWindow(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  if (!launchTokenMatches(req.headers.authorization)) { sendError(res, 401, 'unauthorized', 'bad launch token'); return; }
  holdOpen(req);
  const body = await parseJsonBody(req);
  const projectRoot = typeof body?.projectRoot === 'string' ? body.projectRoot : '';
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  const rec = projectRoot && slug ? getApp(home, projectRoot, slug) : null;
  if (!rec) { sendError(res, 404, 'app_not_found', 'This app is not registered any more.'); return; }
  const rt = runtime(rec);
  const gw = await gatewayFor(rt);
  // The backend is held from now: the window's first heartbeat comes 2 s later, and a sweep in
  // between must not stop what this launch is bringing up. A hold, not a window: nothing is open
  // yet, so /api/apps/running and a snapshot do not count it.
  const runnerToken = gw.mintRunnerToken();
  rt.holdForLaunch();
  if (!rec.stoppedByOwner) await settle(rt, LAUNCH_WAIT_MS);
  const st = rt.status();
  sendJson(res, 200, {
    url: `${gw.origin}/__dc/enter?code=${gw.mintEnterCode()}`,
    runnerToken,
    title: st.name,
    state: rec.stoppedByOwner ? 'stopped' : (st.state === 'starting' ? 'running' : st.state),
    theme: readLauncherTheme(),
    ...(st.state === 'error' ? { lastError: st.lastError } : {}),
  });
}

export async function handleAppsRunning(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  sendJson(res, 200, { count: await runningWindowCount() });
}

/** `POST /api/apps/embed-check`: the page asks before drawing, framed by a foreign parent. */
export async function handleAppsEmbedCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const grant = isLoopbackHostRequest(req) ? resolveEmbedToken(req.headers['x-dc-embed']) : null;
  if (!grant) { sendError(res, 403, 'forbidden', 'This page cannot be shown here.'); return; }
  sendJson(res, 200, { ok: true, slug: grant.slug, vault: grant.vault });
}

/**
 * `POST /api/apps/:slug/say`: the embedded chat. A person typed it, the app's window delivered it,
 * so it runs as an APP message and is labelled so everywhere. Its proof is the embed token of
 * THIS app plus a same-origin Origin, never `fromOwnerPage`: the owner key reaches a page through
 * the shell's IPC, and a runner window has none.
 */
export async function handleAppSay(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  const grant = resolveEmbedToken(req.headers['x-dc-embed']);
  // The grant holds the registry's realpath; a vault reached through a symlink (macOS /var) must match it.
  const projectRoot = real(projectRootOf(contextRoot));
  if (!isLoopbackHostRequest(req) || !grant || grant.slug !== params.slug || grant.projectRoot !== projectRoot) {
    sendError(res, 403, 'forbidden', 'Only this app\'s embedded chat can do that.');
    return;
  }
  if (typeof req.headers.origin !== 'string' || !isSameOriginAsHost(req)) {
    sendError(res, 403, 'forbidden', 'This must come from the page itself.');
    return;
  }
  const app = appRunBrief(projectRoot, params.slug, home);
  if (!app) { sendError(res, 404, 'app_not_found', 'This app is not registered any more.'); return; }
  const body = (await parseJsonBody(req)) ?? {};
  const out = sayFromApp(contextRoot, {
    slug: typeof body.member === 'string' ? body.member : '',
    text: typeof body.text === 'string' ? body.text : '',
    app: { ...app, ownerTyped: true },
  });
  if (out.ok) sendJson(res, 200, out.body);
  else sendError(res, out.status, out.code, out.message);
}

/**
 * The proof an embedded frame shows: this app's token, its project, a loopback Host, and that the
 * page itself asked: a same-origin Origin for a write, `Sec-Fetch-Site: same-origin` for a GET (a
 * same-origin GET sends no Origin). Never `fromOwnerPage`: a runner window has no owner key.
 */
function embedGate(req: IncomingMessage, res: ServerResponse, slug: string, contextRoot: string, write: boolean): EmbedGrant | null {
  const grant = resolveEmbedToken(req.headers['x-dc-embed']);
  const ok = isLoopbackHostRequest(req) && !!grant && grant.slug === slug && grant.projectRoot === real(projectRootOf(contextRoot))
    && (write ? typeof req.headers.origin === 'string' && isSameOriginStrict(req) : String(req.headers['sec-fetch-site'] ?? '') === 'same-origin');
  if (!ok) { sendError(res, 403, 'forbidden', 'Only this app\'s embedded chat can do that.'); return null; }
  return grant;
}

/** GET /api/apps/:slug/chats: the open row and the rest of the app's conversations. */
export async function handleAppChats(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  const grant = embedGate(req, res, params.slug, contextRoot, false);
  if (!grant) return;
  const rec = getApp(home, grant.projectRoot, grant.slug);
  if (!rec) { sendError(res, 404, 'app_not_found', 'This app is not registered any more.'); return; }
  const m = readManifest(rec.root);
  sendJson(res, 200, {
    assistant: assistantOf(rec),
    name: m.ok ? m.manifest.name : rec.name,
    chats: listAppChats(rec.hash, rec.projectRoot, home).filter((c) => !c.removedAt).map((c) => ({
      id: c.id, title: c.title, createdAt: c.createdAt, closedAt: c.closedAt, member: c.member,
      // Nothing was said in it: the row a new chat reuses, after a reload too.
      empty: !claudeConversationExists(newestAppChat(c.id, home)),
    })),
  });
}

async function chatPatch(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string, change: (id: string, body: Record<string, unknown>) => void): Promise<void> {
  const grant = embedGate(req, res, params.slug, contextRoot, true);
  if (!grant) return;
  const body = (await parseJsonBody(req)) ?? {};
  const id = typeof body.id === 'string' ? body.id : '';
  const hit = lookupAppChat(id, home);
  const rec = getApp(home, grant.projectRoot, grant.slug);
  if (hit.kind !== 'record' || !rec || hit.record.hash !== rec.hash) { sendError(res, 404, 'not_found', 'No such conversation in this app.'); return; }
  // A rotated chat: the state lives at the end of its chain.
  change(newestAppChat(id, home), body);
  sendJson(res, 200, { ok: true });
}

/** POST /api/apps/:slug/chats/close {id}: off the open row, and its child ends now: a row never
 *  shown since a reload has no socket to take it down, and it would keep its seat. */
export async function handleAppChatClose(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  await chatPatch(req, res, params, contextRoot, (id) => {
    closeAppChat(id, home);
    void stopLiveChat(appChatRoot(id, home)).catch((err: unknown) => console.warn(`[apps] ${params.slug}: a closed chat did not stop: ${(err as Error).message}`));
  });
}

/** POST /api/apps/:slug/chats/title {id, title}. */
export async function handleAppChatTitle(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  await chatPatch(req, res, params, contextRoot, (id, body) => { titleAppChat(id, typeof body.title === 'string' ? body.title : '', home); });
}

export async function handleAppLaunch(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const rec0 = findApp(contextRoot, params.slug, res);
  if (!rec0) return;
  if (process.platform !== 'darwin') { sendError(res, 409, 'mac_only', 'App windows open in the Mac app.'); return; }
  const body = (await parseJsonBody(req)) ?? {};
  let rec = rec0;
  // A link: a bare one, or a spent one, never spawns anything. See link-nonces.ts.
  const linkPath = body.link === true ? spendLinkNonce(rec.hash, body.nonce) : null;
  if (body.link === true && linkPath === null && (existingRuntime(rec.hash)?.liveWindows() ?? 0) === 0) {
    sendJson(res, 200, { ok: true, landed: 'card' });
    return;
  }
  if (body.owner === true && rec.stoppedByOwner) rec = updateApp(home, rec.projectRoot, rec.slug, { stoppedByOwner: false }) ?? rec;
  const rt = runtime(rec);
  const launchGw = await gatewayFor(rt);
  if (body.owner === true && rec0.stoppedByOwner) await retireStoppedWindow(rec, rt);
  const alive = liveWindowsOf(rec, rt) > 0;
  // A window already open keeps its page: a link only brings it forward.
  if (linkPath !== null && !alive) launchGw.pendingPath = linkPath;
  const f = focusApp(rec, { runnerAlive: alive });
  if (!f.ok) { sendError(res, 409, f.code, f.message); return; }
  sendJson(res, 200, { ok: true, state: rec.stoppedByOwner ? 'stopped' : rt.status().state, focused: alive });
}

export async function handleAppStop(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const rec = findApp(contextRoot, params.slug, res);
  if (!rec) return;
  const next = updateApp(home, rec.projectRoot, rec.slug, { stoppedByOwner: true }) ?? rec;
  const rt = existingRuntime(rec.hash);
  if (rt) { rt.setRecord(next); rt.stop(); }
  await closeMcpClients(rec.hash);
  sendJson(res, 200, { ok: true, state: 'stopped' });
}

export async function handleAppStatus(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const rec = findApp(contextRoot, params.slug, res);
  if (!rec) return;
  sendJson(res, 200, publicStatus(rec));
}

export async function handleAppLogs(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const rec = findApp(contextRoot, params.slug, res);
  if (!rec) return;
  const n = Math.max(1, Math.min(2000, Number(new URL(req.url ?? '/', 'http://x').searchParams.get('n')) || 200));
  const rt = existingRuntime(rec.hash);
  sendJson(res, 200, { lines: rt ? rt.log.tail(n) : [] });
}

export async function handleAppSnapshot(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const rec = findApp(contextRoot, params.slug, res);
  if (!rec) return;
  const gw = await existingGateway(rec.hash);
  if (!gw || gw.runtime.liveWindows() === 0) {
    sendError(res, 409, 'app_not_open', `The app window is not open. Open it with: dreamcontext apps open ${rec.slug}`);
    return;
  }
  const r = await gw.requestSnapshot();
  if ('error' in r) { sendError(res, r.error === 'snapshot_timeout' ? 504 : 409, r.error, `Snapshot failed: ${r.error}`); return; }
  sendJson(res, 200, { ok: true, id: r.id, file: r.file });
}

// ─── The one gate every app tool call passes (app-araclari plan r3 §4.1, §4.2) ─────

/** An unlisted path or a schedule: the 5 minutes every call had before tools got their own timeout. */
const UNLISTED_TIMEOUT_SEC = 300;

export interface GateCall {
  method: string;
  /** The backend path as it will be sent (a query allowed: it is matched without it). */
  path: string;
  /** The caller said the owner agreed to this change (`--confirm`, MCP `confirm`, an Assistant proposal). */
  confirm: boolean;
  claim: CallClaim;
  /** The caller's conversation ids (tab session, Claude session): a Super child is told by them. */
  sessions?: readonly string[];
  /** One of the app's own enabled schedules, the call matching it (the automations tick): the owner agreed when he left it on. */
  schedule?: boolean;
  /** The tool id the caller means (`apps do`): decides between tools sharing one route. */
  tool?: string;
}

export type GateVerdict =
  | { ok: true; effect: ToolEffect; action: AppAction | null; timeoutMs: number }
  | { ok: false; http: number; code: 'needs_confirm' | 'needs_owner'; message: string; tool?: { id: string; title: string; does?: string; input?: string } };

/** The manifest action at (method, path), the query left out. */
export function matchAction(actions: readonly AppAction[], method: string, path: string, tool?: string): AppAction | null {
  return resolveAction(actions, method, path, tool).action;
}

/** The action, and whether the caller's tool name held for this call. */
function resolveAction(actions: readonly AppAction[], method: string, path: string, tool?: string): { action: AppAction | null; named: boolean; shared: boolean } {
  const same = sameRoute(actions, method, path);
  // The caller named the tool (`apps do`, the Assistant). The name never lowers authority: it holds
  // only when the call, its query DECODED, matches that tool and no sibling, with no key twice
  // (`?mode=%6Cive` or `?mode=dry&mode=live` behind a read tool's name names nothing).
  const named = tool ? namedAction(same, path, tool) : undefined;
  if (named) return { action: named, named: true, shared: same.length > 1 };
  // Two tools on one base path (`?mode=dry` / `?mode=live`): a changing one wins, so a query never makes a change look like a read.
  return { action: same.find((a) => effectOf(a) === 'change') ?? same[0] ?? null, named: false, shared: same.length > 1 };
}

function namedAction(same: readonly AppAction[], path: string, tool: string): AppAction | undefined {
  const a = same.find((x) => x.id === tool);
  if (!a) return undefined;
  let call: URLSearchParams;
  try { call = new URLSearchParams(path.split('?').slice(1).join('?')); } catch { return undefined; }
  const keys = [...call.keys()];
  if (new Set(keys).size !== keys.length) return undefined;
  const fits = (x: AppAction): boolean => {
    let own: URLSearchParams;
    try { own = new URLSearchParams(x.path.split('?').slice(1).join('?')); } catch { return true; }
    for (const [k, v] of own) if (call.get(k) !== v) return false;
    return true;
  };
  if (!fits(a)) return undefined;
  return same.some((o) => o !== a && fits(o)) ? undefined : a;
}

function sameRoute(actions: readonly AppAction[], method: string, path: string): AppAction[] {
  const bare = path.split('?')[0];
  return actions.filter((a) => a.method === method && a.path.split('?')[0] === bare);
}

/** Is any of these conversations the Super Agent or one of its children right now? */
function superSession(sessions: readonly string[] | undefined): boolean {
  for (const id of sessions ?? []) {
    if (!id) continue;
    try {
      if (isSuperSessionId(id) || isSuperChild(id) || handedOverChildRoot(id)) return true;
    } catch { return true; /* cannot tell: closed */ }
  }
  return false;
}

/**
 * THE gate, called by `handleAppCall` (CLI, MCP, a raw loopback POST) and `runAppAction` (the
 * Assistant). A read passes. A change needs `confirm`, and then who is asking decides:
 * `spawned` and `crew` (and any Super conversation, whatever it claims) never; an unattended
 * `run` only with this tool in its approved job's `app_tools`, or in a turn the owner started
 * from the dashboard; the owner's chats and terminal pass. A header can only take rights away.
 */
export function gateAppCall(contextRoot: string, rec: AppRecord, actions: readonly AppAction[], call: GateCall, deps: { home?: string } = {}): GateVerdict {
  const method = call.method.toUpperCase();
  const resolved = resolveAction(actions, method, call.path, call.tool);
  const action = resolved.action;
  // Several tools on this route and no name that held: no job's app_tools can vouch for which one runs.
  const ambiguous = resolved.shared && !resolved.named;
  // An unlisted GET reads; an unlisted anything else changes.
  const effect: ToolEffect = action ? effectOf(action) : effectOf({ method });
  // A listed tool gets its own timeout (60 s by default); an unlisted path or a schedule keeps the old 5 minutes.
  const timeoutMs = (action && !call.schedule ? toolTimeoutSec(action) : action?.timeoutSec ?? UNLISTED_TIMEOUT_SEC) * 1000;
  if (effect === 'read') return { ok: true, effect, action, timeoutMs };
  const tool = action ? { id: action.id, title: action.title, ...(action.does ? { does: action.does } : {}), ...(action.input ? { input: action.input } : {}) } : undefined;
  if (!call.confirm && !call.schedule) {
    return { ok: false, http: 409, code: 'needs_confirm', message: `${action ? `"${action.title}"` : `${method} ${call.path.split('?')[0]}`} changes something. Say in one line what it will do, and run it with --confirm only after the owner says yes in this chat.`, ...(tool ? { tool } : {}) };
  }
  const refuse = (why: string): GateVerdict => ({ ok: false, http: 403, code: 'needs_owner', message: `${why} The owner can run it in a normal chat or in the app's window.`, ...(tool ? { tool } : {}) });
  let cls = call.claim.class;
  if (superSession(call.sessions)) cls = 'crew';
  if (cls === 'spawned') return refuse('A changing app tool does not run from a session no owner is typing in.');
  if (cls === 'crew') return refuse('The Super Agent and its chats never run a changing app tool.');
  if (cls === 'run') {
    const slug = call.claim.automation ?? '';
    if (action && slug && !ambiguous) {
      const m = getAutomation(contextRoot, slug, deps.home);
      const ref = `${rec.slug}/${action.id}`;
      if (m && m.appTools?.includes(ref) && checkApproval(projectRootOf(contextRoot), m, deps.home).approved) return { ok: true, effect, action, timeoutMs };
    }
    if (slug && call.claim.run && jobStartedByOwner(contextRoot, slug, call.claim.run)) return { ok: true, effect, action, timeoutMs };
    return refuse(`An unattended run changes things only with a tool its approved job names (app_tools: ${rec.slug}/${action?.id ?? '<tool>'}).`);
  }
  return { ok: true, effect, action, timeoutMs };
}

/** Session ids a caller sent in the `x-dc-run` header (`sessions`), at most 4, uuid-shaped. */
function sessionsOf(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  try {
    const o = JSON.parse(String(Array.isArray(raw) ? raw[0] : raw)) as { sessions?: unknown };
    return Array.isArray(o.sessions) ? o.sessions.filter((x): x is string => typeof x === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(x)).slice(0, 4) : [];
  } catch { return []; }
}

/** One request to the app backend, as the gateway would send it (call lease, sink, 256 KB). */
export async function handleAppCall(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  holdOpen(req);
  const rec = findApp(contextRoot, params.slug, res);
  if (!rec) return;
  if (rec.stoppedByOwner) { sendError(res, 409, 'app_stopped', `The owner stopped this app. Start it with: dreamcontext apps open ${rec.slug}`); return; }
  const body = (await parseJsonBody(req)) ?? {};
  const method = typeof body.method === 'string' ? body.method.toUpperCase() : 'GET';
  if (!(ACTION_METHODS as readonly string[]).includes(method)) { sendError(res, 400, 'bad_method', 'method must be GET, POST, PUT, PATCH or DELETE'); return; }
  const p = safeAppPath(body.path);
  if (!p.ok) { sendError(res, 400, 'bad_path', p.reason); return; }
  const m = readManifest(rec.root);
  const header = req.headers[RUN_HEADER];
  // `schedule: <id>` counts only when that enabled schedule of the manifest makes exactly this call.
  const sid = typeof body.schedule === 'string' ? body.schedule : '';
  const sched = sid && m.ok ? m.manifest.schedules.find((x) => x.id === sid) : undefined;
  const schedPath = sched ? safeAppPath(sched.call.path) : undefined;
  const schedule = !!sched && sched.call.method.toUpperCase() === method && !!schedPath?.ok && schedPath.path === p.path
    && readScheduleState(home, rec.hash)[sid]?.enabled !== false;
  const verdict = gateAppCall(contextRoot, rec, m.ok ? m.manifest.actions : [], {
    method, path: p.path, confirm: body.confirm === true, claim: decodeClaim(header), sessions: sessionsOf(header), schedule,
    ...(typeof body.tool === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(body.tool) ? { tool: body.tool } : {}),
  }, { home });
  if (!verdict.ok) { sendJson(res, verdict.http, { error: verdict.code, message: verdict.message, ...(verdict.tool ? { tool: verdict.tool } : {}) }); return; }
  const out = await callBackend(rec, method, p.path, body.body, verdict.timeoutMs);
  if (!out.ok) { sendError(res, out.http, out.code, out.message); return; }
  sendJson(res, 200, { status: out.status, contentType: out.type, body: out.text, effect: verdict.effect, ms: out.ms });
}

type BackendCall =
  | { ok: true; status: number; type: string; text: string; ms: number }
  | { ok: false; http: number; code: string; message: string };

/** One request to an app's backend under a call lease: `apps call`, `apps do`, the Assistant's `app-do`. */
async function callBackend(rec: AppRecord, method: string, path: string, value: unknown, timeoutMs: number): Promise<BackendCall> {
  const p = { path };
  const t0 = Date.now();
  const rt = runtime(rec);
  await gatewayFor(rt);
  const release = rt.acquireCall();
  try {
    // No 20 s cut here (that budget is the window's): a call waits for the whole start, build
    // included, under its lease; a cut would answer backend_down and leave the start to the sweeper.
    await rt.ensureRunning();
    if (!rt.manifest?.backend) return { ok: false, http: 409, code: 'no_backend', message: 'This app has no backend to call.' };
    const b = rt.backend;
    if (!b) return { ok: false, http: 503, code: 'backend_down', message: rt.scrub(rt.lastError ?? 'the backend is not running') };
    const payload = method === 'GET' || method === 'DELETE' || value === undefined ? null : Buffer.from(JSON.stringify(value), 'utf-8');
    const result = await new Promise<{ status: number; text: string; type: string } | { error: string }>((resolve) => {
      const up = http.request({
        host: '127.0.0.1', port: b.port, method, path: p.path, agent: false, timeout: timeoutMs,
        headers: {
          host: `127.0.0.1:${b.port}`,
          [GATEWAY_SECRET_HEADER]: rt.gatewaySecret,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        },
      }, (ur) => {
        const chunks: Buffer[] = [];
        let n = 0;
        let cut = false;
        ur.on('data', (c: Buffer) => {
          if (cut) return;
          n += c.length;
          if (n > CALL_MAX_BYTES) { cut = true; chunks.push(c.subarray(0, CALL_MAX_BYTES - (n - c.length))); return; }
          chunks.push(c);
        });
        ur.on('end', () => resolve({ status: ur.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf-8') + (cut ? '\n…[truncated at 256 KB]' : ''), type: String(ur.headers['content-type'] ?? '') }));
        ur.on('error', () => resolve({ error: 'backend_error' }));
      });
      up.on('timeout', () => { up.destroy(); resolve({ error: 'call_timeout' }); });
      up.on('error', () => resolve({ error: 'backend_error' }));
      if (payload) up.end(payload); else up.end();
    });
    if ('error' in result) return { ok: false, http: result.error === 'call_timeout' ? 504 : 502, code: result.error, message: result.error === 'call_timeout' ? `The tool ran longer than ${Math.round(timeoutMs / 1000)} s.` : 'The backend did not answer.' };
    return { ok: true, status: result.status, type: result.type, text: rt.scrub(result.text), ms: Date.now() - t0 };
  } finally {
    release();
  }
}

export async function handleAppDelete(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const rec = findApp(contextRoot, params.slug, res);
  if (!rec) return;
  // An installed app leaves through Uninstall (to the trash, restorable), never half-removed.
  if (rec.origin === 'installed') { sendError(res, 409, 'use_uninstall', 'This app was installed from someone else: remove it with Uninstall on its card (it goes to the trash).'); return; }
  // Its conversations read from now on and spawn nothing; the ones running end here.
  for (const id of stampAppRemoved(rec.hash, home)) void stopLiveChat(id).catch(() => { /* already gone */ });
  forgetRuntime(rec.hash);
  await closeMcpClients(rec.hash);
  await closeGateway(rec.hash);
  removeAppBundle(home, rec.slug, rec.hash);
  removeShots(home, rec.hash);
  removePins(home, rec.hash);
  unregisterApp(home, rec.projectRoot, rec.slug);
  sendJson(res, 200, { ok: true, kept: rec.root, note: 'The app code was not deleted.' });
}

/** The app's icon as a raster image (never SVG: on the dashboard origin it would run script). */
export function appIconPath(contextRoot: string, slug: string): string | null {
  const rec = getApp(home, projectRootOf(contextRoot), slug);
  if (!rec) return null;
  const m = readManifest(rec.root);
  return m.ok ? servableIcon(m.manifest.icon) : null;
}


/** GET /api/apps/:slug/icon: the app's raster icon (allow-listed types, nosniff). */
export async function handleAppIcon(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  sendPhotoFile(res, appIconPath(contextRoot, params.slug) ?? await appIcnsRaster(contextRoot, params.slug));
}

/** An `.icns` icon as the cached PNG the notch and the history can draw. */
async function appIcnsRaster(contextRoot: string, slug: string): Promise<string | null> {
  const rec = getApp(home, projectRootOf(contextRoot), slug);
  const m = rec ? readManifest(rec.root) : null;
  return m?.ok && m.manifest.icon ? icnsToPng(m.manifest.icon, home) : null;
}

// ─── MCP approval (.mcp.json definitions need the owner's one click, in the notch) ──────

const mcpPending = new Map<string, true>();
const mcpCooldown = new Map<string, number>();
const MCP_COOLDOWN_MS = 10 * 60_000;

type McpState = { name: string; state: 'ok' | 'needs_owner_ok' | 'changed' | 'pending' | 'unreadable' | 'missing'; source: string | null; message?: string };

function mcpStates(rec: AppRecord, names: readonly string[]): McpState[] {
  return names.map((name) => {
    const hit = resolveMcpDefinition(rec.projectRoot, name, home);
    if (!hit) return { name, state: 'missing', source: null };
    if (hit.source !== 'project') return { name, state: 'ok', source: hit.source };
    const r = reviewMcpDefinition(hit.raw);
    if (!r.ok) return { name, state: 'unreadable', source: 'project', message: r.message };
    if (mcpPending.has(`${rec.hash}:${name}`)) return { name, state: 'pending', source: 'project' };
    const pin = readPins(home, rec.hash).servers[name];
    if (!pin) return { name, state: 'needs_owner_ok', source: 'project' };
    return { name, state: pin.hash === mcpHash(r.def) ? 'ok' : 'changed', source: 'project' };
  });
}

/**
 * POST /api/apps/:slug/mcp-request {server}: open ONE approval row in the notch for a
 * `.mcp.json` definition. Nobody writes a pin here: only the owner's click (the proposal's
 * decision) does, with the copy captured NOW (an edit to the text is never what gets pinned).
 */
export async function handleAppMcpRequest(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const rec = findApp(contextRoot, params.slug, res);
  if (!rec) return;
  const body = (await parseJsonBody(req)) ?? {};
  const name = typeof body.server === 'string' ? body.server : '';
  const m = readManifest(rec.root);
  if (!m.ok || !m.manifest.mcp.includes(name)) { sendError(res, 400, 'mcp_not_in_manifest', 'Name a server from the app manifest\'s mcp list.'); return; }
  const hit = resolveMcpDefinition(rec.projectRoot, name, home);
  if (!hit || hit.source !== 'project') { sendError(res, 409, 'no_approval_needed', 'Only a project .mcp.json definition needs the owner\'s approval.'); return; }
  const review = reviewMcpDefinition(hit.raw);
  if (!review.ok) { sendError(res, 409, review.code, review.message); return; }
  const key = `${rec.hash}:${name}`;
  if (mcpPending.has(key)) { sendError(res, 409, 'already_pending', 'The approval is already waiting in the notch.'); return; }
  const cool = mcpCooldown.get(key);
  if (cool && Date.now() < cool) { sendError(res, 429, 'cooldown', 'Declined a moment ago; ask again in a few minutes.'); return; }
  const prev = readPins(home, rec.hash).servers[name]?.def ?? null;
  const captured = review.def;
  const capturedHash = mcpHash(captured);
  const { view, decision } = createProposal({
    verb: 'app-mcp-accept',
    target: `${rec.vault} · ${rec.slug} · ${rec.name} · ${name}`,
    text: describeChange(prev, captured, review.ignored),
    provenance: 'an app asks to use a server from the project .mcp.json with its own keys',
  });
  mcpPending.set(key, true);
  void decision.then((d) => {
    mcpPending.delete(key);
    if (d.outcome === 'approved') {
      // Pin exactly what was shown, unless the file changed in between.
      const now = resolveMcpDefinition(rec.projectRoot, name, home);
      const again = now && now.source === 'project' ? reviewMcpDefinition(now.raw) : null;
      if (again && again.ok && mcpHash(again.def) === capturedHash) writePin(home, rec.hash, name, captured);
    } else if (d.reason === 'rejected') {
      mcpCooldown.set(key, Date.now() + MCP_COOLDOWN_MS);
    }
  }).catch((err: unknown) => {
    mcpPending.delete(key);
    console.error(`  [apps] ${rec.slug}: the MCP approval for "${name}" could not be saved: ${(err as Error)?.message ?? err}`);
  });
  sendJson(res, 200, { ok: true, proposal: view.id });
}

/** POST /api/apps/:slug/schedules/:id {enabled} — the card's on/off switch. */
export async function handleAppScheduleToggle(req: IncomingMessage, res: ServerResponse, params: Params, contextRoot: string): Promise<void> {
  if (!requireLocalDesktop(req, res)) return;
  const rec = findApp(contextRoot, params.slug, res);
  if (!rec) return;
  const body = (await parseJsonBody(req)) ?? {};
  if (typeof body.enabled !== 'boolean') { sendError(res, 400, 'bad_body', 'enabled must be true or false'); return; }
  setScheduleEnabled(home, rec.hash, params.id, body.enabled);
  sendJson(res, 200, { ok: true, schedules: scheduleViews(home, rec) });
}
