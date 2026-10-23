import {
  createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import type { Duplex } from 'node:stream';
import { claimOwnedPort, ownedLoopbackPorts } from './owned-ports.js';
import {
  clearWebSession, readWebSession, rememberCookies, sanitizeSnapshot, saveWebSession, webSessionKey, MAX_SNAPSHOT_BYTES, type WebSessionCookie,
} from '../lib/super/web-session-store.js';
import { BRIDGE_PATH, CLEAR_PATH, STORAGE_PATH, clearPageHtml, cookiePrefix, webBridgeScript } from '../lib/super/web-bridge.js';

/**
 * The web card's session proxy (owner 2026-10-22: "these pages should keep their own session; a
 * reload loses everything I did").
 *
 * WHY. The desktop window is `http://127.0.0.1:<dashboard>`; a dev server shown in a card is
 * `http://localhost:5173`, another SITE. In WKWebView a frame from another site is third-party:
 * no cookie is stored or sent, so a login never sticks (probe, 2026-10-22). A frame on
 * `127.0.0.1:<other port>` is the same site, still another origin: its cookies are first-party
 * and persist across restarts, while the dashboard's port-strict gates (knowledge
 * dashboard-server-security §8: `isSameOriginStrict`, `isCrossSiteRequest` refusing `same-site`,
 * the frame gate) keep treating it as a stranger.
 *
 * So each project's approved dev-server port gets ONE listener here, `http://127.0.0.1:<proxy>`,
 * forwarding to `<the card's spelling>:<port>`:
 *  - only a request whose Host is exactly `127.0.0.1:<proxy>` is served (a DNS-rebinding page
 *    names another host), and never while the upstream port is one this process owns;
 *  - Host is rewritten to the upstream's, and Origin/Referer only when they are this proxy's own
 *    (a foreign Origin reaches the dev server as it came, so its own checks still see it);
 *  - cookies on 127.0.0.1 are shared by every port, so every cookie name is prefixed with the
 *    session key (`dc<key>.`) on the way to the window and only this session's come back,
 *    prefix removed: two cards never share a login, and nothing the page sets can collide with
 *    the dashboard's own names. `Domain=` is dropped (a cookie for `localhost` would be refused);
 *  - absolute redirects to the upstream come back to the proxy;
 *  - a page navigation's HTML gets the bridge (`web-bridge.ts`) as its first script, streamed
 *    (a server-rendered page that streams its body is never held back);
 *  - request bodies stream through (nothing is held in memory); a client that goes away aborts
 *    its upstream request; WebSocket upgrades (Vite / Next HMR) are piped with the same rewrites.
 * Its port is claimed as owned (T1): no card can be pointed at the proxy itself.
 *
 * Its own three paths: the bridge script, the page's kept localStorage (read: same-origin only,
 * JSON under nosniff; write: Origin must be the proxy's own), and Clear (a token the dashboard
 * holds; it bumps the storage generation, so a beacon from the page being left cannot write the
 * old storage back).
 */

export interface WebSessionInfo { origin: string; port: number; upstreamPort: number; clearToken: string; key: string }

interface Session {
  /** One project's dev-server port (`webSessionKey`): the store's file and the cookie prefix. */
  key: string;
  prefix: string;
  upstreamPort: number;
  /** The upstream as the card wrote it: `localhost`, `127.0.0.1` or `[::1]`. */
  upstreamHost: string;
  server: Server;
  port: number;
  origin: string;
  clearToken: string;
  generation: number;
  parents: Set<string>;
  cookies: Map<string, WebSessionCookie>;
  sockets: Set<Socket | Duplex>;
  home: string;
  release: () => void;
}

export const UPSTREAM_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;
const PARENT_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;
/** How far into a page the bridge waits for `<head>` before it goes in anyway. */
const HEAD_SCAN_BYTES = 64 * 1024;
/** Room for a page that set too many cookies: its Clear must still be readable. */
const MAX_HEADER_BYTES = 64 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const RETRY = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT']);

const sessions = new Map<string, Promise<Session>>();

/** The addresses to dial, the card's spelling first (a dev server may listen on one family only). */
function dialOrder(host: string): string[] {
  return host === '[::1]' ? ['::1', '127.0.0.1'] : ['127.0.0.1', '::1'];
}

/**
 * The card's proxy for this project's (`scope`: the vault's real path) dev-server port, started
 * on first use. `parent` is the dashboard origin asking (the bridge posts only to the origins
 * recorded here). Throws for an owned port.
 */
export async function openWebSession(
  upstreamPort: number,
  opts: { scope: string; host?: string; parent?: string; home?: string },
): Promise<WebSessionInfo> {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error('invalid port');
  if (!opts.scope) throw new Error('no project');
  if (ownedLoopbackPorts().has(upstreamPort)) throw new Error('owned port');
  const id = `${opts.scope}\u0000${upstreamPort}`;
  let pending = sessions.get(id);
  if (!pending) {
    const host = (UPSTREAM_HOSTS as readonly string[]).includes(opts.host ?? '') ? opts.host as string : 'localhost';
    pending = startSession(webSessionKey(opts.scope, upstreamPort), upstreamPort, host, opts.home ?? homedir());
    sessions.set(id, pending);
    pending.catch(() => { if (sessions.get(id) === pending) sessions.delete(id); });
  }
  const s = await pending;
  if (opts.parent && PARENT_RE.test(opts.parent) && s.parents.size < 8) s.parents.add(opts.parent);
  return { origin: s.origin, port: s.port, upstreamPort, clearToken: s.clearToken, key: s.key };
}

/** Close every proxy (the dashboard is shutting down, or a test is done). */
export async function closeAllWebSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map(async (p) => {
    let s: Session;
    try { s = await p; } catch { return; }
    s.release();
    for (const sock of s.sockets) { try { sock.destroy(); } catch { /* gone */ } }
    await new Promise<void>((r) => s.server.close(() => r()));
  }));
}

