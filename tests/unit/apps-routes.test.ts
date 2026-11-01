import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * `/api/apps/*` through the REAL router and request handler, and the REAL `dreamcontext apps`
 * CLI against it (dreamcontext-apps plan r19, W2 tests): the launch token, the local-desktop
 * gate, `app_not_open`, `app_stopped`, a call that outlives the 30 s socket idle, the vault
 * header the CLI sends, cwd-in-app resolution, and the assistant refusal.
 */

const execFileAsync = promisify(execFile);
const VITE_NODE = resolve('node_modules/.bin/vite-node');
const CLI = resolve('src/cli/index.ts');
const FIXTURE = join(__dirname, '..', 'fixtures', 'apps', 'echo-backend');
const PATH = `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`;

const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };
let home: string;
let project: string;
let server: http.Server;
let port = 0;
const cleanup: string[] = [];

function req(opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; json: any }> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, agent: false, headers: { host: `127.0.0.1:${port}`, 'x-dreamcontext-vault': 'acme', 'content-type': 'application/json', ...(opts.headers ?? {}) } }, (resp) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () => { let json: any = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* text */ } res({ status: resp.statusCode ?? 0, json }); });
    });
    r.on('error', rej);
    r.end(payload);
  });
}

async function cli(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(VITE_NODE, ['--root', resolve('.'), CLI, ...args], { cwd, env: { ...process.env, HOME: home, PATH: process.env.PATH ?? PATH, ...extraEnv }, timeout: 60_000 });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-apps-routes-home-')));
  cleanup.push(home);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'dc-apps-routes-proj-')));
  cleanup.push(parent);
  project = join(parent, 'acme');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  process.env.HOME = home;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  // `acme-link` is the same project reached through a symlink, as macOS's /var is.
  symlinkSync(project, join(parent, 'acme-link'));
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }, { name: 'acme-link', path: join(parent, 'acme-link') }] }));

  const { registerApp } = await import('../../src/lib/apps/registry.js');
  const root = join(`${project}-apps`, 'echo');
  mkdirSync(dirname(root), { recursive: true });
  cpSync(FIXTURE, root, { recursive: true });
  registerApp(home, { projectRoot: project, vault: 'acme', slug: 'echo', name: 'Echo', root });

  const { buildRouter, makeRequestHandler } = await import('../../src/server/index.js');
  const { setAppsHomeForTests } = await import('../../src/server/routes/apps.js');
  const { configureGateways } = await import('../../src/server/apps/gateway.js');
  setAppsHomeForTests(home);
  const router = buildRouter();
  server = http.createServer(makeRequestHandler({ gate: () => true, router, dashboardDir: home, contextRoot: null }));
  // A short idle timeout proves the long routes lift it on their own socket (holdOpen).
  server.setTimeout(1000);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  configureGateways({ home, dashboardPort: port, router });
  // desktop-server.json, as the shell's child would write it.
  writeFileSync(join(home, '.dreamcontext', 'desktop-server.json'), JSON.stringify({ schema: 1, pid: process.pid, port, launchToken: 'L'.repeat(43), appBundleId: 'com.dreamcontext.beta' }), { mode: 0o600 });
  const { __setLaunchTokenForTest } = await import('../../src/server/desktop-server-file.js');
  __setLaunchTokenForTest('L'.repeat(43));
  // The backend inherits the server's login PATH: make sure node is on it.
  process.env.PATH = `${PATH}:${process.env.PATH ?? ''}`;
}, 60_000);

