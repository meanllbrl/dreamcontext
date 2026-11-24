/**
 * `POST /api/agents/work/select` and its loopback client (plan uye-gecmis-is C3, G3), and the
 * sweep that traces every transcript of a member at the index build (D4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { handleAgentWorkSelect, sweepMember } from '../../src/server/routes/agent-work.js';
import { selectViaServer, workIndex } from '../../src/lib/agents/work-index.js';
import { readAllTraces, workRoot, writeTrace, traceId, type WorkTrace } from '../../src/lib/agents/work-trace.js';
import { projectKey, recordAgentSession } from '../../src/lib/local-store.js';
import { Tx, makeMachine, globalMember, putClaude, type Machine } from '../helpers/work-trace-fixtures.js';

let m: Machine;
let server: Server;
let port: number;
let lateMs = 0;

beforeEach(async () => {
  m = makeMachine();
  globalMember(m, 'mira');
  workIndex.reset();
  workIndex.hooks = { home: m.home };
  lateMs = 0;
  const ctx = join(m.project('kestrel'), '_dream_context');
  server = createServer((req, res) => {
    const go = () => void handleAgentWorkSelect(req, res, {}, ctx);
    if (lateMs) setTimeout(go, lateMs); else go();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  workIndex.reset();
  workIndex.hooks = {};
  m.dispose();
});

const trace = (key: string, ask: string): WorkTrace => ({
  v: 1, id: traceId(key), key, kind: 'job', at: '2026-11-20T10:00:00.000Z',
  project: { key: projectKey(m.project('lumen')), name: 'lumen', root: m.project('lumen') },
  asks: [{ by: 'owner', text: ask }], did: 'done', files: ['/p/lumen/x.ts'], status: 'ok', through: 1, transcript: key.split(':')[0],
});

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agents/work/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

describe('the route', () => {
  it('answers empty during the build, then the warm index\'s lines; search mode returns every hit', async () => {
    await writeTrace({ slug: 'mira', projectRoot: m.project('lumen'), home: m.home }, trace('s1:a', 'stripe test keys secret card placement'));
    const body = { member: 'mira', root: m.project('kestrel'), query: 'where are the stripe test keys', audience: 'owner' };
    expect((await post(body)).json).toEqual({ lines: [], more: false });
    await workIndex.whenBuilt('mira', m.project('kestrel'));
    const sel = await selectViaServer(body as Parameters<typeof selectViaServer>[0], { port });
    expect(sel?.lines.map((l) => l.id)).toEqual([traceId('s1:a')]);
    const search = await post({ ...body, mode: 'search', all: true });
    expect((search.json.hits as unknown[]).length).toBe(1);
  });

  it('refuses a bad body, an unknown project and a non-loopback caller', async () => {
    expect((await post({ member: '../x', root: m.project('kestrel'), query: 'q' })).status).toBe(400);
    expect((await post({ member: 'mira', root: m.project('kestrel'), query: '  ' })).status).toBe(400);
    expect((await post({ member: 'mira', root: m.root, query: 'q' })).status).toBe(409);
    let status = 0;
    const res = { statusCode: 0, setHeader() {}, writeHead(s: number) { status = s; return this; }, end() {} } as unknown as Parameters<typeof handleAgentWorkSelect>[1];
    await handleAgentWorkSelect({ socket: { remoteAddress: '10.0.0.7' }, headers: {} } as unknown as Parameters<typeof handleAgentWorkSelect>[0], res, {}, '');
    expect(status || (res as unknown as { statusCode: number }).statusCode).toBe(403);
  });
});

describe('the client (G3: no server, late or broken = no block)', () => {
  it('a down server is null', async () => {
    const free = port;
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    expect(await selectViaServer({ member: 'mira', root: '/x', query: 'q', audience: 'owner' }, { port: free, timeoutMs: 300 })).toBeNull();
  });
  it('a late answer is null within the timeout', async () => {
    lateMs = 1_000;
    const t0 = Date.now();
    expect(await selectViaServer({ member: 'mira', root: m.project('kestrel'), query: 'q words', audience: 'owner' }, { port, timeoutMs: 200 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(800);
  });
});

describe('the sweep (D4)', () => {
  it('traces a global member\'s transcripts in every project it is in, once', async () => {
    putClaude(m, 'sess-k', new Tx().user('kestrel upsell one tap').say('added').write('/p/k.tsx').jsonl());
    putClaude(m, 'sess-l', new Tx().user('lumen stripe keys').say('placed').jsonl());
    recordAgentSession(m.project('kestrel'), 'mira', 'sess-k', 'chat', m.home);
    recordAgentSession(m.project('lumen'), 'mira', 'sess-l', 'chat', m.home);
    await sweepMember('mira', m.project('kestrel'), m.home);
    await sweepMember('mira', m.project('lumen'), m.home);
    await sweepMember('mira', m.project('lumen'), m.home);
    const all = readAllTraces(workRoot('mira', m.project('kestrel'), m.home)!);
    expect(all.map((t) => t.transcript).sort()).toEqual(['sess-k', 'sess-l']);
  });
});