function startSession(key: string, upstreamPort: number, upstreamHost: string, home: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES });
    const s: Session = {
      key, prefix: cookiePrefix(key), upstreamPort, upstreamHost, server, port: 0, origin: '', clearToken: randomBytes(24).toString('hex'),
      generation: 1, parents: new Set(), cookies: new Map(), sockets: new Set(), home, release: () => { /* until listening */ },
    };
    for (const c of readWebSession(key, home).cookies) s.cookies.set(`${c.name}\u0000${c.path}`, c);
    server.on('connection', (sock) => { s.sockets.add(sock); sock.once('close', () => s.sockets.delete(sock)); });
    // Nothing a page sends may throw out of a handler: this server lives in the dashboard's process.
    server.on('request', (req, res) => {
      try { handle(s, req, res); } catch (err) { console.error(`[web-session] ${(err as Error).message}`); refuse(res, 500, 'Proxy error.'); }
    });
    server.on('upgrade', (req, sock, head) => {
      try { upgrade(s, req, sock, head); } catch { sock.destroy(); }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      // A listener error later (EMFILE on accept) must never take the dashboard down with it.
      server.on('error', (err) => { console.error(`[web-session] 127.0.0.1:${s.port}: ${err.message}`); });
      const a = server.address();
      s.port = a && typeof a === 'object' ? a.port : 0;
      s.origin = `http://127.0.0.1:${s.port}`;
      s.release = claimOwnedPort(s.port);
      server.once('close', s.release);
      resolve(s);
    });
  });
}

function refuse(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent || res.destroyed) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** The request is for this proxy, by its own name (DNS rebinding sends another Host). */
function rightHost(s: Session, req: IncomingMessage): boolean {
  return (req.headers.host ?? '').toLowerCase() === `127.0.0.1:${s.port}`;
}

function handle(s: Session, req: IncomingMessage, res: ServerResponse): void {
  if (!rightHost(s, req)) { refuse(res, 421, 'Misdirected request.'); return; }
  if (ownedLoopbackPorts().has(s.upstreamPort)) { refuse(res, 403, 'This port belongs to the app.'); return; }
  const path = (req.url ?? '/').split('?')[0];
  if (path.startsWith('/__dreamcontext/')) { own(s, req, res, path); return; }
  forward(s, req, res);
}

// ─── the proxy's own paths ──────────────────────────────────────────────────────────

function sameOriginWrite(s: Session, req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '' && site !== 'same-origin') return false;
  return req.headers.origin === s.origin;
}

