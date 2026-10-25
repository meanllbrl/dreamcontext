/**
 * The remote Super stage (hands-free sekmeler W1, AC10/AC14): what a computer or landscape tablet
 * on the tunnel may read of the stage and arrange on it.
 *
 *  - `superRemoteView` is an ALLOWLIST: over a record with every field filled with markers
 *    (worktree paths, briefs, prompts, branches, owner text, private and loopback addresses, the
 *    tunnel's own host) none reaches the output, and a field added to the record later does not
 *    either;
 *  - the three routes answer only a phone socket, only while handed over, with that view;
 *  - the layout door takes only the arranging keys: every refused key is 400 and changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superRemoteView, isMacOnlyHost, titleFromBrief } from '../../src/lib/super/remote-view.js';
import { checkRemoteLayout } from '../../src/server/routes/super-remote.js';
import { SUPER_VERB_HANDLERS, type SuperCaller } from '../../src/server/routes/super.js';
import type { ServerResponse } from 'node:http';
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
const SECRETS = [
  '/Users/someone', 'BRIEF-MARKER', 'PROMPT-MARKER', 'super/secret-branch', 'OWNER-TEXT-MARKER', 'MCP-MARKER', 'BASE-MARKER',
  'MEMBER-MARKER', 'DISMISSED-MARKER', 'localhost', '127.0.0.1', '10.0.0.7', '172.16.4.2', '192.168.1.20', '[::1]', 'printer.local',
  TUNNEL, 'NEW-FIELD-MARKER', 'HELD-MARKER', 'POOL-TITLE-MARKER',
];

/** A record with every field filled, markers in every place that must not travel. */
function fullRecord(): SuperState & Record<string, unknown> {
  const wt = '/Users/someone/.claude-worktrees/acme-kid';
  return {
    ...emptySuperState(),
    session: 'sess-1', enabled: true,
    containers: [
      { id: 'chat-kid', kind: 'chat', ref: 'kid', shape: 'tall', place: 'float', title: 'Fix login', size: 'large', sizeBy: 'owner', pos: { x: 1, y: 2 }, forChild: 'kid', forAt: 3 },
      { id: 'img-1', kind: 'image', ref: 'docs/shot.png', shape: 'square', place: 'float', title: 'Shot' },
      { id: 'img-abs', kind: 'image', ref: '/Users/someone/secret.png', shape: 'square', place: 'others' },
      { id: 'task-1', kind: 'task', ref: 'my-task', shape: 'square', place: 'float' },
      { id: 'web-ok', kind: 'web', ref: 'https://example.com/page', shape: 'square', place: 'float' },
      { id: 'web-lo', kind: 'web', ref: 'http://localhost:5173/', shape: 'square', place: 'float' },
      { id: 'web-127', kind: 'web', ref: 'http://127.0.0.1:3000/x', shape: 'square', place: 'float' },
      { id: 'web-10', kind: 'web', ref: 'https://10.0.0.7/', shape: 'square', place: 'float' },
      { id: 'web-172', kind: 'web', ref: 'https://172.16.4.2/', shape: 'square', place: 'float' },
      { id: 'web-192', kind: 'web', ref: 'http://192.168.1.20/', shape: 'square', place: 'float' },
      { id: 'web-v6', kind: 'web', ref: 'https://[::1]:8080/', shape: 'square', place: 'float' },
      { id: 'web-local', kind: 'web', ref: 'https://printer.local/', shape: 'square', place: 'float' },
      { id: 'web-tunnel', kind: 'web', ref: `${ORIGIN}/chat`, shape: 'square', place: 'float' },
      { id: 'browser-1', kind: 'browser', ref: 'http://localhost:9222/', shape: 'square', place: 'float' },
    ] as SuperState['containers'],
    view: { mode: 'present', cards: ['img-1', 'task-1'], layout: 'compare', layoutBy: 'owner', auto: true } as SuperState['view'],
    children: {
      kid: {
        sessionId: 'kid', brief: 'BRIEF-MARKER', adopted: false, startedAt: 10, worktree: wt, branch: 'super/secret-branch',
        task: 'my-task', mode: 'develop', model: 'opus', effort: 'high', mcp: ['MCP-MARKER'], row: 'working', finishedAt: 20, seenAt: 21,
      },
    },
    queue: [
      { id: 'q-1', sessionId: 'kid', kind: 'done', state: 'done', createdAt: 1, ownerText: 'OWNER-TEXT-MARKER', brief: 'BRIEF-MARKER', member: 'MEMBER-MARKER' },
      { id: 'q-2', sessionId: 'kid', kind: 'permission', requestId: 'r', state: 'pending', createdAt: 2, ownerText: 'OWNER-TEXT-MARKER' },
    ],
    notes: { kid: 'handover' },
    dismissed: [{ kind: 'web', ref: 'DISMISSED-MARKER', until: 9 }],
    pool: [{ id: 'p-1', title: 'POOL-TITLE-MARKER', prompt: 'PROMPT-MARKER', hash: 'h', base: 'BASE-MARKER', worktree: wt, createdAt: 1 }],
    team: [{ id: 'team-1', member: 'MEMBER-MARKER', runId: 'r', jobKind: 'run', queued: false, brief: 'BRIEF-MARKER', startedAt: 1 }],
    held: [{ item: 'HELD-MARKER', child: 'kid', kind: 'question', at: 1 }],
    newFieldNobodyAllowlisted: 'NEW-FIELD-MARKER',
  } as unknown as SuperState & Record<string, unknown>;
}

