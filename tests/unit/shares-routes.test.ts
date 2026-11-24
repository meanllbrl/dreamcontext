// Live links, the owner routes (plan C4, D8; criterion K12): only the owner's own page opens a
// link or reads it back; the list never carries the link, token or password, for anyone; anyone
// on this Mac may close one. The phone's route policy denies all four.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleShareClose, handleShareCreate, handleShareList, handleShareReveal } from '../../src/server/routes/shares.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { closeAllShares, getShare, openShare } from '../../src/server/shares/registry.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';
import { deniedForEveryone } from '../../src/lib/apps/page-routes.js';
import { fakeKind, fakeWorld, openAndWait, waitFor } from './share-fixture.js';

const KEY = 'c4'.repeat(32);
const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OWNER_CLICK = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [OWNER_KEY_HEADER]: KEY };
const CLI = { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json' };
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

interface Out { status: number; body: Record<string, unknown>; raw: string }

function fakeReq(method: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const text = body === undefined ? '' : JSON.stringify(body);
  const r = Readable.from(text ? [Buffer.from(text)] : []) as unknown as IncomingMessage;
  Object.assign(r, { method, url: '/api/shares', headers: { ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  return r;
}

function fakeRes(): { res: ServerResponse; done: Promise<Out> } {
  let resolve!: (o: Out) => void;
  const done = new Promise<Out>((r) => { resolve = r; });
  let status = 200;
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    writeHead: (s: number, h?: Record<string, string>) => { status = s; Object.assign(headers, h ?? {}); return res; },
    end: (chunk?: string) => { const raw = String(chunk ?? ''); let body = {}; try { body = JSON.parse(raw); } catch { /* none */ } resolve({ status, body, raw }); },
  } as unknown as ServerResponse;
  return { res, done };
}

async function call(h: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>, method: string, headers: Record<string, string>, body?: unknown, params: Record<string, string> = {}): Promise<Out> {
  const { res, done } = fakeRes();
  await h(fakeReq(method, headers, body), res, params);
  return done;
}

const SECRET_KEYS = ['link', 'token', 'password', 'url', 'origin', 'host'];
function carriesSecret(o: unknown, share: { token: string; origin: string | null; password: string | null }): boolean {
  const text = JSON.stringify(o);
  if (text.includes(share.token)) return true;
  if (share.origin && text.includes(share.origin)) return true;
  if (share.password && text.includes(share.password)) return true;
  return false;
}

beforeAll(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; setOwnerKey(KEY); });
afterAll(() => { if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop; });
beforeEach(() => { fakeWorld(); fakeKind('board'); });
afterEach(async () => { await closeAllShares('shutdown'); });

describe('POST /api/shares (create)', () => {
  it('opens from the owner\'s page and answers at once with no secret', async () => {
    const r = await call(handleShareCreate, 'POST', OWNER_CLICK, { kind: 'board', vault: 'demo', slug: 'lansman', password: 'kuzey-limon-pencere' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'board', state: 'starting', password: true, existing: false });
    const s = getShare(String(r.body.id))!;
    expect(carriesSecret(r.body, s)).toBe(false);
    for (const k of SECRET_KEYS) if (k !== 'password') expect(r.body).not.toHaveProperty(k);
  });

  it('refuses an agent\'s curl, a page without the key and another origin: 403 owner_page_only', async () => {
    const without = (k: string) => { const h = { ...OWNER_CLICK } as Record<string, string>; delete h[k]; return h; };
    for (const h of [CLI, without(OWNER_KEY_HEADER), { ...OWNER_CLICK, origin: 'http://127.0.0.1:5173' }, { ...OWNER_CLICK, [OWNER_KEY_HEADER]: 'aa'.repeat(32) }, { ...OWNER_CLICK, 'sec-fetch-site': 'cross-site' }]) {
      const r = await call(handleShareCreate, 'POST', h, { kind: 'board', vault: 'demo', slug: 'x' });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('owner_page_only');
    }
  });

  it('refuses a short password and an unknown kind', async () => {
    expect((await call(handleShareCreate, 'POST', OWNER_CLICK, { kind: 'board', vault: 'demo', slug: 'x', password: 'short' })).body.error).toBe('weak_password');
    expect((await call(handleShareCreate, 'POST', OWNER_CLICK, { kind: 'file', vault: 'demo', slug: 'x' })).body.error).toBe('bad_kind');
  });
});

describe('GET /api/shares (list)', () => {
  it('never carries the link, token or password, even with the owner key and no Origin', async () => {
    const s = await openAndWait(() => openShare({ kind: 'board', vault: 'demo', slug: 'listed', password: 'kuzey-limon-pencere' }).share);
    const { origin: _o, ...keyNoOrigin } = OWNER_CLICK;
    for (const h of [keyNoOrigin, OWNER_CLICK, CLI]) {
      const r = await call(handleShareList, 'GET', h);
      expect(r.status).toBe(200);
      const rows = r.body.shares as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: s.id, state: 'open', password: true, people: 0 });
      expect(carriesSecret(r.body, s)).toBe(false);
      expect(r.raw).not.toContain('trycloudflare');
    }
  });
});

describe('POST /api/shares/:id/reveal', () => {
  it('gives the owner\'s page the link and password of an open share, nobody else', async () => {
    const s = await openAndWait(() => openShare({ kind: 'board', vault: 'demo', slug: 'rev', password: 'kuzey-limon-pencere' }).share);
    const ok = await call(handleShareReveal, 'POST', OWNER_CLICK, undefined, { id: s.id });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ link: `${s.origin}/k/${s.token}`, password: 'kuzey-limon-pencere' });
    const curl = await call(handleShareReveal, 'POST', CLI, undefined, { id: s.id });
    expect(curl.status).toBe(403);
    expect(curl.body.error).toBe('owner_page_only');
    expect(carriesSecret(curl.body, s)).toBe(false);
  });

  it('answers 404 for a share that is not open', async () => {
    const r = await call(handleShareReveal, 'POST', OWNER_CLICK, undefined, { id: 'nope' });
    expect(r.status).toBe(404);
  });
});

describe('POST /api/shares/:id/close', () => {
  it('lets the CLI close one and all', async () => {
    const a = await openAndWait(() => openShare({ kind: 'board', vault: 'demo', slug: 'c1' }).share);
    const b = await openAndWait(() => openShare({ kind: 'board', vault: 'demo', slug: 'c2' }).share);
    const r = await call(handleShareClose, 'POST', CLI, { via: 'cli' }, { id: a.id });
    expect(r.status).toBe(200);
    expect(a.state).toBe('closing');
    const all = await call(handleShareClose, 'POST', CLI, { via: 'cli' }, { id: 'all' });
    expect(all.status).toBe(200);
    expect(b.state).toBe('closing');
    await waitFor(() => getShare(a.id) === null && getShare(b.id) === null);
  });
});

describe('the other doors', () => {
  it('the phone\'s route policy denies all four', () => {
    for (const k of ['GET /api/shares', 'POST /api/shares', 'POST /api/shares/:id/reveal', 'POST /api/shares/:id/close']) {
      expect(ROUTE_POLICY[k]?.allow).toBe(false);
    }
  });

  it('an app\'s gateway may not list or close shares', () => {
    expect(deniedForEveryone('/api/shares')).toBe(true);
    expect(deniedForEveryone('/api/shares/abc/close')).toBe(true);
  });
});
