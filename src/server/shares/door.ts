/**
 * The door of a live link (plan C2, C3, D6, D7): the only routes a request without a guest session
 * reaches. `GET /k/<token>` (the link), `GET|POST /__share/login` (the optional password),
 * `GET /__share/closed`. Every answer here: `no-store`, `no-referrer`, a CSP that runs no script,
 * and no request input echoed. An unknown token, a wrong token and a closed share all get the SAME
 * page (no oracle).
 *
 * Session: `__Host-dcs` (Secure, HttpOnly, SameSite=Strict, Path=/, no Domain), set on a small
 * same-origin page that then opens `/`, so Strict holds on the first navigation from a chat app.
 * With a password: a 5-minute single-use door ticket (`__Host-dct`) first, consumed only by the
 * right password; a wrong one costs a step of a per-IP limiter (5 per minute) keyed on
 * `cf-connecting-ip` (Cloudflare sets it; a client-sent one is refused at the edge, spike S1).
 * The token, the ticket and the password are never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Share } from './registry.js';
import { shareDeps } from './registry.js';

export const SESSION_COOKIE = '__Host-dcs';
export const TICKET_COOKIE = '__Host-dct';
export const TICKET_TTL_MS = 5 * 60_000;
export const SESSION_CAP = 200;
export const TICKET_CAP = 200;
export const LOGIN_PER_MINUTE = 5;
const LOGIN_BODY_MAX = 4096;

export const DOOR_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

const eqStr = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function cookieOf(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

/** True (and the session touched) when the request carries a live guest session of `share`. */
export function hasSession(share: Share, req: IncomingMessage, now: number = shareDeps().now()): boolean {
  if (share.state !== 'open') return false;
  const v = cookieOf(req, SESSION_COOKIE);
  if (!v || !/^[A-Za-z0-9_-]{43}$/.test(v)) return false;
  for (const s of share.sessions.keys()) {
    if (eqStr(v, s)) {
      // LRU: the touched session moves to the end.
      share.sessions.delete(s);
      share.sessions.set(s, now);
      return true;
    }
  }
  return false;
}

function mintSession(share: Share, now: number): string {
  const v = randomBytes(32).toString('base64url');
  share.sessions.set(v, now);
  // Over the cap the least recently used (idle first) goes: link-preview bots cannot grow memory.
  while (share.sessions.size > SESSION_CAP) share.sessions.delete(share.sessions.keys().next().value as string);
  return v;
}

function mintTicket(share: Share, now: number): string {
  for (const [t, exp] of share.tickets) if (exp < now) share.tickets.delete(t);
  const v = randomBytes(32).toString('base64url');
  share.tickets.set(v, now + TICKET_TTL_MS);
  while (share.tickets.size > TICKET_CAP) share.tickets.delete(share.tickets.keys().next().value as string);
  return v;
}

function liveTicket(share: Share, req: IncomingMessage, now: number): string | null {
  const v = cookieOf(req, TICKET_COOKIE);
  if (!v || !/^[A-Za-z0-9_-]{43}$/.test(v)) return null;
  for (const [t, exp] of share.tickets) {
    if (eqStr(v, t)) return exp >= now ? t : null;
  }
  return null;
}

// ─── The per-IP password limiter ────────────────────────────────────────────

export class LoginLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly perMinute = LOGIN_PER_MINUTE) {}
  /** True when `ip` still may try (and counts nothing). */
  allowed(ip: string, now: number): boolean {
    const h = (this.hits.get(ip) ?? []).filter((t) => t > now - 60_000);
    this.hits.set(ip, h);
    return h.length < this.perMinute;
  }
  /** A wrong password from `ip`. */
  fail(ip: string, now: number): void {
    const h = (this.hits.get(ip) ?? []).filter((t) => t > now - 60_000);
    h.push(now);
    this.hits.set(ip, h);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value as string);
  }
}

const limiters = new WeakMap<Share, LoginLimiter>();
function limiterOf(share: Share): LoginLimiter {
  let l = limiters.get(share);
  if (!l) { l = new LoginLimiter(); limiters.set(share, l); }
  return l;
}

