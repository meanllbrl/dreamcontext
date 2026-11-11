/**
 * The owner's consent to share an app's hand-made data (app-veri-ortak r6, K3, criterion 2) and the
 * app's own data paths `/__dc/data/*` (K6, K8, criterion 11).
 *
 *  - `POST /api/apps/:slug/data-share`: only the owner's own Apps page (the shell's key on a
 *    same-origin click). An agent's curl, the Super, an app's own page: 403 `owner_page_only`.
 *    A new declared path asks only it; a narrowed declaration asks nothing; a bad body is 400; a
 *    settings write never erases the consent.
 *  - `/__dc/data/*` resolves only inside the CALLING app's data folder: `..`, a dotted part and
 *    another app's path are refused; write and remove are the backend's alone.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handleAppDataShare, handleAppsList, setAppsHomeForTests } from '../../src/server/routes/apps.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { registerApp, type AppRecord } from '../../src/lib/apps/registry.js';
import { consentPath, readConsent } from '../../src/lib/apps/data-consent.js';
import { newConfigId, setAppConfig } from '../../src/lib/apps/app-config.js';
import { appDataStatus } from '../../src/lib/apps/others.js';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import { runtimeFor, stopAllRuntimes } from '../../src/lib/apps/supervisor.js';
import { closeAllGateways, gatewayFor, type AppGateway } from '../../src/server/apps/gateway.js';
import { configureGatewayW3 } from '../../src/server/apps/gateway-w3.js';
import { addTombstone, listTombstones } from '../../src/lib/apps/data-deletes.js';

const KEY = 'd4'.repeat(32);
const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OWNER_CLICK = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [OWNER_KEY_HEADER]: KEY };

let home: string;
let project: string;
let contextRoot: string;
let rec: AppRecord;
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function manifest(root: string, data: unknown, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'rakip', name: 'Rakip', ...(data === undefined ? {} : { data }), ...extra }));
}

const DECL = {
  shared: [{ path: 'favorites/', why: 'The team\'s picked ads and their notes' }],
  local: [{ path: 'cache/', why: 'Re-fetched from Meta with Refresh' }],
};

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-data-route-')));
  project = join(home, 'proj');
  contextRoot = join(project, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  const root = join(home, 'proj-apps', 'rakip');
  mkdirSync(join(root, 'public'), { recursive: true });
  writeFileSync(join(root, 'public', 'index.html'), '<!doctype html><p>rakip</p>');
  manifest(root, DECL);
  rec = registerApp(home, { projectRoot: project, vault: 'acme', slug: 'rakip', name: 'Rakip', root });
  setAppsHomeForTests(home);
  configureGatewayW3({ home });
});
afterAll(async () => {
  setOwnerKey(null);
  stopAllRuntimes();
  await closeAllGateways();
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  setOwnerKey(KEY);
  rmSync(consentPath(home, rec.hash), { force: true });
  manifest(rec.root, DECL);
});

function request(method: string, headers: Record<string, string>, body?: unknown, remote = '127.0.0.1'): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return Object.assign(Readable.from(chunks), {
    method, url: '/', headers,
    socket: { remoteAddress: remote, setTimeout() {} },
    setTimeout() {},
  }) as unknown as IncomingMessage;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string) => Promise<void>;
async function call(h: Handler, headers: Record<string, string>, body?: unknown, method = 'POST') {
  let status = 0;
  let out: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { try { out = JSON.parse(String(data)); } catch { out = {}; } },
  } as unknown as ServerResponse;
  await h(request(method, headers, body), res, { slug: 'rakip' }, contextRoot);
  return { status, body: out };
}

const without = (k: string) => Object.fromEntries(Object.entries(OWNER_CLICK).filter(([x]) => x !== k));

describe('POST /api/apps/:slug/data-share (criterion 2)', () => {
  it('the owner\'s click approves, and only that path stops being asked', async () => {
    const r = await call(handleAppDataShare, OWNER_CLICK, { approve: ['favorites/'] });
    expect(r.status).toBe(200);
    expect(readConsent(home, rec.hash)).toMatchObject({ approved: ['favorites/'], excluded: [], declined: false });
    expect((r.body.data as { pendingPaths: unknown[] }).pendingPaths).toEqual([]);
  });

  const refused: Array<[string, Record<string, string>]> = [
    ['an agent\'s curl (no Origin, no key)', { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json' }],
    ['the Super or its child (a run header, no Origin)', { host: `127.0.0.1:${PORT}`, 'x-dc-run': JSON.stringify({ class: 'crew' }) }],
    ['the app\'s own page (another loopback origin, no key)', { ...without(OWNER_KEY_HEADER), origin: 'http://127.0.0.1:51234' }],
    ['the right headers without the key', without(OWNER_KEY_HEADER)],
    ['the key without an Origin', without('origin')],
  ];
  for (const [what, headers] of refused) {
    it(`${what}: 403 owner_page_only, nothing written`, async () => {
      const r = await call(handleAppDataShare, headers, { approve: ['favorites/'] });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('owner_page_only');
      expect(existsSync(consentPath(home, rec.hash))).toBe(false);
    });
  }

  it('a newly declared path asks only it; a narrowed declaration asks nothing', async () => {
    await call(handleAppDataShare, OWNER_CLICK, { approve: ['favorites/'] });
    manifest(rec.root, { ...DECL, shared: [...DECL.shared, { path: 'notes/', why: 'Notes the team writes' }] });
    expect(appDataStatus(home, rec, { mode: { fullRepo: true, cloudSyncOn: true } }).pending).toEqual(['notes/']);
    manifest(rec.root, { shared: [], local: DECL.local });
    expect(appDataStatus(home, rec, { mode: { fullRepo: true, cloudSyncOn: true } }).pending).toEqual([]);
  });

  it('a bad body is 400 and changes nothing', async () => {
    for (const body of [{ approve: ['../x/'] }, { approve: ['.env'] }, { approve: 'favorites/' }, { nope: true }, {}, { approve: ['undeclared/'] }, { approve: Array.from({ length: 21 }, (_, i) => `p${i}/`) }]) {
      const r = await call(handleAppDataShare, OWNER_CLICK, body);
      expect(r.status).toBe(400);
    }
    expect(existsSync(consentPath(home, rec.hash))).toBe(false);
  });

  it('decline keeps everything here; an exclusion stays until the owner lifts it', async () => {
    await call(handleAppDataShare, OWNER_CLICK, { exclude: ['favorites/'] });
    expect(readConsent(home, rec.hash)?.excluded).toEqual(['favorites/']);
    const r = await call(handleAppDataShare, OWNER_CLICK, { decline: true });
    expect(r.status).toBe(200);
    expect(readConsent(home, rec.hash)).toMatchObject({ declined: true, excluded: ['favorites/'] });
  });

  it('a settings write never erases the consent (its own file, never DC_CONFIG)', async () => {
    await call(handleAppDataShare, OWNER_CLICK, { approve: ['favorites/'] });
    const before = readFileSync(consentPath(home, rec.hash), 'utf-8');
    setAppConfig(home, newConfigId(), [{ key: 'market', type: 'text', label: 'Market', required: false }], { market: 'TR' });
    expect(readFileSync(consentPath(home, rec.hash), 'utf-8')).toBe(before);
  });

  it('GET /api/apps carries the card\'s data field: counts, paths, the agent\'s reasons, sync off', async () => {
    const r = await call(handleAppsList, OWNER_CLICK, undefined, 'GET');
    const app = (r.body.apps as Array<{ slug: string; data: Record<string, unknown> }>).find((a) => a.slug === 'rakip')!;
    expect(app.data).toMatchObject({ declared: true, syncOff: true, mode: 'sync_off', pull: 'none' });
    expect(app.data.localPaths).toEqual([{ path: 'cache/', why: 'Re-fetched from Meta with Refresh' }]);
    expect(app.data.pendingPaths).toEqual([{ path: 'favorites/', why: 'The team\'s picked ads and their notes', files: 0, bytes: 0 }]);
  });
});

// ─── /__dc/data/* (K8, criterion 11) ────────────────────────────────────────────────

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

describe('/__dc/data/* (criterion 11)', () => {
  let gw: AppGateway;
  let cookie: string;
  let token: string;

  beforeAll(async () => {
    const other = join(home, 'proj-apps', 'baska');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'dreamcontext-app.json'), JSON.stringify({ slug: 'baska', name: 'Baska' }));
    registerApp(home, { projectRoot: project, vault: 'acme', slug: 'baska', name: 'Baska', root: other });
    writeFileSync(join(ensureAppDataDir(project, 'baska'), 'secret.json'), '{"other":"app"}');
    const dir = ensureAppDataDir(project, 'rakip');
    mkdirSync(join(dir, 'favorites'), { recursive: true });
    writeFileSync(join(dir, 'favorites', 'a1.json'), '{"id":"a1","note":"şunu deneyelim"}');
    writeFileSync(join(dir, 'favorites', 'bad.json'), '{"id":');
    const rt = runtimeFor(rec, { home, noWatch: true, noBackup: true });
    gw = await gatewayFor(rt);
    await rt.ensureRunning();
    token = rt.dcToken;
    // The window's cookie, from the one-time enter code's redirect.
    cookie = await new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1', port: gw.port, path: `/__dc/enter?code=${gw.mintEnterCode()}`, headers: { host: `127.0.0.1:${gw.port}` }, agent: false }, (res) => { res.resume(); resolve(String(res.headers['set-cookie']).split(';')[0]); });
    });
  }, 30_000);

  it('status answers the five-field shape from sharedSet', async () => {
    const r = await req(gw.port, { path: '/__dc/data/status', headers: { cookie } });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['held', 'mode', 'pending', 'shared']);
    expect(r.json.mode).toBe('sync_off');
  });

  it('read gives one file, or a folder\'s files one level down', async () => {
    const one = await req(gw.port, { path: `/__dc/data/read?path=${encodeURIComponent('favorites/a1.json')}`, headers: { cookie } });
    expect(one.json).toEqual({ path: 'favorites/a1.json', text: '{"id":"a1","note":"şunu deneyelim"}' });
    const all = await req(gw.port, { path: `/__dc/data/read?path=${encodeURIComponent('favorites/')}`, headers: { authorization: `Bearer ${token}` } });
    expect(all.json.records.map((x: { path: string }) => x.path)).toEqual(['favorites/a1.json', 'favorites/bad.json']);
  });

  it('refuses `..`, another app\'s data, a dotted part and an absolute path', async () => {
    for (const p of ['../baska/secret.json', '../../apps/baska/secret.json', 'favorites/../../baska/secret.json', '.env', 'favorites/.hidden', '/etc/hosts', 'CLAUDE.md']) {
      const r = await req(gw.port, { path: `/__dc/data/read?path=${encodeURIComponent(p)}`, headers: { cookie } });
      expect(r.status, p).toBe(400);
      expect(r.text).not.toContain('other');
    }
  });

  it('write is the backend\'s alone and atomic; the page gets backend_only', async () => {
    const page = await req(gw.port, { method: 'POST', path: '/__dc/data/write', headers: { cookie, origin: gw.origin, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'favorites/x.json', content: '{}' }) });
    expect(page.status).toBe(403);
    expect(page.json.error).toBe('backend_only');
    const ok = await req(gw.port, { method: 'POST', path: '/__dc/data/write', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'favorites/b2.json', content: { id: 'b2' } }) });
    expect(ok.status).toBe(200);
    expect(JSON.parse(readFileSync(join(project, '_dream_context', 'apps', 'rakip', 'favorites', 'b2.json'), 'utf-8'))).toEqual({ id: 'b2' });
    const bad = await req(gw.port, { method: 'POST', path: '/__dc/data/write', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: '../baska/secret.json', content: 'x' }) });
    expect(bad.status).toBe(400);
    expect(readFileSync(join(project, '_dream_context', 'apps', 'baska', 'secret.json'), 'utf-8')).toBe('{"other":"app"}');
  });

  it('a write of a path drops an earlier delete of it (the app wrote it again)', async () => {
    addTombstone(home, rec.hash, 'favorites/again.json');
    addTombstone(home, rec.hash, 'favorites/other.json');
    const ok = await req(gw.port, { method: 'POST', path: '/__dc/data/write', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'favorites/again.json', content: '{}' }) });
    expect(ok.status).toBe(200);
    expect(listTombstones(home, rec.hash).map((t) => t.path)).toEqual(['favorites/other.json']);
    rmSync(join(home, '.dreamcontext', 'apps', 'deletes', `${rec.hash}.json`), { force: true });
  });

  it('remove refuses a path that is not a tracked file of this app\'s live shared set (no tombstone)', async () => {
    const r = await req(gw.port, { method: 'POST', path: '/__dc/data/remove', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'favorites/a1.json' }) });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('not_shared');
    expect(listTombstones(home, rec.hash)).toEqual([]);
    expect(existsSync(join(project, '_dream_context', 'apps', 'rakip', 'favorites', 'a1.json'))).toBe(true);
    const other = await req(gw.port, { method: 'POST', path: '/__dc/data/remove', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: '../baska/secret.json' }) });
    expect(other.status).toBe(400);
  });
});