function own(s: Session, req: IncomingMessage, res: ServerResponse, path: string): void {
  const url = new URL(req.url ?? '/', s.origin);
  if (path === BRIDGE_PATH && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(webBridgeScript({ parents: [...s.parents], generation: s.generation, cookiePrefix: s.prefix }));
    return;
  }
  if (path === STORAGE_PATH && req.method === 'GET') {
    // The kept localStorage, to the page's own synchronous read only: JSON under nosniff (a
    // script tag elsewhere cannot run it), and never to a request another site made.
    const site = req.headers['sec-fetch-site'];
    if ((typeof site === 'string' && site !== '' && site !== 'same-origin') || (req.headers.origin && req.headers.origin !== s.origin)) {
      refuse(res, 403, 'Forbidden.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(readWebSession(s.key, s.home).localStorage));
    return;
  }
  if (path === STORAGE_PATH && req.method === 'POST') {
    if (!sameOriginWrite(s, req)) { req.resume(); refuse(res, 403, 'Forbidden.'); return; }
    const gen = Number(url.searchParams.get('g'));
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_SNAPSHOT_BYTES) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => {
      if (over) { refuse(res, 413, 'Too large.'); return; }
      // A beacon from a page loaded before the last Clear: dropped, not written back.
      if (gen !== s.generation) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return; }
      try {
        saveWebSession(s.key, JSON.parse(Buffer.concat(chunks).toString('utf-8')), s.home);
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      } catch {
        refuse(res, 400, 'Bad snapshot.');
      }
    });
    return;
  }
  if (path === CLEAR_PATH && req.method === 'GET') {
    const token = url.searchParams.get('t') ?? '';
    const a = Buffer.from(token);
    const b = Buffer.from(s.clearToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) { refuse(res, 403, 'Forbidden.'); return; }
    const raw = url.searchParams.get('next') ?? '/';
    const next = raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/';
    s.generation += 1;
    // Every cookie of this session the window sent (path /), and every one ever seen elsewhere.
    const sent = (ownCookies(req.headers.cookie, s.prefix) ?? '').split(/;\s*/)
      .map((p) => p.split('=')[0]).filter(Boolean).map((name) => ({ name, path: '/' }));
    const known = [...s.cookies.values(), ...readWebSession(s.key, s.home).cookies, ...sent];
    // The headers first: a session is forgotten only once its expiries could be written.
    try {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Clear-Site-Data': '"cache"',
        'Set-Cookie': expiries(known, s.prefix),
      });
    } catch {
      s.generation -= 1;
      refuse(res, 500, 'The page could not be cleared.');
      return;
    }
    clearWebSession(s.key, s.home);
    s.cookies.clear();
    res.end(clearPageHtml(next));
    return;
  }
  refuse(res, 404, 'Not found.');
}

const HEADER_SAFE = /^[\x21-\x7e]+$/;

/** Set-Cookie lines expiring each known cookie (its prefixed name) at its own path and at `/`.
 *  A name or path a header cannot carry is left out (it would throw in `writeHead`). */
export function expiries(cookies: readonly WebSessionCookie[], prefix: string): string[] {
  const out = new Set<string>();
  for (const c of cookies) {
    if (!HEADER_SAFE.test(c.name) || c.name.includes(';') || c.name.includes('=')) continue;
    for (const p of new Set([c.path, '/'])) {
      if (/^\/[\x20-\x3a\x3c-\x7e]*$/.test(p)) out.add(`${prefix}${c.name}=; Max-Age=0; Path=${p}`);
    }
  }
  return [...out];
}

// ─── forwarding ─────────────────────────────────────────────────────────────────────

/** Only this session's cookies, their prefix removed (null: none). */
export function ownCookies(header: string | undefined, prefix: string): string | null {
  if (!header) return null;
  const mine = header.split(/;\s*/).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)).filter((p) => /^[^=]+=/.test(p));
  return mine.length ? mine.join('; ') : null;
}

/** Request headers as the upstream must see them. */
export function upstreamHeaders(
  headers: IncomingHttpHeaders, proxyOrigin: string, upstreamHost: string, upstreamPort: number, opts: { identity: boolean; prefix: string },
): Record<string, string | string[]> {
  const upstreamOrigin = `http://${upstreamHost}:${upstreamPort}`;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP.has(k) || k === 'cookie') continue;
    out[k] = v;
  }
  out.host = `${upstreamHost}:${upstreamPort}`;
  const cookie = ownCookies(headers.cookie, opts.prefix);
  if (cookie) out.cookie = cookie;
  if (headers.origin === proxyOrigin) out.origin = upstreamOrigin;
  const ref = headers.referer;
  if (typeof ref === 'string' && (ref === proxyOrigin || ref.startsWith(`${proxyOrigin}/`))) out.referer = upstreamOrigin + ref.slice(proxyOrigin.length);
  if (opts.identity) out['accept-encoding'] = 'identity';
  return out;
}

