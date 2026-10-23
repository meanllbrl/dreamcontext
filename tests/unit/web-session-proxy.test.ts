/**
 * The web card's session proxy (owner 2026-10-22): an approved dev server served from
 * 127.0.0.1:<proxy> so its cookies are first-party in the window, its localStorage kept on disk
 * between runs, its page carrying the bridge, Clear wiping what it set — and nothing about it
 * loosening the dashboard's own gates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearWebSession, readWebSession, rememberCookies, sanitizeSnapshot, saveWebSession, webSessionKey, webSessionsDir, MAX_COOKIES,
} from '../../src/lib/super/web-session-store.js';
import { BRIDGE_PATH, CLEAR_PATH, STORAGE_PATH, clearPageHtml, cookiePrefix, inlineJson, webBridgeScript, WEB_CARD_KEY } from '../../src/lib/super/web-bridge.js';
import {
  closeAllWebSessions, expiries, headSeen, injectBridge, openWebSession, ownCookies, rewriteLocation, rewriteSetCookie, upstreamHeaders,
} from '../../src/server/web-session-proxy.js';

const SCOPE = '/v/acme-app/_dream_context';
const K = webSessionKey(SCOPE, 5173);
import { claimOwnedPort, ownedLoopbackPorts, resetOwnedPortsForTests } from '../../src/server/owned-ports.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'websess-')); resetOwnedPortsForTests(); });
afterEach(async () => { await closeAllWebSessions(); rmSync(home, { recursive: true, force: true }); resetOwnedPortsForTests(); });

describe('the per-origin store', () => {
  it('one session per project and port: its own key, 0600, and a clear forgets it', () => {
    // Two projects on :5173 are two sessions; one project's two ports too.
    expect(K).toMatch(/^[a-f0-9]{8}$/);
    expect(webSessionKey('/v/beta/_dream_context', 5173)).not.toBe(K);
    expect(webSessionKey(SCOPE, 3000)).not.toBe(K);
    saveWebSession(K, { localStorage: { token: 'abc', n: '1' }, cookies: [{ name: 'js', path: '/' }] }, home);
    rememberCookies(K, [{ name: 'sid', path: '/' }], home);
    const s = readWebSession(K, home);
    expect(s.localStorage).toEqual({ token: 'abc', n: '1' });
    expect(s.cookies).toEqual([{ name: 'js', path: '/' }, { name: 'sid', path: '/' }]);
    expect(readWebSession(webSessionKey('/v/beta/_dream_context', 5173), home)).toEqual({ localStorage: {}, cookies: [] });
    expect(lstatSync(join(webSessionsDir(home), `${K}.json`)).mode & 0o777).toBe(0o600);
    // A later save replaces the storage but keeps every cookie name already known.
    saveWebSession(K, { localStorage: { n: '2' } }, home);
    expect(readWebSession(K, home)).toEqual({ localStorage: { n: '2' }, cookies: [{ name: 'js', path: '/' }, { name: 'sid', path: '/' }] });
    clearWebSession(K, home);
    expect(readWebSession(K, home)).toEqual({ localStorage: {}, cookies: [] });
    // A key that is not one is never a path.
    expect(saveWebSession('../../x', { localStorage: { a: 'b' } }, home)).toBe(false);
  });

  it('what a page posts is shaped: strings only, cookie names that are tokens, paths absolute, capped', () => {
    const s = sanitizeSnapshot({
      localStorage: { a: 'x', b: 2, c: null },
      cookies: [{ name: 'ok', path: '/app' }, { name: 'bad name', path: '/' }, { name: 'p', path: 'relative' }, { name: 'ok', path: '/app' }, 'junk'],
    });
    expect(s).toEqual({ localStorage: { a: 'x' }, cookies: [{ name: 'ok', path: '/app' }, { name: 'p', path: '/' }] });
    const many = sanitizeSnapshot({ cookies: Array.from({ length: MAX_COOKIES + 20 }, (_, i) => ({ name: `c${i}`, path: '/' })) });
    expect(many.cookies).toHaveLength(MAX_COOKIES);
    expect(sanitizeSnapshot('nope')).toEqual({ localStorage: {}, cookies: [] });
  });

  it('a symlinked session file is neither read nor written through', () => {
    const other = mkdtempSync(join(tmpdir(), 'websess-other-'));
    try {
      mkdirSync(webSessionsDir(home), { recursive: true });
      const target = join(other, 'x.json');
      writeFileSync(target, JSON.stringify({ localStorage: { stolen: '1' }, cookies: [] }));
      symlinkSync(target, join(webSessionsDir(home), `${K}.json`));
      expect(readWebSession(K, home).localStorage).toEqual({});
      expect(() => saveWebSession(K, { localStorage: { a: 'b' } }, home)).toThrow(/symlink/);
      expect(JSON.parse(readFileSync(target, 'utf-8')).localStorage).toEqual({ stolen: '1' });
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});

describe('the rewrites', () => {
  it('Host becomes the upstream; Origin and Referer only when they are the proxy\'s own', () => {
    const P = cookiePrefix(K);
    const own = upstreamHeaders({ host: '127.0.0.1:9000', origin: 'http://127.0.0.1:9000', referer: 'http://127.0.0.1:9000/a?b=1', connection: 'keep-alive', cookie: `${P}sid=1; other=2; dcffffffff.x=3` },
      'http://127.0.0.1:9000', 'localhost', 5173, { identity: true, prefix: P });
    // Only this session's cookies reach the dev server, under their own names.
    expect(own).toMatchObject({ host: 'localhost:5173', origin: 'http://localhost:5173', referer: 'http://localhost:5173/a?b=1', cookie: 'sid=1', 'accept-encoding': 'identity' });
    expect(own.connection).toBeUndefined();
    expect(upstreamHeaders({ cookie: 'other=2' }, 'http://127.0.0.1:9000', 'localhost', 5173, { identity: false, prefix: P }).cookie).toBeUndefined();
    const foreign = upstreamHeaders({ host: '127.0.0.1:9000', origin: 'http://evil.test', referer: 'http://evil.test/x' }, 'http://127.0.0.1:9000', 'localhost', 5173, { identity: false, prefix: P });
    expect(foreign.origin).toBe('http://evil.test');
    expect(foreign.referer).toBe('http://evil.test/x');
    // A lookalike prefix is not the proxy's origin.
    expect(upstreamHeaders({ referer: 'http://127.0.0.1:90001/x' }, 'http://127.0.0.1:9000', 'localhost', 5173, { identity: false, prefix: P }).referer).toBe('http://127.0.0.1:90001/x');
    expect(ownCookies(`a=1; ${P}b=2; ${P}=junk`, P)).toBe('b=2');
  });

  it('a redirect to the upstream (any loopback spelling, same port) comes back to the proxy; others stay', () => {
    expect(rewriteLocation('http://localhost:5173/login?x=1', 'http://127.0.0.1:9000', 5173)).toBe('http://127.0.0.1:9000/login?x=1');
    expect(rewriteLocation('http://127.0.0.1:5173', 'http://127.0.0.1:9000', 5173)).toBe('http://127.0.0.1:9000/');
    expect(rewriteLocation('http://localhost:3000/x', 'http://127.0.0.1:9000', 5173)).toBe('http://localhost:3000/x');
    expect(rewriteLocation('/relative', 'http://127.0.0.1:9000', 5173)).toBe('/relative');
    expect(rewriteLocation('https://accounts.example.com/o', 'http://127.0.0.1:9000', 5173)).toBe('https://accounts.example.com/o');
  });

  it('a Set-Cookie gets the session prefix, loses Domain (refused on 127.0.0.1) and names its path', () => {
    expect(rewriteSetCookie('sid=1; Domain=localhost; Path=/; HttpOnly', '/login', 'dcab12cd34.')).toEqual({ line: 'dcab12cd34.sid=1; Path=/; HttpOnly', cookie: { name: 'sid', path: '/' } });
    expect(rewriteSetCookie('t=2; HttpOnly', '/app/login', 'p.').cookie).toEqual({ name: 't', path: '/app' });
    expect(rewriteSetCookie(' t=2', '/login', 'p.')).toEqual({ line: 'p.t=2', cookie: { name: 't', path: '/' } });
  });

  it('the bridge goes first in <head>, never before the doctype', () => {
    const tag = `<script src="${BRIDGE_PATH}"></script>`;
    expect(injectBridge(Buffer.from('<!doctype html><html><head><title>x</title></head></html>')).toString()).toBe(`<!doctype html><html><head>${tag}<title>x</title></head></html>`);
    expect(injectBridge(Buffer.from('<!DOCTYPE html><html lang="tr"><body>x</body></html>')).toString()).toBe(`<!DOCTYPE html><html lang="tr">${tag}<body>x</body></html>`);
    expect(injectBridge(Buffer.from('<!doctype html><p>bare')).toString()).toBe(`<!doctype html>${tag}<p>bare`);
    // Bytes outside ASCII are carried as they are.
    expect(injectBridge(Buffer.from('<head>Öğretmen</head>', 'utf-8')).toString('utf-8')).toBe(`<head>${tag}Öğretmen</head>`);
  });

  it('Clear expires each known cookie (its prefixed name) at its own path and at /', () => {
    expect(expiries([{ name: 'sid', path: '/' }, { name: 't', path: '/app' }], 'p.')).toEqual([
      'p.sid=; Max-Age=0; Path=/', 'p.t=; Max-Age=0; Path=/app', 'p.t=; Max-Age=0; Path=/',
    ]);
  });

  it('the bridge goes in as soon as the page\'s <head> (or <body>) has arrived', () => {
    expect(headSeen(Buffer.from('<!doctype html><html><he'))).toBe(false);
    expect(headSeen(Buffer.from('<!doctype html><html><head>'))).toBe(true);
    expect(headSeen(Buffer.from('<html><body class="x">'))).toBe(true);
  });

  it('the bridge and the clear page are valid scripts that cannot be closed by a value', () => {
    const src = webBridgeScript({ parents: ['http://127.0.0.1:4173'], generation: 3, cookiePrefix: cookiePrefix(K) });
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('["http://127.0.0.1:4173"]');
    expect(src).toContain(`var PREFIX = "dc${K}.";`);
    expect(src).toContain(JSON.stringify(WEB_CARD_KEY));
    expect(src).toContain('var GEN = 3;');
    expect(src).not.toMatch(/__PARENTS__|__GENERATION__|__STORAGE__|__KEY__|__PREFIX__/);
    expect(clearPageHtml('/')).toContain('<meta name="referrer" content="no-referrer">');
    expect(inlineJson('</script><b>')).toBe('"\\u003c/script>\\u003cb>"');
    const page = clearPageHtml('/x</script><script>alert(1)</script>');
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    const inline = /<script>([\s\S]*)<\/script>/.exec(page)![1];
    expect(() => new Function(inline)).not.toThrow();
  });
});

// ─── against a real upstream ────────────────────────────────────────────────────────

interface Seen { host?: string; origin?: string; cookie?: string; url?: string }
let upstream: Server;
let upPort: number;
let seen: Seen[];
let upSockets: Set<import('node:stream').Duplex>;
function stopUpstream(): Promise<void> {
  for (const sk of upSockets) sk.destroy();
  return new Promise<void>((r) => upstream.close(() => r()));
}
async function startUpstream(): Promise<void> {
  seen = [];
  upSockets = new Set();
  upstream = createServer((req, res) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie, url: req.url });
    if (req.url === '/login') {
      res.writeHead(302, { Location: `http://localhost:${upPort}/home`, 'Set-Cookie': ['sid=abc; Domain=localhost; Path=/; HttpOnly'] });
      res.end();
      return;
    }
    if (req.url === '/api.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (req.url === '/echo') {
      let n = 0;
      req.on('data', (c: Buffer) => { n += c.length; });
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`got ${n}`); });
      return;
    }
    if (req.url === '/stream') {
      // A server-rendered page that streams: its head now, the rest a while later.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.write('<!doctype html><html><head><title>S</title></head><body>first');
      setTimeout(() => res.end('second</body></html>'), 400);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Tilki</title></head><body>hi</body></html>');
  });
  upstream.on('connection', (sk) => { upSockets.add(sk); sk.once('close', () => upSockets.delete(sk)); });
  upstream.on('upgrade', (req, sock) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin, url: req.url });
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    sock.on('data', (d) => sock.write(d));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upPort = (upstream.address() as { port: number }).port;
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe('the proxy, in front of a real dev server', () => {
  beforeEach(startUpstream);
  afterEach(stopUpstream);

  it('serves the page under 127.0.0.1:<proxy>, the bridge first, the upstream seeing its own Host', async () => {
    const s = await openWebSession(upPort, { scope: SCOPE, host: 'localhost', parent: 'http://127.0.0.1:4173', home });
    expect(s.origin).toBe(`http://127.0.0.1:${s.port}`);
    // Its port is the app's own from now on: no card can be pointed at the proxy itself.
    expect(ownedLoopbackPorts().has(s.port)).toBe(true);
    const page = await get(s.port, '/', { 'sec-fetch-dest': 'iframe', accept: 'text/html' });
    expect(page.status).toBe(200);
    expect(page.body).toContain(`<head><script src="${BRIDGE_PATH}"></script><title>Tilki</title>`);
    // Streamed (the page grows by the tag): chunked, never a stale length.
    expect(page.headers['content-length']).toBeUndefined();
    expect(page.headers['transfer-encoding']).toBe('chunked');
    expect(seen.at(-1)?.host).toBe(`localhost:${upPort}`);
    // A fetch() of data is passed as it is, never injected.
    const data = await get(s.port, '/api.json', { 'sec-fetch-dest': 'empty' });
    expect(data.body).toBe('{"ok":true}');
    // The same port asked again: the same proxy.
    expect((await openWebSession(upPort, { scope: SCOPE, home })).port).toBe(s.port);
  });

  it('answers only to its own name: a rebinding Host is refused; an owned upstream is never opened', async () => {
    const s = await openWebSession(upPort, { scope: SCOPE, home });
    expect((await get(s.port, '/', { host: `evil.test:${s.port}` })).status).toBe(421);
    expect((await get(s.port, '/', { host: `localhost:${s.port}` })).status).toBe(421);
    expect(seen).toHaveLength(0);
    const release = claimOwnedPort(upPort);
    expect((await get(s.port, '/')).status).toBe(403);
    await expect(openWebSession(upPort, { scope: SCOPE, home })).rejects.toThrow(/owned/);
    release();
    expect((await get(s.port, '/')).status).toBe(200);
  });

  it('a login cookie: Domain dropped, the redirect back to the proxy, the name kept for Clear', async () => {
    const s = await openWebSession(upPort, { scope: SCOPE, home });
    const r = await get(s.port, '/login', { origin: s.origin });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`${s.origin}/home`);
    const P = cookiePrefix(s.key);
    expect(r.headers['set-cookie']).toEqual([`${P}sid=abc; Path=/; HttpOnly`]);
    expect(seen.at(-1)?.origin).toBe(`http://localhost:${upPort}`);
    expect(readWebSession(s.key, home).cookies).toEqual([{ name: 'sid', path: '/' }]);
    // The window sends back every 127.0.0.1 cookie; only this session's reach the dev server.
    await get(s.port, '/home', { cookie: `${P}sid=abc; dcffffffff.sid=other; dashboard=1` });
    expect(seen.at(-1)?.cookie).toBe('sid=abc');
    // Another project on the same port: another proxy, another jar, another storage.
    const b = await openWebSession(upPort, { scope: '/v/beta/_dream_context', home });
    expect(b.port).not.toBe(s.port);
    expect(b.key).not.toBe(s.key);
    await get(b.port, '/home', { cookie: `${P}sid=abc` });
    expect(seen.at(-1)?.cookie).toBeUndefined();
  });

  it('localStorage: written only by the page itself, read only by the page itself', async () => {
    const s = await openWebSession(upPort, { scope: SCOPE, home });
    const snap = JSON.stringify({ localStorage: { token: 't1' }, cookies: [{ name: 'js', path: '/' }] });
    expect((await get(s.port, `${STORAGE_PATH}?g=1`, { origin: 'http://evil.test', 'content-type': 'text/plain' }, 'POST', snap)).status).toBe(403);
    expect((await get(s.port, `${STORAGE_PATH}?g=1`, { origin: 'http://127.0.0.1:4173' }, 'POST', snap)).status).toBe(403);
    expect(readWebSession(s.key, home).localStorage).toEqual({});
    expect((await get(s.port, `${STORAGE_PATH}?g=1`, { origin: s.origin, 'sec-fetch-site': 'same-origin' }, 'POST', snap)).status).toBe(204);
    expect(readWebSession(s.key, home).localStorage).toEqual({ token: 't1' });
    const read = await get(s.port, STORAGE_PATH, { 'sec-fetch-site': 'same-origin' });
    expect(JSON.parse(read.body)).toEqual({ token: 't1' });
    expect(read.headers['x-content-type-options']).toBe('nosniff');
    expect((await get(s.port, STORAGE_PATH, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await get(s.port, STORAGE_PATH, { origin: 'http://evil.test' })).status).toBe(403);
    // The bridge names the dashboard as its only parent, and carries no stored value.
    await openWebSession(upPort, { scope: SCOPE, parent: 'http://127.0.0.1:4173', home });
    await openWebSession(upPort, { scope: SCOPE, parent: 'javascript:alert(1)', home });
    const bridge = await get(s.port, BRIDGE_PATH);
    expect(bridge.body).toContain('var PARENTS = ["http://127.0.0.1:4173"]');
    expect(bridge.body).not.toContain('t1');
    expect(bridge.headers['cache-control']).toBe('no-store');
  });

  it('Clear: needs the token, expires the known cookies, clears the cache, forgets the storage, and a late beacon cannot write it back', async () => {
    const s = await openWebSession(upPort, { scope: SCOPE, home });
    await get(s.port, '/login');
    await get(s.port, `${STORAGE_PATH}?g=1`, { origin: s.origin }, 'POST', JSON.stringify({ localStorage: { token: 't1' }, cookies: [{ name: 'js', path: '/app' }] }));
    expect((await get(s.port, `${CLEAR_PATH}?t=wrong&next=/home`)).status).toBe(403);
    const P = cookiePrefix(s.key);
    const c = await get(s.port, `${CLEAR_PATH}?t=${s.clearToken}&next=${encodeURIComponent('/home?tab=2')}`, { cookie: `${P}late=1; dcffffffff.other=1` });
    expect(c.status).toBe(200);
    expect(c.headers['clear-site-data']).toBe('"cache"');
    expect(c.headers['referrer-policy']).toBe('no-referrer');
    expect(c.headers['set-cookie']).toEqual(expect.arrayContaining([`${P}sid=; Max-Age=0; Path=/`, `${P}js=; Max-Age=0; Path=/app`, `${P}js=; Max-Age=0; Path=/`, `${P}late=; Max-Age=0; Path=/`]));
    // Never another session's cookie.
    expect(String(c.headers['set-cookie'])).not.toContain('other');
    expect(c.body).toContain('"/home?tab=2"');
    expect(readWebSession(s.key, home)).toEqual({ localStorage: {}, cookies: [] });
    // The page being left posts its storage on pagehide: generation 1 is gone.
    expect((await get(s.port, `${STORAGE_PATH}?g=1`, { origin: s.origin }, 'POST', JSON.stringify({ localStorage: { token: 't1' } }))).status).toBe(204);
    expect(readWebSession(s.key, home).localStorage).toEqual({});
    expect((await get(s.port, BRIDGE_PATH)).body).toContain('var GEN = 2;');
    // `next` never leaves the proxy.
    expect((await get(s.port, `${CLEAR_PATH}?t=${s.clearToken}&next=${encodeURIComponent('//evil.test/x')}`)).body).toContain('var NEXT = "/"');
  });

  it('streams: a page\'s head (with the bridge) arrives before its slow end; a body streams up', async () => {
    const s = await openWebSession(upPort, { scope: SCOPE, home });
    const t0 = Date.now();
    const firstAt = await new Promise<{ first: string; ms: number; all: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: s.port, path: '/stream', headers: { host: `127.0.0.1:${s.port}`, 'sec-fetch-dest': 'iframe' } }, (res) => {
        let first = '';
        let ms = 0;
        let all = '';
        res.on('data', (c: Buffer) => { if (!first) { first = c.toString(); ms = Date.now() - t0; } all += c.toString(); });
        res.on('end', () => resolve({ first, ms, all }));
      });
      r.on('error', reject);
      r.end();
    });
    expect(firstAt.first).toContain(`<head><script src="${BRIDGE_PATH}"></script><title>S</title>`);
    expect(firstAt.ms).toBeLessThan(300);
    expect(firstAt.all.endsWith('second</body></html>')).toBe(true);
    const big = 'x'.repeat(3 * 1024 * 1024);
    expect((await get(s.port, '/echo', { 'content-type': 'text/plain' }, 'POST', big)).body).toBe(`got ${big.length}`);
  });

  it('a page\'s cookie path no header can carry never takes Clear (or the dashboard) down', async () => {
    const s = await openWebSession(upPort, { scope: SCOPE, home });
    const snap = JSON.stringify({ localStorage: { a: '1' }, cookies: [{ name: 'lang', path: '/şirket' }, { name: 'ok', path: '/app' }] });
    expect((await get(s.port, `${STORAGE_PATH}?g=1`, { origin: s.origin }, 'POST', snap)).status).toBe(204);
    const c = await get(s.port, `${CLEAR_PATH}?t=${s.clearToken}&next=/`);
    expect(c.status).toBe(200);
    const P = cookiePrefix(s.key);
    expect(c.headers['set-cookie']).toEqual(expect.arrayContaining([`${P}ok=; Max-Age=0; Path=/app`, `${P}lang=; Max-Age=0; Path=/`]));
    expect(readWebSession(s.key, home)).toEqual({ localStorage: {}, cookies: [] });
    // Still serving.
    expect((await get(s.port, '/api.json', { 'sec-fetch-dest': 'empty' })).body).toBe('{"ok":true}');
    expect(expiries([{ name: 'x', path: '/ş' }, { name: 'bad name', path: '/' }], 'p.')).toEqual(['p.x=; Max-Age=0; Path=/']);
  });

  it('pipes a WebSocket upgrade (HMR) with Host and Origin rewritten', async () => {
    const s = await openWebSession(upPort, { scope: SCOPE, home });
    const sock = connect({ host: '127.0.0.1', port: s.port });
    const got = await new Promise<string>((resolve, reject) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n') && !buf.includes('ping')) sock.write('ping');
        if (buf.includes('ping')) resolve(buf);
      });
      sock.on('error', reject);
      sock.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nOrigin: ${s.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.destroy();
    expect(got).toContain('101 Switching Protocols');
    expect(seen.at(-1)).toMatchObject({ host: `localhost:${upPort}`, origin: `http://localhost:${upPort}`, url: '/hmr' });
  });

  it('a dev server that is down: a 502 page, not a hang', async () => {
    const s = await openWebSession(upPort, { scope: SCOPE, home });
    await stopUpstream();
    const r = await get(s.port, '/', { 'sec-fetch-dest': 'iframe' });
    expect(r.status).toBe(502);
    expect(r.body).toContain(`localhost:${upPort} is not answering`);
    await startUpstream();
  });
});

describe('the route: the owner\'s own window, an allowed port', async () => {
  const { PassThrough } = await import('node:stream');
  const { handleWebSessionOpen } = await import('../../src/server/routes/agent-chat.js');
  const { setLoopbackGrant } = await import('../../src/lib/loopback-grants.js');
  const { markPhoneSocket } = await import('../../src/server/phone-origin.js');
  const { ROUTE_POLICY } = await import('../../src/lib/handsfree/mac/route-policy.js');
  type Req = import('node:http').IncomingMessage;
  type Res = import('node:http').ServerResponse;
  const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };
  let vault: string;
  beforeEach(async () => {
    process.env.HOME = home;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    vault = join(home, 'acme', '_dream_context');
    mkdirSync(vault, { recursive: true });
    await startUpstream();
  });
  afterEach(async () => {
    process.env.HOME = saved.HOME;
    if (saved.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved.DESKTOP;
    await stopUpstream();
  });
  const call = async (o: { headers?: Record<string, string>; body?: unknown; phone?: boolean } = {}) => {
    const q = new PassThrough() as unknown as Req & InstanceType<typeof PassThrough>;
    const socket = { remoteAddress: '127.0.0.1' };
    if (o.phone) markPhoneSocket(socket);
    Object.assign(q, { headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', ...(o.headers ?? {}) }, socket, method: 'POST', url: '/' });
    setImmediate(() => (q as unknown as InstanceType<typeof PassThrough>).end(o.body === undefined ? '' : JSON.stringify(o.body)));
    const out = { status: 0, json: {} as Record<string, unknown> };
    const r = { writeHead: (s: number) => { out.status = s; }, end: (b?: string) => { out.json = b ? JSON.parse(b) : {}; }, setHeader: () => {} } as unknown as Res;
    await handleWebSessionOpen(q, r, {}, vault);
    return out;
  };

  it('opens for an always-allowed port or an "Open once", never for an owned or unasked one', async () => {
    expect((await call({ body: { port: upPort, host: 'localhost' } })).status).toBe(403);
    const once = await call({ body: { port: upPort, host: 'localhost', once: true } });
    expect(once.status).toBe(200);
    expect(once.json.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof once.json.clearToken).toBe('string');
    setLoopbackGrant(realpathSync(vault), upPort, 'grant', new Set(), home);
    expect((await call({ body: { port: upPort, host: 'localhost' } })).status).toBe(200);
    const release = claimOwnedPort(4173);
    expect((await call({ body: { port: 4173, host: 'localhost', once: true } })).status).toBe(403);
    release();
    expect((await call({ body: { port: upPort, host: 'evil.test', once: true } })).status).toBe(400);
  });

  it('another loopback port, a rebinding page, the phone, or outside the desktop app → 403; denied on the phone surface', async () => {
    const body = { port: upPort, host: 'localhost', once: true };
    expect((await call({ headers: { origin: 'http://localhost:5173' }, body })).status).toBe(403);
    expect((await call({ headers: { host: 'evil.test:4173', origin: 'http://evil.test:4173' }, body })).status).toBe(403);
    expect((await call({ headers: { 'sec-fetch-site': 'same-site' }, body })).status).toBe(403);
    expect((await call({ phone: true, body })).status).toBe(403);
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect((await call({ body })).status).toBe(403);
    expect(ROUTE_POLICY['POST /api/agent/web-session']?.allow).toBe(false);
  });
});
