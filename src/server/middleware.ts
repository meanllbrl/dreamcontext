import { IncomingMessage, ServerResponse } from 'node:http';
import { isSameOriginAsHost, remoteAccessEnabled } from './remote-access.js';
import { CLOUD_FORWARDED_ORIGIN, CLOUD_WS_PATHS, classifyCloudRoute, cloudPhase } from './cloud-mode.js';
import {
  TRANSFER_NONCE_HEADER,
  carriesTransferAuth,
  deviceCookieValue,
  handsfreeAuth,
  hasValidDeviceSession,
  hasValidTransferProof,
  clearDeviceCookieHeader,
} from './handsfree-auth.js';
import { redirectToTripChat, sendSealedPage } from './handsfree-login.js';

const MAX_BODY_SIZE = 1_048_576; // 1MB

/**
 * Parse JSON body from request. Returns parsed object or null.
 */
export async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * Send JSON response.
 */
export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Send error response.
 */
export function sendError(res: ServerResponse, statusCode: number, error: string, message: string): void {
  sendJson(res, statusCode, { error, message });
}

/** Origins allowed to call the local dashboard API — loopback only. */
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * A WebSocket upgrade from a BROWSER page on another origin. Browsers send `Origin` on every
 * WS handshake and CORS does not apply to WebSockets, so without this a web page the owner
 * merely visits could open `ws://127.0.0.1:<port>/…` — it IS loopback from the server's view.
 * No `Origin` (a CLI, a test, a native client) is not a browser page and is not refused here.
 */
export function isForeignOriginUpgrade(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !!origin && !LOCAL_ORIGIN_RE.test(origin);
}

/**
 * True for a state-changing request issued from a cross-site origin.
 * Browsers always attach Origin on POST/PUT/PATCH/DELETE; a non-browser
 * client (curl, the CLI itself) sends none and is not a CSRF vector.
 * Used to block drive-by writes from a malicious page in the user's browser.
 */
export function isCrossSiteWrite(req: IncomingMessage): boolean {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  if (LOCAL_ORIGIN_RE.test(origin)) return false;
  // Remote access (see `remote-access.ts`): the dashboard now answers on a tailnet address,
  // so a phone's own writes carry `Origin: http://100.x.y.z:4173` — same-origin in every
  // sense a browser means it, but not a spelling `LOCAL_ORIGIN_RE` can enumerate. Accept it
  // only when the origin IS the host that was dialed; a drive-by page still sends its own
  // origin and stays blocked, and with remote access off nothing here changes at all.
  return !(remoteAccessEnabled() && isSameOriginAsHost(req));
}

/**
 * CORS for the local dashboard. Reflects ONLY a loopback origin — or, with remote access
 * on, the host this request was sent to — never a wildcard, so a third-party web page
 * cannot read API responses.
 * Returns true if the request was a handled OPTIONS preflight.
 */
export function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  // Same widening as `isCrossSiteWrite`, and for the same reason: with remote access on, a
  // reflectable origin is either a loopback spelling or the host this very request was sent
  // to. Never a wildcard, and never a third-party origin.
  const reflectable = !!origin
    && (LOCAL_ORIGIN_RE.test(origin) || (remoteAccessEnabled() && isSameOriginAsHost(req)));
  if (origin && reflectable) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dreamcontext-Vault');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// ─── Cloud mode (hands-free): the public forwarded port ─────────────────────
//
// GitHub's forwarder connects on loopback with `Host: localhost:8080` (W0), so in cloud mode
// NOTHING is trusted for being loopback and nothing is derived from Host. A request passes on
// exactly one credential for its route class: none (public), the device cookie (the phone),
// or the transfer proof (the laptop) — the last two are never interchangeable.

/** The origins a cloud write or WS upgrade may carry: the forwarder's rewrite of our own
 *  public origin, plus `DC_HF_ORIGIN` itself for a client that reaches us unrewritten. */
export function cloudAllowedOrigins(): string[] {
  const out = [CLOUD_FORWARDED_ORIGIN];
  const own = process.env.DC_HF_ORIGIN;
  if (own) out.push(own.replace(/\/+$/, ''));
  return out;
}

/** A missing Origin is refused too: in the cloud every legitimate writer sends one. */
export function isCloudOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && cloudAllowedOrigins().includes(origin);
}

function isWriteMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

