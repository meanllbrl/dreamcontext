import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import {
  startDeviceFlow,
  pollDeviceFlow,
  fetchAuthenticatedLogin,
  resolveBrainOAuthClientId,
  isOAuthAppConfigured,
  type FetchImpl,
} from '../../lib/git-sync/oauth.js';
import { dirname } from 'node:path';
import {
  writeGlobalGitHubToken,
  setGlobalGitHubLogin,
  readGlobalGitHubLogin,
  readGlobalGitHubNeedsReconnect,
  setGlobalGitHubAuthValid,
  clearGlobalGitHubToken,
  clearProjectGitHubDemotion,
  projectGitHubTokenState,
  resolveGitHubCredential,
} from '../../lib/git-sync/auth-store.js';
import { writeGitHubToken, removeProjectGitHubToken } from '../../lib/task-backend/secrets.js';
import { drainGitHubTaskQueues, isDrainStuck } from '../sync-job.js';
import { readTaskQueueDepth } from '../../lib/sleep-cycle-tools.js';
import { readSetupConfig } from '../../lib/setup-config.js';

/**
 * `/api/brain/auth/*` — the app-global "sign into dreamcontext with GitHub"
 * routes (device flow + PAT fallback). App-global (vault-agnostic): they write
 * the SIGNED-IN account to the global `~/.dreamcontext/.secrets.json` store, not
 * a per-project one.
 *
 * SECURITY POSTURE (every handler):
 *  - desktop-gated (`isDesktop()` → 403 desktop_only);
 *  - loopback-only + CSRF fronted by the server entry (isCrossSiteWrite);
 *  - the device_code lives SERVER-ONLY in {@link deviceSessions} and is NEVER
 *    returned to the browser; the token is NEVER logged and NEVER echoed in a
 *    response body.
 */

// ─── Injectable fetch (tests mock GitHub with zero network) ──────────────────

let fetchImpl: FetchImpl = globalThis.fetch;
/** TEST-ONLY: swap the GitHub transport. Reset to `globalThis.fetch` in teardown. */
export function __setBrainAuthFetch(f: FetchImpl): void {
  fetchImpl = f;
}

/**
 * Home directory for the global auth store. `undefined` ⇒ the real `homedir()`.
 * TEST-ONLY override so a route test never reads or clobbers the developer's
 * real `~/.dreamcontext/.secrets.json`.
 */
let authHome: string | undefined;
export function __setBrainAuthHome(home: string | undefined): void {
  authHome = home;
}

// ─── Server-only device session store ────────────────────────────────────────

interface DeviceSession {
  /** SERVER-ONLY — never leaves this process. */
  deviceCode: string;
  /** Seconds between polls; bumped server-side on a GitHub `slow_down`. */
  interval: number;
  /** Epoch ms after which the code is dead. */
  expiresAt: number;
  /** Epoch ms of the last poll — a too-early poll is short-circuited to slow_down. */
  lastPolledAt: number;
}

const deviceSessions = new Map<string, DeviceSession>();
const DEVICE_SESSION_TTL_MS = 20 * 60 * 1000; // GitHub codes live ~15 min; evict a bit after.
const DEVICE_SESSIONS_MAX = 50;

/** Evict expired sessions and cap the map (oldest-first) — mirrors launcher captureRuns. */
function pruneDeviceSessions(): void {
  const now = Date.now();
  for (const [id, s] of deviceSessions) {
    if (now > s.expiresAt || now - s.expiresAt > DEVICE_SESSION_TTL_MS) deviceSessions.delete(id);
  }
  while (deviceSessions.size > DEVICE_SESSIONS_MAX) {
    const oldest = deviceSessions.keys().next().value;
    if (oldest === undefined) break;
    deviceSessions.delete(oldest);
  }
}

function gate(res: ServerResponse): boolean {
  if (!isDesktop()) {
    // C5: the dashboard maps this to "managed in the app", never to "not connected".
    sendJson(res, 403, { error: 'desktop_only', kind: 'desktop_only', reconnect: false, message: 'GitHub sign-in is only available in the desktop app.' });
    return false;
  }
  return true;
}

/**
 * After a fresh sign-in, the task queues that waited on a refused credential drain in the
 * background (D4). TEST seam: a route test swaps it so no real vault is touched.
 */
let afterSignIn: () => void = () => { void drainGitHubTaskQueues(authHome).catch(() => undefined); };
export function __setAfterGitHubSignIn(fn: () => void): void {
  afterSignIn = fn;
}

