// Mac mode: the phone listener judges every request by the route policy although every peer is
// 127.0.0.1 (cloudflared dials it from the laptop itself) — the whole dashboard for the
// hands-free project, the laptop-only rows refused, one project per run — and the MAIN listener
// refuses anything that came through a Cloudflare edge, HTTP and WebSocket, the PTY's upgrade
// included.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRouter, makeRequestHandler, mainLaptopGate, attachMainListenerBackstop,
  setMainServerForTests, startPhoneListener, stopPhoneListener,
} from '../../src/server/index.js';
import { attachAgentTerminal } from '../../src/server/routes/agent-terminal.js';
import { attachAgentChat } from '../../src/server/routes/agent-chat.js';
import { DEVICE_COOKIE, HandsfreeAuth, hashPassphrase, setMacHandsfreeAuthForTests } from '../../src/server/handsfree-auth.js';
import { setMacProbeNonce, setMacExposedVaults, setMacPublicOrigin } from '../../src/server/phone-origin.js';
import { MAC_PROBE_HEADER } from '../../src/lib/handsfree/mac/contract.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';
import { addVault } from '../../src/lib/vaults.js';
import { claudeProjectDirName } from '../../src/lib/transcript-sessions.js';
import type { Router } from '../../src/server/router.js';

const ORIGIN = 'https://quiet-lake-1234.trycloudflare.com';
const saved: Record<string, string | undefined> = {};
let dir: string;
let main: http.Server;
let mainPort: number;
let phonePort: number;
let macAuth: HandsfreeAuth;
let cookie: string;
let router: Router;
const PROJECT = 'phone-proj';
const OTHER = 'other-proj';
const THIRD = 'third-proj';
/** Conversation ids: one of the chosen project, one of an unchosen project, one with no cwd. */
const MINE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const NOCWD_ID = '33333333-3333-4333-8333-333333333333';
const TEAMMATE_ID = '44444444-4444-4444-8444-444444444444';

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


