/**
 * The agenda's server half (task super-agent-ajandasi-suren-bekleyen-biten-ve-siradaki-isler-
 * tek-bakista, plan r2 D4/D5):
 *  - `setRow` stamps `finishedAt` only when a job FINISHES (a not-finished row, or a row-less
 *    child that never finished, moving to done/gone), never on done <-> gone or on the reconcile's
 *    gone -> (no row) -> done; it clears `etaAt` on done/gone and keeps it on asking/stuck;
 *  - `POST /api/super/seen` (the owner's door; auth in super-route-auth.test.ts) raises `seenAt`
 *    to the finish key the window SHOWED, never lowers it, ignores unknown children, refuses a
 *    malformed body, and the record keeps it across a re-read;
 *  - the store keeps finishedAt/seenAt/etaAt and drops non-finite or negative values;
 *  - `super brief --eta` takes whole minutes 0..1440 (0 clears), anything else is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox, setRow } from '../../src/lib/super/inbox.js';
import { emptySuperState, type SuperChild } from '../../src/lib/super/types.js';
import { MAX_ETA_MIN, SUPER_OWNER_HANDLERS, SUPER_VERB_HANDLERS, etaMinutes, type SuperCaller } from '../../src/server/routes/super.js';

let dir: string;
let root: string;
const SESSION = 'sess-agenda';
const A = 'child-a';
const B = 'child-b';

const child = (sid: string, o: Partial<SuperChild> = {}): SuperChild => ({ sessionId: sid, brief: '', adopted: true, startedAt: 1, ...o });

function makeVault(children: Record<string, unknown>): string {
  const r = join(dir, 'acme', '_dream_context');
  mkdirSync(join(r, 'state'), { recursive: true });
  writeFileSync(join(r, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SESSION, enabled: true, children }));
  return r;
}

function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

async function seen(body: Record<string, unknown>) {
  const r = res();
  await SUPER_OWNER_HANDLERS.seen({} as never, r, root, body);
  return r;
}

beforeEach(() => {
  resetSuperIndex();
  _resetSuperInbox();
  dir = mkdtempSync(join(tmpdir(), 'super-agenda-'));
});
afterEach(() => {
  _resetSuperInbox();
  resetSuperIndex();
  rmSync(dir, { recursive: true, force: true });
});

describe('setRow: a job finishes once, and its estimate goes with it', () => {
  it('working -> done stamps finishedAt and clears etaAt; done -> gone and gone -> done keep it', () => {
    const ch = child(A, { row: 'working', etaAt: 500 });
    setRow(ch, 'done', undefined, 100);
    expect(ch).toMatchObject({ row: 'done', finishedAt: 100 });
    expect(ch.etaAt).toBeUndefined();
    setRow(ch, 'gone', undefined, 200);
    expect(ch.finishedAt).toBe(100);
    // The reconcile clears a gone row when the chat is live again, then derives done.
    delete ch.row;
    setRow(ch, 'done', undefined, 300);
    expect(ch.finishedAt).toBe(100);
  });

  it('a new run that finishes again is a new finish; a v1 child with no row finishes on its first done', () => {
    const ch = child(A, { row: 'done', finishedAt: 100 });
    setRow(ch, 'working', undefined, 200);
    expect(ch.finishedAt).toBe(100);
    setRow(ch, 'done', undefined, 300);
    expect(ch.finishedAt).toBe(300);
    const v1 = child(B);
    setRow(v1, 'done', undefined, 400);
    expect(v1.finishedAt).toBe(400);
  });

  it('asking and stuck keep the estimate (the owner answers, the job goes on)', () => {
    const ch = child(A, { row: 'working', etaAt: 900 });
    setRow(ch, 'asking', undefined, 100);
    expect(ch.etaAt).toBe(900);
    setRow(ch, 'stuck', 'stale', 200);
    expect(ch.etaAt).toBe(900);
    expect(ch.finishedAt).toBeUndefined();
  });
});

describe('POST /api/super/seen (the owner looked at finished jobs)', () => {
  it('raises seenAt to the shown finish key, never lowers it, ignores unknown children; survives a re-read', async () => {
    root = makeVault({ [A]: child(A, { row: 'done', finishedAt: 100 }), [B]: child(B, { row: 'done', finishedAt: 200, seenAt: 250 }) });
    const r = await seen({ children: [{ id: A, at: 100 }, { id: B, at: 200 }, { id: 'child-nobody', at: 5 }] });
    expect(r.status).toBe(200);
    resetSuperIndex();
    const s = await readSuperState(root);
    expect(s.children[A].seenAt).toBe(100);
    expect(s.children[B].seenAt).toBe(250);
    expect(s.children['child-nobody']).toBeUndefined();
  });

  it('a key from the future is clamped to now (it can never pre-see a later finish)', async () => {
    root = makeVault({ [A]: child(A, { row: 'done', finishedAt: 100 }) });
    const before = Date.now();
    expect((await seen({ children: [{ id: A, at: Number.MAX_SAFE_INTEGER }] })).status).toBe(200);
    const s = await readSuperState(root);
    expect(s.children[A].seenAt).toBeGreaterThanOrEqual(before);
    expect(s.children[A].seenAt).toBeLessThanOrEqual(Date.now());
  });

  it('refuses an empty, oversized or malformed body and writes nothing', async () => {
    root = makeVault({ [A]: child(A, { row: 'done', finishedAt: 100 }) });
    const file = () => readFileSync(join(root, SUPER_STATE_REL), 'utf-8');
    const was = file();
    for (const body of [{}, { children: [] }, { children: 'all' }, { children: [{ id: A }] }, { children: [{ id: A, at: -1 }] },
      { children: [{ id: '../x', at: 1 }] }, { children: Array.from({ length: 49 }, () => ({ id: A, at: 1 })) }]) {
      expect((await seen(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(file()).toBe(was);
  });
});

describe('the record keeps the agenda stamps, and only sane ones', () => {
  it('finite, non-negative values survive a read; junk is dropped', async () => {
    root = makeVault({
      [A]: { ...child(A, { row: 'done' }), finishedAt: 100, seenAt: 90, etaAt: 1234 },
      [B]: { ...child(B, { row: 'working' }), finishedAt: 'soon', seenAt: -5, etaAt: null },
    });
    const s = await readSuperState(root);
    expect(s.children[A]).toMatchObject({ finishedAt: 100, seenAt: 90, etaAt: 1234 });
    expect(s.children[B].finishedAt).toBeUndefined();
    expect(s.children[B].seenAt).toBeUndefined();
    expect(s.children[B].etaAt).toBeUndefined();
  });

  it('a seenAt from the future is read as now (it could otherwise hide every later finish)', async () => {
    root = makeVault({ [A]: { ...child(A, { row: 'done' }), finishedAt: 100, seenAt: 9e15 } });
    const before = Date.now();
    const s = await readSuperState(root);
    expect(s.children[A].seenAt).toBeGreaterThanOrEqual(before);
    expect(s.children[A].seenAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('super brief --eta', () => {
  it('whole minutes 0..1440, absent keeps, anything else is refused', () => {
    expect(etaMinutes(undefined)).toBeUndefined();
    expect(etaMinutes('')).toBeUndefined();
    expect(etaMinutes('0')).toBe(0);
    expect(etaMinutes('15')).toBe(15);
    expect(etaMinutes(String(MAX_ETA_MIN))).toBe(MAX_ETA_MIN);
    for (const bad of [String(MAX_ETA_MIN + 1), '-1', '1.5', '10m', 'soon', 1.5, -3]) expect(etaMinutes(bad), String(bad)).toBe('bad');
  });
});

describe('super brief --eta, through the verb', () => {
  async function brief(body: Record<string, unknown>) {
    const r = res();
    const caller = { token: 't', who: { contextRoot: root }, state: await readSuperState(root) } as unknown as SuperCaller;
    await SUPER_VERB_HANDLERS.brief(caller, body, r);
    return r;
  }
  it('sets the estimate on a working job, 0 clears it, a bad value is refused, a finished job gets none', async () => {
    root = makeVault({ [A]: child(A, { row: 'working' }), [B]: child(B, { row: 'done', finishedAt: 100 }) });
    const before = Date.now();
    expect((await brief({ child: A, line: 'rendering', eta: '15' })).status).toBe(200);
    let s = await readSuperState(root);
    expect(s.children[A].etaAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect((await brief({ child: A, line: 'still rendering' })).status).toBe(200);
    s = await readSuperState(root);
    expect(s.children[A].etaAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect((await brief({ child: A, line: 'x', eta: '2000' })).status).toBe(400);
    expect((await brief({ child: A, line: 'done soon', eta: '0' })).status).toBe(200);
    s = await readSuperState(root);
    expect(s.children[A].etaAt).toBeUndefined();
    expect((await brief({ child: B, line: 'shipped', eta: '30' })).status).toBe(200);
    s = await readSuperState(root);
    expect(s.children[B].etaAt).toBeUndefined();
  });
});
