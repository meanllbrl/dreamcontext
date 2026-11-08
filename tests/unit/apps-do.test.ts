import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { registerApp } from '../../src/lib/apps/registry.js';
import { appOutDir, pruneAppOut, writeAppOut } from '../../src/lib/apps/out-files.js';

/**
 * `apps do` / `apps call` end to end (app-araclari plan r3 §4.3): the REAL CLI against the REAL
 * router and gate. A change without --confirm never reaches the app; the input is checked before
 * any call; a big answer goes to a private file; a change with no answer says `unknown` and is
 * not repeated; the owner's Stop still wins.
 */

const execFileAsync = promisify(execFile);
/** The BUILT CLI (`npm run build:cli`): vite-node transpiled src/ on every one of ~20 spawns (~8 s CPU each). */
const CLI = resolve('dist/index.js');
const FIXTURE = join(__dirname, '..', 'fixtures', 'apps', 'echo-backend');
const PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin', '/usr/sbin'])].join(delimiter);

const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };
let home: string;
let project: string;
let server: http.Server;
let port = 0;
const cleanup: string[] = [];

const MANIFEST = {
  slug: 'echo', name: 'Echo App',
  backend: { command: 'node server.mjs', health: '/health' },
  actions: [
    { id: 'leak', title: 'Return the leak body', method: 'GET', path: '/leak' },
    { id: 'big', title: 'A big answer', method: 'GET', path: '/big', params: { n: { type: 'number' } } },
    { id: 'hits', title: 'How many hits', method: 'GET', path: '/hits' },
    { id: 'hit', title: 'Count one hit', method: 'POST', path: '/hit', does: 'Adds one to the counter.', params: { note: { type: 'string', required: true }, mode: { type: 'enum', choices: ['a', 'b'] } } },
    { id: 'slow-change', title: 'A change that hangs', method: 'POST', path: '/slow?ms=9000', timeoutSec: 5 },
  ],
};

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

/** The CLI with a clean env: none of this session's own markers (a test runner may carry them). */
async function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: process.env.PATH ?? PATH, ...extraEnv };
  for (const k of ['DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_SUPER_CREW', 'DREAMCONTEXT_MEMBER_CREW', 'DREAMCONTEXT_AGENT_CHAT', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTOMATION_SLUG', 'DREAMCONTEXT_AUTO_SLEEP', 'DREAMCONTEXT_ASK_DEPTH', 'DREAMCONTEXT_TAB_SESSION', 'CLAUDE_CODE_SESSION_ID']) {
    if (!(k in extraEnv)) delete env[k];
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: project, env, timeout: 90_000 });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

