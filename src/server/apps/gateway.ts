/**
 * The per-app gateway (dreamcontext-apps plan r19, "Gateway sözleşmesi"): one `http.Server`
 * per app inside the dreamcontext process, at `http://127.0.0.1:<gwPort>`. The app's window,
 * its page and its backend all meet here.
 *
 * Why a gateway: the dashboard's CORS / cross-site-write guards are port-strict, so the app's
 * own origin cannot call the dashboard API; and the backend must not be reachable by anything
 * but the window. Everything first passes: Host exactly `127.0.0.1:<gw>` (DNS rebinding names
 * another host), no Cloudflare edge header (HTTP and upgrade).
 *
 * The port is KEPT (`gwPort` in the registry; tried first, EADDRINUSE retried for 7 s): the
 * origin includes the port, and a backend-less app's only store is its origin's localStorage /
 * IndexedDB. If the port stays taken, a temporary one is used, `gwPort` is NOT overwritten, and
 * the card says the app's data may look empty this time.
 *
 * Identities: the WINDOW's cookie (`dc_gw_<port>`, minted by the one-time `/__dc/enter` code),
 * the BACKEND's `Authorization: Bearer DC_TOKEN`, and the RUNNER's `Bearer runnerToken`
 * (only `/__dc/runner/*`; crossing classes is 401). With the cookie, a write or a WebSocket
 * upgrade needs Origin = this gateway exactly ("null" refused); with a Bearer, an Origin
 * must be absent.
 *
 * Paths: `/__dc/enter`, `/__dc/runner/*`, `/__dc/api/*` (the dashboard API, vault pinned;
 * page = PAGE_ROUTES only), `/__dc/theme`; W3/W4 add theirs through `registerGatewayRoute`.
 * Everything else goes to the backend (WebSocket included) with the gateway secret added and
 * only this app's prefixed cookies; with no backend, `public/` is served statically.
 */

import { dropEmbedToken } from './embed-token.js';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, lstatSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { carriesCloudflareHeaders } from '../phone-origin.js';
import { claimOwnedPort } from '../owned-ports.js';
import { HOP, ownCookies, rewriteLocation, rewriteSetCookie, upstreamHeaders } from '../proxy-shared.js';
import { safeChildPath } from '../safe-path.js';
import { GATEWAY_SECRET_HEADER, type AppRuntime } from '../../lib/apps/supervisor.js';
import { narrowPageBody, narrowPageResponse, pageRouteDecision, deniedForEveryone, type RouteMatcher } from '../../lib/apps/page-routes.js';
import { updateApp } from '../../lib/apps/registry.js';
import { writeShot, SHOT_MAX_BYTES } from '../../lib/apps/shots.js';

const ENTER_TTL_MS = 60_000;
const SNAPSHOT_WAIT_MS = 10_000;
const PORT_RETRY_MS = 7_000;
const MAX_BODY = 1024 * 1024;

export type GatewayHandler = (gw: AppGateway, req: IncomingMessage, res: ServerResponse, ident: Identity, url: URL) => Promise<void> | void;
const extraRoutes = new Map<string, { handler: GatewayHandler; cookie: boolean; bearer: boolean }>();

/** W3/W4 add their `/__dc/<name>` paths here (exact prefix match). */
export function registerGatewayRoute(prefix: string, opts: { cookie: boolean; bearer: boolean }, handler: GatewayHandler): void {
  extraRoutes.set(prefix, { handler, ...opts });
}

export type Identity = { kind: 'cookie' } | { kind: 'backend' } | { kind: 'runner'; token: string } | { kind: 'none' };

interface GatewayEnv {
  home: string;
  router: RouteMatcher | null;
  dashboardPort: number | null;
  theme: () => 'light' | 'dark' | 'system';
}

const env: GatewayEnv = { home: process.env.HOME ?? '', router: null, dashboardPort: null, theme: () => 'system' };

/** Where an embed redirect lands: the dashboard on loopback, null before the server is up. */
export function gatewayDashboardPort(): number | null {
  return env.dashboardPort;
}

export function gatewayTheme(): string {
  return env.theme();
}

/** The server wires the dashboard port, its router and the theme reader at listen time. */
export function configureGateways(patch: Partial<GatewayEnv>): void {
  Object.assign(env, patch);
}

