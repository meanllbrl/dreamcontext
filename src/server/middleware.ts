import { IncomingMessage, ServerResponse } from 'node:http';
import { isSameOriginAsHost, remoteAccessEnabled } from './remote-access.js';

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