describe('superRemoteView is an allowlist (AC14)', () => {
  it('no marker of a filled record reaches the view, and a new record field does not either', () => {
    const rec = fullRecord();
    (rec.containers[0] as unknown as Record<string, unknown>).aNewCardField = 'NEW-FIELD-MARKER';
    (rec.children.kid as unknown as Record<string, unknown>).aNewChildField = 'NEW-FIELD-MARKER';
    const out = JSON.stringify(superRemoteView(rec, 'acme', TUNNEL));
    for (const m of SECRETS) expect(out, m).not.toContain(m);
  });

  it('keeps what the stage draws: an https page, project files, slugs, a child\'s row; blocks the rest by host only', () => {
    const v = superRemoteView(fullRecord(), 'acme', TUNNEL);
    const by = (id: string) => v.containers.find((c) => c.id === id);
    expect(by('web-ok')).toMatchObject({ ref: 'https://example.com/page' });
    expect(by('web-ok')?.blocked).toBeUndefined();
    for (const id of ['web-lo', 'web-127', 'web-10', 'web-172', 'web-192', 'web-v6', 'web-local', 'web-tunnel', 'browser-1', 'img-abs']) {
      expect(by(id)?.blocked, id).toBe('mac_only');
      expect(by(id)?.ref, id).toBeUndefined();
    }
    expect(by('img-1')?.ref).toBe('docs/shot.png');
    expect(by('task-1')?.ref).toBe('my-task');
    expect(by('chat-kid')).toMatchObject({ ref: 'kid', title: 'Fix login', size: 'large', sizeBy: 'owner', pos: { x: 1, y: 2 } });
    expect(v.children.kid).toEqual({ sessionId: 'kid', row: 'working', startedAt: 10, finishedAt: 20, seenAt: 21 });
    expect(v.view).toEqual({ mode: 'present', cards: ['img-1', 'task-1'], layout: 'compare', layoutBy: 'owner' });
    expect(v.head).toEqual({ item: 'q-2', kind: 'permission', text: '' });
  });

  it('the host rule', () => {
    for (const h of ['localhost', 'a.localhost', 'nas.local', '127.0.0.5', '10.1.2.3', '172.31.0.1', '192.168.0.1', '169.254.1.1', '0.0.0.0', '[::1]', '[fe80::1]', '[fd00::1]', 'intranet', TUNNEL]) {
      expect(isMacOnlyHost(h, TUNNEL), h).toBe(true);
    }
    for (const h of ['example.com', '172.32.0.1', '8.8.8.8']) expect(isMacOnlyHost(h, TUNNEL), h).toBe(false);
  });

  it('a private network name or range is the Mac\'s too: the tailnet, private suffixes, CGNAT, benchmarking', () => {
    for (const h of ['mac.tail1234.ts.net', 'ts.net', 'build.internal', 'nas.lan', 'router.home.arpa', 'wiki.intranet', 'git.corp', '100.64.0.1', '100.127.255.254', '198.18.0.1', '198.19.9.9']) {
      expect(isMacOnlyHost(h, TUNNEL), h).toBe(true);
    }
    for (const h of ['100.63.0.1', '100.128.0.1', '198.20.0.1', 'corp.example.com', 'internal.example.com']) expect(isMacOnlyHost(h, TUNNEL), h).toBe(false);
  });

  it('a chat card titled from its child\'s brief carries no title, and the agenda never names a child by it', () => {
    const rec = fullRecord();
    rec.children.kid.brief = 'BRIEF-MARKER fix the login page for the owner';
    rec.containers[0].title = 'BRIEF-MARKER fix the login';
    rec.queue[0] = { ...rec.queue[0], state: 'pending', kind: 'question' } as SuperState['queue'][number];
    const v = superRemoteView(rec, 'acme', TUNNEL);
    expect(v.containers.find((c) => c.id === 'chat-kid')?.title).toBeUndefined();
    expect(JSON.stringify(v.names)).not.toContain('BRIEF-MARKER');
    expect(JSON.stringify(v)).not.toContain('BRIEF-MARKER');
  });

  it('titleFromBrief: the brief, a cut of it, or a title that opens with it; never an unrelated title', () => {
    expect(titleFromBrief('Fix  the login', 'fix the login')).toBe(true);
    expect(titleFromBrief('Fix the', 'Fix the login page')).toBe(true);
    expect(titleFromBrief(`${'a'.repeat(40)}…`, `${'a'.repeat(60)}`)).toBe(true);
    expect(titleFromBrief('Fix login', 'Rebuild the pricing page')).toBe(false);
    expect(titleFromBrief('Fix login', undefined)).toBe(false);
    expect(titleFromBrief(undefined, 'brief')).toBe(false);
  });
});

