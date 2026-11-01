import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerApp, type AppRecord } from '../../src/lib/apps/registry.js';
import { runtimeFor, stopAllRuntimes, type AppRuntime } from '../../src/lib/apps/supervisor.js';
import { closeAllGateways, configureGateways, gatewayFor, type AppGateway } from '../../src/server/apps/gateway.js';
import { MASK } from '../../src/lib/apps/redact.js';

/**
 * The gateway + supervisor end to end, with a real backend process (tests/fixtures/apps/
 * echo-backend) and a stand-in dashboard (dreamcontext-apps plan r19, W2 tests).
 */

const FIXTURE = join(__dirname, '..', 'fixtures', 'apps', 'echo-backend');
const PATH = `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`;
const cleanup: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); cleanup.push(d); return d; };

interface Res { status: number; headers: http.IncomingHttpHeaders; text: string; json: any }
function req(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) }, agent: false }, (res) => {
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
const dashSeen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

function makeApp(slug: string, env = ''): AppRecord {
  const root = join(`${project}-apps`, slug);
  mkdirSync(dirname(root), { recursive: true });
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug, name: `App ${slug}`, backend: { command: 'node server.mjs', health: '/health' }, actions: [{ id: 'leak', title: 'Leak', method: 'GET', path: '/leak' }] }));
  if (env) writeFileSync(join(root, '.env'), env);
  return registerApp(home, { projectRoot: project, vault: 'acme', slug, name: `App ${slug}`, root });
}
const rt = (rec: AppRecord): AppRuntime => runtimeFor(rec, { home, loginPath: async () => PATH, noWatch: true });