/** The limiter key: Cloudflare's own client address. Absent = refused (never x-forwarded-for). */
export function clientIp(req: IncomingMessage): string | null {
  const v = req.headers['cf-connecting-ip'];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// ─── Pages ──────────────────────────────────────────────────────────────────

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const PAGE_STYLE = [
  ':root{color-scheme:light dark;--bg:#fff;--text:#292d34;--text2:#646464;--border:#e8e8e8;--bg2:#f6f7fa;--accent:#6647f0;--bad:#b91c1c}',
  '@media (prefers-color-scheme:dark){:root{--bg:#16171b;--text:#ececf1;--text2:#a1a1aa;--border:#2c2d33;--bg2:#1f2026;--accent:#8b74ff;--bad:#f87171}}',
  '*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}',
  "body{font:14px/1.5 'Inter',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;min-height:100vh}",
  'main{flex:1;width:100%;max-width:400px;margin:0 auto;padding:48px 20px 24px}',
  "h1{font:700 20px/1.25 'Plus Jakarta Sans','Inter',ui-sans-serif,system-ui,sans-serif;margin:24px 0 6px}",
  '.sub{font-size:14px;color:var(--text2);margin:0 0 18px}',
  'label{display:block;font-size:12px;font-weight:600;color:var(--text2);margin:12px 0 6px}',
  'input{width:100%;font:15px/1.2 ui-sans-serif,system-ui,sans-serif;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:9px;padding:12px}',
  'input:focus{outline:2px solid var(--accent);outline-offset:1px}',
  'button{display:block;width:100%;padding:12px;border:0;border-radius:9px;background:var(--accent);color:#fff;font:600 15px/1.2 ui-sans-serif,system-ui,sans-serif;margin-top:14px;cursor:pointer}',
  '.err{color:var(--bad);font-size:13px;margin:10px 0 0}',
  '.en{color:var(--text2);font-size:12px;margin-top:20px}',
  'footer{text-align:center;font-size:11px;color:var(--text2);padding:16px}',
].join('');

function page(title: string, body: string): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>`
    + `<body><main>${body}</main><footer>dreamcontext canlı link</footer></body></html>`;
}

function doorHeaders(extra: Record<string, string | string[]> = {}): Record<string, string | string[]> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': DOOR_CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

/** True when the request asks for a page (a navigation), not data. */
export function wantsHtml(req: IncomingMessage): boolean {
  const m = (req.method ?? 'GET').toUpperCase();
  return (m === 'GET' || m === 'HEAD') && String(req.headers.accept ?? '').includes('text/html');
}

const CLOSED_TITLE = 'Bu paylaşım kapandı';
const CLOSED_BODY = `<h1>${CLOSED_TITLE}</h1><p class="sub">Linki gönderen kişi paylaşımı kapattı ya da link hiç geçerli değildi. Yeniden görmek için ondan yeni bir link iste.</p>`
  + '<p class="en" lang="en">This share is closed, or the link was never valid. Ask the person who sent it for a new link.</p>';

/**
 * The one page for an unknown token, a wrong token, no session and a closed share: the same body
 * for every case (no oracle). HTML for a navigation, JSON otherwise.
 */
export function sendUnavailable(req: IncomingMessage, res: ServerResponse, status: 401 | 410 = 401): void {
  if (res.headersSent) { res.destroy(); return; }
  if (wantsHtml(req)) {
    const html = page(CLOSED_TITLE, CLOSED_BODY);
    res.writeHead(status, doorHeaders({ 'Content-Length': String(Buffer.byteLength(html)) }));
    res.end((req.method ?? 'GET').toUpperCase() === 'HEAD' ? undefined : html);
    return;
  }
  const body = JSON.stringify({ error: status === 410 ? 'share_closed' : 'share_unavailable' });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function passwordPage(share: Share, error: string | null): string {
  const what = share.kind === 'app' ? 'bu app\'i' : 'bu panoyu';
  const who = share.ownerName ? `${escapeHtml(share.ownerName)} ${what} seninle paylaştı.` : `${what.charAt(0).toUpperCase()}${what.slice(1)} seninle paylaşıldı.`;
  return page(share.name, `<h1>${escapeHtml(share.name)}</h1><p class="sub">${who} Açmak için şifreyi gir.</p>`
    + '<form method="post" action="/__share/login" autocomplete="off">'
    + '<label for="p">Şifre</label><input id="p" name="p" type="password" autocomplete="current-password" autofocus required maxlength="200">'
    + (error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : '')
    + '<button type="submit">Aç</button></form>'
    + '<p class="en" lang="en">Enter the password to open it.</p>');
}

function sendPasswordPage(res: ServerResponse, share: Share, status: number, error: string | null, setCookie?: string): void {
  const html = passwordPage(share, error);
  res.writeHead(status, doorHeaders({ 'Content-Length': String(Buffer.byteLength(html)), ...(setCookie ? { 'Set-Cookie': setCookie } : {}) }));
  res.end(html);
}

/** The same-origin bounce: the session cookie is set here and the page opens `/` itself. */
function sendBounce(res: ServerResponse, session: string, clearTicket: boolean): void {
  const html = page('Açılıyor', '<h1>Açılıyor…</h1><p class="sub"><a href="/">Açılmazsa buraya dokun.</a></p>')
    .replace('<meta name="referrer"', '<meta http-equiv="refresh" content="0;url=/"><meta name="referrer"');
  const cookies = [`${SESSION_COOKIE}=${session}; Secure; HttpOnly; SameSite=Strict; Path=/`];
  if (clearTicket) cookies.push(`${TICKET_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.writeHead(200, doorHeaders({ 'Content-Length': String(Buffer.byteLength(html)), 'Set-Cookie': cookies }));
  res.end(html);
}

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > LOGIN_BODY_MAX) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * The door routes. True when the request was one of them (and answered); false for every other
 * path (the listener then requires a session).
 */