function cloudPathname(req: IncomingMessage): string {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/** HTML navigations without a session go to the login page instead of a JSON 401. */
function wantsHtml(req: IncomingMessage): boolean {
  return /text\/html/.test(String(req.headers.accept || ''));
}

/**
 * The cloud gate, replacing checkNetworkAuth → handleCors → isCrossSiteWrite in cloud mode.
 * Returns true when the request may proceed; otherwise it has answered. Never logs headers,
 * bodies or query strings.
 */
export function cloudGate(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader('X-Dreamcontext-Cloud', '1');
  const method = (req.method || 'GET').toUpperCase();
  // No CORS at all: the phone is same-origin, and a preflight answered without
  // Access-Control-Allow-Origin makes the browser refuse any cross-site caller.
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return false;
  }
  if (isWriteMethod(method) && !isCloudOriginAllowed(req)) {
    sendError(res, 403, 'forbidden', 'Cross-site request blocked.');
    return false;
  }

  const pathname = cloudPathname(req);
  const cls = classifyCloudRoute(method, pathname);
  if (cls === 'unavailable') {
    sendError(res, 403, 'cloud_unavailable', 'This is not available on the cloud machine.');
    return false;
  }
  if (cls === 'public') {
    // /api/health hands out the nonce the laptop's next transfer proof signs.
    if (pathname === '/api/health') res.setHeader(TRANSFER_NONCE_HEADER, handsfreeAuth().issueNonce());
    return true;
  }
  if (cls === 'transfer') {
    if (deviceCookieValue(req) !== null) {
      sendError(res, 403, 'credential_mismatch', 'A device session cannot call a transfer route.');
      return false;
    }
    if (!hasValidTransferProof(req)) {
      sendError(res, 401, 'unauthorized', 'Transfer proof required.');
      return false;
    }
    return true;
  }

  // Device class: the phone's UI and its allow-listed API.
  if (carriesTransferAuth(req)) {
    sendError(res, 403, 'credential_mismatch', 'The transfer credential cannot call a device route.');
    return false;
  }
  const htmlNavigation = !pathname.startsWith('/api/') && (method === 'GET' || method === 'HEAD') && wantsHtml(req);
  // AC3: a sealed cloud serves only the sealed page to a navigation, signed in or not (it also
  // forgets the offline worker); the API keeps the JSON 503 below.
  if (htmlNavigation && cloudPhase() === 'sealed') {
    sendSealedPage(req, res);
    return false;
  }
  if (!hasValidDeviceSession(req)) {
    if (htmlNavigation) {
      // A cookie the server no longer accepts (revoked, password changed, expired): the login
      // page is told so it unregisters the offline worker (AC16). No cookie: a plain first visit.
      const stale = deviceCookieValue(req) !== null;
      res.writeHead(302, {
        Location: stale ? '/login?revoked=1' : '/login',
        'Cache-Control': 'no-store',
        ...(stale ? { 'Set-Cookie': clearDeviceCookieHeader() } : {}),
      });
      res.end();
      return false;
    }
    sendError(res, 401, 'unauthorized', 'Sign in on this device first.');
    return false;
  }
  const phase = cloudPhase();
  if (phase === 'sealed') {
    sendError(res, 503, 'cloud_sealed', 'This project is back on your laptop.');
    return false;
  }
  if (phase === 'quiescing' && isWriteMethod(method)) {
    sendError(res, 423, 'cloud_quiescing', 'Your laptop is taking this project back.');
    return false;
  }
  // AC3: `/` on the phone opens the trip's project chat, never the launcher.
  if (htmlNavigation && redirectToTripChat(req, res)) return false;
  return true;
}

/**
 * The cloud's WebSocket gate: the status to refuse an upgrade with, or null to let it
 * through. Only the chat socket, only with a device session, our Origin and phase active.
 */
export function cloudUpgradeRefusal(req: IncomingMessage): number | null {
  if (!CLOUD_WS_PATHS.includes(cloudPathname(req))) return 403;
  if (!isCloudOriginAllowed(req)) return 403;
  if (carriesTransferAuth(req)) return 403;
  if (!hasValidDeviceSession(req)) return 401;
  if (cloudPhase() !== 'active') return 403;
  return null;
}

/** Answer a refused cloud upgrade on the raw socket, with the cloud header like every
 *  other cloud response. */
export function rejectCloudUpgrade(socket: import('node:stream').Duplex, code: number): void {
  const text = code === 401 ? 'Unauthorized' : 'Forbidden';
  socket.write(`HTTP/1.1 ${code} ${text}\r\nX-Dreamcontext-Cloud: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
