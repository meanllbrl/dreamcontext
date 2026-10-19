/**
 * Who may reach the Super Agent's routes (plan-r7 D4, AC11).
 *
 *  - The agent's verbs (`POST /api/super/v/:verb`): loopback, then a live window token whose
 *    chat is THE vault's recorded super session, spawned in super mode. No token, a basic
 *    chat's token, another vault's super token, a child's token, a super-mode chat that is not
 *    the recorded session: all refused.
 *  - The owner's routes: the desktop app, loopback, a loopback Host, never cross-site, never
 *    the phone; denied on the phone/tunnel surface by the route policy too.
 *  - `/api/window` gains no `answer` verb: only the queue strip answers a child (D7).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { handleSuperEnable, handleSuperStateGet, handleSuperVerb } from '../../src/server/routes/super.js';
import { handleWindowCommand } from '../../src/server/routes/window-control.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';
import { phoneAllows, setPhoneSurfaceForTests } from '../../dashboard/src/lib/phoneSurface.js';

let dir: string;
let vaultA: string;
let vaultB: string;
const savedEnv = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };

function makeVault(name: string, state: Record<string, unknown> | null): string {
  const root = join(dir, name, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  if (state) writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), ...state }));
  return root;
}

beforeEach(() => {
  resetWindowControl();
  resetSuperIndex();
  dir = mkdtempSync(join(tmpdir(), 'super-auth-'));
  process.env.HOME = join(dir, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
  vaultA = makeVault('acme', { session: 'sess-a', enabled: true, children: { 'child-a': { sessionId: 'child-a', brief: '', adopted: true, startedAt: 1 } } });
  vaultB = makeVault('beta', { session: 'sess-b', enabled: true });
});
afterEach(() => {
  process.env.HOME = savedEnv.HOME;
  if (savedEnv.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedEnv.DESKTOP;
  rmSync(dir, { recursive: true, force: true });
});

interface FakeReq { headers?: Record<string, string>; remote?: string; body?: unknown; phone?: boolean; method?: string }

function req(o: FakeReq = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  const socket = { remoteAddress: o.remote ?? '127.0.0.1' };
  if (o.phone) markPhoneSocket(socket);
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...(o.headers ?? {}) }, socket, method: o.method ?? 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(o.body === undefined ? '' : JSON.stringify(o.body)); });
  return r;
}

function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

const token = (contextRoot: string, sessionId: string, mode: string, vault = 'acme') =>
  mintWindowToken({ send: () => true, vault, contextRoot, sessionId, mode }).token;

async function verb(name: string, headers: Record<string, string> = {}, o: Partial<FakeReq> = {}) {
  const r = res();
  await handleSuperVerb(req({ headers, ...o }), r, { verb: name });
  return r;
}

describe('the agent\'s verbs: only the vault\'s super-chat token', () => {
  it('no token → 401', async () => {
    expect((await verb('state')).status).toBe(401);
  });

  it('a basic chat\'s token → 403, even with the super session\'s id', async () => {
    expect((await verb('state', { 'x-dreamcontext-window-token': token(vaultA, 'sess-a', 'basic') })).status).toBe(403);
    expect((await verb('state', { 'x-dreamcontext-window-token': token(vaultA, 'other', 'develop') })).status).toBe(403);
  });

  it('a child\'s token → 403', async () => {
    expect((await verb('state', { 'x-dreamcontext-window-token': token(vaultA, 'child-a', 'basic') })).status).toBe(403);
  });

  it('a super-mode chat that is not the recorded session → 403', async () => {
    const r = await verb('state', { 'x-dreamcontext-window-token': token(vaultA, 'sess-impostor', 'super') });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('not_the_super_agent');
  });

  it('another vault\'s super token reaches only its own vault', async () => {
    const r = await verb('state', { 'x-dreamcontext-window-token': token(vaultB, 'sess-b', 'super', 'beta') });
    expect(r.status).toBe(200);
    expect((r.json.result as { session: string }).session).toBe('sess-b');
    // B's token claiming A's session id is still checked against B's own record.
    expect((await verb('state', { 'x-dreamcontext-window-token': token(vaultB, 'sess-a', 'super', 'beta') })).status).toBe(403);
  });

  it('the vault\'s super token → accepted', async () => {
    const r = await verb('state', { 'x-dreamcontext-window-token': token(vaultA, 'sess-a', 'super') });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ session: 'sess-a', enabled: true, children: { 'child-a': { sessionId: 'child-a' } } });
  });

  it('not from this machine → 403 before the token is even looked at', async () => {
    expect((await verb('state', { 'x-dreamcontext-window-token': token(vaultA, 'sess-a', 'super') }, { remote: '10.0.0.5' })).status).toBe(403);
    expect((await verb('state', { 'x-dreamcontext-window-token': token(vaultA, 'sess-a', 'super') }, { phone: true })).status).toBe(403);
  });

  it('an unknown verb → 404', async () => {
    expect((await verb('format-disk', { 'x-dreamcontext-window-token': token(vaultA, 'sess-a', 'super') })).status).toBe(404);
  });

  it('a released token (the chat ended) → 401', async () => {
    const m = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: vaultA, sessionId: 'sess-a', mode: 'super' });
    m.release();
    expect((await verb('state', { 'x-dreamcontext-window-token': m.token })).status).toBe(401);
  });
});

describe('/api/window has no answer verb', () => {
  it('`/api/window/answer` → unknown verb', async () => {
    const r = res();
    await handleWindowCommand(req({ headers: { 'x-dreamcontext-window-token': token(vaultA, 'sess-a', 'super') } }), r, { verb: 'answer' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('unknown_verb');
  });
});

describe('the owner\'s routes: this machine\'s desktop window only', () => {
  const owner = async (h: (req: IncomingMessage, res: ServerResponse, p: Record<string, string>, root: string) => Promise<void>, o: FakeReq = {}) => {
    const r = res();
    await h(req(o), r, {}, vaultA);
    return r;
  };

  it('a same-origin desktop GET of the state is answered', async () => {
    const r = await owner(handleSuperStateGet, { method: 'GET', headers: { origin: 'http://127.0.0.1:4173' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ session: 'sess-a', vault: 'acme' });
  });

  it('a foreign Origin or a cross-site fetch → 403', async () => {
    expect((await owner(handleSuperEnable, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await owner(handleSuperEnable, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await owner(handleSuperStateGet, { method: 'GET', headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('outside the desktop app, from another host, under a foreign Host header, or from the phone → 403', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect((await owner(handleSuperEnable)).status).toBe(403);
    process.env.DREAMCONTEXT_DESKTOP = '1';
    expect((await owner(handleSuperEnable, { remote: '192.168.1.9' })).status).toBe(403);
    expect((await owner(handleSuperEnable, { headers: { host: 'rebound.example:4173' } })).status).toBe(403);
    expect((await owner(handleSuperEnable, { phone: true })).status).toBe(403);
  });

  it('every super route is denied on the phone/tunnel surface, on the server and in the page', () => {
    const rows = Object.entries(ROUTE_POLICY).filter(([k]) => k.includes('/api/super/'));
    expect(rows.map(([k]) => k).sort()).toEqual([
      'GET /api/super/state', 'POST /api/super/activity', 'POST /api/super/disable', 'POST /api/super/enable',
      'POST /api/super/layout', 'POST /api/super/recap', 'POST /api/super/v/:verb',
    ]);
    for (const [k, row] of rows) expect(row.allow, k).toBe(false);
    setPhoneSurfaceForTests('mac');
    try {
      expect(phoneAllows('POST', '/api/super/enable')).toBe(false);
      expect(phoneAllows('GET', '/api/super/state')).toBe(false);
      expect(phoneAllows('POST', '/api/super/v/state')).toBe(false);
    } finally { setPhoneSurfaceForTests(null); }
  });
});