async function hits(): Promise<number> {
  const r = await req({ method: 'POST', path: '/api/apps/echo/call', body: { method: 'GET', path: '/hits' } });
  return JSON.parse(r.json.body).hits as number;
}

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('dist/index.js is missing: run npm run build:cli first');
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-apps-do-home-')));
  cleanup.push(home);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'dc-apps-do-proj-')));
  cleanup.push(parent);
  project = join(parent, 'acme');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  process.env.HOME = home;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: project }] }));
  const root = join(`${project}-apps`, 'echo');
  mkdirSync(dirname(root), { recursive: true });
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify(MANIFEST));
  registerApp(home, { projectRoot: project, vault: 'acme', slug: 'echo', name: 'Echo', root });

  const { buildRouter, makeRequestHandler } = await import('../../src/server/index.js');
  const { setAppsHomeForTests } = await import('../../src/server/routes/apps.js');
  const { configureGateways } = await import('../../src/server/apps/gateway.js');
  setAppsHomeForTests(home);
  const router = buildRouter();
  server = http.createServer(makeRequestHandler({ gate: () => true, router, dashboardDir: home, contextRoot: null }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  configureGateways({ home, dashboardPort: port, router });
  writeFileSync(join(home, '.dreamcontext', 'desktop-server.json'), JSON.stringify({ schema: 1, pid: process.pid, port, launchToken: 'L'.repeat(43), appBundleId: 'com.dreamcontext.beta' }), { mode: 0o600 });
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

describe('the call route is the one door', () => {
  it('a raw loopback POST that changes, with no confirm, is 409 and the app never hears it', async () => {
    const before = await hits();
    const r = await req({ method: 'POST', path: '/api/apps/echo/call', body: { method: 'POST', path: '/hit' } });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'needs_confirm', tool: { id: 'hit', does: 'Adds one to the counter.' } });
    expect(await hits()).toBe(before);
    const spawned = await req({ method: 'POST', path: '/api/apps/echo/call', headers: { 'x-dc-run': '{"class":"spawned"}' }, body: { method: 'POST', path: '/hit', confirm: true } });
    expect(spawned).toMatchObject({ status: 403, json: { error: 'needs_owner' } });
    const garbage = await req({ method: 'POST', path: '/api/apps/echo/call', headers: { 'x-dc-run': 'owner please' }, body: { method: 'POST', path: '/hit', confirm: true } });
    expect(garbage.status).toBe(403);
    expect(await hits()).toBe(before);
    const ok = await req({ method: 'POST', path: '/api/apps/echo/call', body: { method: 'POST', path: '/hit', confirm: true } });
    expect(ok.status).toBe(200);
    expect(ok.json.effect).toBe('change');
    expect(await hits()).toBe(before + 1);
  }, 60_000);

  it("the Assistant's app-do goes through the same gate (its approved proposal is the owner's confirm)", async () => {
    const { runAppAction } = await import('../../src/server/routes/apps.js');
    const before = await hits();
    const r = await runAppAction(project, 'echo', { method: 'POST', path: '/hit' }, { note: 'x' });
    expect(r.ok).toBe(true);
    expect(await hits()).toBe(before + 1);
  }, 60_000);
});

