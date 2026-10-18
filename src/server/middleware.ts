import { IncomingMessage, ServerResponse } from 'node:http';
import { isSameOriginAsHost, remoteAccessEnabled } from './remote-access.js';
import { isMacOriginAllowed, macProbeNonce, requestSurface } from './phone-origin.js';
import type { AuditVia } from '../lib/task-audit.js';
import { MAC_PROBE_HEADER, MAC_SURFACE_HEADER, MAC_WS_PATHS } from '../lib/handsfree/mac/contract.js';
import { classifyMacRoute, type MacRouteClass, type RouteMatcher } from '../lib/handsfree/mac/route-policy.js';
import { deviceCookieValue, hasValidDeviceSession, clearDeviceCookieHeader } from './handsfree-auth.js';
import { redirectToMacChat } from './handsfree-login.js';

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

/**
 * An owner-only write (a verdict, a proposal accept, a change apply, a learned revert,
 * an Inbox "seen") must come from a browser: the dashboard and the phone always send
 * `Origin` on a write, a scripted call (an agent's `curl`) usually does not. Sends 403
 * `origin_required` and returns false when the header is missing. An accident guard and
 * a detective aid, not a security boundary (plan r3 E9): a determined local process can
 * forge the header, and every such write is also recorded with its `via`.
 */
export function requireBrowserOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) return true;
  sendError(res, 403, 'origin_required', 'This action is the owner\'s and is taken in the dashboard; a request without a browser Origin is refused.');
  return false;
}

/** How a server write reached us, for the task audit: no Origin, the phone, or the dashboard. */
export function writeVia(req: IncomingMessage): AuditVia {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return 'no-origin';
  return requestSurface(req) !== 'desktop' ? 'phone' : 'dashboard';
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

// ─── Mac mode's phone listener (hands-free) ─────────────────────────────────
//
// cloudflared connects on loopback, so on the phone listener NOTHING is trusted for being
// loopback. A request passes on exactly one credential for its route class: none (public) or
// a Mac device cookie (the phone).

function isWriteMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

function phonePathname(req: IncomingMessage): string {
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

/** What the phone gate needs to know about its surface (Mac mode's phone listener). */
export interface PhoneGateCtx {
  /** Stamped on every response, refusals included. */
  headers: Readonly<Record<string, string>>;
  classify: (method: string, pathname: string) => MacRouteClass;
  /** The Origin a write must carry (a missing Origin is refused too). */
  originAllowed: (req: IncomingMessage) => boolean;
  /** A public route passed (the Mac probe value). */
  onPublic: (req: IncomingMessage, res: ServerResponse, pathname: string) => void;
  /** A signed-in HTML navigation to `/`: true when it answered (a redirect into a chat). */
  landing: (req: IncomingMessage, res: ServerResponse) => boolean;
}

/** The Mac phone listener's context; `match` is the main server's router (route-policy.ts). */
export function macGateCtx(match: RouteMatcher): PhoneGateCtx {
  return {
  headers: {
    [MAC_SURFACE_HEADER]: 'mac',
    // Nothing on the phone listener may be framed by another site (clickjacking a chat).
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    // No response is ever sniffed into another type (D9a), public ones included.
    'X-Content-Type-Options': 'nosniff',
  },
  classify: (m, p) => classifyMacRoute(m, p, match),
  originAllowed: (req) => isMacOriginAllowed(req),
  onPublic: (_req, res, pathname) => {
    const nonce = macProbeNonce();
    if (pathname === '/api/health' && nonce) res.setHeader(MAC_PROBE_HEADER, nonce);
    if (pathname === '/login') {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
    }
  },
  landing: (req, res) => redirectToMacChat(req, res),
  };
}

/** Mac mode's phone listener gate: the route policy, a MAC device session. */
export function macPhoneGate(req: IncomingMessage, res: ServerResponse, match: RouteMatcher): boolean {
  return phoneGate(req, res, macGateCtx(match));
}

/** The phone gate, by `ctx`. */
export function phoneGate(req: IncomingMessage, res: ServerResponse, ctx: PhoneGateCtx): boolean {
  for (const [name, value] of Object.entries(ctx.headers)) res.setHeader(name, value);
  const method = (req.method || 'GET').toUpperCase();
  // No CORS at all: the phone is same-origin, and a preflight answered without
  // Access-Control-Allow-Origin makes the browser refuse any cross-site caller.
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return false;
  }
  if (isWriteMethod(method) && !ctx.originAllowed(req)) {
    sendError(res, 403, 'forbidden', 'Cross-site request blocked.');
    return false;
  }

  const pathname = phonePathname(req);
  // D9b: an API request another site's page made is refused, GETs included (SameSite=Lax would
  // still carry the cookie on a cross-site top-level GET). A request without the header is
  // judged by the Origin rule above.
  const site = req.headers['sec-fetch-site'];
  if ((pathname === '/api' || pathname.startsWith('/api/')) && typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    sendError(res, 403, 'forbidden', 'Cross-site request blocked.');
    return false;
  }
  const cls = ctx.classify(method, pathname);
  if (cls === 'unavailable') {
    sendError(res, 403, 'phone_unavailable', 'This is not available on the phone.');
    return false;
  }
  if (cls === 'public') {
    ctx.onPublic(req, res, pathname);
    return true;
  }
  // Device class: the phone's UI and its allowed API.
  const htmlNavigation = !pathname.startsWith('/api/') && (method === 'GET' || method === 'HEAD') && wantsHtml(req);
  if (!hasValidDeviceSession(req)) {
    if (htmlNavigation) {
      // A cookie the server no longer accepts (revoked, password changed, expired): the login
      // page says this device was signed out. No cookie: a plain first visit.
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
  // `/` on the phone opens a chat, never the launcher.
  if (htmlNavigation && ctx.landing(req, res)) return false;
  return true;
}

/**
 * The Mac phone listener's WebSocket gate: only the chat socket, only the tunnel's own Origin
 * (none until the URL is known), and a MAC device session.
 */
export function macUpgradeRefusal(req: IncomingMessage): number | null {
  if (!MAC_WS_PATHS.includes(phonePathname(req))) return 403;
  if (!isMacOriginAllowed(req)) return 403;
  if (!hasValidDeviceSession(req)) return 401;
  return null;
}

/** Answer a refused Mac phone upgrade on the raw socket (never framed, never cached). */
export function rejectMacUpgrade(socket: import('node:stream').Duplex, code: number): void {
  const text = code === 401 ? 'Unauthorized' : 'Forbidden';
  socket.write(`HTTP/1.1 ${code} ${text}\r\n${MAC_SURFACE_HEADER}: mac\r\nX-Frame-Options: DENY\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