/** A Location pointing at the upstream (any loopback spelling, same port) comes back here. */
export function rewriteLocation(location: string, proxyOrigin: string, upstreamPort: number): string {
  const m = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)(\/.*)?$/i.exec(location.trim());
  if (!m || Number(m[2]) !== upstreamPort) return location;
  return proxyOrigin + (m[3] ?? '/');
}

/** A Set-Cookie with its name prefixed and without Domain, and the cookie's own name and path. */
export function rewriteSetCookie(line: string, requestPath: string, prefix: string): { line: string; cookie: WebSessionCookie | null } {
  const parts = line.split(';');
  const kept = parts.filter((p, i) => i === 0 || !/^\s*domain\s*=/i.test(p));
  const nameMatch = /^\s*([^=;\s]+)\s*=/.exec(parts[0] ?? '');
  const pathAttr = parts.slice(1).map((p) => /^\s*path\s*=\s*(.*)$/i.exec(p)).find(Boolean);
  let path = pathAttr ? pathAttr[1].trim() : '';
  if (!path.startsWith('/')) {
    const i = requestPath.lastIndexOf('/');
    path = i > 0 ? requestPath.slice(0, i) : '/';
  }
  kept[0] = prefix + (kept[0] ?? '').replace(/^\s+/, '');
  return { line: kept.join(';'), cookie: nameMatch ? { name: nameMatch[1], path } : null };
}

/** The HTML with the bridge's script tag first in <head> (after a doctype, never before it). */
export function injectBridge(html: Buffer): Buffer {
  const text = html.toString('latin1');
  const tag = Buffer.from(`<script src="${BRIDGE_PATH}"></script>`, 'latin1');
  const at = (re: RegExp): number => { const m = re.exec(text); return m ? m.index + m[0].length : -1; };
  let pos = at(/<head(\s[^>]*)?>/i);
  if (pos < 0) pos = at(/<html(\s[^>]*)?>/i);
  if (pos < 0) pos = at(/^\s*<!doctype[^>]*>/i);
  if (pos < 0) pos = 0;
  return Buffer.concat([html.subarray(0, pos), tag, html.subarray(pos)]);
}

/** Enough of the page has arrived to place the bridge: its <head> (or its <body>) is in. */
export function headSeen(html: Buffer): boolean {
  const text = html.toString('latin1');
  return /<head(\s[^>]*)?>/i.test(text) || /<body[\s>]/i.test(text);
}

/** A page navigation (the frame's document), not a fetch() of some HTML. */
function isNavigation(req: IncomingMessage): boolean {
  const dest = req.headers['sec-fetch-dest'];
  if (typeof dest === 'string' && dest !== '') return dest === 'document' || dest === 'iframe';
  return req.method === 'GET' && /text\/html/i.test(req.headers.accept ?? '');
}

function forward(s: Session, req: IncomingMessage, res: ServerResponse): void {
  const nav = isNavigation(req) && req.method === 'GET';
  const headers = upstreamHeaders(req.headers, s.origin, s.upstreamHost, s.upstreamPort, { identity: nav, prefix: s.prefix });
  const reqPath = (req.url ?? '/').split('?')[0];
  const addrs = dialOrder(s.upstreamHost);
  // The body waits until a dial connects, then streams: a refused dial (the other address
  // family) is retried with nothing consumed, and nothing is ever held in memory.
  req.pause();
  let up: ClientRequest | null = null;
  res.on('close', () => { if (!res.writableFinished) up?.destroy(); });
  const attempt = (i: number) => {
    let connected = false;
    const r = httpRequest({ host: addrs[i], port: s.upstreamPort, method: req.method, path: req.url, headers, agent: false });
    up = r;
    r.on('socket', (sock) => {
      const go = () => { connected = true; req.pipe(r); };
      if ((sock as Socket).connecting) sock.once('connect', go); else go();
    });
    r.on('response', (ur) => respond(s, res, ur, nav, reqPath));
    r.on('error', (err: NodeJS.ErrnoException) => {
      if (res.destroyed) return;
      if (!connected && RETRY.has(err.code ?? '') && i + 1 < addrs.length) { attempt(i + 1); return; }
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui,sans-serif;color:#888;padding:24px">The dev server at ${s.upstreamHost}:${s.upstreamPort} is not answering.</body>`);
      } else {
        res.destroy();
      }
    });
  };
  attempt(0);
}

