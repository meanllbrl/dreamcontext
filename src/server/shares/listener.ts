/**
 * A live link's own listener (plan C1): an `http.Server` on `127.0.0.1:<random>`, the ONLY thing
 * its cloudflared points at. Every socket it accepts is marked a share socket before a byte is
 * read (phone-origin.ts), so every loopback trust check refuses it.
 *
 * Its handler is a closed switch and nothing else: the closing grace's closed page, the tunnel
 * checks (`cf-connecting-ip` present, `Host` = the share's public host), the probe, the door, then
 * the share's kind handler with a live guest session. It never calls `makeRequestHandler` or the
 * dashboard router; no path here reaches a dashboard handler.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { markShareSocket } from '../phone-origin.js';
import { claimOwnedPort } from '../owned-ports.js';
import { clientIp, handleDoor, hasSession, sendUnavailable } from './door.js';
import { setShareListenerStart, shareDeps, shareKind, SHARE_PROBE_HEADER, SHARE_PROBE_PATH, type Share } from './registry.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Length': String(Buffer.byteLength(text)) });
  res.end(text);
}

/** The raw path of a request (no decoding; a malformed URL is null). */
function pathOf(req: IncomingMessage): string | null {
  const raw = req.url ?? '/';
  if (!raw.startsWith('/')) return null;
  return raw.split('?')[0].split('#')[0];
}

/** The tunnel's own checks: the request came through Cloudflare, to this share's public host. */
function viaTunnel(share: Share, req: IncomingMessage): 'ok' | 'no_cf' | 'host' {
  if (!clientIp(req)) return 'no_cf';
  if (!share.host || String(req.headers.host ?? '').toLowerCase() !== share.host.toLowerCase()) return 'host';
  return 'ok';
}

export async function handleShareRequest(share: Share, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The closing grace (D13): ONLY the closed page or 410, on every path.
  if (share.state !== 'starting' && share.state !== 'open') { req.resume(); sendUnavailable(req, res, 410); return; }
  const tunnel = viaTunnel(share, req);
  if (tunnel === 'no_cf') { req.resume(); sendJson(res, 400, { error: 'tunnel_only' }); return; }
  if (tunnel === 'host') { req.resume(); sendJson(res, 421, { error: 'misdirected' }); return; }
  const path = pathOf(req);
  if (path === null) { req.resume(); sendJson(res, 400, { error: 'bad_url' }); return; }
  const method = (req.method ?? 'GET').toUpperCase();
  if (path === SHARE_PROBE_PATH) {
    req.resume();
    if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { error: 'method' }); return; }
    res.writeHead(204, { [SHARE_PROBE_HEADER]: share.nonce, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  // No link was handed out before the probe passed: nothing but the probe answers.
  if (share.state !== 'open') { req.resume(); sendUnavailable(req, res); return; }
  if (await handleDoor(share, req, res, path)) return;
  if (!hasSession(share, req)) { req.resume(); sendUnavailable(req, res); return; }
  const kind = shareKind(share.kind);
  if (!kind) { req.resume(); sendUnavailable(req, res); return; }
  let url: URL;
  try { url = new URL(req.url ?? '/', share.origin ?? 'https://invalid.invalid'); } catch { req.resume(); sendJson(res, 400, { error: 'bad_url' }); return; }
  await kind.serve(share, req, res, url);
}

export function handleShareUpgrade(share: Share, req: IncomingMessage, sock: Duplex, head: Buffer): void {
  const deny = (code: number, text: string): void => {
    try { sock.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ }
    sock.destroy();
  };
  sock.on('error', () => { /* the guest went away */ });
  // During the grace every upgrade is refused.
  if (share.state !== 'open') { sock.destroy(); return; }
  if (viaTunnel(share, req) !== 'ok') { deny(403, 'Forbidden'); return; }
  if (!share.origin || req.headers.origin !== share.origin) { deny(403, 'Forbidden'); return; }
  if (!hasSession(share, req)) { deny(401, 'Unauthorized'); return; }
  const path = pathOf(req);
  if (path === null || path.startsWith('/__share') || path.startsWith('/k/')) { deny(404, 'Not Found'); return; }
  const kind = shareKind(share.kind);
  if (!kind?.upgrade) { deny(404, 'Not Found'); return; }
  kind.upgrade(share, req, sock, head);
}

/** Start a share's listener on 127.0.0.1, port 0 (claimed as ours while it listens). */
export async function startShareListener(share: Share): Promise<{ server: http.Server; port: number; release: () => void }> {
  const server = http.createServer({ maxHeaderSize: 64 * 1024 });
  server.on('connection', (socket) => {
    markShareSocket(socket);
    share.sockets.add(socket);
    socket.once('close', () => share.sockets.delete(socket));
  });
  server.on('request', (req, res) => {
    Promise.resolve(handleShareRequest(share, req, res)).catch((err) => {
      shareDeps().log(`[shares] ${share.id} request: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'share_error' }); else res.destroy();
    });
  });
  server.on('upgrade', (req, sock, head) => {
    try { handleShareUpgrade(share, req, sock, head); } catch { sock.destroy(); }
  });
  server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch { /* gone */ } });
  server.setTimeout(120_000);
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const a = server.address();
      resolvePort(a && typeof a === 'object' ? a.port : 0);
    });
  });
  server.on('error', (e) => shareDeps().log(`[shares] ${share.id} listener: ${e.message}`));
  const release = claimOwnedPort(port);
  return { server, port, release };
}

setShareListenerStart(startShareListener);