export async function handleDoor(share: Share, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  const now = shareDeps().now();
  if (path.startsWith('/k/')) {
    req.resume();
    if (method !== 'GET' && method !== 'HEAD') { sendUnavailable(req, res); return true; }
    const candidate = path.slice(3);
    if (share.state !== 'open' || !eqStr(candidate, share.token)) { sendUnavailable(req, res); return true; }
    if (share.passwordDigest) {
      const ticket = mintTicket(share, now);
      sendPasswordPage(res, share, 200, null, `${TICKET_COOKIE}=${ticket}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TICKET_TTL_MS / 1000}`);
      return true;
    }
    sendBounce(res, mintSession(share, now), false);
    return true;
  }
  if (path === '/__share/closed') {
    req.resume();
    sendUnavailable(req, res, share.state === 'open' ? 401 : 410);
    return true;
  }
  if (path === '/__share/login') {
    if (!share.passwordDigest || share.state !== 'open') { req.resume(); sendUnavailable(req, res); return true; }
    if (method === 'GET' || method === 'HEAD') {
      req.resume();
      if (!liveTicket(share, req, now)) { sendUnavailable(req, res); return true; }
      sendPasswordPage(res, share, 200, null);
      return true;
    }
    if (method !== 'POST') { req.resume(); sendUnavailable(req, res); return true; }
    // A write to the door carries the share's own public origin.
    if (!share.origin || req.headers.origin !== share.origin) { req.resume(); sendUnavailable(req, res); return true; }
    const ip = clientIp(req);
    if (!ip) { req.resume(); sendUnavailable(req, res); return true; }
    const ticket = liveTicket(share, req, now);
    if (!ticket) { req.resume(); sendUnavailable(req, res); return true; }
    const limiter = limiterOf(share);
    if (!limiter.allowed(ip, now)) {
      req.resume();
      sendPasswordPage(res, share, 429, 'Çok fazla deneme. Bir dakika sonra yeniden dene.');
      return true;
    }
    const form = await readForm(req);
    if (share.state !== 'open') { sendUnavailable(req, res); return true; }
    const given = form?.get('p') ?? '';
    const right = given.length > 0 && given.length <= 200 && timingSafeEqual(digest(given), share.passwordDigest);
    if (!right) {
      limiter.fail(ip, now);
      sendPasswordPage(res, share, 401, 'Şifre yanlış.');
      return true;
    }
    share.tickets.delete(ticket);
    sendBounce(res, mintSession(share, now), true);
    return true;
  }
  return false;
}