const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function bearerOf(req: IncomingMessage): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(String(req.headers.authorization ?? '').trim());
  return m ? m[1] : null;
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of String(header ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function errorPage(res: ServerResponse, status: number, title: string, detail: string): void {
  if (res.headersSent) { res.destroy(); return; }
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:14px -apple-system,sans-serif;padding:32px;color:#666"><h1 style="font-size:18px">${escapeHtml(title)}</h1><pre style="white-space:pre-wrap">${escapeHtml(detail)}</pre></body>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
  res.end(html);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

export class AppGateway {
  readonly server: http.Server;
  port = 0;
  origin = '';
  /** Window sessions (cookie values). */
  private sessions = new Set<string>();
  private codes = new Map<string, { exp: number; path: string }>();
  readonly runnerTokens = new Set<string>();
  private snapshots = new Map<string, { sent: boolean; resolve: (r: SnapshotResult) => void }>();
  private sockets = new Set<Socket | Duplex>();
  private release: () => void = () => {};
  /** A path the next `/__dc/enter` lands on (an app link's nonce, plan W3). */
  pendingPath: string | null = null;

  constructor(readonly runtime: AppRuntime) {
    this.server = http.createServer({ maxHeaderSize: 64 * 1024 });
    this.server.on('connection', (s) => { this.sockets.add(s); s.once('close', () => this.sockets.delete(s)); });
    this.server.on('request', (req, res) => {
      Promise.resolve(this.handle(req, res)).catch((err) => {
        this.runtime.log.push(`[gateway] ${this.runtime.scrub((err as Error).message)}`);
        errorPage(res, 500, 'Gateway error', 'See the app log.');
      });
    });
    this.server.on('upgrade', (req, sock, head) => {
      try { this.upgrade(req, sock, head); } catch { sock.destroy(); }
    });
  }

  /** Listen on the kept port (retrying EADDRINUSE for 7 s), else a temporary one. */
  async listen(): Promise<void> {
    const kept = this.runtime.rec.gwPort;
    const tryListen = (port: number) => new Promise<boolean>((resolve, reject) => {
      const onErr = (e: NodeJS.ErrnoException) => {
        this.server.off('listening', onOk);
        if (e.code === 'EADDRINUSE') resolve(false); else reject(e);
      };
      const onOk = () => { this.server.off('error', onErr); resolve(true); };
      this.server.once('error', onErr);
      this.server.once('listening', onOk);
      this.server.listen(port, '127.0.0.1');
    });
    let ok = false;
    if (kept) {
      const until = Date.now() + PORT_RETRY_MS;
      while (!ok && Date.now() < until) {
        ok = await tryListen(kept);
        if (!ok) await new Promise((r) => setTimeout(r, 300));
      }
      if (!ok) {
        this.runtime.portFallback = true;
        this.runtime.log.push(`[gateway] port ${kept} is taken: serving on a temporary port this time (the app's browser data may look empty)`);
      }
    }
    if (!ok) await tryListen(0);
    const a = this.server.address();
    this.port = a && typeof a === 'object' ? a.port : 0;
    this.origin = `http://127.0.0.1:${this.port}`;
    this.runtime.gwPort = this.port;
    this.release = claimOwnedPort(this.port);
    this.server.on('error', (e) => this.runtime.log.push(`[gateway] ${e.message}`));
    if (!kept) {
      try { updateApp(env.home, this.runtime.rec.projectRoot, this.runtime.rec.slug, { gwPort: this.port }); } catch { /* the next launch picks one again */ }
    }
  }

  async close(): Promise<void> {
    dropEmbedToken(this.port);
    this.release();
    for (const s of this.sockets) { try { s.destroy(); } catch { /* gone */ } }
    for (const [, w] of this.snapshots) w.resolve({ error: 'snapshot_failed' });
    this.snapshots.clear();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** A one-time `/__dc/enter` code (60 s). */
  mintEnterCode(): string {
    const code = randomBytes(32).toString('base64url');
    const now = Date.now();
    for (const [c, v] of this.codes) if (v.exp < now) this.codes.delete(c);
    this.codes.set(code, { exp: now + ENTER_TTL_MS, path: this.pendingPath ?? '/' });
    this.pendingPath = null;
    return code;
  }

  mintRunnerToken(): string {
    const t = randomBytes(32).toString('base64url');
    this.runnerTokens.add(t);
    if (this.runnerTokens.size > 64) this.runnerTokens.delete(this.runnerTokens.values().next().value as string);
    return t;
  }

  /** Queue a snapshot for the window's next heartbeat and wait for it (≤10 s). */
  requestSnapshot(): Promise<SnapshotResult> {
    const id = randomBytes(18).toString('base64url');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.snapshots.delete(id); resolve({ error: 'snapshot_timeout' }); }, SNAPSHOT_WAIT_MS);
      this.snapshots.set(id, { sent: false, resolve: (r) => { clearTimeout(timer); this.snapshots.delete(id); resolve(r); } });
    });
  }

  private rightHost(req: IncomingMessage): boolean {
    return String(req.headers.host ?? '').toLowerCase() === `127.0.0.1:${this.port}`;
  }

  identify(req: IncomingMessage): Identity {
    const bearer = bearerOf(req);
    if (bearer) {
      if (eq(bearer, this.runtime.dcToken)) return { kind: 'backend' };
      for (const t of this.runnerTokens) if (eq(bearer, t)) return { kind: 'runner', token: t };
      return { kind: 'none' };
    }
    const c = cookieValue(req.headers.cookie, `dc_gw_${this.port}`);
    if (c) for (const s of this.sessions) if (eq(c, s)) return { kind: 'cookie' };
    return { kind: 'none' };
  }

  /** The Origin rule: cookie writes and upgrades need our exact origin; Bearer needs none. */
  originOk(req: IncomingMessage, ident: Identity, isWriteOrUpgrade: boolean): boolean {
    const origin = req.headers.origin;
    if (ident.kind === 'backend' || ident.kind === 'runner') return origin === undefined;
    if (ident.kind === 'cookie' && isWriteOrUpgrade) return origin === this.origin;
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.rightHost(req)) { send(res, 421, { error: 'misdirected' }); return; }
    if (carriesCloudflareHeaders(req)) { send(res, 403, { error: 'forbidden' }); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', this.origin); } catch { send(res, 400, { error: 'bad_url' }); return; }
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    if (path === '/__dc/enter') { this.enter(url, res); return; }

    const ident = this.identify(req);
    if (ident.kind === 'none') { send(res, 401, { error: 'unauthorized', message: 'Open this app from dreamcontext.' }); return; }
    const write = method !== 'GET' && method !== 'HEAD';
    if (!this.originOk(req, ident, write)) { send(res, 403, { error: 'bad_origin' }); return; }

    if (path.startsWith('/__dc/runner/')) {
      if (ident.kind !== 'runner') { send(res, 401, { error: 'unauthorized' }); return; }
      await this.runner(path, req, res, ident.token);
      return;
    }
    if (ident.kind === 'runner') { send(res, 401, { error: 'unauthorized' }); return; }
    // An incoming gateway secret is never trusted (only the gateway sets it).
    delete req.headers[GATEWAY_SECRET_HEADER];

    if (path === '/__dc/api' || path.startsWith('/__dc/api/')) { await this.api(req, res, ident, url); return; }
    if (path === '/__dc/theme') { send(res, 200, { theme: env.theme() }); return; }
    for (const [prefix, r] of extraRoutes) {
      if (path === prefix || path.startsWith(prefix + '/')) {
        if ((ident.kind === 'cookie' && !r.cookie) || (ident.kind === 'backend' && !r.bearer)) {
          send(res, 403, { error: 'backend_only', message: `${prefix} is not available to this caller.` });
          return;
        }
        await r.handler(this, req, res, ident, url);
        return;
      }
    }
    if (path.startsWith('/__dc/')) { send(res, 404, { error: 'not_found' }); return; }
    await this.toApp(req, res);
  }

  private enter(url: URL, res: ServerResponse): void {
    const code = url.searchParams.get('code') ?? '';
    const hit = this.codes.get(code);
    this.codes.delete(code);
    if (!hit || hit.exp < Date.now()) { errorPage(res, 403, 'This link was already used', 'Open the app again from dreamcontext.'); return; }
    const session = randomBytes(32).toString('base64url');
    this.sessions.add(session);
    if (this.sessions.size > 64) this.sessions.delete(this.sessions.values().next().value as string);
    res.writeHead(302, {
      Location: hit.path,
      'Set-Cookie': `dc_gw_${this.port}=${session}; HttpOnly; SameSite=Strict; Path=/`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }

  private async runner(path: string, req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const rt = this.runtime;
    if (path === '/__dc/runner/heartbeat') {
      const lapsed = rt.liveWindows() === 0;
      rt.heartbeat(token);
      if (!rt.rec.stoppedByOwner && (rt.state === 'stopped' || (lapsed && rt.state !== 'running' && rt.state !== 'updating' && rt.state !== 'starting'))) {
        void rt.ensureRunning();
      }
      const out: Record<string, unknown> = {
        rev: rt.rev,
        lastError: rt.lastError ? rt.scrub(rt.lastError) : null,
        theme: env.theme(),
        state: rt.rec.stoppedByOwner ? 'stopped' : rt.state,
      };
      for (const [id, w] of this.snapshots) {
        if (!w.sent) { w.sent = true; out.command = { id, type: 'snapshot' }; break; }
      }
      send(res, 200, out);
      return;
    }
    if (path === '/__dc/runner/stop') {
      rt.dropWindow(token);
      send(res, 200, { ok: true });
      return;
    }
    if (path === '/__dc/runner/start') {
      try {
        const next = updateApp(env.home, rt.rec.projectRoot, rt.rec.slug, { stoppedByOwner: false });
        if (next) rt.setRecord(next);
      } catch {
        // Registry busy: the flag stays, so nothing starts (a start would be stopped again by the sweep).
        send(res, 503, { error: 'registry_busy', message: 'Try again in a moment.' });
        return;
      }
      rt.heartbeat(token);
      void rt.ensureRunning();
      send(res, 200, { ok: true });
      return;
    }
    const m = /^\/__dc\/runner\/snapshot\/([A-Za-z0-9_-]{16,64})$/.exec(path);
    if (m) {
      const w = this.snapshots.get(m[1]);
      if (!w || !w.sent) { req.resume(); send(res, 404, { error: 'unknown_snapshot' }); return; }
      const body = await readBody(req, SHOT_MAX_BYTES);
      if (!body) { w.resolve({ error: 'snapshot_failed' }); send(res, 413, { error: 'too_large' }); return; }
      if (String(req.headers['content-type'] ?? '').startsWith('image/png')) {
        try {
          const file = writeShot(env.home, rt.hash, m[1], body);
          w.resolve({ id: m[1], file });
        } catch (e) {
          w.resolve({ error: 'snapshot_failed' });
          rt.log.push(`[gateway] snapshot: ${(e as Error).message}`);
        }
      } else {
        let code: 'window_hidden' | 'snapshot_failed' = 'snapshot_failed';
        try {
          const e = (JSON.parse(body.toString('utf-8')) as { error?: unknown }).error;
          if (e === 'window_hidden' || e === 'snapshot_failed') code = e;
        } catch { /* default */ }
        w.resolve({ error: code });
      }
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: 'not_found' });
  }

  private async api(req: IncomingMessage, res: ServerResponse, ident: Identity, url: URL): Promise<void> {
    if (!env.dashboardPort || !env.router) { send(res, 503, { error: 'not_ready' }); return; }
    const method = (req.method ?? 'GET').toUpperCase();
    const apiPath = url.pathname.slice('/__dc'.length) || '/';
    if (!apiPath.startsWith('/api/')) { send(res, 404, { error: 'not_found' }); return; }
    if (deniedForEveryone(apiPath)) { req.resume(); send(res, 403, { error: 'forbidden', message: 'Apps cannot speak for the owner or drive other apps.' }); return; }
    let body: Buffer | null = null;
    let pageKey: string | null = null;
    if (ident.kind === 'cookie') {
      const d = pageRouteDecision(env.router, method, apiPath);
      if (!d.ok) { req.resume(); send(res, d.status, { error: d.error, message: d.message }); return; }
      pageKey = d.key;
      if (method !== 'GET' && method !== 'HEAD') {
        const raw = await readBody(req, MAX_BODY);
        if (!raw) { send(res, 413, { error: 'too_large' }); return; }
        const nb = narrowPageBody(d.key, raw.toString('utf-8'));
        if (!nb.ok) { send(res, nb.status, { error: nb.error, message: nb.message }); return; }
        body = Buffer.from(nb.body ?? '', 'utf-8');
      }
    } else {
      try { env.router.match(method, apiPath); } catch { req.resume(); send(res, 400, { error: 'bad_path' }); return; }
      if (method !== 'GET' && method !== 'HEAD') {
        body = await readBody(req, 8 * MAX_BODY);
        if (!body) { send(res, 413, { error: 'too_large' }); return; }
      }
    }
    // Origin is ALWAYS dropped (never rewritten to the dashboard's): the owner-only gates
    // (`fromOwnerPage`) need a string Origin and stay shut for an app.
    const headers: Record<string, string> = {
      host: `127.0.0.1:${env.dashboardPort}`,
      'x-dreamcontext-vault': this.runtime.rec.vault,
      'x-dc-app': this.runtime.rec.slug,
      accept: 'application/json',
    };
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
    if (body) headers['content-length'] = String(body.length);
    const search = url.search;
    await new Promise<void>((resolve) => {
      const up = http.request({ host: '127.0.0.1', port: env.dashboardPort!, method, path: apiPath + search, headers, agent: false }, (ur) => {
        const chunks: Buffer[] = [];
        ur.on('data', (c: Buffer) => chunks.push(c));
        ur.on('end', () => {
          let text = Buffer.concat(chunks).toString('utf-8');
          if (pageKey) {
            try { text = JSON.stringify(narrowPageResponse(pageKey, JSON.parse(text))); } catch { /* not JSON: as is */ }
          }
          res.writeHead(ur.statusCode ?? 502, { 'Content-Type': String(ur.headers['content-type'] ?? 'application/json'), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(text);
          resolve();
        });
        ur.on('error', () => { res.destroy(); resolve(); });
      });
      up.on('error', () => { send(res, 502, { error: 'dashboard_unreachable' }); resolve(); });
      if (body) up.end(body); else up.end();
    });
  }

  private backendPrefix(): string {
    return `dcapp${this.runtime.hash}.`;
  }

  private async toApp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rt = this.runtime;
    if (!rt.manifest?.backend && rt.state !== 'stopped') { this.serveStatic(req, res); return; }
    if (rt.state === 'starting' || rt.state === 'stopped') {
      if (rt.rec.stoppedByOwner) { errorPage(res, 503, 'Stopped', 'The app was stopped from dreamcontext.'); return; }
      await rt.ensureRunning();
    }
    if (!rt.manifest?.backend) { this.serveStatic(req, res); return; }
    const b = rt.backend;
    if (!b) {
      this.runtime.log.push('[gateway] request while the backend is down');
      errorPage(res, 503, 'The app backend is not running', rt.lastError ? rt.scrub(rt.lastError) : 'It may be restarting.');
      return;
    }
    const headers = upstreamHeaders(req.headers, this.origin, '127.0.0.1', b.port, { identity: false, prefix: this.backendPrefix() });
    delete headers.authorization;
    headers[GATEWAY_SECRET_HEADER] = rt.gatewaySecret;
    const reqPath = (req.url ?? '/').split('?')[0];
    const up = http.request({ host: '127.0.0.1', port: b.port, method: req.method, path: req.url, headers, agent: false }, (ur) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        if (v === undefined || HOP.has(k)) continue;
        if (k === 'location' && typeof v === 'string') { out[k] = rewriteLocation(v, this.origin, b.port); continue; }
        if (k === 'set-cookie') { out[k] = (Array.isArray(v) ? v : [v]).map((l) => rewriteSetCookie(l, reqPath, this.backendPrefix()).line); continue; }
        out[k] = v;
      }
      res.writeHead(ur.statusCode ?? 502, ur.statusMessage, out);
      ur.pipe(res);
      res.on('close', () => { if (!res.writableFinished) ur.destroy(); });
    });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    up.on('error', () => errorPage(res, 502, 'The app backend is not answering', rt.lastError ? rt.scrub(rt.lastError) : ''));
    req.pipe(up);
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const pub = join(this.runtime.rec.root, 'public');
    let rel: string;
    try { rel = decodeURIComponent((req.url ?? '/').split('?')[0]); } catch { errorPage(res, 400, 'Bad path', ''); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    const target = safeChildPath(pub, rel.replace(/^\/+/, ''));
    const notFound = () => errorPage(res, 404, 'Not found', rel);
    if (!target) { notFound(); return; }
    try {
      const realPub = realpathSync(pub);
      if (lstatSync(target).isSymbolicLink()) { notFound(); return; }
      const real = realpathSync(target);
      const r = relative(realPub, real);
      if (!r || r.startsWith('..') || r.split(sep).some((s) => s.startsWith('.'))) { notFound(); return; }
      const st = statSync(real);
      if (!st.isFile()) { notFound(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(real).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      createReadStream(real).pipe(res);
    } catch {
      notFound();
    }
  }

  private upgrade(req: IncomingMessage, sock: Duplex, head: Buffer): void {
    const deny = (code: number, text: string) => { sock.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); sock.destroy(); };
    sock.on('error', () => { /* the window went away */ });
    if (!this.rightHost(req)) { deny(421, 'Misdirected Request'); return; }
    if (carriesCloudflareHeaders(req)) { deny(403, 'Forbidden'); return; }
    const ident = this.identify(req);
    if (ident.kind === 'none' || ident.kind === 'runner') { deny(401, 'Unauthorized'); return; }
    if (!this.originOk(req, ident, true)) { deny(403, 'Forbidden'); return; }
    if ((req.url ?? '').startsWith('/__dc')) { deny(404, 'Not Found'); return; }
    const b = this.runtime.backend;
    if (!b) { deny(503, 'Service Unavailable'); return; }
    delete req.headers[GATEWAY_SECRET_HEADER];
    const headers = upstreamHeaders(req.headers, this.origin, '127.0.0.1', b.port, { identity: false, prefix: this.backendPrefix() });
    delete headers.authorization;
    headers[GATEWAY_SECRET_HEADER] = this.runtime.gatewaySecret;
    headers.connection = 'Upgrade';
    headers.upgrade = String(req.headers.upgrade ?? 'websocket');
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    this.sockets.add(sock);
    sock.once('close', () => this.sockets.delete(sock));
    const u = connect({ host: '127.0.0.1', port: b.port });
    u.once('connect', () => {
      this.sockets.add(u);
      u.once('close', () => { this.sockets.delete(u); sock.destroy(); });
      u.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) u.write(head);
      u.pipe(sock);
      sock.pipe(u);
    });
    u.on('error', () => deny(502, 'Bad Gateway'));
    sock.once('close', () => u.destroy());
  }
}