describe('the layout door\'s allowlist (AC10)', () => {
  it('every refused key is a 400', () => {
    for (const body of [
      { closed: ['x'] }, { group: { id: 'grp-a', cards: ['a', 'b'] } }, { leave: ['a'] }, { ungroup: ['grp-a'] }, { touch: ['a'] },
      { cards: [{ id: 'a', place: 'others' }] }, { cards: [{ id: 'a', closed: true }] }, { view: { mode: 'half' } },
      { view: { mode: 'present', cards: [], extra: 1 } }, { view: { mode: 'float', auto: true } }, { exit: { cards: ['a'], closing: ['a'] } },
      { agenda: 'close' }, { cards: [{ id: 'a', pos: { x: 'left' } }] },
    ]) expect(() => checkRemoteLayout(body as Record<string, unknown>), JSON.stringify(body)).toThrow();
  });

  it('the stage\'s own gestures pass, and the view is rebuilt from its checked fields', () => {
    expect(checkRemoteLayout({ cards: [{ id: 'a', place: 'float', pos: { x: 1, y: 2 }, size: 'large', order: 'last' }] }).patch)
      .toEqual({ cards: [{ id: 'a', place: 'float', pos: { x: 1, y: 2 }, size: 'large', order: 'last' }] });
    expect(checkRemoteLayout({ exit: { cards: ['a', 'b'], closing: [] } }).patch).toEqual({ exit: { cards: ['a', 'b'], closing: [] } });
    expect(checkRemoteLayout({ view: { mode: 'half', card: 'a' } }).view).toEqual({ mode: 'half', card: 'a' });
    expect(checkRemoteLayout({ agenda: 'min', presentLayout: { layout: 'grid', cards: ['a'] }, chat: { value: null, cards: ['a'] } }).patch)
      .toMatchObject({ agenda: 'min' });
  });
});