// ─── POST /api/brain/auth/device/start ───────────────────────────────────────

export async function handleBrainAuthDeviceStart(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gate(res)) return;

  // No registered OAuth App ⇒ the device flow can't work (GitHub 404s the
  // placeholder client_id). Short-circuit with a clear, actionable code so the
  // UI steers the user to the PAT path instead of firing a doomed request.
  if (!isOAuthAppConfigured()) {
    sendError(
      res,
      501,
      'oauth_not_configured',
      'One-click GitHub sign-in is not available in this build. Connect with a personal access token instead.',
    );
    return;
  }

  pruneDeviceSessions();

  try {
    const started = await startDeviceFlow(resolveBrainOAuthClientId(), fetchImpl);
    const sessionId = randomUUID();
    deviceSessions.set(sessionId, {
      deviceCode: started.deviceCode,
      interval: started.interval,
      expiresAt: Date.now() + started.expiresIn * 1000,
      lastPolledAt: 0,
    });
    // NOTE: deviceCode is intentionally NOT included in the response.
    sendJson(res, 200, {
      sessionId,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      expiresIn: started.expiresIn,
      interval: started.interval,
    });
  } catch (err) {
    sendError(res, 502, 'device_start_failed', (err as Error).message);
  }
}

// ─── POST /api/brain/auth/device/poll ────────────────────────────────────────

export async function handleBrainAuthDevicePoll(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gate(res)) return;

  const body = await parseJsonBody(req);
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    sendError(res, 400, 'invalid_body', 'sessionId is required.');
    return;
  }
  const session = deviceSessions.get(sessionId);
  if (!session) {
    sendError(res, 404, 'unknown_session', 'No such device session (expired or never started).');
    return;
  }

  const now = Date.now();
  if (now > session.expiresAt) {
    deviceSessions.delete(sessionId);
    sendJson(res, 200, { status: 'expired' });
    return;
  }
  // HARDENING: a poll arriving before the interval elapsed is short-circuited to
  // slow_down WITHOUT hitting GitHub — protects against a client that ignores
  // the server-returned interval.
  if (session.lastPolledAt && now - session.lastPolledAt < session.interval * 1000) {
    sendJson(res, 200, { status: 'slow_down', interval: session.interval });
    return;
  }
  session.lastPolledAt = now;

  try {
    const result = await pollDeviceFlow(resolveBrainOAuthClientId(), session.deviceCode, fetchImpl);
    switch (result.status) {
      case 'authorized': {
        // Persist to the global store (0600) BEFORE evicting — never log the token.
        writeGlobalGitHubToken(result.token, authHome);
        let login: string | null = null;
        try { login = await fetchAuthenticatedLogin(result.token, fetchImpl); } catch { login = null; }
        if (login) setGlobalGitHubLogin(login, authHome);
        // A fresh, GitHub-issued token clears any stale reconnect flag immediately.
        setGlobalGitHubAuthValid(true, authHome);
        deviceSessions.delete(sessionId);
        sendJson(res, 200, { status: 'authorized', login });
        afterSignIn();
        return;
      }
      case 'slow_down':
        session.interval = result.interval; // bump server-side
        sendJson(res, 200, { status: 'slow_down', interval: session.interval });
        return;
      case 'pending':
        sendJson(res, 200, { status: 'pending' });
        return;
      case 'expired':
        deviceSessions.delete(sessionId);
        sendJson(res, 200, { status: 'expired' });
        return;
      case 'denied':
        deviceSessions.delete(sessionId);
        sendJson(res, 200, { status: 'denied' });
        return;
      default:
        sendJson(res, 200, { status: 'error', message: result.message });
        return;
    }
  } catch (err) {
    sendError(res, 502, 'poll_failed', (err as Error).message);
  }
}

// ─── GET /api/brain/auth/status ──────────────────────────────────────────────

