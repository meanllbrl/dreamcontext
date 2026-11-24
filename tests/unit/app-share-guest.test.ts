// Live links, the app guest (tunel-paylasim C6, C9, C10): a guest reaches the app's page, backend
// and four gateway paths, nothing of dreamcontext; its identity is fixed by the share socket,
// never by a header; while the app is shared its backend's agent doors and non-listed dashboard
// writes answer 409 shared_live (unless the AI switch is on); the share holds a runtime lease; every
// app removal closes the app's share first.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { registerApp, updateApp, type AppRecord } from '../../src/lib/apps/registry.js';
import { runtimeFor, stopAllRuntimes, type AppRuntime } from '../../src/lib/apps/supervisor.js';
import { closeAllGateways, configureGateways, gatewayFor, guestUpstreamHeaders, registeredGatewayPrefixes, type AppGateway } from '../../src/server/apps/gateway.js';
import { GUEST_GATEWAY_ROUTES, guestRoute } from '../../src/server/apps/guest-routes.js';
import { deniedForEveryone, SHARED_BACKEND_WRITES } from '../../src/lib/apps/page-routes.js';
import { handleAppDelete, retireAppRuntime, setAppsHomeForTests } from '../../src/server/routes/apps.js';
import { closeShare, configureSharesForTests, getShare, openShare, sharedLive, appShareKey, type Share } from '../../src/server/shares/registry.js';
import { fakeWorld, openAndWait, sessionCookie, upgradeViaTunnel, viaTunnel, waitFor } from './share-fixture.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'apps', 'echo-backend');
const PATH = [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin'].join(delimiter);
const cleanup: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); cleanup.push(d); return d; };
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