beforeAll(async () => {
  home = tmp('dc-gw-home-');
  project = join(tmp('dc-gw-proj-'), 'acme');
  mkdirSync(project);
  dash = http.createServer((q, s) => {
    const chunks: Buffer[] = [];
    q.on('data', (c: Buffer) => chunks.push(c));
    q.on('end', () => {
      dashSeen.push({ method: q.method ?? '', url: q.url ?? '', headers: q.headers, body: Buffer.concat(chunks).toString() });
      s.writeHead(200, { 'content-type': 'application/json' });
      // The real shapes: handleAgentsList and handleAutomationsRunStatus.
      if (q.url === '/api/agents') s.end(JSON.stringify({ agents: [{ slug: 'ua', title: 'UA', hasPhoto: false, roleLine: 'r', approvedForChat: true, approvedToRun: false, instructions: 'SECRET PROMPT' }] }));
      else if (q.url === '/api/automations/runs') s.end(JSON.stringify({ job: { id: 'j', slug: 'ua', status: 'success', startedAt: 1, finishedAt: 2, runId: 'r1', error: null, outcome: { result: 'SECRET ANSWER', outputPath: '/Users/x/out.md', sessionId: 's' }, override: null } }));
      else s.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => dash.listen(0, '127.0.0.1', () => r()));
  dashPort = (dash.address() as { port: number }).port;
  const { buildRouter } = await import('../../src/server/index.js');
  configureGateways({ home, dashboardPort: dashPort, router: buildRouter(), theme: () => 'dark' });
}, 60_000);

afterAll(async () => {
  stopAllRuntimes();
  await closeAllGateways();
  await new Promise<void>((r) => dash.close(() => r()));
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

async function enter(gw: AppGateway): Promise<string> {
  const r = await req(gw.port, { path: `/__dc/enter?code=${gw.mintEnterCode()}` });
  expect(r.status).toBe(302);
  return String(r.headers['set-cookie']).split(';')[0];
}

describe('gateway', () => {
  let a: AppRuntime;
  let gw: AppGateway;
  let cookie: string;

  beforeAll(async () => {
    a = rt(makeApp('alpha', 'API_KEY_FOR_TEST=graph-secret-123456\n'));
    gw = await gatewayFor(a);
    await a.ensureRunning();
    expect(a.status()).toMatchObject({ state: 'running' });
    cookie = await enter(gw);
  }, 60_000);

  it('serves only its own Host; nothing without an identity; cf headers refused', async () => {
    expect((await req(gw.port, { path: '/', headers: { host: 'evil.test:80' } })).status).toBe(421);
    expect((await req(gw.port, { path: '/' })).status).toBe(401);
    expect((await req(gw.port, { path: '/', headers: { cookie, 'cf-ray': 'x' } })).status).toBe(403);
  });

  it('the enter code is single-use and sets an HttpOnly SameSite=Strict cookie', async () => {
    const code = gw.mintEnterCode();
    const r1 = await req(gw.port, { path: `/__dc/enter?code=${code}` });
    expect(String(r1.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    expect(r1.headers['cache-control']).toBe('no-store');
    expect((await req(gw.port, { path: `/__dc/enter?code=${code}` })).status).toBe(403);
  });

  it('proxies the page to the backend with the gateway secret and this app\'s cookies only', async () => {
    const r = await req(gw.port, { path: '/echo', headers: { cookie: `${cookie}; dcappffffffffffffffff.sid=other; plain=1`, 'x-dc-gateway-secret': 'forged' } });
    expect(r.status).toBe(200);
    expect(r.json.headers['x-dc-gateway-secret']).toBe(a.gatewaySecret);
    expect(r.json.headers.cookie).toBeUndefined();
    expect(String(r.headers['set-cookie'])).toContain(`dcapp${a.hash}.sid=abc`);
    const r2 = await req(gw.port, { path: '/echo', headers: { cookie: `${cookie}; dcapp${a.hash}.sid=abc` } });
    expect(r2.json.headers.cookie).toBe('sid=abc');
  });

  it('origin rules: cookie writes need our origin, Bearer must carry none', async () => {
    expect((await req(gw.port, { method: 'POST', path: '/echo', headers: { cookie } })).status).toBe(403);
    expect((await req(gw.port, { method: 'POST', path: '/echo', headers: { cookie, origin: 'null' } })).status).toBe(403);
    expect((await req(gw.port, { method: 'POST', path: '/echo', headers: { cookie, origin: gw.origin } })).status).toBe(200);
    expect((await req(gw.port, { method: 'GET', path: '/__dc/theme', headers: { authorization: `Bearer ${a.dcToken}`, origin: gw.origin } })).status).toBe(403);
    expect((await req(gw.port, { method: 'GET', path: '/__dc/theme', headers: { authorization: `Bearer ${a.dcToken}` } })).json).toEqual({ theme: 'dark' });
  });

  it('token classes do not cross: runner token only on /__dc/runner, DC_TOKEN never there', async () => {
    const runner = gw.mintRunnerToken();
    expect((await req(gw.port, { method: 'POST', path: '/__dc/runner/heartbeat', headers: { authorization: `Bearer ${a.dcToken}` } })).status).toBe(401);
    expect((await req(gw.port, { path: '/echo', headers: { authorization: `Bearer ${runner}` } })).status).toBe(401);
    const hb = await req(gw.port, { method: 'POST', path: '/__dc/runner/heartbeat', headers: { authorization: `Bearer ${runner}` } });
    expect(hb.json).toMatchObject({ rev: 1, theme: 'dark', state: 'running', lastError: null });
    expect(a.liveWindows()).toBe(1);
  });

  it('/__dc/api: the page reaches only PAGE_ROUTES, narrowed; Origin dropped, vault pinned', async () => {
    dashSeen.length = 0;
    const ok = await req(gw.port, { path: '/__dc/api/tasks', headers: { cookie, 'x-dreamcontext-vault': 'other' } });
    expect(ok.status).toBe(200);
    const seen = dashSeen.at(-1)!;
    expect(seen.headers['x-dreamcontext-vault']).toBe('acme');
    expect(seen.headers.origin).toBeUndefined();
    expect(seen.headers['x-dc-app']).toBe('alpha');
    const agents = await req(gw.port, { path: '/__dc/api/agents', headers: { cookie } });
    expect(agents.json.agents[0]).toEqual({ slug: 'ua', title: 'UA', hasPhoto: false, roleLine: 'r', approvedForChat: true, approvedToRun: false });
    const runs = await req(gw.port, { path: '/__dc/api/automations/runs', headers: { cookie } });
    expect(runs.json).toEqual({ job: { status: 'success', startedAt: 1, finishedAt: 2, runId: 'r1' } });
    expect((await req(gw.port, { method: 'POST', path: '/__dc/api/automations/threads/say', headers: { cookie, origin: gw.origin } })).status).toBe(403);
    expect((await req(gw.port, { method: 'POST', path: '/__dc/api/automations/threads/say', headers: { authorization: `Bearer ${a.dcToken}` } })).status).toBe(403);
    expect((await req(gw.port, { method: 'POST', path: '/__dc/api/automations/ua/run', headers: { cookie, origin: gw.origin } })).json.error).toBe('backend_only');
    const patch = await req(gw.port, { method: 'PATCH', path: '/__dc/api/tasks/x', headers: { cookie, origin: gw.origin, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
    expect(patch.json.error).toBe('backend_only');
    dashSeen.length = 0;
    const post = await req(gw.port, { method: 'POST', path: '/__dc/api/tasks', headers: { cookie, origin: gw.origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'n', priority: 'high' }) });
    expect(post.status).toBe(200);
    expect(JSON.parse(dashSeen.at(-1)!.body)).toEqual({ name: 'n', priority: 'high', by: 'agent' });
    expect((await req(gw.port, { method: 'POST', path: '/__dc/api/tasks', headers: { cookie, origin: gw.origin }, body: JSON.stringify({ name: 'n', by: 'human' }) })).status).toBe(403);
    expect((await req(gw.port, { path: '/__dc/api/tasks/%zz', headers: { cookie } })).status).toBe(400);
    // The backend has the API in full.
    expect((await req(gw.port, { method: 'POST', path: '/__dc/api/automations/ua/run', headers: { authorization: `Bearer ${a.dcToken}` } })).status).toBe(200);
  });

  it('asking an agent and making an automation are the backend\'s; a page gets backend_only', async () => {
    for (const path of ['/__dc/team/say', '/__dc/automations']) {
      const r = await req(gw.port, { method: 'POST', path, headers: { cookie, origin: gw.origin, 'content-type': 'application/json' }, body: '{}' });
      expect(r.status, path).toBe(403);
      expect(r.json.error, path).toBe('backend_only');
    }
  });

  it('the embed redirect is the page\'s, carries a token only in its Location, and names known views', async () => {
    expect((await req(gw.port, { path: '/__dc/embed/tasks', headers: { authorization: `Bearer ${a.dcToken}` } })).status).toBe(403);
    expect((await req(gw.port, { path: '/__dc/embed/secrets', headers: { cookie } })).status).toBe(404);
    const r = await req(gw.port, { path: '/__dc/embed/chat?member=ua&evil=1', headers: { cookie } });
    expect(r.status).toBe(302);
    const to = new URL(String(r.headers.location));
    expect(to.origin).toBe(`http://127.0.0.1:${dashPort}`);
    expect(to.searchParams.get('embed')).toBe('chat');
    expect(to.searchParams.get('member')).toBe('ua');
    expect(to.searchParams.get('evil')).toBeNull();
    expect(to.searchParams.get('tk')).toHaveLength(43);
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    const bad = await req(gw.port, { path: '/__dc/embed/chat?member=../x', headers: { cookie } });
    expect(new URL(String(bad.headers.location)).searchParams.get('member')).toBeNull();
  });

  it('WebSocket upgrades: cookie + our Origin are piped with the secret; no Origin, no identity or a runner token are refused', async () => {
    const { connect } = await import('node:net');
    const upgrade = (headers: Record<string, string>) => new Promise<string>((resolve) => {
      const s = connect(gw.port, '127.0.0.1', () => {
        const lines = ['GET /ws HTTP/1.1', `Host: 127.0.0.1:${gw.port}`, 'Upgrade: websocket', 'Connection: Upgrade', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
        s.write(lines.join('\r\n') + '\r\n\r\n');
        setTimeout(() => s.write('ping'), 200);
      });
      let got = '';
      s.on('data', (d) => { got += d.toString(); });
      setTimeout(() => { s.destroy(); resolve(got); }, 700);
      s.on('error', () => resolve(got));
    });
    const ok = await upgrade({ cookie, origin: gw.origin });
    expect(ok).toMatch(/^HTTP\/1\.1 101/);
    expect(ok).toContain('X-Saw-Secret: yes');
    expect(ok).toContain(`X-Saw-Origin: http://127.0.0.1:${a.backend!.port}`);
    expect(ok).toContain('ping');
    expect(await upgrade({ cookie })).toMatch(/^HTTP\/1\.1 403/);
    expect(await upgrade({ origin: gw.origin })).toMatch(/^HTTP\/1\.1 401/);
    expect(await upgrade({ authorization: `Bearer ${gw.mintRunnerToken()}` })).toMatch(/^HTTP\/1\.1 401/);
    expect(await upgrade({ cookie, origin: gw.origin, 'cf-ray': 'x' })).toMatch(/^HTTP\/1\.1 403/);
  });

  it('status and heartbeat never carry a secret, even from lastError', async () => {
    const runner = gw.mintRunnerToken();
    a.lastError = `backend said token=${a.dcToken} and https://g.example/x?access_token=EAABsecret&after=1 graph-secret-123456`;
    const hb = await req(gw.port, { method: 'POST', path: '/__dc/runner/heartbeat', headers: { authorization: `Bearer ${runner}` } });
    const st = JSON.stringify(a.status());
    for (const text of [hb.text, st]) {
      expect(text).not.toContain(a.dcToken);
      expect(text).not.toContain('EAABsecret');
      expect(text).not.toContain('graph-secret-123456');
    }
    a.lastError = null;
  });

  it('logs and answers are scrubbed of DC_TOKEN, .env values and query tokens', async () => {
    const r = await req(gw.port, { path: '/leak', headers: { cookie } });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 100));
    const tail = a.log.tail().join('\n');
    expect(tail).not.toContain(a.dcToken);
    expect(tail).not.toContain('graph-secret-123456');
    expect(a.scrub(r.text)).not.toContain('graph-secret-123456');
    expect(a.scrub(r.text)).toContain(MASK);
  });

  it('a snapshot request rides the next heartbeat and lands as a 0600 PNG under the app hash', async () => {
    const runner = gw.mintRunnerToken();
    const pending = gw.requestSnapshot();
    const hb = await req(gw.port, { method: 'POST', path: '/__dc/runner/heartbeat', headers: { authorization: `Bearer ${runner}` } });
    const id = hb.json.command.id;
    expect(hb.json.command.type).toBe('snapshot');
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);
    const up = await req(gw.port, { method: 'POST', path: `/__dc/runner/snapshot/${id}`, headers: { authorization: `Bearer ${runner}`, 'content-type': 'image/png' }, body: png as unknown as string });
    expect(up.status).toBe(200);
    const result = await pending;
    expect('file' in result && result.file).toContain(a.hash);
    expect((await req(gw.port, { method: 'POST', path: `/__dc/runner/snapshot/${id}`, headers: { authorization: `Bearer ${runner}` } })).status).toBe(404);
  });

  it('owner stop: the heartbeat says stopped and does not revive; start clears it', async () => {
    const { updateApp } = await import('../../src/lib/apps/registry.js');
    const runner = gw.mintRunnerToken();
    a.setRecord(updateApp(home, a.rec.projectRoot, a.rec.slug, { stoppedByOwner: true })!);
    a.stop();
    const hb = await req(gw.port, { method: 'POST', path: '/__dc/runner/heartbeat', headers: { authorization: `Bearer ${runner}` } });
    expect(hb.json.state).toBe('stopped');
    await new Promise((r) => setTimeout(r, 300));
    expect(a.state).toBe('stopped');
    await req(gw.port, { method: 'POST', path: '/__dc/runner/start', headers: { authorization: `Bearer ${runner}` } });
    await a.ensureRunning();
    expect(a.state).toBe('running');
    expect(a.rec.stoppedByOwner).toBeUndefined();
  }, 30_000);

  it('another app\'s cookie never reaches this backend', async () => {
    const b = rt(makeApp('beta'));
    const gwb = await gatewayFor(b);
    await b.ensureRunning();
    const cb = await enter(gwb);
    const r = await req(gwb.port, { path: '/echo', headers: { cookie: `${cb}; ${cookie}; dcapp${a.hash}.sid=abc` } });
    expect(r.json.headers.cookie).toBeUndefined();
    // and A's window cookie is no identity at B
    expect((await req(gwb.port, { path: '/echo', headers: { cookie: cookie.replace(`dc_gw_${gw.port}`, `dc_gw_${gwb.port}`) } })).status).toBe(401);
  }, 60_000);
});

describe('supervisor checks', () => {
  it('a backend bound to all interfaces is an error ("bind to 127.0.0.1")', async () => {
    const r = rt(makeApp('wide', 'BIND_ALL=1\n'));
    await gatewayFor(r);
    await r.ensureRunning();
    expect(r.state).toBe('error');
    expect(r.lastError).toMatch(/127\.0\.0\.1/);
  }, 30_000);

  it('a backend without dcGuard is an error; unguarded:true makes it a warning', async () => {
    const r = rt(makeApp('open', 'UNGUARDED=1\n'));
    await gatewayFor(r);
    await r.ensureRunning();
    expect(r.state).toBe('error');
    expect(r.lastError).toMatch(/dcGuard/);
    const rec = makeApp('open2', 'UNGUARDED=1\n');
    writeFileSync(join(rec.root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'open2', name: 'O', backend: { command: 'node server.mjs', health: '/health', unguarded: true } }));
    const r2 = rt(rec);
    await gatewayFor(r2);
    await r2.ensureRunning();
    expect(r2.state).toBe('running');
    expect(r2.status().warnings.join(' ')).toMatch(/dcGuard/);
  }, 40_000);

  it('a broken update keeps the running version; a good one bumps rev', async () => {
    const rec = makeApp('roll');
    const r = rt(rec);
    await gatewayFor(r);
    await r.ensureRunning();
    const port1 = r.backend!.port;
    writeFileSync(join(rec.root, '.env'), 'EXIT_EARLY=1\n');
    await r.update();
    expect(r.state).toBe('running');
    expect(r.backend!.port).toBe(port1);
    expect(r.rev).toBe(1);
    expect(r.lastError).toMatch(/running version stays/);
    writeFileSync(join(rec.root, '.env'), '');
    await r.update();
    expect(r.rev).toBe(2);
    expect(r.backend!.port).not.toBe(port1);
  }, 60_000);

  it('the backend env is an allow-list: a login-shell secret does not reach it; .env cannot override DC_*', async () => {
    process.env.GH_TOKEN_FOR_APPS_TEST = 'should-not-leak';
    const rec = makeApp('envy', 'DC_TOKEN=evil\nHOST=0.0.0.0\nMY_SETTING=ok\n');
    const r = rt(rec);
    const gwe = await gatewayFor(r);
    await r.ensureRunning();
    const c = await enter(gwe);
    const env = (await req(gwe.port, { path: '/env', headers: { cookie: c } })).json;
    expect(env.GH_TOKEN_FOR_APPS_TEST).toBeUndefined();
    expect(env.DC_TOKEN).toBe(r.dcToken);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.MY_SETTING).toBe('ok');
    expect(env.DC_DATA_DIR).toContain(r.hash);
    delete process.env.GH_TOKEN_FOR_APPS_TEST;
  }, 30_000);

  it('leases: no window and no call stops the backend; a call lease keeps it', async () => {
    let now = 1_000_000;
    const rec = makeApp('lease');
    const r = runtimeFor(rec, { home, loginPath: async () => PATH, noWatch: true, now: () => now });
    await gatewayFor(r);
    await r.ensureRunning();
    r.heartbeat('t');
    now += 10_000;
    expect(r.sweep()).toBe(false);
    const release = r.acquireCall();
    now += 25_000;
    expect(r.sweep()).toBe(false);
    release();
    now += 5_000;
    expect(r.sweep()).toBe(true);
    expect(r.state).toBe('stopped');
  }, 30_000);

  it('a window being opened holds the backend until its first heartbeat, and counts as no window', async () => {
    let now = 3_000_000;
    const r = runtimeFor(makeApp('launchhold'), { home, loginPath: async () => PATH, noWatch: true, now: () => now });
    await gatewayFor(r);
    await r.ensureRunning();
    r.holdForLaunch();
    now += 5_000;
    expect(r.liveWindows()).toBe(0);
    expect(r.sweep()).toBe(false);
    now += 30_000;
    expect(r.sweep()).toBe(true);
  }, 30_000);

  it('a held call lease is never aged out: a long action is not stopped mid-way', async () => {
    let now = 2_000_000;
    const r = runtimeFor(makeApp('longcall'), { home, loginPath: async () => PATH, noWatch: true, now: () => now });
    await gatewayFor(r);
    await r.ensureRunning();
    const release = r.acquireCall();
    for (let i = 0; i < 80; i++) { now += 5_000; expect(r.sweep()).toBe(false); }
    expect(r.backend).not.toBeNull();
    release();
    now += 5_000;
    expect(r.sweep()).toBe(true);
  }, 30_000);

  it('an owner Stop during the build is not undone when the start finishes', async () => {
    const rec = makeApp('slowstart');
    writeFileSync(join(rec.root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'slowstart', name: 'S', build: 'sleep 1', backend: { command: 'node server.mjs', health: '/health' } }));
    const r = rt(rec);
    await gatewayFor(r);
    const started = r.ensureRunning();
    await new Promise((res) => setTimeout(res, 300));
    expect(r.state).toBe('starting');
    r.stop();
    await started;
    expect(r.state).toBe('stopped');
    expect(r.backend).toBeNull();
  }, 30_000);

  it('a Start right after a Stop starts afresh, not the cancelled start', async () => {
    const rec = makeApp('restart');
    writeFileSync(join(rec.root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'restart', name: 'R', build: 'sleep 1', backend: { command: 'node server.mjs', health: '/health' } }));
    const r = rt(rec);
    await gatewayFor(r);
    const first = r.ensureRunning();
    await new Promise((res) => setTimeout(res, 300));
    r.stop();
    await r.ensureRunning();
    await first;
    expect(r.state).toBe('running');
    expect(r.backend).not.toBeNull();
    expect(r.lastError).toBeNull();
  }, 30_000);

  it('a Stop while a start waits for an update wins: nothing starts afterwards', async () => {
    const rec = makeApp('stopwait');
    writeFileSync(join(rec.root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'stopwait', name: 'W', build: 'sleep 1', backend: { command: 'node server.mjs', health: '/health' } }));
    const r = rt(rec);
    await gatewayFor(r);
    await r.ensureRunning();
    r.state = 'error';
    const up = r.update();
    const waiting = r.ensureRunning();
    await new Promise((res) => setTimeout(res, 300));
    r.stop();
    await Promise.all([up, waiting]);
    expect(r.state).toBe('stopped');
    expect(r.backend).toBeNull();
  }, 30_000);

  it('a start asked for while an update runs waits for it: one backend, never two', async () => {
    const rec = makeApp('racer');
    writeFileSync(join(rec.root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'racer', name: 'R', build: 'sleep 1', backend: { command: 'node server.mjs', health: '/health' } }));
    const r = rt(rec);
    await gatewayFor(r);
    await r.ensureRunning();
    const old = r.backend!;
    r.state = 'error';
    const up = r.update();
    const start = r.ensureRunning();
    await Promise.all([up, start]);
    expect(r.state).toBe('running');
    expect(r.backend).not.toBe(old);
    // The replaced backend is gone; only the tracked one answers.
    await new Promise((res) => setTimeout(res, 2500));
    expect(old.child.exitCode !== null || old.child.signalCode !== null).toBe(true);
  }, 40_000);

  it('the sweep stops a backend the owner stopped, even while a window keeps its lease', async () => {
    const rec = makeApp('ownerstop');
    const r = rt(rec);
    await gatewayFor(r);
    await r.ensureRunning();
    r.heartbeat('w');
    expect(r.sweep()).toBe(false);
    r.setRecord({ ...r.rec, stoppedByOwner: true });
    expect(r.sweep()).toBe(true);
    expect(r.backend).toBeNull();
    expect(r.liveWindows()).toBe(1);
  }, 30_000);
});
