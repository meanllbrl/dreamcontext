/**
 * The return recap's server half (plan-r7 D13): `POST /api/super/recap`.
 *
 * The window calls it when the owner comes back after >= 10 min away (the client half,
 * `shouldRecap`, is tested in super-handover-model.test.ts). The route decides from the
 * record's own `away` counter:
 *  - handed over, nothing happened (away.events = 0) → `{ queued: false }`, no recap item;
 *  - handed over, >= 1 event → `{ queued: true }`, ONE pending recap item for the super session,
 *    and `away` starts over;
 *  - a second call, or a recap already pending → still ONE pending recap item;
 *  - not handed over → `{ queued: false }`, the record is not touched.
 *
 * Driven through the real route handler with the owner's door satisfied the way
 * super-route-auth.test.ts does it (desktop app, loopback, loopback Host).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox, _superInboxDrained } from '../../src/lib/super/inbox.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { handleSuperRecap } from '../../src/server/routes/super.js';

let dir: string;
let root: string;
const savedEnv = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP };

const SESSION = 'sess-recap';
const CHILD = 'child-recap';

function makeVault(state: Record<string, unknown>): string {
  const r = join(dir, 'acme', '_dream_context');
  mkdirSync(join(r, 'state'), { recursive: true });
  writeFileSync(join(r, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), ...state }));
  return r;
}

const handedOver = (extra: Record<string, unknown> = {}) => ({
  session: SESSION,
  enabled: true,
  children: { [CHILD]: { sessionId: CHILD, brief: '', adopted: true, startedAt: 1 } },
  ...extra,
});

beforeEach(() => {
  resetWindowControl();
  resetSuperIndex();
  _resetSuperInbox();
  dir = mkdtempSync(join(tmpdir(), 'super-recap-'));
  process.env.HOME = join(dir, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(async () => {
  // A recap that queued fires a pump nobody awaits: let it finish before the vault goes.
  await _superInboxDrained();
  _resetSuperInbox();
  resetSuperIndex();
  // Restore IN PLACE, key by key: never replace `process.env` itself.
  if (savedEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = savedEnv.HOME;
  if (savedEnv.DESKTOP === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedEnv.DESKTOP;
  rmSync(dir, { recursive: true, force: true });
});

function req(): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173' }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(''); });
  return r;
}

function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

async function recap() {
  const r = res();
  await handleSuperRecap(req(), r, {}, root);
  return r;
}

async function pendingRecaps() {
  const s = await readSuperState(root);
  return s.queue.filter((q) => q.kind === 'recap' && q.state === 'pending');
}

const rawFile = () => readFileSync(join(root, SUPER_STATE_REL), 'utf-8');

describe('POST /api/super/recap', () => {
  it('handed over, nothing happened while away → { queued: false }, no recap item', async () => {
    root = makeVault(handedOver({ away: { since: Date.now() - 20 * 60_000, events: 0 } }));
    const r = await recap();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ queued: false });
    expect(await pendingRecaps()).toHaveLength(0);
    expect((await readSuperState(root)).queue.some((q) => q.kind === 'recap')).toBe(false);
  });

  it('handed over, >= 1 event while away → { queued: true }, ONE pending recap for the super session, away reset', async () => {
    root = makeVault(handedOver({ away: { since: Date.now() - 20 * 60_000, events: 3 } }));
    const r = await recap();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ queued: true });
    const items = await pendingRecaps();
    expect(items).toHaveLength(1);
    expect(items[0].sessionId).toBe(SESSION);
    expect((await readSuperState(root)).away).toEqual({ since: null, events: 0 });
  });

  it('called twice in a row → still exactly one pending recap item', async () => {
    root = makeVault(handedOver({ away: { since: Date.now() - 20 * 60_000, events: 1 } }));
    expect((await recap()).json).toEqual({ queued: true });
    // The first call reset `away`: the second has nothing to recap.
    expect((await recap()).json).toEqual({ queued: false });
    expect(await pendingRecaps()).toHaveLength(1);
  });

  it('a recap already pending and new events since → no second recap item', async () => {
    const existing = { id: 'q-old-recap', sessionId: SESSION, kind: 'recap', state: 'pending', createdAt: 1 };
    root = makeVault(handedOver({ queue: [existing], away: { since: Date.now() - 20 * 60_000, events: 2 } }));
    const r = await recap();
    expect(r.status).toBe(200);
    const items = await pendingRecaps();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('q-old-recap');
    expect((await readSuperState(root)).away).toEqual({ since: null, events: 0 });
  });

  it('not handed over (enabled false) → { queued: false }, nothing written', async () => {
    root = makeVault({ session: SESSION, enabled: false, away: { since: Date.now() - 20 * 60_000, events: 4 } });
    const before = rawFile();
    const mtimeBefore = statSync(join(root, SUPER_STATE_REL)).mtimeMs;
    const r = await recap();
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ queued: false });
    expect(rawFile()).toBe(before);
    expect(statSync(join(root, SUPER_STATE_REL)).mtimeMs).toBe(mtimeBefore);
    expect(await pendingRecaps()).toHaveLength(0);
  });
});
