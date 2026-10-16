// Mac mode, AC6 + AC7: the phone listener is DEFAULT-DENY although every peer is 127.0.0.1
// (cloudflared dials it from the laptop itself), and the MAIN listener refuses anything that
// came through a Cloudflare edge — HTTP and WebSocket, the PTY's upgrade included.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRouter, makeRequestHandler, mainLaptopGate, attachMainListenerBackstop,
  setMainServerForTests, startPhoneListener, stopPhoneListener,
} from '../../src/server/index.js';
import { attachAgentTerminal } from '../../src/server/routes/agent-terminal.js';
import { attachAgentChat } from '../../src/server/routes/agent-chat.js';
import { DEVICE_COOKIE, HandsfreeAuth, hashPassphrase, setMacHandsfreeAuthForTests, setHandsfreeAuthForTests } from '../../src/server/handsfree-auth.js';
import { setMacProbeNonce, setMacPublicOrigin } from '../../src/server/phone-origin.js';
import { MAC_DEVICE_API_ROUTES } from '../../src/server/cloud-mode.js';
import { MAC_PUBLIC_ROUTES, MAC_PROBE_HEADER } from '../../src/lib/handsfree/mac/contract.js';

const ORIGIN = 'https://quiet-lake-1234.trycloudflare.com';
const saved: Record<string, string | undefined> = {};
let dir: string;
let main: http.Server;
let mainPort: number;
let phonePort: number;
let macAuth: HandsfreeAuth;
let cloudAuth: HandsfreeAuth;
let cookie: string;
let cloudCookie: string;

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}) }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** A raw WebSocket handshake: the status code the server answered the upgrade with. */
function upgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', '',
      ];
      sock.write(lines.join('\r\n'));
    });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); resolve(0); }, 4000);
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) { clearTimeout(timer); sock.destroy(); resolve(Number(m[1])); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('close', () => { clearTimeout(timer); if (!/^HTTP/.test(buf)) resolve(0); });
  });
}

/** A concrete path for a registered pattern. */
function concrete(path: string): string {
  return path.replace(/\*[a-zA-Z_]+/g, 'a/b').replace(/:[a-zA-Z_]+/g, 'x');
}

const ALLOWED = new Set([...MAC_PUBLIC_ROUTES, ...MAC_DEVICE_API_ROUTES]);

beforeAll(async () => {
  for (const k of ['DREAMCONTEXT_DESKTOP', 'DREAMCONTEXT_CLOUD', 'HOME']) saved[k] = process.env[k];
  process.env.DREAMCONTEXT_DESKTOP = '1';
  delete process.env.DREAMCONTEXT_CLOUD;
  dir = mkdtempSync(join(tmpdir(), 'phone-gate-'));
  process.env.HOME = dir;
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>spa</body></html>');
  macAuth = new HandsfreeAuth({ dir: join(dir, 'mac') });
  cloudAuth = new HandsfreeAuth({ dir: join(dir, 'cloud') });
  for (const d of ['mac', 'cloud']) { try { (await import('node:fs')).mkdirSync(join(dir, d), { recursive: true }); } catch { /* exists */ } }
  macAuth.store.setPassphrase(await hashPassphrase('alpha bravo charlie delta echo foxtrot'));
  cookie = `${DEVICE_COOKIE}=${macAuth.store.createDevice('iPhone · Safari')}`;
  cloudAuth.store.setPassphrase(await hashPassphrase('alpha bravo charlie delta echo foxtrot'));
  cloudCookie = `${DEVICE_COOKIE}=${cloudAuth.store.createDevice()}`;
  setMacHandsfreeAuthForTests(macAuth);
  setHandsfreeAuthForTests(cloudAuth);

  const router = buildRouter();
  main = http.createServer(makeRequestHandler({ gate: (req, res) => mainLaptopGate(req, res, null), router, dashboardDir: dir, contextRoot: null, cloud: false }));
  attachMainListenerBackstop(main);
  attachAgentTerminal(main);
  attachAgentChat(main, { networkToken: null });
  await new Promise<void>((r) => main.listen(0, '127.0.0.1', () => r()));
  mainPort = (main.address() as net.AddressInfo).port;
  setMainServerForTests({ server: main, router, dashboardDir: dir, contextRoot: null });
  phonePort = (await startPhoneListener()).port;
});

