/**
 * Hackathon criterion 4: start, resume, pick and pr are the owner's alone. They refuse a request
 * carrying the agent's window token (even with the owner key) and any request without the app's
 * own page and key; the listener-wide backstop closes their no-Origin pass. Stop stays open to
 * any local caller. A Başlat whose design hash no longer matches answers 409 design_changed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  HACKATHON_ROUTES, handleHackathonPick, handleHackathonPr, handleHackathonResume, handleHackathonStart, handleHackathonStop, ownerWriteRefusal,
} from '../../src/server/routes/hackathon.js';
import { isCrossSiteWrite, isOwnerCardWrite } from '../../src/server/middleware.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { WINDOW_TOKEN_HEADER } from '../../src/lib/window-control.js';
import { createRun, designHash, newRunId, readRun, type RunRecord } from '../../src/lib/hackathon/run-store.js';
import { validateDesign } from '../../src/lib/hackathon/designer.js';

const KEY = 'c4'.repeat(32);
const ORIGIN = 'http://127.0.0.1:4173';
const OWNER = { host: '127.0.0.1:4173', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', [OWNER_KEY_HEADER]: KEY };
const AGENT = { host: '127.0.0.1:4173', 'content-type': 'application/json' };
const repo = join(__dirname, '..', '..');

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string) => Promise<void>;

let root: string;
let ctx: string;
const saved = { ...process.env };

function req(method: string, url: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return Object.assign(Readable.from(chunks), {
    method, url, headers,
    socket: { remoteAddress: '127.0.0.1', setTimeout() {} },
    setTimeout() {},
  }) as unknown as IncomingMessage;
}

async function call(h: Handler, run: string, action: string, headers: Record<string, string>, body: unknown = {}) {
  let status = 0;
  let raw = '';
  const res = {
    writableEnded: false, destroyed: false,
    writeHead(code: number) { status = code; return this; },
    setHeader() {},
    end(data?: string | Buffer) { raw = data === undefined ? '' : String(data); },
  } as unknown as ServerResponse;
  await h(req('POST', `/api/hackathon/${run}/${action}`, headers, body), res, { run }, ctx);
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  return { status, body: parsed };
}

function seed(state: RunRecord['state'] = 'awaiting-owner'): RunRecord {
  const design = validateDesign({
    kind: 'plan', problem: 'Gelir artıracak funnel testi', target: root,
    teams: [{ id: 'alfa', name: 'Alfa', tool: 'claude' }, { id: 'beta', name: 'Beta', tool: 'claude' }],
    rounds: 2, roundMinutes: 20,
  }, { codexUsable: false }, new Date('2026-11-18T10:00:00Z')).design;
  const id = newRunId(ctx, design.problem, new Date('2026-11-18T10:00:00Z'));
  const r: RunRecord = { version: 1, id, problem: design.problem, state, createdAt: '2026-11-18T10:00:00Z', design };
  createRun(ctx, r);
  return r;
}

beforeAll(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });
afterAll(() => {
  setOwnerKey(null);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});
beforeEach(() => {
  setOwnerKey(KEY);
  root = mkdtempSync(join(tmpdir(), 'hk-routes-'));
  ctx = join(root, '_dream_context');
  mkdirSync(ctx);
  process.env.DREAMCONTEXT_HACKATHON_HOME = join(root, 'ws');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('owner-only hackathon writes', () => {
  const owned: [string, Handler][] = [
    ['start', handleHackathonStart], ['resume', handleHackathonResume], ['pick', handleHackathonPick], ['pr', handleHackathonPr],
  ];

  it.each(owned)('%s refuses an agent call without the owner page and key', async (action, h) => {
    const r = seed();
    const out = await call(h, r.id, action, AGENT, { designHash: designHash(r), team: 'alfa' });
    expect(out.status).toBe(403);
    expect(JSON.stringify(out.body)).toContain('owner_page_only');
    expect(readRun(ctx, r.id)?.state).toBe('awaiting-owner');
  });

  it.each(owned)('%s refuses the window token even with the owner page and key', async (action, h) => {
    const r = seed();
    const out = await call(h, r.id, action, { ...OWNER, [WINDOW_TOKEN_HEADER]: 'tok-123' }, { designHash: designHash(r), team: 'alfa' });
    expect(out.status).toBe(403);
    expect(readRun(ctx, r.id)?.state).toBe('awaiting-owner');
  });

  it('the owner page passes the gate; a stale design hash answers 409 design_changed', async () => {
    const r = seed();
    expect(ownerWriteRefusal(req('POST', '/', OWNER))).toBeNull();
    const out = await call(handleHackathonStart, r.id, 'start', OWNER, { designHash: 'f'.repeat(64) });
    expect(out.status).toBe(409);
    expect(JSON.stringify(out.body)).toContain('design_changed');
    expect(readRun(ctx, r.id)?.state).toBe('awaiting-owner');
  });

  it('stop is open to any local caller', async () => {
    const r = seed();
    const out = await call(handleHackathonStop, r.id, 'stop', AGENT);
    expect(out.status).toBe(200);
    expect(readRun(ctx, r.id)?.state).toBe('stopped');
  });

  it('the listener backstop closes the no-Origin pass for the four, not for stop', () => {
    const id = '20261118-gelir-testi';
    for (const a of ['start', 'resume', 'pick', 'pr']) {
      const q = req('POST', `/api/hackathon/${id}/${a}`, AGENT);
      expect(isOwnerCardWrite(q)).toBe(true);
      expect(isCrossSiteWrite(q)).toBe(true);
    }
    const stop = req('POST', `/api/hackathon/${id}/stop`, AGENT);
    expect(isOwnerCardWrite(stop)).toBe(false);
    expect(isCrossSiteWrite(stop)).toBe(false);
  });

  it('every listed route is registered on the server', () => {
    const index = readFileSync(join(repo, 'src', 'server', 'index.ts'), 'utf-8');
    for (const p of HACKATHON_ROUTES.get) expect(index).toContain(`router.get('${p}'`);
    for (const p of HACKATHON_ROUTES.post) expect(index).toContain(`router.post('${p}'`);
  });
});