afterAll(async () => {
  const { stopAllRuntimes } = await import('../../src/lib/apps/supervisor.js');
  const { closeAllGateways } = await import('../../src/server/apps/gateway.js');
  stopAllRuntimes();
  await closeAllGateways();
  await new Promise<void>((r) => server.close(() => r()));
  process.env.HOME = saved.HOME;
  if (saved.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved.DESKTOP;
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

describe('/api/apps', () => {
  it('lists this project\'s apps', async () => {
    const r = await req({ path: '/api/apps' });
    expect(r.status).toBe(200);
    expect(r.json.apps.map((a: { slug: string }) => a.slug)).toEqual(['echo']);
    expect(r.json.apps[0].actions[0]).toMatchObject({ id: 'leak' });
  });

  it('a bare app link, or a spent nonce, lands on the card and spawns nothing', async () => {
    const list = () => req({ path: '/api/apps' }).then((r) => r.json.apps.find((a: { slug: string }) => a.slug === 'echo'));
    const before = await list();
    for (const body of [{ link: true }, { link: true, nonce: 'a'.repeat(43) }]) {
      const r = await req({ method: 'POST', path: '/api/apps/echo/launch', body });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: true, landed: 'card' });
    }
    expect((await list()).state).toBe(before.state);
  });

  it('launch-window needs the launch token, is vault-agnostic, and answers an enter url + runner token', async () => {
    const body = { projectRoot: project, slug: 'echo' };
    expect((await req({ method: 'POST', path: '/api/apps/launch-window', headers: { 'x-dreamcontext-vault': '' }, body })).status).toBe(401);
    expect((await req({ method: 'POST', path: '/api/apps/launch-window', headers: { authorization: `Bearer ${'M'.repeat(43)}` }, body })).status).toBe(401);
    const ok = await req({ method: 'POST', path: '/api/apps/launch-window', headers: { authorization: `Bearer ${'L'.repeat(43)}` }, body });
    expect(ok.status).toBe(200);
    expect(ok.json.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__dc\/enter\?code=[A-Za-z0-9_-]+$/);
    expect(ok.json.runnerToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(ok.json.state).toBe('running');
    expect(JSON.stringify(ok.json)).not.toMatch(/DC_TOKEN|gatewaySecret/);
    expect((await req({ method: 'POST', path: '/api/apps/launch-window', headers: { authorization: `Bearer ${'L'.repeat(43)}` }, body: { projectRoot: project, slug: 'nope' } })).status).toBe(404);
  }, 40_000);

  it('refuses outside the desktop app and under a foreign Host', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect((await req({ path: '/api/apps/running' })).status).toBe(403);
    process.env.DREAMCONTEXT_DESKTOP = '1';
    expect((await req({ path: '/api/apps/running', headers: { host: 'evil.test' } })).status).toBe(403);
    expect((await req({ path: '/api/apps/running' })).json).toEqual({ count: 0 });
  });

  it('a snapshot without an open window is app_not_open (and opens nothing)', async () => {
    const r = await req({ method: 'POST', path: '/api/apps/echo/snapshot', body: {} });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('app_not_open');
    expect(r.json.message).toContain('apps open echo');
  });

  it('call: runs without a window, outlives the socket idle, scrubs the answer; refuses unsafe paths', async () => {
    const slow = await req({ method: 'POST', path: '/api/apps/echo/call', body: { method: 'GET', path: '/slow?ms=1800' } });
    expect(slow.status).toBe(200);
    expect(slow.json.body).toBe('slow done');
    const leak = await req({ method: 'POST', path: '/api/apps/echo/call', body: { method: 'GET', path: '/leak' } });
    expect(leak.status).toBe(200);
    expect(leak.json.body).not.toMatch(/"token":"[A-Za-z0-9_-]{20,}"/);
    expect((await req({ method: 'POST', path: '/api/apps/echo/call', body: { method: 'GET', path: '/.//evil.com' } })).json.error).toBe('bad_path');
    expect((await req({ method: 'POST', path: '/api/apps/echo/call', body: { method: 'TRACE', path: '/x' } })).json.error).toBe('bad_method');
  }, 40_000);

  it('owner stop sticks: call answers app_stopped and does not revive the backend', async () => {
    expect((await req({ method: 'POST', path: '/api/apps/echo/stop', body: {} })).status).toBe(200);
    const r = await req({ method: 'POST', path: '/api/apps/echo/call', body: { method: 'GET', path: '/health' } });
    expect(r.json.error).toBe('app_stopped');
    expect(r.json.message).toContain('apps open echo');
    const st = await req({ path: '/api/apps/echo/status' });
    expect(st.json).toMatchObject({ state: 'stopped', stoppedByOwner: true });
    const { updateApp } = await import('../../src/lib/apps/registry.js');
    updateApp(home, project, 'echo', { stoppedByOwner: false });
  });
});

describe('dreamcontext apps (the real CLI against the real router)', () => {
  it('resolves the project from inside the app folder and sends the vault header', async () => {
    const r = await cli(['apps', 'list', '--json'], join(`${project}-apps`, 'echo'));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.slice(r.out.indexOf('['))).map((a: { slug: string }) => a.slug)).toEqual(['echo']);
  }, 90_000);

  it('actions lists the manifest; do runs one through the call route, fenced, without a window', async () => {
    const a = await cli(['apps', 'actions', 'echo'], project);
    expect(a.out).toMatch(/leak\s+GET \/leak/);
    expect(a.out).toMatch(/<<<app-output actions nonce=[0-9a-f]{12}/);
    const d = await cli(['apps', 'do', 'echo', 'leak'], project);
    expect(d.code).toBe(0);
    expect(d.out).toMatch(/<<<app-output do leak status=200 nonce=/);
    const bad = await cli(['apps', 'do', 'echo', 'not-there'], project);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('unknown_action');
  }, 120_000);

  it('screenshot of an app with no window is app_not_open', async () => {
    const r = await cli(['apps', 'screenshot', 'echo'], project);
    expect(r.code).toBe(1);
    expect(r.out).toContain('app_not_open');
  }, 90_000);

  it('every apps verb refuses inside the dreamcontext Assistant', async () => {
    for (const args of [['apps', 'list'], ['apps', 'actions', 'echo']]) {
      const r = await cli(args, project, { DREAMCONTEXT_ASSISTANT_URL: 'garbage' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('use_assistant_verb');
    }
  }, 120_000);

  it('outside any project: project_not_found, never "run dreamcontext init"', async () => {
    const r = await cli(['apps', 'list'], home);
    expect(r.code).toBe(1);
    expect(r.out).toContain('project_not_found');
    expect(r.out).not.toContain('dreamcontext init');
  }, 90_000);
});

describe('the embedded chat', () => {
  it('a vault reached through a symlink still matches its embed grant (no 403)', async () => {
    const { mintEmbedToken } = await import('../../src/server/apps/embed-token.js');
    const tk = mintEmbedToken({ slug: 'echo', vault: 'acme-link', projectRoot: project, gwPort: 1 });
    const headers = { 'x-dreamcontext-vault': 'acme-link', 'x-dc-embed': tk, origin: `http://127.0.0.1:${port}` };
    const r = await req({ method: 'POST', path: '/api/apps/echo/say', headers, body: { member: 'nobody', text: 'hi' } });
    expect(r.json?.error).not.toBe('forbidden');
    const other = await req({ method: 'POST', path: '/api/apps/echo/say', headers: { ...headers, 'x-dc-embed': 'x'.repeat(43) }, body: { member: 'nobody', text: 'hi' } });
    expect(other.status).toBe(403);
  });
});