afterAll(async () => {
  await stopPhoneListener();
  await new Promise<void>((r) => main.close(() => r()));
  setMainServerForTests(null);
  setMacHandsfreeAuthForTests(null);
  setHandsfreeAuthForTests(null);
  setMacPublicOrigin(null);
  setMacProbeNonce(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  setMacPublicOrigin(ORIGIN);
  setMacProbeNonce('probe-nonce-1');
});

describe('phone listener: default-deny over the FULL route table (AC6)', () => {
  it('every registered route outside the Mac allow-list is refused through the phone listener, signed in and with our Origin', async () => {
    const routes = buildRouter().list();
    expect(routes.length).toBeGreaterThan(200);
    const leaked: string[] = [];
    let walked = 0;
    for (const r of routes) {
      if (ALLOWED.has(`${r.method} ${r.path}`)) continue;
      walked++;
      const path = concrete(r.path);
      const write = r.method !== 'GET';
      const res = await request(phonePort, r.method, path, { cookie, origin: ORIGIN, accept: 'application/json' }, write ? '{}' : undefined);
      if (res.status !== 403) leaked.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(walked).toBeGreaterThan(200);
    expect(leaked).toEqual([]);
  }, 60_000);

  it('every WS upgrade but the chat socket is refused (PTY, Assistant, anything else), the peer being 127.0.0.1', async () => {
    const h = { cookie, origin: ORIGIN };
    expect(await upgrade(phonePort, '/api/agent/terminal?vault=x', h)).toBe(403);
    expect(await upgrade(phonePort, '/api/agent/chat?vault=__assistant__', h)).toBe(403);
    expect(await upgrade(phonePort, '/api/agent/browser-mirror', h)).toBe(403);
    expect(await upgrade(phonePort, '/api/tasks', h)).toBe(403);
    // The chat socket itself passes the gate (then refuses here only for want of a vault).
    expect(await upgrade(phonePort, '/api/agent/chat?vault=nope', h)).toBe(400);
    // …but never without a Mac session, or with a foreign Origin.
    expect(await upgrade(phonePort, '/api/agent/chat?vault=nope', { origin: ORIGIN })).toBe(401);
    expect(await upgrade(phonePort, '/api/agent/chat?vault=nope', { cookie, origin: 'https://evil.example' })).toBe(403);
    expect(await upgrade(phonePort, '/api/agent/chat?vault=nope', { cookie })).toBe(403);
  });

  it('before the URL is set, every write and every upgrade is refused', async () => {
    setMacPublicOrigin(null);
    expect((await request(phonePort, 'POST', '/api/agent/prompt', { cookie, origin: ORIGIN }, '{}')).status).toBe(403);
    expect((await request(phonePort, 'POST', '/api/handsfree/login', { origin: ORIGIN }, '{}')).status).toBe(403);
    expect(await upgrade(phonePort, '/api/agent/chat?vault=nope', { cookie, origin: ORIGIN })).toBe(403);
  });

  it('unauthenticated: an HTML navigation goes to /login, an API call gets 401; a foreign-Origin write is 403', async () => {
    const nav = await request(phonePort, 'GET', '/', { accept: 'text/html' });
    expect(nav.status).toBe(302);
    expect(nav.headers.location).toBe('/login');
    expect((await request(phonePort, 'GET', '/api/agent/chat-history', { accept: 'application/json' })).status).toBe(401);
    expect((await request(phonePort, 'POST', '/api/agent/prompt', { cookie, origin: 'https://evil.example' }, '{}')).status).toBe(403);
    expect((await request(phonePort, 'POST', '/api/agent/prompt', { cookie }, '{}')).status).toBe(403);
  });

  it('a cloud cookie on the phone listener is not a session (401); a Mac cookie is not a cloud one', async () => {
    expect((await request(phonePort, 'GET', '/api/agent/chat-history', { cookie: cloudCookie })).status).toBe(401);
    expect(cloudAuth.store.isValidDevice(cookie.split('=')[1])).toBe(false);
  });

  it('every phone response carries X-Frame-Options DENY and frame-ancestors none, refusals included', async () => {
    for (const [m, p, h] of [['GET', '/login', {}], ['GET', '/api/tasks', { cookie }], ['GET', '/api/health', {}], ['GET', '/', { cookie, accept: 'text/html' }]] as const) {
      const r = await request(phonePort, m, p, h as Record<string, string>);
      expect(r.headers['x-frame-options'], `${m} ${p}`).toBe('DENY');
      expect(String(r.headers['content-security-policy']), `${m} ${p}`).toContain("frame-ancestors 'none'");
    }
  });

  it('/api/health on a phone socket returns only {version} (plus the probe value); the main listener keeps its full body', async () => {
    const phone = await request(phonePort, 'GET', '/api/health');
    expect(Object.keys(JSON.parse(phone.body))).toEqual(['version']);
    expect(phone.headers[MAC_PROBE_HEADER.toLowerCase()]).toBe('probe-nonce-1');
    const desk = JSON.parse((await request(mainPort, 'GET', '/api/health')).body);
    expect(desk).toHaveProperty('contextRoot');
    expect(desk).toHaveProperty('capabilities');
  });

  it('a signed-in phone gets the SPA with the mac surface marker; /api/vaults is names only', async () => {
    const spa = await request(phonePort, 'GET', '/somewhere', { cookie, accept: 'text/html' });
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('<meta name="dreamcontext-surface" content="mac" />');
    const vaults = JSON.parse((await request(phonePort, 'GET', '/api/vaults', { cookie })).body);
    for (const v of vaults.vaults) expect(Object.keys(v).sort()).toEqual(['exists', 'name']);
    const deskSpa = await request(mainPort, 'GET', '/somewhere', { accept: 'text/html' });
    expect(deskSpa.body).not.toContain('dreamcontext-surface');
  });

  it('/login is public and sends no-referrer + no-store', async () => {
    const r = await request(phonePort, 'GET', '/login', { accept: 'text/html' });
    expect(r.status).toBe(200);
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('Sign in to your Mac');
  });
});

describe('main listener: unchanged for the desktop, closed to a tunnel (AC7)', () => {
  it('a desktop request is served as before', async () => {
    const r = await request(mainPort, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.headers['x-frame-options']).toBeUndefined();
  });

  it.each(['cf-ray', 'cf-connecting-ip', 'cf-warp-tag-id'])('an HTTP request carrying %s is 403', async (h) => {
    const r = await request(mainPort, 'GET', '/api/health', { [h]: 'x' });
    expect(r.status).toBe(403);
  });

  it.each(['cf-ray', 'cf-connecting-ip', 'cf-warp-tag-id'])('a WS upgrade carrying %s is refused, the PTY path included', async (h) => {
    expect(await upgrade(mainPort, '/api/agent/terminal?vault=x', { [h]: 'x' })).toBe(403);
    expect(await upgrade(mainPort, '/api/agent/chat?vault=x', { [h]: 'x' })).toBe(403);
  });
});

describe('stopPhoneListener', () => {
  it('closes the listener and destroys every connection, an open keep-alive one included', async () => {
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve) => {
      http.get({ host: '127.0.0.1', port: phonePort, path: '/api/health', agent }, (res) => { res.resume(); res.on('end', () => resolve()); });
    });
    const sockets = Object.values(agent.sockets).flat().concat(Object.values(agent.freeSockets).flat());
    await stopPhoneListener();
    await new Promise((r) => setTimeout(r, 50));
    for (const s of sockets) expect(s?.destroyed).toBe(true);
    await expect(request(phonePort, 'GET', '/api/health')).rejects.toThrow();
    agent.destroy();
    phonePort = (await startPhoneListener()).port;
  });
});