beforeAll(async () => {
  for (const k of ['DREAMCONTEXT_DESKTOP', 'HOME']) saved[k] = process.env[k];
  process.env.DREAMCONTEXT_DESKTOP = '1';
  dir = mkdtempSync(join(tmpdir(), 'phone-gate-'));
  process.env.HOME = dir;
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>spa</body></html>');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  mkdirSync(join(dir, 'icons'), { recursive: true });
  for (const f of ['icon-192.png', 'icon-512.png', 'apple-touch-icon-180.png']) writeFileSync(join(dir, 'icons', f), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"dreamcontext"}');
  // Three registered projects: the hands-free one, another the phone must never reach, and a
  // third that some tests choose as well.
  for (const name of [PROJECT, OTHER, THIRD]) {
    mkdirSync(join(dir, name, '_dream_context', 'state'), { recursive: true });
    mkdirSync(join(dir, name, '_dream_context', 'core'), { recursive: true });
    addVault(name, join(dir, name));
  }
  // Claude's transcripts (HOME is the scratch dir): the head real ones start with (no cwd), then
  // the launch dir. The unchosen project's carries markers no phone response may contain.
  const tdir = join(dir, '.claude', 'projects', '-scratch');
  mkdirSync(tdir, { recursive: true });
  const head = [{ type: 'queue-operation', operation: 'enqueue' }, { type: 'custom-title', customTitle: 't' }];
  const turn = (cwd: string | null, text: string, id: string) => [
    { type: 'user', ...(cwd ? { cwd } : {}), sessionId: id, uuid: `${id}-u`, message: { role: 'user', content: text } },
    { type: 'assistant', ...(cwd ? { cwd } : {}), sessionId: id, uuid: `${id}-a`, message: { role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'text', text }], usage: { input_tokens: 987654, output_tokens: 13, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  ];
  const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  // Each in its project's own folder, as Claude files them; the cwd-less one in an unrelated one.
  const folder = (root: string) => { const f = join(dir, '.claude', 'projects', claudeProjectDirName(root)); mkdirSync(f, { recursive: true }); return f; };
  writeFileSync(join(folder(join(dir, PROJECT)), `${MINE_ID}.jsonl`), jsonl([...head, ...turn(join(dir, PROJECT), 'MINE-MARKER', MINE_ID)]));
  writeFileSync(join(folder(join(dir, OTHER)), `${OTHER_ID}.jsonl`), jsonl([...head, ...turn(join(dir, OTHER), 'OTHER-SECRET-MARKER', OTHER_ID)]));
  writeFileSync(join(tdir, `${NOCWD_ID}.jsonl`), jsonl([...head, ...turn(null, 'NOCWD-SECRET-MARKER', NOCWD_ID)]));
  writeFileSync(join(dir, PROJECT, '_dream_context', 'state', 'phone-task.md'), '---\nid: task_x\nname: Phone task\nstatus: todo\npriority: medium\n---\n\n## Why\n\nA task.\n');
  macAuth = new HandsfreeAuth({ dir: join(dir, 'mac') });
  for (const d of ['mac']) { try { (await import('node:fs')).mkdirSync(join(dir, d), { recursive: true }); } catch { /* exists */ } }
  macAuth.store.setPassphrase(await hashPassphrase('alpha bravo charlie delta echo foxtrot'));
  cookie = `${DEVICE_COOKIE}=${macAuth.store.createDevice('iPhone · Safari')}`;
  setMacHandsfreeAuthForTests(macAuth);

  router = buildRouter();
  // A route nobody classified: the gate must refuse it (fail closed).
  router.get('/api/zz-unclassified', async (_req, res) => { res.writeHead(200); res.end('leaked'); });
  main = http.createServer(makeRequestHandler({ gate: (req, res) => mainLaptopGate(req, res, null), router, dashboardDir: dir, contextRoot: null }));
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
  setMacPublicOrigin(null);
  setMacProbeNonce(null);
  setMacExposedVaults([]);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  setMacPublicOrigin(ORIGIN);
  setMacProbeNonce('probe-nonce-1');
  setMacExposedVaults([PROJECT]);
});

describe('phone listener: the route policy over the FULL route table (AC4/AC5)', () => {
  const H = () => ({ cookie, origin: ORIGIN, accept: 'application/json' });

  it('every DENIED row is refused 403 phone_unavailable through the phone listener, signed in and with our Origin', async () => {
    const routes = router.list().filter((r) => ROUTE_POLICY[`${r.method} ${r.path}`]?.allow === false);
    expect(routes.length).toBeGreaterThan(100);
    const leaked: string[] = [];
    for (const r of routes) {
      const res = await request(phonePort, r.method, concrete(r.path), H(), r.method !== 'GET' ? '{}' : undefined);
      if (res.status !== 403 || JSON.parse(res.body || '{}').error !== 'phone_unavailable') leaked.push(`${r.method} ${r.path} → ${res.status} ${res.body.slice(0, 60)}`);
    }
    expect(leaked).toEqual([]);
  }, 120_000);

  it('every ALLOWED GET row passes the gate (never phone_unavailable)', async () => {
    const routes = router.list().filter((r) => r.method === 'GET' && ROUTE_POLICY[`${r.method} ${r.path}`]?.allow === true);
    expect(routes.length).toBeGreaterThan(80);
    const refused: string[] = [];
    for (const r of routes) {
      const res = await request(phonePort, 'GET', concrete(r.path), H());
      if (res.status === 403 && /phone_unavailable/.test(res.body)) refused.push(`${r.method} ${r.path}`);
    }
    expect(refused).toEqual([]);
  }, 120_000);

  it('an unclassified route is refused (fail closed), and so is an /api path no route matches', async () => {
    const a = await request(phonePort, 'GET', '/api/zz-unclassified', H());
    expect(a.status).toBe(403);
    expect(a.body).not.toContain('leaked');
    expect((await request(phonePort, 'GET', '/api/no-such-route', H())).status).toBe(403);
    // The laptop still reaches it: the policy is the phone's only.
    expect((await request(mainPort, 'GET', '/api/zz-unclassified', { 'x-dreamcontext-vault': PROJECT })).status).toBe(200);
  });

  it('the dashboard loads: the SPA, an asset, and every page area answers 2xx; a task write lands', async () => {
    expect((await request(phonePort, 'GET', '/?vault=' + PROJECT, { cookie, accept: 'text/html' })).status).toBe(200);
    expect((await request(phonePort, 'GET', '/assets/app.js', { cookie })).status).toBe(200);
    for (const p of ['/api/lab', '/api/whiteboards', '/api/tasks', '/api/knowledge', '/api/roadmap', '/api/objectives', '/api/automations', '/api/sleep', '/api/core', '/api/council', '/api/theses', '/api/taxonomy', '/api/packs', '/api/releases']) {
      const r = await request(phonePort, 'GET', p, H());
      expect(r.status, `${p} ${r.body.slice(0, 80)}`).toBeLessThan(300);
    }
    const w = await request(phonePort, 'PATCH', '/api/tasks/phone-task', H(), JSON.stringify({ status: 'in_progress' }));
    expect(w.status, w.body).toBeLessThan(300);
  });

  it('one sample of every deny category is refused', async () => {
    for (const [m, p] of [
      ['POST', '/api/window/focus'], ['GET', '/api/assistant/status'], ['POST', '/api/agent/open-terminal'],
      ['POST', '/api/launcher/register'], ['POST', '/api/agent/secret'], ['POST', '/api/handsfree/mac/stop'],
      ['POST', '/api/admin/shutdown'], ['POST', '/api/agent/voice/tts'], ['POST', '/api/notify'], ['POST', '/api/agent/drop'],
      ['POST', '/api/brain/auth/device/start'], ['GET', '/api/launcher/status'], ['POST', '/api/agent/install'],
    ] as const) {
      const r = await request(phonePort, m, p, H(), m !== 'GET' ? '{}' : undefined);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(JSON.parse(r.body).error, `${m} ${p}`).toBe('phone_unavailable');
    }
  });

  it('a write with a foreign Origin is refused; without a cookie only the public routes answer', async () => {
    const w = await request(phonePort, 'PATCH', '/api/tasks/phone-task', { cookie, origin: 'https://evil.example', 'x-dreamcontext-vault': PROJECT }, JSON.stringify({ status: 'done' }));
    expect(w.status).toBe(403);
    expect((await request(phonePort, 'GET', '/api/tasks', { origin: ORIGIN, 'x-dreamcontext-vault': PROJECT })).status).toBe(401);
    expect((await request(phonePort, 'GET', '/api/health')).status).toBe(200);
  });

  it('D9: an /api request another site made is 403 even as a GET; every phone response carries nosniff', async () => {
    expect((await request(phonePort, 'GET', '/api/tasks', { cookie, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await request(phonePort, 'GET', '/api/tasks', { cookie, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await request(phonePort, 'GET', '/api/tasks', { cookie, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    for (const [m, p, h] of [['GET', '/login', {}], ['GET', '/api/tasks', { cookie }], ['GET', '/api/health', {}], ['GET', '/handsfree-sw.js', {}], ['GET', '/api/window/x', { cookie }], ['GET', '/icons/icon-192.png', {}]] as const) {
      const r = await request(phonePort, m, p, h as Record<string, string>);
      expect(r.headers['x-content-type-options'], `${m} ${p}`).toBe('nosniff');
    }
  });

  it('AC10: the worker, its offline page, the manifest and every icon load WITHOUT a cookie', async () => {
    for (const p of ['/handsfree-sw.js', '/handsfree-offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon-180.png']) {
      const r = await request(phonePort, 'GET', p);
      expect(r.status, p).toBe(200);
    }
    // …and nothing else without a session.
    expect((await request(phonePort, 'GET', '/assets/app.js')).status).toBe(401);
  });
});

describe('one project per hands-free run (AC16)', () => {
  const H = () => ({ cookie, origin: ORIGIN, accept: 'application/json' });

  it('/api/vaults lists only the hands-free project, by name', async () => {
    const v = JSON.parse((await request(phonePort, 'GET', '/api/vaults', H())).body);
    expect(v.vaults).toEqual([{ name: PROJECT, exists: true }]);
    expect(v.current).toBe(PROJECT);
    // The laptop still lists both.
    const desk = JSON.parse((await request(mainPort, 'GET', '/api/vaults')).body);
    expect(desk.vaults.map((x: { name: string }) => x.name).sort()).toEqual([OTHER, PROJECT, THIRD].sort());
  });

  it('a request naming another project is refused: the header, ?vault= on a GET and on a write', async () => {
    expect((await request(phonePort, 'GET', '/api/tasks', { ...H(), 'x-dreamcontext-vault': OTHER })).status).toBe(403);
    expect((await request(phonePort, 'GET', `/api/tasks?vault=${OTHER}`, H())).status).toBe(403);
    expect((await request(phonePort, 'POST', `/api/tasks?vault=${OTHER}`, H(), '{}')).status).toBe(403);
    expect((await request(phonePort, 'GET', '/api/tasks', { ...H(), 'x-dreamcontext-vault': PROJECT })).status).toBe(200);
    // A request naming no vault runs on the hands-free project, never the server's pinned root.
    const t = JSON.parse((await request(phonePort, 'GET', '/api/tasks', H())).body);
    expect(JSON.stringify(t)).toContain('phone-task');
  });

  it('the prompt hand-off refuses another project in its body', async () => {
    const r = await request(phonePort, 'POST', '/api/agent/prompt', H(), JSON.stringify({ vault: OTHER, prompt: 'hi' }));
    expect(r.status).toBe(403);
    expect((await request(phonePort, 'POST', '/api/agent/prompt', H(), JSON.stringify({ vault: PROJECT, prompt: 'hi' }))).status).toBe(200);
  });

  it('the chat socket for another project is refused; with no project set every API request is', async () => {
    expect(await upgrade(phonePort, `/api/agent/chat?vault=${OTHER}`, { cookie, origin: ORIGIN })).toBe(403);
    setMacExposedVaults([]);
    expect((await request(phonePort, 'GET', '/api/tasks', H())).status).toBe(403);
    expect(await upgrade(phonePort, `/api/agent/chat?vault=${PROJECT}`, { cookie, origin: ORIGIN })).toBe(403);
  });
});

describe('the projects chosen at start (AC16)', () => {
  const H = (vault?: string) => ({ cookie, origin: ORIGIN, accept: 'application/json', ...(vault ? { 'x-dreamcontext-vault': vault } : {}) });

  it('several chosen: both are listed, the others are not; a vault-scoped request naming none is 400 phone_vault_required', async () => {
    setMacExposedVaults([PROJECT, THIRD]);
    const v = JSON.parse((await request(phonePort, 'GET', '/api/vaults', H())).body);
    expect(v.vaults.map((x: { name: string }) => x.name).sort()).toEqual([PROJECT, THIRD].sort());
    expect(v.current).toBeNull();
    const none = await request(phonePort, 'GET', '/api/tasks', H());
    expect(none.status).toBe(400);
    expect(JSON.parse(none.body).error).toBe('phone_vault_required');
    expect((await request(phonePort, 'GET', '/api/tasks', H(THIRD))).status).toBe(200);
    expect((await request(phonePort, 'GET', '/api/tasks', H(OTHER))).status).toBe(403);
    expect((await request(phonePort, 'GET', `/api/tasks?vault=${THIRD}`, H(PROJECT))).status).toBe(400);
    // A vault-agnostic route needs no project.
    expect((await request(phonePort, 'GET', '/api/agent/capabilities', H())).status).toBe(200);
    expect(await upgrade(phonePort, `/api/agent/chat?vault=${OTHER}`, { cookie, origin: ORIGIN })).toBe(403);
  });

  it('the phone lands on a chosen project; live-chats carries the running and draining lists', async () => {
    setMacExposedVaults([THIRD, PROJECT]);
    const r = await request(phonePort, 'GET', '/', { cookie, accept: 'text/html' });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`/?vault=${THIRD}`);
    const live = JSON.parse((await request(phonePort, 'GET', '/api/agent/live-chats', H(PROJECT))).body);
    expect(live).toEqual({ chats: [], draining: [] });
  });

  it('one chosen: a request naming none runs on it (never the pinned root)', async () => {
    setMacExposedVaults([THIRD]);
    expect((await request(phonePort, 'GET', '/api/tasks', H())).status).toBe(200);
    expect((await request(phonePort, 'GET', '/api/tasks', H(PROJECT))).status).toBe(403);
  });

  it('every phone-allowed GET /api/agent/* route given an UNCHOSEN project\'s conversation id returns 403 or nothing of it', async () => {
    const rows = router.list().filter((r) => r.method === 'GET' && r.path.startsWith('/api/agent/') && ROUTE_POLICY[`GET ${r.path}`]?.allow);
    expect(rows.length).toBeGreaterThan(10);
    const leaked: string[] = [];
    for (const r of rows) {
      for (const id of [OTHER_ID, NOCWD_ID]) {
        const q = `claudeId=${id}&session=${TEAMMATE_ID}&launched=1&id=${id}&sessionId=${id}`;
        const res = await request(phonePort, 'GET', `${concrete(r.path)}?${q}`, H(PROJECT));
        if (/OTHER-SECRET-MARKER|NOCWD-SECRET-MARKER|9876[0-9][0-9]/.test(res.body)) leaked.push(`${r.path} ${id} → ${res.status} ${res.body.slice(0, 80)}`);
      }
    }
    expect(leaked).toEqual([]);
    const refused = await request(phonePort, 'GET', `/api/agent/chat-history?claudeId=${OTHER_ID}`, H(PROJECT));
    expect(refused.status).toBe(403);
    expect((await request(phonePort, 'GET', `/api/agent/chat-history?claudeId=${NOCWD_ID}`, H(PROJECT))).status).toBe(403);
    expect(JSON.parse((await request(phonePort, 'GET', `/api/agent/session-model?claudeId=${OTHER_ID}`, H(PROJECT))).body).model).toBeNull();
    expect(JSON.parse((await request(mainPort, 'GET', `/api/agent/session-model?claudeId=${OTHER_ID}`, { 'x-dreamcontext-vault': PROJECT })).body).model).not.toBeNull();
    // Positive control: the chosen project's own conversation reads, and the laptop reads them all.
    expect((await request(phonePort, 'GET', `/api/agent/chat-history?claudeId=${MINE_ID}`, H(PROJECT))).body).toContain('MINE-MARKER');
    expect((await request(phonePort, 'GET', `/api/agent/session-stats?claudeId=${MINE_ID}`, H(PROJECT))).body).toMatch(/9876[0-9][0-9]/);
    expect((await request(mainPort, 'GET', `/api/agent/chat-history?claudeId=${OTHER_ID}`, { 'x-dreamcontext-vault': PROJECT })).body).toContain('OTHER-SECRET-MARKER');
  }, 60_000);

  it('the chat socket resuming an unchosen project\'s conversation is refused', async () => {
    expect(await upgrade(phonePort, `/api/agent/chat?vault=${PROJECT}&resume=${OTHER_ID}`, { cookie, origin: ORIGIN })).toBe(403);
    expect(await upgrade(phonePort, `/api/agent/chat?vault=${PROJECT}&resume=${NOCWD_ID}&reattach=1`, { cookie, origin: ORIGIN })).toBe(403);
  });
});

describe('phone listener: sockets, sign-in and pages', () => {
  it('every WS upgrade but the chat socket is refused (PTY, Assistant, anything else), the peer being 127.0.0.1', async () => {
    const h = { cookie, origin: ORIGIN };
    expect(await upgrade(phonePort, '/api/agent/terminal?vault=x', h)).toBe(403);
    expect(await upgrade(phonePort, '/api/agent/chat?vault=__assistant__', h)).toBe(403);
    expect(await upgrade(phonePort, '/api/agent/browser-mirror', h)).toBe(403);
    expect(await upgrade(phonePort, '/api/tasks', h)).toBe(403);
    // The chat socket itself passes the gate (then refuses here: not the hands-free project).
    expect(await upgrade(phonePort, '/api/agent/chat?vault=nope', h)).toBe(403);
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
    // `/` lands in the hands-free project's chat.
    const land = await request(phonePort, 'GET', '/', { cookie, accept: 'text/html' });
    expect(land.status).toBe(302);
    expect(land.headers.location).toBe(`/?vault=${PROJECT}`);
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
