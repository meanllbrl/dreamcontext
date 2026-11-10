/**
 * A team pull of app data pauses the app (app-veri-ortak r6, K5 "tek kapı", K7; criteria 9a server
 * half and 9e).
 *
 *  - `POST /api/apps/:slug/sync-pause` stops the running backend WITHOUT `stoppedByOwner`; an
 *    unregistered slug is 404. While the pull record exists nothing starts it again; once it is gone
 *    `DELETE` lets an open window's lease bring it back.
 *  - While the record exists no door of the app opens: the page shows "Ekipten veri geliyor", every
 *    `/__dc/*` path answers 503 `paused_for_sync` (a backend-less app's `/__dc/data/read` too), a
 *    WebSocket upgrade is refused, and the app's assistant can neither read nor write its folder.
 *    Everything opens again when the record goes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { handleAppSyncPause, handleAppSyncResume, setAppsHomeForTests } from '../../src/server/routes/apps.js';
import { getApp, registerApp, type AppRecord } from '../../src/lib/apps/registry.js';
import { PAUSED_FOR_SYNC, runtimeFor, stopAllRuntimes, type AppRuntime } from '../../src/lib/apps/supervisor.js';
import { closeAllGateways, gatewayFor, type AppGateway } from '../../src/server/apps/gateway.js';
import { configureGatewayW3 } from '../../src/server/apps/gateway-w3.js';
import { removePullRecord, writePullRecord } from '../../src/lib/apps/data-conflicts.js';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import { classifyFileTool } from '../../src/lib/apps/write-gate.js';
import { classifyBash } from '../../src/lib/apps/bash-gate.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'apps', 'echo-backend');
const PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin', '/usr/sbin'])].join(delimiter);

let home: string;
let project: string;
let contextRoot: string;
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-sync-pause-')));
  project = join(home, 'acme');
  contextRoot = join(project, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  setAppsHomeForTests(home);
  configureGatewayW3({ home });
});
afterAll(async () => {
  stopAllRuntimes();
  await closeAllGateways();
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(home, { recursive: true, force: true });
});

function backendApp(slug: string): AppRecord {
  const root = join(`${project}-apps`, slug);
  mkdirSync(dirname(root), { recursive: true });
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug, name: `App ${slug}`, backend: { command: 'node server.mjs', health: '/health' }, data: { shared: [], local: [{ path: 'cache/', why: 'Re-fetched' }] } }));
  return registerApp(home, { projectRoot: project, vault: 'acme', slug, name: `App ${slug}`, root });
}

function staticApp(slug: string): AppRecord {
  const root = join(`${project}-apps`, slug);
  mkdirSync(join(root, 'public'), { recursive: true });
  writeFileSync(join(root, 'public', 'index.html'), '<!doctype html><p>static</p>');
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug, name: `App ${slug}`, data: { shared: [{ path: 'notes/', why: 'Notes the team writes' }], local: [{ path: 'cache/', why: 'Re-fetched' }] } }));
  return registerApp(home, { projectRoot: project, vault: 'acme', slug, name: `App ${slug}`, root });
}

const rt = (rec: AppRecord): AppRuntime => runtimeFor(rec, { home, loginPath: async () => PATH, noWatch: true, noBackup: true });

/** A pull record as data-exchange.ts writes it before anything else (the backend is held from now). */
function hold(rec: AppRecord): void {
  writePullRecord(home, { v: 1, hash: rec.hash, slug: rec.slug, preHead: null, mergeHead: null, phase: 'parked', parked: [], plan: null, at: new Date().toISOString() });
}

function control(method: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method, url: '/', headers: { host: '127.0.0.1:4173', 'user-agent': 'dreamcontext-cli' },
    socket: { remoteAddress: '127.0.0.1', setTimeout() {} },
    setTimeout() {},
  }) as unknown as IncomingMessage;
}
async function call(h: typeof handleAppSyncPause, slug: string, method = 'POST') {
  let status = 0;
  let out: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { try { out = JSON.parse(String(data)); } catch { out = {}; } },
  } as unknown as ServerResponse;
  await h(control(method), res, { slug }, contextRoot);
  return { status, body: out };
}

interface Res { status: number; text: string; json: any }
function req(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}
function cookieOf(gw: AppGateway): Promise<string> {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: gw.port, path: `/__dc/enter?code=${gw.mintEnterCode()}`, headers: { host: `127.0.0.1:${gw.port}` }, agent: false }, (res) => { res.resume(); resolve(String(res.headers['set-cookie']).split(';')[0]); });
  });
}

