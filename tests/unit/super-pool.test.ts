/**
 * The job pool, `super ask`, `delegate --from/--task` and the record's caps (plan r4 D7, D9,
 * AC6, AC10), through the REAL verb handlers with a stand-in window:
 *  - pool add/remove/list: fenced titles and notes, no prompt, the same prompt kept once, the
 *    16 KB and 30-row caps, a full pool says the job was NOT kept;
 *  - a capped `delegate` keeps its job in the pool (deduplicated);
 *  - `delegate --from`: the row leaves the pool in the write that records the child, stays on a
 *    refusal, is marked `maybeStarted` when unconfirmed (refused again without --force), a
 *    second claim of the same row is 409, the claim is released whatever happened;
 *  - `--task`: an unknown or symlinked slug is refused, a real task links the row;
 *  - `ask`: <= 4 options of <= 24 characters, refused never cut, format characters stripped,
 *    one open at a time; ask, pool-add and delegate need the hand-over, pool-list does not;
 *  - a record at the caps still reads and disable still works; no write produces a record the
 *    read refuses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-pool-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { MAX_FILE_BYTES, SUPER_STATE_REL, SuperStoreRefused, readSuperState, resetSuperIndex, updateSuperState } from '../../src/lib/super/store.js';
import { MAX_LIVE_CHILDREN, MAX_POOL, MAX_POOL_PROMPT, MAX_QUEUE, emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { disableSuper } from '../../src/lib/super/handover.js';
import { resetCapacityForTests } from '../../src/lib/super/capacity.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
let token = '';
const frames: Array<Record<string, unknown>> = [];
type Answer = { ok: true; result: unknown } | { ok: false; error: string };
let answer: Answer = { ok: true, result: { sessionId: '12345678-1234-4234-8234-123456789abc' } };
let hold: Promise<void> | null = null;
const CHILD_SID = '12345678-1234-4234-8234-123456789abc';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-pool-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  frames.length = 0;
  answer = { ok: true, result: { sessionId: CHILD_SID } };
  hold = null;
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  resetCapacityForTests();
  token = mintWindowToken({
    send: (frame) => {
      frames.push(frame);
      const a = answer;
      void (hold ?? Promise.resolve()).then(() => setImmediate(() => deliverSuperResult(token, frame.id, a)));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super',
  }).token;
});
afterEach(() => { _resetSuperInbox(); rmSync(dir, { recursive: true, force: true }); });

function write(state: Record<string, unknown> = {}): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true, ...state }));
}
function req(body: unknown, withToken = true): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...(withToken ? { 'x-dreamcontext-window-token': token } : {}) }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown> = {}, withToken = true) {
  const r = res();
  await handleSuperVerb(req(body, withToken), r, { verb: name });
  return r;
}
const result = (r: { json: Record<string, unknown> }) => r.json.result as Record<string, unknown>;
const commands = () => frames.filter((f) => f.subtype === 'super_command');
function fillCap(): void {
  const ids = Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => `live-${i}`);
  write({ children: Object.fromEntries(ids.map((id) => [id, { sessionId: id, brief: '', adopted: false, startedAt: 1 }])) });
  for (const id of ids) registerChat({ sessionId: id, conversationId: null, vault: 'acme', mode: 'basic' }).userSent('busy');
}

describe('the new verbs need the vault\'s super token; the hand-over gates ask, pool-add and delegate', () => {
  it('no token -> 401 for every new verb', async () => {
    write();
    for (const v of ['pool-add', 'pool-remove', 'pool-list', 'ask']) expect((await verb(v, {}, false)).status).toBe(401);
  });

  it('not handed over: ask, pool-add, delegate are 409 not_handed_over; pool-list still answers', async () => {
    write({ enabled: false });
    expect((await verb('ask', { text: 'which one?' })).json.error).toBe('not_handed_over');
    expect((await verb('pool-add', { prompt: 'later' })).json.error).toBe('not_handed_over');
    expect((await verb('delegate', { prompt: 'now' })).json.error).toBe('not_handed_over');
    expect((await verb('pool-list')).status).toBe(200);
    expect(commands()).toHaveLength(0);
  });
});

describe('pool add | remove | list', () => {
  it('adds, lists fenced without the prompt, keeps the same prompt once, removes', async () => {
    write();
    const a = await verb('pool-add', { prompt: 'Write the users migration.', brief: 'users migration', note: 'after the auth job' });
    expect(a.status).toBe(200);
    const id = result(a).pooled as string;
    expect(id).toMatch(/^p-/);
    expect(result(await verb('pool-add', { prompt: 'Write the users migration.' }))).toEqual({ pooled: id, reused: true });
    const list = result(await verb('pool-list')).pool as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0].prompt).toBeUndefined();
    expect(list[0].hash).toBeUndefined();
    expect(list[0].promptBytes).toBe(Buffer.byteLength('Write the users migration.'));
    expect(String(list[0].title)).toMatch(/users migration/);
    expect(String(list[0].title)).not.toBe('users migration');
    expect(String(list[0].note)).toMatch(/after the auth job/);
    expect(String(list[0].note)).not.toBe('after the auth job');
    expect((await verb('pool-remove', { id })).status).toBe(200);
    expect((await readSuperState(root)).pool).toEqual([]);
    expect((await verb('pool-remove', { id })).status).toBe(404);
  });

  it('a prompt over 16 KB is refused; a full pool keeps nothing and says so', async () => {
    write();
    expect((await verb('pool-add', { prompt: 'x'.repeat(MAX_POOL_PROMPT + 1) })).json.error).toBe('too_large');
    for (let i = 0; i < MAX_POOL; i += 1) expect((await verb('pool-add', { prompt: `job ${i}` })).status).toBe(200);
    const full = await verb('pool-add', { prompt: 'one too many' });
    expect(full.status).toBe(409);
    expect(full.json.error).toBe('pool_full');
    expect(String(full.json.message ?? full.json.hint ?? JSON.stringify(full.json))).toMatch(/NOT kept/);
    expect((await readSuperState(root)).pool).toHaveLength(MAX_POOL);
  });
});

describe('a capped delegate keeps its job', () => {
  it('held -> pooled (kept: true, held), the same prompt again reuses the row, a full pool keeps nothing', async () => {
    fillCap();
    const r = await verb('delegate', { prompt: 'one more' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'held', kept: true, reused: false });
    const pooled = r.json.pooled as string;
    expect((await readSuperState(root)).pool).toEqual([expect.objectContaining({ id: pooled, held: true })]);
    expect((await verb('delegate', { prompt: 'one more' })).json).toMatchObject({ pooled, reused: true });
    expect((await readSuperState(root)).pool).toHaveLength(1);
    for (let i = 1; i < MAX_POOL; i += 1) await verb('pool-add', { prompt: `fill ${i}` });
    expect((await verb('delegate', { prompt: 'no room' })).json).toMatchObject({ error: 'pool_full', kept: false });
    expect(commands()).toHaveLength(0);
  });
});

describe('delegate --from', () => {
  async function pooled(prompt = 'Pooled job.'): Promise<string> {
    return result(await verb('pool-add', { prompt, brief: 'pooled' })).pooled as string;
  }

  it('Havuz -> Calisiyor in ONE write: the child is recorded working and the row is gone', async () => {
    write();
    const id = await pooled();
    const r = await verb('delegate', { from: id });
    expect(r.status).toBe(200);
    expect(result(r)).toMatchObject({ sessionId: CHILD_SID, from: id });
    expect(commands()[0].args).toMatchObject({ prompt: 'Pooled job.' });
    const s = await readSuperState(root);
    expect(s.pool).toEqual([]);
    expect(s.children[CHILD_SID]).toMatchObject({ row: 'working' });
  });

  it('a refusing window keeps the row, and the claim is released (the next try is not "claimed")', async () => {
    write();
    const id = await pooled();
    // The window's own refusal (no child can exist): `no_window` without `sent: false` would
    // count as unconfirmed (M4).
    answer = { ok: false, error: 'window_refused' };
    expect((await verb('delegate', { from: id })).status).toBeGreaterThanOrEqual(400);
    expect((await readSuperState(root)).pool).toEqual([expect.objectContaining({ id })]);
    expect((await readSuperState(root)).pool[0].maybeStarted).toBeUndefined();
    answer = { ok: true, result: { sessionId: CHILD_SID } };
    expect((await verb('delegate', { from: id })).status).toBe(200);
  });

  it('unconfirmed marks the row maybeStarted; --from refuses it until --force', async () => {
    write();
    const id = await pooled();
    answer = { ok: true, result: {} };
    expect((await verb('delegate', { from: id })).json.error).toBe('delegate_unconfirmed');
    expect((await readSuperState(root)).pool[0]).toMatchObject({ id, maybeStarted: true });
    answer = { ok: true, result: { sessionId: CHILD_SID } };
    expect((await verb('delegate', { from: id })).json.error).toBe('maybe_started');
    expect((await verb('delegate', { from: id, force: true })).status).toBe(200);
  });

  it('a second claim of the same row while the first runs is 409 claimed; a capped --from keeps the row and adds none', async () => {
    write();
    const id = await pooled();
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    const first = verb('delegate', { from: id });
    await vi.waitFor(() => expect(commands()).toHaveLength(1));
    expect((await verb('delegate', { from: id })).json.error).toBe('claimed');
    expect((await verb('pool-remove', { id })).json.error).toBe('claimed');
    release();
    expect((await first).status).toBe(200);
  });

  it('an unknown pool id is 404', async () => {
    write();
    expect((await verb('delegate', { from: 'p-nope' })).status).toBe(404);
  });

  it('capped: the --from row stays as it is, no second row', async () => {
    write();
    const id = await pooled();
    fillCap();
    // fillCap rewrote the record: pool the job again under the cap.
    const again = await pooled();
    const r = await verb('delegate', { from: again });
    expect(r.json).toMatchObject({ error: 'held', pooled: again });
    expect((await readSuperState(root)).pool.map((p) => p.id)).toEqual([again]);
    expect(id).toBeTruthy();
  });
});

describe('--task', () => {
  it('an unknown or symlinked slug is refused on delegate, pool-add and brief; a real task links the row', async () => {
    write({ children: { [CHILD_SID]: { sessionId: CHILD_SID, brief: '', adopted: true, startedAt: 1 } } });
    writeFileSync(join(dir, 'outside.md'), '# not a task');
    symlinkSync(join(dir, 'outside.md'), join(root, 'state', 'linked.md'));
    writeFileSync(join(root, 'state', 'real-task.md'), '---\nname: real\n---\n');
    for (const task of ['missing-task', 'linked', '../escape', 'UPPER']) {
      expect((await verb('delegate', { prompt: 'x', task })).status, task).toBeGreaterThanOrEqual(400);
      expect((await verb('pool-add', { prompt: 'x', task })).status, task).toBeGreaterThanOrEqual(400);
      expect((await verb('brief', { child: CHILD_SID, line: 'doing x', task })).status, task).toBeGreaterThanOrEqual(400);
    }
    expect(commands()).toHaveLength(0);
    expect((await verb('brief', { child: CHILD_SID, line: 'doing x', task: 'real-task' })).status).toBe(200);
    expect((await readSuperState(root)).children[CHILD_SID].task).toBe('real-task');
    expect((await verb('delegate', { prompt: 'linked job', task: 'real-task' })).status).toBe(200);
  });
});

describe('super ask', () => {
  it('options: at most 4, each <= 24 characters (refused, never cut), no duplicates', async () => {
    write();
    expect((await verb('ask', { text: 'Which?', options: ['a', 'b', 'c', 'd', 'e'] })).json.error).toBe('invalid_options');
    expect((await verb('ask', { text: 'Which?', options: ['x'.repeat(25)] })).json.error).toBe('invalid_options');
    expect((await verb('ask', { text: 'Which?', options: ['same', 'same'] })).json.error).toBe('invalid_options');
    expect((await verb('ask', { text: '   ' })).json.error).toBe('invalid_args');
    expect((await verb('ask', { text: 'x'.repeat(2001) })).json.error).toBe('invalid_args');
    expect((await readSuperState(root)).queue).toEqual([]);
  });

  it('a 24-character label is kept whole; control and Unicode format characters are stripped', async () => {
    write();
    const r = await verb('ask', { text: 'Ship​ it‮ now?\n', options: ['W'.repeat(24), 'no⁦pe\u0007'] });
    expect(r.status).toBe(200);
    const item = (await readSuperState(root)).queue.find((q) => q.kind === 'ask')!;
    expect(item).toMatchObject({ state: 'escalated', sessionId: 'sup-1', ownerText: 'Ship it now?', options: ['W'.repeat(24), 'nope'] });
    expect(item.requestId).toBeUndefined();
  });

  it('one open ask at a time', async () => {
    write();
    expect((await verb('ask', { text: 'First?' })).status).toBe(200);
    expect((await verb('ask', { text: 'Second?' })).json.error).toBe('ask_open');
  });
});

describe('the record\'s caps', () => {
  it('a record at the caps (30 pool rows of 16 KB + a full queue) still reads, and disable still works', async () => {
    const pool = Array.from({ length: MAX_POOL }, (_, i) => ({
      id: `p-cap-${i}`, title: `job ${i}`, prompt: `${i}`.padEnd(MAX_POOL_PROMPT - 64, 'y'), hash: `h${i}`, createdAt: i + 1,
    }));
    const queue = Array.from({ length: MAX_QUEUE }, (_, i) => ({
      id: `q-cap-${i}`, sessionId: 'c1', kind: 'question', state: 'escalated', ownerText: 'q'.repeat(1900), createdAt: i + 1, requestId: `r-${i}`,
    }));
    write({ pool, queue, children: { c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 } } });
    expect(statSync(join(root, SUPER_STATE_REL)).size).toBeLessThan(MAX_FILE_BYTES);
    const s = await readSuperState(root);
    expect(s.session).toBe('sup-1');
    expect(s.pool.length).toBeGreaterThan(0);
    const off = await disableSuper(root);
    expect(off.enabled).toBe(false);
    expect(JSON.parse(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).enabled).toBe(false);
  });

  it('no write produces a record the read refuses: over 2 MiB of UTF-8 is refused before the rename', async () => {
    write();
    const before = readFileSync(join(root, SUPER_STATE_REL), 'utf-8');
    const many = Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => {
      const id = `child-${i}`;
      return [id, { sessionId: id, brief: 'ü'.repeat(100), adopted: true, startedAt: 1 }];
    }));
    await expect(updateSuperState(root, (s) => { Object.assign(s.children, many); })).rejects.toBeInstanceOf(SuperStoreRefused);
    expect(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).toBe(before);
  });
});
