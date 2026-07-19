import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Cookie that carries the network-access token after the first tokenized visit. */
export const AUTH_COOKIE = 'dreamcontext_token';

/** True when the TCP peer is the local machine (IPv4, IPv6, or v4-mapped-v6 loopback). */
export function isLoopbackAddress(remote: string | undefined | null): boolean {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/** One token per server process; shown only in the startup banner. */
export function generateNetworkToken(): string {
  return randomBytes(32).toString('hex');
}

function tokenMatches(candidate: string | null, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === AUTH_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Auth gate for network-exposed binds (`--host` other than loopback). The
 * dashboard API is unauthenticated by design for the localhost case, so when
 * the server is reachable from the LAN every request from a non-loopback peer
 * must present the per-process token — via the `?token=` URL printed at
 * startup (which sets an HttpOnly cookie) or the cookie itself thereafter.
 * Loopback peers bypass the gate so the CLI, hooks, and local browser keep
 * working unchanged.
 *
 * Returns true when the request may proceed; otherwise responds 401 itself.
 */
export function checkNetworkAuth(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  if (isLoopbackAddress(req.socket?.remoteAddress)) return true;
  if (tokenMatches(cookieToken(req), token)) return true;

  let queryToken: string | null = null;
  try {
    queryToken = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).searchParams.get('token');
  } catch {
    queryToken = null;
  }
  if (tokenMatches(queryToken, token)) {
    // Not `Secure` — the local dashboard is plain HTTP. SameSite=Strict keeps
    // the cookie out of any cross-site request a hostile page could forge.
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    return true;
  }

  const body = JSON.stringify({
    error: 'unauthorized',
    message: 'This dashboard is network-exposed and requires an access token. Open the tokenized URL printed where the server was started.',
  });
  res.writeHead(401, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
  return false;
}