describe('POST/DELETE /api/apps/:slug/sync-pause (criterion 9a, server half)', () => {
  let rec: AppRecord;
  let a: AppRuntime;
  beforeAll(async () => {
    rec = backendApp('pauser');
    a = rt(rec);
    await gatewayFor(a);
    await a.ensureRunning();
    expect(a.status().state).toBe('running');
  }, 60_000);
  afterEach(() => removePullRecord(home, rec.hash));

  it('stops the running backend without stoppedByOwner, and nothing starts it while held', async () => {
    hold(rec);
    const r = await call(handleAppSyncPause, 'pauser');
    expect(r).toEqual({ status: 200, body: { state: 'stopped' } });
    expect(a.backend).toBeNull();
    expect(getApp(home, project, 'pauser')?.stoppedByOwner).toBeFalsy();
    await a.ensureRunning();
    expect(a.status().state).toBe('stopped');
    expect(a.lastError).toBe(PAUSED_FOR_SYNC);
    expect(a.log.tail(5).join('\n')).toMatch(/paused for a team sync: backend stopped \(asked by owner/);
  });

  it('answers not_running when no backend runs', async () => {
    hold(rec);
    expect(await call(handleAppSyncPause, 'pauser')).toEqual({ status: 200, body: { state: 'not_running' } });
  });

  it('DELETE after the record went: an open window\'s lease brings the backend back', async () => {
    hold(rec);
    await call(handleAppSyncPause, 'pauser');
    a.heartbeat('window-token');
    expect((await call(handleAppSyncResume, 'pauser', 'DELETE')).body).toEqual({ ok: true, held: true });
    expect(a.backend).toBeNull();
    removePullRecord(home, rec.hash);
    expect((await call(handleAppSyncResume, 'pauser', 'DELETE')).body).toEqual({ ok: true, held: false });
    await a.ensureRunning();
    expect(a.status().state).toBe('running');
    expect(a.backend).not.toBeNull();
  }, 60_000);

  it('an unregistered slug is 404', async () => {
    expect((await call(handleAppSyncPause, 'nope')).status).toBe(404);
    expect((await call(handleAppSyncResume, 'nope', 'DELETE')).status).toBe(404);
  });
});

describe('the pause answers only once the backend is gone (K7: its last save is never cut off)', () => {
  it('a backend that writes its save 400 ms into SIGTERM: the answer comes after the write', async () => {
    const slug = 'saver';
    const root = join(`${project}-apps`, slug);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'server.mjs'), [
      "import http from 'node:http';",
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const s = http.createServer((q, r) => { if (q.headers['x-dc-gateway-secret'] !== process.env.DC_GATEWAY_SECRET) { r.writeHead(401); r.end(); return; } r.writeHead(200); r.end('ok'); });",
      's.listen(Number(process.env.PORT), process.env.HOST);',
      "process.on('SIGTERM', () => { setTimeout(() => { writeFileSync(join(process.env.DC_DATA_DIR, 'last-save.json'), '{\"saved\":true}'); process.exit(0); }, 400); });",
    ].join('\n'));
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug, name: 'Saver', backend: { command: 'node server.mjs', health: '/health' }, data: { shared: [], local: [] } }));
    const rec = registerApp(home, { projectRoot: project, vault: 'acme', slug, name: 'Saver', root });
    const a = runtimeFor(rec, { home, loginPath: async () => PATH, noWatch: true, noBackup: true, listeners: async () => [] });
    await gatewayFor(a);
    await a.ensureRunning();
    expect(a.status().state).toBe('running');
    hold(rec);
    try {
      const r = await call(handleAppSyncPause, slug);
      expect(r).toEqual({ status: 200, body: { state: 'stopped' } });
      // The old route answered at SIGTERM: this file did not exist yet.
      expect(existsSync(join(project, '_dream_context', 'apps', slug, 'last-save.json'))).toBe(true);
    } finally { removePullRecord(home, rec.hash); }
  }, 60_000);

  /** A backend app whose server.mjs is `lines`; health is guarded by the gateway secret. */
  function scriptedApp(slug: string, lines: string[], extra: Record<string, unknown> = {}): AppRecord {
    const root = join(`${project}-apps`, slug);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'server.mjs'), [
      "import http from 'node:http';",
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const born = Date.now();',
      ...lines,
    ].join('\n'));
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug, name: slug, backend: { command: 'node server.mjs', health: '/health' }, data: { shared: [], local: [] }, ...extra }));
    return registerApp(home, { projectRoot: project, vault: 'acme', slug, name: slug, root });
  }
  const until = async (ok: () => boolean, ms = 20_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

  it('a pause while a start is in flight (health answers late): the answer comes only after that child\'s group is gone', async () => {
    const rec = scriptedApp('late', [
      // Health answers 200 only 3 s after boot: the start sits in its health poll, its backend not adopted.
      "const s = http.createServer((q, r) => { if (q.headers['x-dc-gateway-secret'] !== process.env.DC_GATEWAY_SECRET) { r.writeHead(401); r.end(); return; } r.writeHead(Date.now() - born > 3000 ? 200 : 503); r.end(); });",
      's.listen(Number(process.env.PORT), process.env.HOST);',
      "process.on('SIGTERM', () => { setTimeout(() => { writeFileSync(join(process.env.DC_DATA_DIR, 'boot-save.json'), '{}'); process.exit(0); }, 300); });",
      // Written only once the handler above is in place: the test pauses after it, never before.
      "writeFileSync(join(process.env.DC_DATA_DIR, 'sigterm-ready.json'), '{}');",
    ]);
    const a = runtimeFor(rec, { home, loginPath: async () => PATH, noWatch: true, noBackup: true, listeners: async () => [] });
    const starting = a.ensureRunning();
    await until(() => a.liveChildCount() > 0);
    // node has loaded server.mjs and holds its SIGTERM handler (a pause before that is a plain kill).
    await until(() => existsSync(join(project, '_dream_context', 'apps', 'late', 'sigterm-ready.json')));
    expect(a.backend).toBeNull(); // spawned, not adopted (health still 503): the old pause saw nothing to wait for
    hold(rec);
    try {
      const r = await call(handleAppSyncPause, 'late');
      expect(r).toEqual({ status: 200, body: { state: 'stopped' } });
      expect(a.liveChildCount()).toBe(0);
      expect(existsSync(join(project, '_dream_context', 'apps', 'late', 'boot-save.json'))).toBe(true);
      await starting;
      expect(a.backend).toBeNull();
    } finally { removePullRecord(home, rec.hash); }
  }, 60_000);

  it('a pull record written after the start began stops the spawn (read at spawn time)', async () => {
    const rec = scriptedApp('afterbuild', [
      "writeFileSync(join(process.env.DC_DATA_DIR, 'booted.json'), '{}');",
      "const s = http.createServer((q, r) => { if (q.headers['x-dc-gateway-secret'] !== process.env.DC_GATEWAY_SECRET) { r.writeHead(401); r.end(); return; } r.writeHead(200); r.end(); });",
      's.listen(Number(process.env.PORT), process.env.HOST);',
    ], { build: 'node -e "setTimeout(() => {}, 1000)"' });
    const a = runtimeFor(rec, { home, loginPath: async () => PATH, noWatch: true, noBackup: true, listeners: async () => [] });
    const starting = a.ensureRunning();
    await until(() => a.liveChildCount() > 0); // the build runs: the start is past its first check
    hold(rec);
    try {
      await starting;
      expect(a.backend).toBeNull();
      expect(a.status().state).toBe('stopped');
      expect(a.lastError).toBe(PAUSED_FOR_SYNC);
      expect(existsSync(join(project, '_dream_context', 'apps', 'afterbuild', 'booted.json'))).toBe(false);
      await until(() => a.liveChildCount() === 0);
    } finally { removePullRecord(home, rec.hash); }
  }, 60_000);

  it('stopAndWait resolves false when the backend outlives the deadline (the route then answers 503)', async () => {
    const slug = 'stubborn';
    const root = join(`${project}-apps`, slug);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'server.mjs'), [
      "import http from 'node:http';",
      "const s = http.createServer((q, r) => { if (q.headers['x-dc-gateway-secret'] !== process.env.DC_GATEWAY_SECRET) { r.writeHead(401); r.end(); return; } r.writeHead(200); r.end('ok'); });",
      's.listen(Number(process.env.PORT), process.env.HOST);',
      "process.on('SIGTERM', () => {});",
    ].join('\n'));
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug, name: 'Stubborn', backend: { command: 'node server.mjs', health: '/health' }, data: { shared: [], local: [] } }));
    const rec = registerApp(home, { projectRoot: project, vault: 'acme', slug, name: 'Stubborn', root });
    const a = runtimeFor(rec, { home, loginPath: async () => PATH, noWatch: true, noBackup: true, listeners: async () => [] });
    await a.ensureRunning();
    // 500 ms is before the 2 s SIGKILL: it ignores SIGTERM, so it is not gone yet.
    const child = a.backend!.child;
    expect(await a.stopAndWait(500)).toBe(false);
    // The 2 s SIGKILL ends it: never left running past the test.
    await new Promise<void>((r) => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once('exit', () => r()); });
  }, 60_000);
});

