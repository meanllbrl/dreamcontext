/**
 * D3 seeding (hands-free sekmeler W1): a remote screen opening a project on the desktop layout
 * reads the Mac window's tabs — `GET /api/agent/sessions?of=desktop` on a phone socket — narrowed
 * to title, id, pane, kind, bypass (and which was active): never a path, a mode or an agent, never
 * a terminal or an automation run, never the Super's own tab; a handed-over project seeds nothing.
 * It is never written, and the phone's own roster is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopSeed } from '../../src/server/routes/agent-sessions.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import {
  buildRouter, makeRequestHandler, mainLaptopGate, attachMainListenerBackstop, setMainServerForTests, startPhoneListener, stopPhoneListener,
} from '../../src/server/index.js';
import { DEVICE_COOKIE, HandsfreeAuth, hashPassphrase, setMacHandsfreeAuthForTests } from '../../src/server/handsfree-auth.js';
import { setMacProbeNonce, setMacExposedVaults, setMacPublicOrigin } from '../../src/server/phone-origin.js';
import { addVault } from '../../src/lib/vaults.js';

const TUNNEL = 'quiet-lake-1234.trycloudflare.com';
const ORIGIN = `https://${TUNNEL}`;
const SUPER = 'aaaaaaaa-0000-4000-8000-000000000001';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'aaaaaaaa-0000-4000-8000-00000000000b';

const DESKTOP = {
  generation: 3,
  chatPermissionMode: 'auto',
  activePane: 1,
  sessions: [
    { title: 'Plan', bypass: false, minimized: false, size: 1, sessionId: A, kind: 'chat', mode: 'plan', pane: 0, active: true },
    { title: 'Build', bypass: true, minimized: false, size: 1, sessionId: B, kind: 'chat', mode: 'develop', agent: 'helper', pane: 1 },
    { title: 'zsh', bypass: false, minimized: false, size: 1, sessionId: 'aaaaaaaa-0000-4000-8000-00000000000c', kind: 'shell', pane: 1 },
    { title: 'Nightly', bypass: false, minimized: false, size: 1, sessionId: 'aaaaaaaa-0000-4000-8000-00000000000d', kind: 'automation', automation: { slug: 'nightly', runFiredAt: '2026-10-25T00:00:00Z' } },
    { title: 'Super Agent', bypass: false, minimized: false, size: 1, sessionId: SUPER, kind: 'chat', mode: 'super', pane: 2 },
    { title: 'No id', bypass: false, minimized: false, size: 1, kind: 'agent' },
  ],
};

describe('desktopSeed (pure)', () => {
  it('chat and agent tabs with a conversation, narrowed; never a terminal, an automation or the Super', () => {
    expect(desktopSeed(DESKTOP as never, { enabled: false, session: SUPER })).toEqual([
      { title: 'Plan', sessionId: A, pane: 0, kind: 'chat', bypass: false, active: true },
      { title: 'Build', sessionId: B, pane: 1, kind: 'chat', bypass: true },
    ]);
  });
  it('a handed-over project seeds nothing (its stage is the view)', () => {
    expect(desktopSeed(DESKTOP as never, { enabled: true, session: SUPER })).toEqual([]);
  });
});

// ─── The routes, through the real phone listener ─────────────────────────────

const PROJECT = 'seed-proj';
const saved: Record<string, string | undefined> = {};
let dir: string;
let main: http.Server;
let mainPort: number;
let phonePort: number;
let cookie: string;
let root: string;

function request(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}) }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const H = () => ({ cookie, origin: ORIGIN, accept: 'application/json', 'x-dreamcontext-vault': PROJECT });
const phone = (method: string, path: string, body?: unknown) => request(phonePort, method, path, H(), body === undefined ? undefined : JSON.stringify(body));

async function seed(extra: Partial<SuperState> & Record<string, unknown> = {}): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sess-1', ...extra }));
  resetSuperIndex();
  await readSuperState(root);
}
const record = () => JSON.parse(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')) as SuperState;

beforeAll(async () => {
  for (const k of ['DREAMCONTEXT_DESKTOP', 'HOME']) saved[k] = process.env[k];
  process.env.DREAMCONTEXT_DESKTOP = '1';
  dir = mkdtempSync(join(tmpdir(), 'desktop-seed-'));
  process.env.HOME = dir;
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  mkdirSync(join(dir, PROJECT, '_dream_context', 'state'), { recursive: true });
  mkdirSync(join(dir, PROJECT, '_dream_context', 'core'), { recursive: true });
  addVault(PROJECT, join(dir, PROJECT));
  root = join(dir, PROJECT, '_dream_context');
  const macAuth = new HandsfreeAuth({ dir: join(dir, 'mac') });
  mkdirSync(join(dir, 'mac'), { recursive: true });
  macAuth.store.setPassphrase(await hashPassphrase('alpha bravo charlie delta echo foxtrot'));
  cookie = `${DEVICE_COOKIE}=${macAuth.store.createDevice('iPad · Safari')}`;
  setMacHandsfreeAuthForTests(macAuth);
  const router = buildRouter();
  main = http.createServer(makeRequestHandler({ gate: (req, res) => mainLaptopGate(req, res, null), router, dashboardDir: dir, contextRoot: null }));
  attachMainListenerBackstop(main);
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


const phoneRoster = () => join(root, 'state', '.agent-sessions.phone.json');

describe('GET /api/agent/sessions?of=desktop', () => {
  it('on a phone socket: the narrowed Mac tabs, nothing written', async () => {
    writeFileSync(join(root, 'state', '.agent-sessions.json'), JSON.stringify(DESKTOP));
    resetSuperIndex();
    const r = await phone('GET', '/api/agent/sessions?of=desktop');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.sessions.map((x: { sessionId: string }) => x.sessionId)).toEqual([A, B]);
    for (const k of ['mode', 'agent', 'automation', 'minimized', 'size', 'bound']) expect(r.body).not.toContain(`"${k}"`);
    expect(r.body).not.toContain(dir);
    expect(existsSync(phoneRoster())).toBe(false);
  });

  it('without ?of=desktop the phone still reads its OWN roster', async () => {
    writeFileSync(phoneRoster(), JSON.stringify({ generation: 1, chatPermissionMode: 'auto', sessions: [{ title: 'Mine', bypass: false, minimized: false, size: 1, sessionId: B, kind: 'chat' }] }));
    const r = await phone('GET', '/api/agent/sessions');
    expect(JSON.parse(r.body).sessions.map((x: { title: string }) => x.title)).toEqual(['Mine']);
    rmSync(phoneRoster(), { force: true });
  });

  it('handed over: nothing to seed', async () => {
    await seed({ enabled: true, session: SUPER } as never);
    const r = await phone('GET', '/api/agent/sessions?of=desktop');
    expect(JSON.parse(r.body)).toEqual({ sessions: [] });
    rmSync(join(root, SUPER_STATE_REL), { force: true });
    resetSuperIndex();
  });

  it('an unreadable Super record fails closed: nothing to seed (it may be a handed-over project)', async () => {
    writeFileSync(join(root, 'state', '.agent-sessions.json'), JSON.stringify(DESKTOP));
    mkdirSync(join(root, SUPER_STATE_REL), { recursive: true });
    resetSuperIndex();
    try {
      const r = await phone('GET', '/api/agent/sessions?of=desktop');
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ sessions: [] });
    } finally {
      rmSync(join(root, SUPER_STATE_REL), { recursive: true, force: true });
      resetSuperIndex();
    }
  });
});