export async function handleBrainAuthStatus(
  req: IncomingMessage,
  res: ServerResponse,
  _params?: Record<string, string>,
  contextRoot?: string | null,
): Promise<void> {
  if (!gate(res)) return;

  // `oauthConfigured` tells the UI whether to offer the one-click device flow or
  // steer straight to the PAT path (the placeholder client_id can't reach GitHub).
  const oauthConfigured = isOAuthAppConfigured();
  // C5: whether the OPEN project overrides the sign-in with its own token, and its state.
  const projectToken = contextRoot ? projectGitHubTokenState(dirname(contextRoot)) : 'none';
  // The open project's GitHub task queue: what waits to sync, and whether the post-sign-in
  // drain gave up waiting on it (Settings → GitHub shows both).
  const taskQueue = contextRoot && readSetupConfig(dirname(contextRoot))?.taskBackend === 'github'
    ? { ...readTaskQueueDepth(contextRoot), stuck: isDrainStuck(contextRoot) }
    : null;

  // C1 without a project: the sign-in, else env (never read here directly).
  const cred = resolveGitHubCredential({ purpose: 'browse', home: authHome });
  if (cred?.source === 'global') {
    sendJson(res, 200, {
      connected: true,
      login: readGlobalGitHubLogin(authHome) ?? undefined,
      source: 'global',
      // Read straight off the shared truth the sync path writes — so this chip
      // and the sidebar sync surface can never disagree about the session.
      needsReconnect: readGlobalGitHubNeedsReconnect(authHome),
      oauthConfigured,
      projectToken,
      taskQueue,
    });
    return;
  }
  if (cred?.source === 'env') {
    sendJson(res, 200, { connected: true, source: 'env', oauthConfigured, projectToken, taskQueue });
    return;
  }
  sendJson(res, 200, { connected: false, source: null, oauthConfigured, projectToken, taskQueue });
}

// ─── POST /api/brain/auth/token (PAT fallback) ───────────────────────────────

export async function handleBrainAuthToken(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gate(res)) return;

  const body = await parseJsonBody(req);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) {
    sendError(res, 400, 'invalid_body', 'token is required.');
    return;
  }

  let login: string | null;
  try {
    login = await fetchAuthenticatedLogin(token, fetchImpl);
  } catch (err) {
    sendError(res, 502, 'validate_failed', (err as Error).message);
    return;
  }
  if (!login) {
    sendError(res, 400, 'invalid_token', 'That token is not valid (GitHub rejected it).');
    return;
  }
  // Never echo the token back.
  writeGlobalGitHubToken(token, authHome);
  setGlobalGitHubLogin(login, authHome);
  // The PAT just validated against GitHub — clear any stale reconnect flag.
  setGlobalGitHubAuthValid(true, authHome);
  sendJson(res, 200, { connected: true, login, source: 'global', needsReconnect: false });
  afterSignIn();
}

// ─── POST/DELETE /api/brain/auth/project-token (C6, Settings → GitHub → Advanced) ─

/**
 * The OPEN project's own GitHub token: validated against GitHub, written ONLY to its
 * `github.token` (gitignore first, 0600), the project's demotion marker lifted. GitHub-only
 * on purpose: it never writes through the active task backend, so a ClickUp key is never
 * touched. The token is never echoed.
 */
export async function handleBrainAuthProjectToken(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string | null,
): Promise<void> {
  if (!gate(res)) return;
  if (!contextRoot) {
    sendError(res, 400, 'no_vault', 'Open a project first: this token belongs to one project.');
    return;
  }
  const projectRoot = dirname(contextRoot);
  if (req.method === 'DELETE') {
    removeProjectGitHubToken(projectRoot);
    clearProjectGitHubDemotion(projectRoot);
    sendJson(res, 200, { projectToken: 'none' });
    return;
  }
  const body = await parseJsonBody(req);
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
  const raw = body && keys && keys.length === 1 && keys[0] === 'token' ? body.token : undefined;
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) {
    sendError(res, 400, 'invalid_body', 'The body must be exactly { "token": "<token>" }.');
    return;
  }
  let login: string | null;
  try {
    login = await fetchAuthenticatedLogin(token, fetchImpl);
  } catch (err) {
    sendError(res, 502, 'validate_failed', (err as Error).message);
    return;
  }
  if (!login) {
    sendError(res, 400, 'invalid_token', 'That token is not valid (GitHub rejected it).');
    return;
  }
  try {
    writeGitHubToken(projectRoot, token);
  } catch (err) {
    sendError(res, 500, 'write_failed', (err as Error).message);
    return;
  }
  clearProjectGitHubDemotion(projectRoot);
  sendJson(res, 200, { projectToken: 'active', login });
}

// ─── POST /api/brain/auth/logout ─────────────────────────────────────────────

export async function handleBrainAuthLogout(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gate(res)) return;
  clearGlobalGitHubToken(authHome);
  sendJson(res, 200, { connected: false });
}
