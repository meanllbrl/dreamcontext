import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import {
  startDeviceFlow,
  pollDeviceFlow,
  fetchAuthenticatedLogin,
  BRAIN_OAUTH_CLIENT_ID,
  type FetchImpl,
} from '../../lib/git-sync/oauth.js';
import {
  writeGlobalGitHubToken,
  setGlobalGitHubLogin,
  readGlobalGitHubToken,
  readGlobalGitHubLogin,
  clearGlobalGitHubToken,
} from '../../lib/git-sync/auth-store.js';

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
    sendError(res, 403, 'desktop_only', 'GitHub sign-in is only available in the desktop app.');
    return false;
  }
  return true;
}

// ─── POST /api/brain/auth/device/start ───────────────────────────────────────

export async function handleBrainAuthDeviceStart(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gate(res)) return;
  pruneDeviceSessions();

  try {
    const started = await startDeviceFlow(BRAIN_OAUTH_CLIENT_ID, fetchImpl);
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
    const result = await pollDeviceFlow(BRAIN_OAUTH_CLIENT_ID, session.deviceCode, fetchImpl);
    switch (result.status) {
      case 'authorized': {
        // Persist to the global store (0600) BEFORE evicting — never log the token.
        writeGlobalGitHubToken(result.token, authHome);
        let login: string | null = null;
        try { login = await fetchAuthenticatedLogin(result.token, fetchImpl); } catch { login = null; }
        if (login) setGlobalGitHubLogin(login, authHome);
        deviceSessions.delete(sessionId);
        sendJson(res, 200, { status: 'authorized', login });
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
): Promise<void> {
  if (!gate(res)) return;

  const global = readGlobalGitHubToken(authHome);
  if (global) {
    sendJson(res, 200, { connected: true, login: readGlobalGitHubLogin(authHome) ?? undefined, source: 'global' });
    return;
  }
  for (const envVar of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = process.env[envVar];
    if (v && v.trim()) {
      sendJson(res, 200, { connected: true, source: 'env' });
      return;
    }
  }
  sendJson(res, 200, { connected: false, source: null });
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
  sendJson(res, 200, { connected: true, login, source: 'global' });
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