interface Res { status: number; headers: http.IncomingHttpHeaders; text: string; json: any }
function gwReq(gw: AppGateway, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: gw.port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${gw.port}`, ...(opts.headers ?? {}) }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

let home: string;
let project: string;
let dash: http.Server;
let dashPort = 0;
let router: { list(): Array<{ method: string; path: string }>; match(m: string, u: string): { method: string; path: string } | null };
const dashSeen: Array<{ method: string; url: string; body: string }> = [];
let rec: AppRecord;
let rt: AppRuntime;
let gw: AppGateway;

function makeApp(slug: string): AppRecord {
  const root = join(`${project}-apps`, slug);
  mkdirSync(dirname(root), { recursive: true });
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug, name: `App ${slug}`, backend: { command: 'node server.mjs', health: '/health' } }));
  return registerApp(home, { projectRoot: project, vault: 'acme', slug, name: `App ${slug}`, root });
}

async function openApp(slug: string, opts: { ai?: boolean } = {}): Promise<Share> {
  return openAndWait(() => openShare({ kind: 'app', vault: 'acme', slug, ai: opts.ai }).share);
}

async function guestSession(share: Share): Promise<string> {
  const door = await viaTunnel(share, 'GET', `/k/${share.token}`);
  return sessionCookie(door);
}

beforeAll(async () => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  home = tmp('dc-asg-home-');
  project = join(realpathSync(tmp('dc-asg-proj-')), 'acme');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));
  setAppsHomeForTests(home);
  fakeWorld();
  dash = http.createServer((q, s) => {
    const chunks: Buffer[] = [];
    q.on('data', (c: Buffer) => chunks.push(c));
    q.on('end', () => {
      dashSeen.push({ method: q.method ?? '', url: q.url ?? '', body: Buffer.concat(chunks).toString() });
      s.writeHead(200, { 'content-type': 'application/json' });
      s.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => dash.listen(0, '127.0.0.1', () => r()));
  dashPort = (dash.address() as { port: number }).port;
  const { buildRouter } = await import('../../src/server/index.js');
  router = buildRouter() as unknown as typeof router;
  configureGateways({ home, dashboardPort: dashPort, router: router as never, theme: () => 'dark' });
  rec = makeApp('echo');
  // The test's runtime (its own PATH, no file watch); routes/apps.ts reuses it by hash.
  rt = runtimeFor(rec, { home, loginPath: async () => PATH, noWatch: true });
  gw = await gatewayFor(rt);
  await rt.ensureRunning();
}, 60_000);

afterAll(async () => {
  stopAllRuntimes();
  await closeAllGateways();
  await new Promise<void>((r) => dash.close(() => r()));
  configureSharesForTests(null);
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

describe('guest route table (C6)', () => {
  it('has a row for every gateway prefix, and no row for a prefix the gateway does not answer', () => {
    const registered = registeredGatewayPrefixes();
    for (const p of registered) expect(GUEST_GATEWAY_ROUTES, `no guest row for ${p}`).toHaveProperty([p]);
    for (const p of Object.keys(GUEST_GATEWAY_ROUTES)) expect(registered, `stale guest row ${p}`).toContain(p);
  });

  it('allows the app and four gateway paths only, default deny', () => {
    expect(guestRoute('/')).toEqual({ kind: 'app' });
    expect(guestRoute('/api/board')).toEqual({ kind: 'app' });
    expect(guestRoute('/__dc/theme')).toEqual({ kind: 'theme' });
    for (const p of ['/__dc/sdk.js', '/__dc/config', '/__dc/data/read']) expect(guestRoute(p).kind).toBe('gateway');
    for (const p of ['/__dc/api/tasks', '/__dc/embed/chat', '/__dc/notify', '/__dc/schedules', '/__dc/enter', '/__dc/runner/heartbeat', '/__dc/mcp/a/b', '/__dc/ask', '/__dc/team/say', '/__dc/automations', '/__dc/learn', '/__dc/unknown', '/__dc', '/__dc/sdk.jsx']) {
      expect(guestRoute(p), p).toEqual({ kind: 'deny' });
    }
  });
});

describe('guest headers toward the backend (C6)', () => {
  it('drops tunnel, forwarding, identity and x-dc headers and foreign cookies; adds the guest flag and the secret', () => {
    const origin = 'https://calm-river-9.trycloudflare.com';
    const out = guestUpstreamHeaders({
      host: 'calm-river-9.trycloudflare.com', origin, 'cf-connecting-ip': '203.0.113.7', 'cf-ray': 'r', 'cdn-loop': 'cloudflare',
      'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https', forwarded: 'for=1.2.3.4', 'true-client-ip': '1.2.3.4', 'x-real-ip': '1.2.3.4',
      authorization: 'Bearer forged-forged-forged-forged', 'x-dc-gateway-secret': 'forged', 'x-dc-app': 'other', 'x-dc-guest': '0',
      cookie: '__Host-dcs=sess; __Host-dct=tick; dcsabc.sid=1; dc_gw_4000=win; dcappx.sid=2', accept: 'text/html',
    }, { origin, cookiePrefix: 'dcsabc.' }, 5555, 'real-secret');
    for (const k of Object.keys(out)) {
      expect(k.startsWith('cf-') || k.startsWith('x-forwarded-') || ['cdn-loop', 'authorization', 'forwarded', 'true-client-ip', 'x-real-ip', 'x-dc-app'].includes(k), k).toBe(false);
    }
    expect(out.cookie).toBe('sid=1');
    expect(out['x-dc-guest']).toBe('1');
    expect(out['x-dc-gateway-secret']).toBe('real-secret');
    expect(out.host).toBe('127.0.0.1:5555');
    expect(out.origin).toBe('http://127.0.0.1:5555');
    expect(out.accept).toBe('text/html');
  });
});

describe('app guest end to end (C6)', () => {
  it('uses the app, never reaches dreamcontext, and an Authorization header never becomes the backend', async () => {
    const share = await openApp('echo');
    expect(share.state).toBe('open');
    const cookie = await guestSession(share);
    const page = await viaTunnel(share, 'GET', '/', { cookie, accept: 'text/html' });
    expect(page.status).toBe(200);
    expect(page.body).toContain('echo app');

    const echo = await viaTunnel(share, 'GET', '/echo', {
      cookie: `${cookie}; ${share.cookiePrefix}sid=abc; dc_gw_${gw.port}=zzz`, 'x-forwarded-for': '9.9.9.9', authorization: `Bearer ${rt.dcToken}`, 'x-dc-gateway-secret': 'forged',
    });
    expect(echo.status).toBe(200);
    const seen = JSON.parse(echo.body).headers as Record<string, string>;
    expect(seen.cookie).toBe('sid=abc');
    expect(seen['x-dc-guest']).toBe('1');
    expect(seen.authorization).toBeUndefined();
    expect(seen['x-forwarded-for']).toBeUndefined();
    expect(Object.keys(seen).some((k) => k.startsWith('cf-'))).toBe(false);
    const sc = ([] as string[]).concat(echo.headers['set-cookie'] ?? []);
    expect(sc[0]?.startsWith(`${share.cookiePrefix}sid=abc`)).toBe(true);
    expect(sc.join(';')).not.toMatch(/__Host-dc|domain=/i);

    for (const p of ['/__dc/api/tasks', '/__dc/embed/chat', '/__dc/notify', '/__dc/schedules', '/__dc/learn', '/__dc/ask', '/__dc/runner/heartbeat', '/__dc/enter?code=x']) {
      const r = await viaTunnel(share, 'GET', p, { cookie, authorization: `Bearer ${rt.dcToken}` });
      expect(r.status, p).toBe(403);
      expect(JSON.parse(r.body).error, p).toBe('guest_unavailable');
    }
    const write = await viaTunnel(share, 'POST', '/__dc/data/write', { cookie, origin: share.origin!, authorization: `Bearer ${rt.dcToken}`, 'content-type': 'application/json' }, '{"path":"a.json","content":"{}"}');
    expect(write.status).toBe(403);
    expect(JSON.parse(write.body).error).toBe('backend_only');
    expect((await viaTunnel(share, 'GET', '/__dc/sdk.js', { cookie })).status).toBe(200);
    expect(JSON.parse((await viaTunnel(share, 'GET', '/__dc/theme', { cookie })).body)).toEqual({ theme: 'dark' });
    expect((await viaTunnel(share, 'GET', '/__dc/config', { cookie })).status).toBe(200);
    expect((await viaTunnel(share, 'GET', '/__dc/data/status', { cookie })).status).toBe(200);

    // A write needs the share's own Origin.
    expect((await viaTunnel(share, 'POST', '/echo', { cookie }, '{}')).status).toBe(403);
    expect((await viaTunnel(share, 'POST', '/echo', { cookie, origin: 'https://evil.example' }, '{}')).status).toBe(403);
    expect((await viaTunnel(share, 'POST', '/echo', { cookie, origin: share.origin! }, '{}')).status).toBe(200);
    await closeShare(share.id, 'removed');
  }, 30_000);

  it('pipes a guest WebSocket with the secret, and the close cuts it within 1 s', async () => {
    const share = await openApp('echo');
    const cookie = await guestSession(share);
    const { status, sock } = await upgradeViaTunnel(share, '/ws', { cookie });
    expect(status).toBe(101);
    let closed = false;
    sock.once('close', () => { closed = true; });
    const t0 = Date.now();
    await closeShare(share.id, 'owner');
    await waitFor(() => closed, 1000, 'guest socket closed');
    expect(Date.now() - t0).toBeLessThan(1000);
    // During the grace every path answers the closed page and upgrades are refused.
    const after = await viaTunnel(share, 'GET', '/echo', { cookie });
    expect(after.status).toBe(410);
    await closeShare(share.id, 'owner');
  }, 30_000);

  it('a /__dc upgrade from a guest is refused', async () => {
    const share = await openApp('echo');
    const cookie = await guestSession(share);
    const { status, sock } = await upgradeViaTunnel(share, '/__dc/api/x', { cookie });
    expect(status).toBe(404);
    sock.destroy();
    await closeShare(share.id, 'removed');
  }, 30_000);
});

describe('runtime lease and the owner stop (C9)', () => {
  it('holds a lease while shared (the sweep keeps the backend), releases it at close; a stopped app reads Durduruldu', async () => {
    const before = rt.shareLeaseCount();
    const share = await openApp('echo');
    expect(rt.shareLeaseCount()).toBe(before + 1);
    expect(rt.liveWindows()).toBe(0);
    expect(rt.sweep()).toBe(false);
    expect(rt.status().state).toBe('running');

    const cookie = await guestSession(share);
    // The kind reads the record from the registry on every request, as the owner's Stop writes it.
    updateApp(home, rec.projectRoot, rec.slug, { stoppedByOwner: true });
    try {
      const r = await viaTunnel(share, 'GET', '/', { cookie, accept: 'text/html' });
      expect(r.status).toBe(503);
      expect(r.body).toContain('Durduruldu');
    } finally {
      const back = updateApp(home, rec.projectRoot, rec.slug, { stoppedByOwner: false });
      if (back) rt.setRecord(back);
    }
    await closeShare(share.id, 'owner');
    expect(rt.shareLeaseCount()).toBe(before);
    await closeShare(share.id, 'owner');
  }, 30_000);
});

describe('backend narrowing while shared (C10)', () => {
  const backend = () => ({ authorization: `Bearer ${rt.dcToken}`, 'content-type': 'application/json' });
  const writes = () => router.list().filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  const concrete = (p: string) => p.replace(/:[A-Za-z_]+/g, 'zz');
  const bodyFor = (key: string) => (key === 'POST /api/tasks' ? '{"name":"Guest task"}' : key === 'PATCH /api/tasks/:slug' ? '{"priority":"high"}' : '{}');

  /** Every registered dashboard write through the backend's /__dc/api: which reached the dashboard. */
  async function walk(): Promise<Array<{ key: string; status: number; error: string | null; reached: boolean }>> {
    const out: Array<{ key: string; status: number; error: string | null; reached: boolean }> = [];
    for (const r of writes()) {
      const path = concrete(r.path);
      if (deniedForEveryone(path)) continue;
      const m = router.match(r.method, path);
      const key = m ? `${m.method} ${m.path}` : `${r.method} ${r.path}`;
      const n = dashSeen.length;
      const res = await gwReq(gw, { method: r.method, path: `/__dc${path}`, headers: backend(), body: bodyFor(key) });
      out.push({ key, status: res.status, error: res.json?.error ?? null, reached: dashSeen.length > n });
    }
    return out;
  }

  it('names the agent rows and keeps the allow-list closed', () => {
    const keys = new Set(writes().map((r) => `${r.method} ${r.path}`));
    expect(keys.has('POST /api/automations/:slug/run')).toBe(true);
    expect(keys.has('POST /api/automations/questions/:id')).toBe(true);
    expect([...SHARED_BACKEND_WRITES].sort()).toEqual(['PATCH /api/tasks/:slug', 'POST /api/tasks']);
  });

  it('while shared with AI off only the list passes; with AI on all pass; after close all pass', async () => {
    const share = await openApp('echo');
    expect(sharedLive(appShareKey(rec.hash))).toBe(true);
    const off = await walk();
    expect(off.length).toBeGreaterThan(20);
    for (const r of off) {
      if (SHARED_BACKEND_WRITES.has(r.key)) expect(r.reached, r.key).toBe(true);
      else { expect(r.status, r.key).toBe(409); expect(r.error, r.key).toBe('shared_live'); expect(r.reached, r.key).toBe(false); }
    }
    for (const named of ['POST /api/automations/:slug/run', 'POST /api/automations/questions/:id']) {
      expect(off.find((r) => r.key === named)?.error, named).toBe('shared_live');
    }
    // A listed write is rebuilt as for a page: `status` is not the backend's while shared.
    const patch = await gwReq(gw, { method: 'PATCH', path: '/__dc/api/tasks/zz', headers: backend(), body: '{"status":"completed"}' });
    expect(patch.json?.error).toBe('backend_only');
    // The gateway's agent doors, and the two that no switch opens.
    for (const p of ['/__dc/ask', '/__dc/team/say', '/__dc/automations', '/__dc/learn']) {
      const r = await gwReq(gw, { method: 'POST', path: p, headers: backend(), body: '{"text":"hi","member":"ua"}' });
      expect(r.json?.error, p).toBe('shared_live');
    }
    // A poll of a question asked before still answers (not shared_live).
    const poll = await gwReq(gw, { path: '/__dc/ask/00000000-0000-0000-0000-000000000000', headers: { authorization: `Bearer ${rt.dcToken}` } });
    expect(poll.json?.error).not.toBe('shared_live');
    await closeShare(share.id, 'owner');
    // Closing: the gate is down at once (criterion 4: works again at Kapat).
    expect(sharedLive(appShareKey(rec.hash))).toBe(false);
    for (const r of await walk()) expect(r.reached, r.key).toBe(true);
    const learn = await gwReq(gw, { method: 'POST', path: '/__dc/learn', headers: backend(), body: '{"text":"after close"}' });
    expect(learn.status).toBe(200);
    await closeShare(share.id, 'owner');

    const withAi = await openApp('echo', { ai: true });
    for (const r of await walk()) expect(r.reached, r.key).toBe(true);
    for (const p of ['/__dc/ask', '/__dc/team/say']) {
      const r = await gwReq(gw, { method: 'POST', path: p, headers: backend(), body: '{"text":"hi","member":"ua"}' });
      expect(r.json?.error, p).not.toBe('shared_live');
    }
    for (const p of ['/__dc/automations', '/__dc/learn']) {
      const r = await gwReq(gw, { method: 'POST', path: p, headers: backend(), body: '{"text":"hi"}' });
      expect(r.json?.error, p).toBe('shared_live');
    }
    await closeShare(withAi.id, 'removed');
  }, 60_000);
});

// ─── every app removal closes the app's share first ────────────────────────────

function fakeReq(method: string): IncomingMessage {
  const r = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(r, { method, url: '/api/apps/x', headers: { host: '127.0.0.1:4173' }, socket: { remoteAddress: '127.0.0.1' } });
  return r;
}
function fakeRes(): { res: ServerResponse; done: Promise<number> } {
  let resolve!: (s: number) => void;
  const done = new Promise<number>((r) => { resolve = r; });
  let status = 200;
  const res = {
    headersSent: false,
    setHeader: () => {},
    writeHead: (s: number) => { status = s; return res; },
    end: () => resolve(status),
  } as unknown as ServerResponse;
  return { res, done };
}

describe('app removal closes the share (C5 removed)', () => {
  it('retireAppRuntime (uninstall) closes it first', async () => {
    const gone = makeApp('gone-retire');
    const share = await openApp('gone-retire');
    const t0 = Date.now();
    await retireAppRuntime(gone);
    expect(Date.now() - t0).toBeLessThan(2000);
    const s = getShare(share.id);
    expect(s === null || s.state === 'closing').toBe(true);
    expect(sharedLive(appShareKey(gone.hash))).toBe(false);
  }, 30_000);

  it('handleAppDelete closes it first, during a grace too, under 1 s', async () => {
    const gone = makeApp('gone-delete');
    const share = await openApp('gone-delete');
    await closeShare(share.id, 'owner'); // now in its grace
    expect(getShare(share.id)?.state).toBe('closing');
    const again = await openApp('gone-delete');
    const { res, done } = fakeRes();
    const t0 = Date.now();
    await handleAppDelete(fakeReq('DELETE'), res, { slug: 'gone-delete' }, join(project, '_dream_context'));
    expect(await done).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(sharedLive(appShareKey(gone.hash))).toBe(false);
    await waitFor(() => getShare(share.id) === null && getShare(again.id) === null, 3000, 'both shares torn down');
  }, 30_000);
});