function respond(s: Session, res: ServerResponse, ur: IncomingMessage, nav: boolean, reqPath: string): void {
  const out: Record<string, string | string[]> = {};
  const learned: WebSessionCookie[] = [];
  for (const [k, v] of Object.entries(ur.headers)) {
    if (v === undefined || HOP.has(k)) continue;
    if (k === 'location' && typeof v === 'string') { out[k] = rewriteLocation(v, s.origin, s.upstreamPort); continue; }
    if (k === 'set-cookie') {
      const lines = Array.isArray(v) ? v : [v];
      out[k] = lines.map((line) => {
        const r = rewriteSetCookie(line, reqPath, s.prefix);
        if (r.cookie) learned.push(r.cookie);
        return r.line;
      });
      continue;
    }
    out[k] = v;
  }
  if (learned.length) learnCookies(s, learned);
  // The upstream goes when the window does (a reload of a page that streams, a closed card).
  res.on('close', () => { if (!res.writableFinished) ur.destroy(); });
  ur.on('error', () => res.destroy());
  const type = String(ur.headers['content-type'] ?? '');
  const encoding = String(ur.headers['content-encoding'] ?? 'identity').toLowerCase();
  const status = ur.statusCode ?? 502;
  const inject = nav && status >= 200 && status < 300 && /text\/html/i.test(type) && encoding === 'identity';
  if (!inject) {
    res.writeHead(status, ur.statusMessage, out);
    ur.pipe(res);
    return;
  }
  // The page grows by the bridge's tag: no length, chunked. Held only until its <head> is in.
  delete out['content-length'];
  res.writeHead(status, ur.statusMessage, out);
  let held: Buffer[] = [];
  let size = 0;
  let placed = false;
  const place = () => {
    placed = true;
    const page = Buffer.concat(held);
    held = [];
    return res.write(injectBridge(page));
  };
  ur.on('data', (c: Buffer) => {
    let flowing = true;
    if (placed) flowing = res.write(c);
    else {
      held.push(c);
      size += c.length;
      if (size >= HEAD_SCAN_BYTES || headSeen(Buffer.concat(held))) flowing = place();
    }
    if (!flowing) { ur.pause(); res.once('drain', () => ur.resume()); }
  });
  ur.on('end', () => {
    if (!placed) place();
    res.end();
  });
}

function learnCookies(s: Session, found: WebSessionCookie[]): void {
  const fresh = sanitizeSnapshot({ cookies: found }).cookies.filter((c) => !s.cookies.has(`${c.name}\u0000${c.path}`));
  if (!fresh.length) return;
  for (const c of fresh) s.cookies.set(`${c.name}\u0000${c.path}`, c);
  try { rememberCookies(s.key, fresh, s.home); } catch { /* the names stay in memory */ }
}

// ─── WebSocket upgrades (HMR) ───────────────────────────────────────────────────────

function upgrade(s: Session, req: IncomingMessage, sock: Duplex, head: Buffer): void {
  const deny = (code: number, text: string) => { sock.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); sock.destroy(); };
  sock.on('error', () => { /* the window went away */ });
  if (!rightHost(s, req)) { deny(421, 'Misdirected Request'); return; }
  if (ownedLoopbackPorts().has(s.upstreamPort)) { deny(403, 'Forbidden'); return; }
  s.sockets.add(sock);
  sock.once('close', () => s.sockets.delete(sock));
  const headers = upstreamHeaders(req.headers, s.origin, s.upstreamHost, s.upstreamPort, { identity: false, prefix: s.prefix });
  headers.connection = 'Upgrade';
  headers.upgrade = String(req.headers.upgrade ?? 'websocket');
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
  const addrs = dialOrder(s.upstreamHost);
  let up: Socket | null = null;
  sock.once('close', () => up?.destroy());
  const attempt = (i: number) => {
    const u = connect({ host: addrs[i], port: s.upstreamPort });
    up = u;
    let open = false;
    u.once('connect', () => {
      open = true;
      s.sockets.add(u);
      u.once('close', () => { s.sockets.delete(u); sock.destroy(); });
      u.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) u.write(head);
      u.pipe(sock);
      sock.pipe(u);
    });
    u.on('error', (err: NodeJS.ErrnoException) => {
      if (!open && RETRY.has(err.code ?? '') && i + 1 < addrs.length && !sock.destroyed) { attempt(i + 1); return; }
      if (!open) deny(502, 'Bad Gateway'); else sock.destroy();
    });
  };
  attempt(0);
}