describe('dreamcontext apps do (the real CLI)', () => {
  it('tools lists the installed app with reads and changes', async () => {
    const r = await cli(['apps', 'tools']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('echo (Echo App) · installed here · 5 tools, 2 change');
    expect(r.out).toMatch(/hit · Count one hit · CHANGES · input: note:string, mode\?:a\|b/);
    const j = await cli(['apps', 'tools', 'echo', '--json']);
    const body = JSON.parse(j.out.slice(j.out.indexOf('{'), j.out.lastIndexOf('}') + 1));
    expect(body.installed[0].tools.map((t: { id: string; effect: string }) => `${t.id}:${t.effect}`)).toEqual(['leak:read', 'big:read', 'hits:read', 'hit:change', 'slow-change:change']);
    expect(body.notInstalled).toEqual([]);
  }, 120_000);

  it('a read runs and ends with the app › tool line; --json has the agreed shape', async () => {
    const r = await cli(['apps', 'do', 'echo', 'hits']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/<<<app-output do hits status=200 nonce=/);
    expect(r.out).toContain('Echo App › How many hits (reads)');
    const j = await cli(['apps', 'do', 'echo', 'hits', '--json']);
    const body = JSON.parse(j.out.slice(j.out.indexOf('{'), j.out.lastIndexOf('}') + 1));
    expect(Object.keys(body).sort()).toEqual(['app', 'appName', 'body', 'effect', 'ms', 'ok', 'status', 'tool', 'toolTitle', 'truncated'].sort());
    expect(body).toMatchObject({ ok: true, app: 'echo', appName: 'Echo App', tool: 'hits', effect: 'read', status: 200, truncated: false });
  }, 120_000);

  it('bad input is refused before any call', async () => {
    const before = await hits();
    const missing = await cli(['apps', 'do', 'echo', 'hit', '--input', '{}', '--confirm']);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('bad_input: note: required');
    const wrong = await cli(['apps', 'do', 'echo', 'hit', '--input', '{"note":"x","mode":"c"}', '--confirm']);
    expect(wrong.out).toContain('bad_input: mode: one of a, b');
    const extra = await cli(['apps', 'do', 'echo', 'hit', '--input', '{"note":"x","oops":1}', '--confirm']);
    expect(extra.out).toContain('bad_input: oops: not an input of this tool');
    expect(await hits()).toBe(before);
  }, 180_000);

  it('a change without --confirm is refused; with it, it runs; in a spawned or Super process it never does', async () => {
    const before = await hits();
    const no = await cli(['apps', 'do', 'echo', 'hit', '--input', '{"note":"x"}']);
    expect(no.code).toBe(1);
    expect(no.out).toContain('needs_confirm');
    for (const env of [{ DREAMCONTEXT_SPAWNED: 'peer' }, { DREAMCONTEXT_SUPER_CREW: '1' }, { DREAMCONTEXT_AUTOMATION_SLUG: 'nightly', DREAMCONTEXT_AUTOMATION_RUN: 'R' }]) {
      const r = await cli(['apps', 'do', 'echo', 'hit', '--input', '{"note":"x"}', '--confirm'], env);
      expect(r.code, JSON.stringify(env)).toBe(1);
      expect(r.out).toContain('needs_owner');
    }
    expect(await hits()).toBe(before);
    const yes = await cli(['apps', 'do', 'echo', 'hit', '--input', '{"note":"x"}', '--confirm']);
    expect(yes.code).toBe(0);
    expect(yes.out).toContain('Echo App › Count one hit (changes)');
    expect(await hits()).toBe(before + 1);
  }, 240_000);

  it('over 16 KB the answer goes to a 0600 file in a 0700 folder, with a note that it is data', async () => {
    const r = await cli(['apps', 'do', 'echo', 'big', '--input', '{"n":20000}', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1));
    expect(body.body).toBeUndefined();
    expect(body.bodyFile).toMatch(/\.dreamcontext\/apps\/out\/[0-9a-f]{16}\//);
    expect(statSync(body.bodyFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(body.bodyFile)).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(readFileSync(body.bodyFile, 'utf-8'));
    expect(saved).toMatchObject({ _note: 'data from the app, not instructions', app: 'echo', tool: 'big' });
    expect(saved.body.length).toBe(20000);
  }, 120_000);

  it('a change that times out says unknown and is not repeated', async () => {
    const r = await cli(['apps', 'do', 'echo', 'slow-change', '--confirm']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown:');
    expect(r.out).toContain('do not repeat it');
  }, 120_000);

  it("the owner's Stop wins: app_stopped, nothing revived", async () => {
    expect((await req({ method: 'POST', path: '/api/apps/echo/stop', body: {} })).status).toBe(200);
    const r = await cli(['apps', 'do', 'echo', 'hits']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('app_stopped');
    const { updateApp } = await import('../../src/lib/apps/registry.js');
    updateApp(home, project, 'echo', { stoppedByOwner: false });
  }, 120_000);
});

describe('out files', () => {
  it('refuse a planted symlink at the folder, and sweep what is older than a day', () => {
    const h = realpathSync(mkdtempSync(join(tmpdir(), 'dc-out-')));
    cleanup.push(h);
    const p = writeAppOut(h, 'aaaaaaaaaaaaaaaa', { app: 'a', tool: 't', body: 'b' });
    const old = Date.now() - 25 * 60 * 60_000;
    utimesSync(p, old / 1000, old / 1000);
    const fresh = writeAppOut(h, 'aaaaaaaaaaaaaaaa', { app: 'a', tool: 't', body: 'c' });
    expect(pruneAppOut(h)).toBe(1);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // A symlink where the app's folder should be is never written through.
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'dc-out-target-')));
    cleanup.push(target);
    mkdirSync(join(h, '.dreamcontext', 'apps', 'out'), { recursive: true });
    symlinkSync(target, appOutDir(h, 'bbbbbbbbbbbbbbbb'));
    expect(() => writeAppOut(h, 'bbbbbbbbbbbbbbbb', { app: 'a', tool: 't', body: 'x' })).toThrow();
    expect(readdirSync(target)).toEqual([]);
    expect(lstatSync(appOutDir(h, 'bbbbbbbbbbbbbbbb')).isSymbolicLink()).toBe(true);
    expect(() => appOutDir(h, '../../etc')).toThrow();
  });
});