// ─── The routes, through the real phone listener ─────────────────────────────

const PROJECT = 'remote-proj';
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
  dir = mkdtempSync(join(tmpdir(), 'super-remote-'));
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

describe('the remote stage routes', () => {
  it('answer only a phone socket: the main listener is 403 for all three', async () => {
    await seed({ enabled: true });
    const h = { 'x-dreamcontext-vault': PROJECT, origin: `http://127.0.0.1:${mainPort}` };
    expect((await request(mainPort, 'GET', '/api/agent/super-stage', h)).status).toBe(403);
    expect((await request(mainPort, 'POST', '/api/agent/super-stage/layout', h, '{}')).status).toBe(403);
    expect((await request(mainPort, 'POST', '/api/agent/super-stage/seen', h, '{"children":[{"id":"kid","at":1}]}')).status).toBe(403);
  });

  it('refuse a project that is not handed over (409 not_handed_over), writing nothing', async () => {
    await seed({ enabled: false });
    expect((await phone('GET', '/api/agent/super-stage')).status).toBe(409);
    const before = readFileSync(join(root, SUPER_STATE_REL), 'utf-8');
    const r = await phone('POST', '/api/agent/super-stage/layout', { agenda: 'open' });
    expect([r.status, JSON.parse(r.body).error]).toEqual([409, 'not_handed_over']);
    expect(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).toBe(before);
  });

  it('GET answers the allowlisted view of the handed-over record', async () => {
    await seed(fullRecord());
    const r = await phone('GET', '/api/agent/super-stage');
    expect(r.status).toBe(200);
    for (const m of SECRETS) expect(r.body, m).not.toContain(m);
    expect(JSON.parse(r.body)).toMatchObject({ vault: PROJECT, enabled: true, session: 'sess-1' });
  });

  it('every refused key is 400 and changes nothing; the answer carries no details', async () => {
    await seed({ enabled: true, containers: [{ id: 'a', kind: 'task', ref: 't', shape: 'square', place: 'float' }] as never });
    const before = readFileSync(join(root, SUPER_STATE_REL), 'utf-8');
    for (const body of [
      { closed: ['a'] }, { group: { id: 'grp-a', cards: ['a', 'a'] } }, { leave: ['a'] }, { ungroup: ['grp-a'] }, { touch: ['a'] },
      { cards: [{ id: 'a', place: 'others' }] }, { view: { mode: 'grid' } }, { view: { mode: 'half', card: 'missing' } },
      { exit: { cards: ['a'], closing: ['a'] } },
    ]) {
      const r = await phone('POST', '/api/agent/super-stage/layout', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(Object.keys(JSON.parse(r.body)).sort()).toEqual(['error', 'message']);
    }
    expect(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).toBe(before);
  });

  it('open large from Others: the card floats, an agent picture becomes the owner\'s; owner-sized as on the Mac', async () => {
    await seed({ enabled: true, containers: [{ id: 'pic', kind: 'image', ref: 'a.png', shape: 'square', place: 'others', forChild: 'kid', forAt: 5 }] as never });
    const r = await phone('POST', '/api/agent/super-stage/layout', { cards: [{ id: 'pic', place: 'float', size: 'large' }], view: { mode: 'half', card: 'pic' } });
    expect(r.status).toBe(200);
    const pic = record().containers.find((c) => c.id === 'pic');
    expect(pic).toMatchObject({ place: 'float', size: 'large', sizeBy: 'owner' });
    expect(pic?.forChild).toBeUndefined();
    expect(pic?.forAt).toBeUndefined();
    expect(record().view).toMatchObject({ mode: 'half', card: 'pic' });
    // The remote owner's size is the owner's: an agent's --size over it is refused, as on the Mac.
    const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (n: number) => void }).writeHead = (n: number) => { out.status = n; };
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
    await SUPER_VERB_HANDLERS.shape({ token: 't', who: { contextRoot: root }, state: await readSuperState(root) } as unknown as SuperCaller, { container: 'pic', shape: 'small' }, out);
    expect([out.status, out.json.error]).toEqual([409, 'owner_sized']);
    expect(JSON.parse(r.body).state.containers.find((c: { id: string }) => c.id === 'pic')).toMatchObject({ place: 'float' });
  });

  it('a `brief` change re-titles a card titled from the OLD brief, so the old brief never reaches the view', async () => {
    const kid = 'bbbbbbbb-0000-4000-8000-00000000000b';
    await seed({
      enabled: true,
      children: { [kid]: { sessionId: kid, brief: 'OLD-BRIEF-MARKER fix the login page', adopted: false, startedAt: 1 } } as never,
      containers: [
        { id: 'c-kid', kind: 'chat', ref: kid, shape: 'tall', place: 'float', title: 'OLD-BRIEF-MARKER fix the login page' },
        { id: 'c-other', kind: 'chat', ref: kid, shape: 'tall', place: 'others', title: 'Owner named this' },
      ] as never,
    });
    const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (n: number) => void }).writeHead = (n: number) => { out.status = n; };
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
    await SUPER_VERB_HANDLERS.brief({ token: 't', who: { contextRoot: root }, state: await readSuperState(root) } as unknown as SuperCaller, { child: kid, line: 'Waiting on the login fix' }, out);
    expect(out.status).toBe(200);
    const titles = record().containers.map((c) => c.title);
    expect(titles).toEqual(['Waiting on the login fix', 'Owner named this']);
    const r = await phone('GET', '/api/agent/super-stage');
    expect(r.body).not.toContain('OLD-BRIEF-MARKER');
    expect(r.body).not.toContain('Waiting on the login fix');
    expect(r.body).toContain('Owner named this');
  });

  it('minimise during a presentation (exit with an empty closing) lands; a stale card set is dropped', async () => {
    await seed({
      enabled: true, view: { mode: 'present', cards: ['a', 'b'] } as never,
      containers: [{ id: 'a', kind: 'task', ref: 't', shape: 'square', place: 'float' }, { id: 'b', kind: 'task', ref: 'u', shape: 'square', place: 'float' }] as never,
    });
    const stale = await phone('POST', '/api/agent/super-stage/layout', { presentLayout: { layout: 'grid', cards: ['a'] } });
    expect(stale.status).toBe(200);
    expect(record().view.layout).not.toBe('grid');
    expect(record().view.layoutBy).toBeUndefined();
    const r = await phone('POST', '/api/agent/super-stage/layout', { exit: { cards: ['a', 'b'], closing: [] } });
    expect(r.status).toBe(200);
    expect(record().view.mode).toBe('float');
  });

  it('seen raises seenAt and answers the view', async () => {
    await seed({ enabled: true, children: { kid: { sessionId: 'kid', brief: 'BRIEF-MARKER', adopted: false, startedAt: 1, finishedAt: 50 } } as never });
    const r = await phone('POST', '/api/agent/super-stage/seen', { children: [{ id: 'kid', at: 50 }] });
    expect(r.status).toBe(200);
    expect(record().children.kid.seenAt).toBe(50);
    expect(r.body).not.toContain('BRIEF-MARKER');
  });

  it('/api/super/* stays laptop-only on the phone', async () => {
    await seed({ enabled: true });
    for (const [m, p] of [['GET', '/api/super/state'], ['POST', '/api/super/layout'], ['POST', '/api/super/seen'], ['POST', '/api/super/enable']]) {
      expect((await phone(m, p, m === 'POST' ? {} : undefined)).status, p).toBe(403);
    }
  });
});