export type SnapshotResult = { id: string; file: string } | { error: 'window_hidden' | 'snapshot_failed' | 'snapshot_timeout' };

const gateways = new Map<string, Promise<AppGateway>>();

/** The app's gateway, started on first use (shared by concurrent launches). */
export function gatewayFor(runtime: AppRuntime): Promise<AppGateway> {
  let g = gateways.get(runtime.hash);
  if (!g) {
    const gw = new AppGateway(runtime);
    g = gw.listen().then(() => gw);
    gateways.set(runtime.hash, g);
    g.catch(() => gateways.delete(runtime.hash));
  }
  return g;
}

export async function existingGateway(hash: string): Promise<AppGateway | null> {
  const g = gateways.get(hash);
  return g ? g.catch(() => null) : null;
}

export async function closeGateway(hash: string): Promise<void> {
  const g = gateways.get(hash);
  gateways.delete(hash);
  if (g) { try { await (await g).close(); } catch { /* never listened */ } }
}

export async function closeAllGateways(): Promise<void> {
  const all = [...gateways.keys()];
  await Promise.all(all.map((h) => closeGateway(h)));
}

/** Windows heartbeating across every app (GET /api/apps/running; "Durduruldu" windows count). */
export async function runningWindowCount(): Promise<number> {
  let n = 0;
  for (const g of gateways.values()) {
    try { n += (await g).runtime.liveWindows(); } catch { /* never listened */ }
  }
  return n;
}

// Re-export for routes/tests.
export { ownCookies };