describe('a held app opens no door (criterion 9e)', () => {
  let rec: AppRecord;
  let gw: AppGateway;
  let cookie: string;
  let token: string;
  let dataDir: string;
  beforeAll(async () => {
    rec = staticApp('statik');
    const a = rt(rec);
    gw = await gatewayFor(a);
    await a.ensureRunning();
    token = a.dcToken;
    cookie = await cookieOf(gw);
    dataDir = ensureAppDataDir(project, 'statik');
    mkdirSync(join(dataDir, 'cache'), { recursive: true });
    // A team file on a path this Mac calls local, landed by a merge that is still open.
    writeFileSync(join(dataDir, 'cache', 'team.json'), '{"from":"the team"}');
  }, 30_000);
  afterEach(() => removePullRecord(home, rec.hash));

  it('page: "Ekipten veri geliyor"; /__dc/* and the data read: 503 paused_for_sync; an upgrade: 503', async () => {
    hold(rec);
    const page = await req(gw.port, { path: '/', headers: { cookie, accept: 'text/html' } });
    expect(page.status).toBe(503);
    expect(page.text).toContain('Ekipten veri geliyor');
    const read = await req(gw.port, { path: `/__dc/data/read?path=${encodeURIComponent('cache/team.json')}`, headers: { cookie } });
    expect(read.status).toBe(503);
    expect(read.json).toMatchObject({ error: 'paused_for_sync' });
    expect(read.text).not.toContain('the team');
    const viaBearer = await req(gw.port, { path: '/__dc/data/status', headers: { authorization: `Bearer ${token}` } });
    expect(viaBearer.status).toBe(503);
    const statik = await req(gw.port, { path: '/index.html', headers: { cookie } });
    expect(statik.status).toBe(503);
    const api = await req(gw.port, { path: '/__dc/api/tasks', headers: { cookie } });
    expect(api.status).toBe(503);
    const upgrade = await new Promise<string>((resolve) => {
      const s = connect(gw.port, '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${gw.port}\r\nCookie: ${cookie}\r\nOrigin: ${gw.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
      let got = '';
      s.on('data', (c) => { got += String(c); });
      s.on('close', () => resolve(got));
      s.on('error', () => resolve(got));
    });
    expect(upgrade).toMatch(/^HTTP\/1\.1 503/);
  });

  it('the app\'s assistant cannot read, search or write its folder while held; can once it is gone', () => {
    const ctx = { slug: 'statik', appRoot: rec.root, dataDir, projectRoot: project, home, actions: [] };
    hold(rec);
    for (const [tool, input] of [
      ['Read', { file_path: join(dataDir, 'cache', 'team.json') }],
      ['Grep', { pattern: 'team', path: dataDir }],
      ['Write', { file_path: join(dataDir, 'notes', 'n.json'), content: '{}' }],
    ] as const) {
      const d = classifyFileTool(tool, input as Record<string, unknown>, ctx);
      expect(d.decision, tool).toBe('deny');
      expect('reason' in d && d.reason).toMatch(/paused_for_sync/);
    }
    expect(classifyBash(`ls ${dataDir}`, ctx)).toMatchObject({ decision: 'deny' });
    removePullRecord(home, rec.hash);
    expect(classifyFileTool('Read', { file_path: join(dataDir, 'cache', 'team.json') }, ctx)).toEqual({ decision: 'pass' });
    expect(classifyFileTool('Write', { file_path: join(dataDir, 'notes', 'n.json'), content: '{}' }, ctx)).toEqual({ decision: 'pass' });
  });

  it('opens again once the record is gone', async () => {
    hold(rec);
    expect((await req(gw.port, { path: '/__dc/data/status', headers: { cookie } })).status).toBe(503);
    removePullRecord(home, rec.hash);
    const r = await req(gw.port, { path: '/__dc/data/status', headers: { cookie } });
    expect(r.status).toBe(200);
    expect((await req(gw.port, { path: '/index.html', headers: { cookie } })).status).toBe(200);
  });
});
