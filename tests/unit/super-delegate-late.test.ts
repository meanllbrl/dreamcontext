/**
 * A `super delegate` the window answers too late (field 2026-11-15: a hidden window on a loaded
 * Mac, three `delegate_unconfirmed` in a row for one job):
 *  - the agent hears `pending` (never asked to delegate again), and the start is kept;
 *  - the same job delegated again while it is pending is refused `starting`;
 *  - the window's late answer records the child exactly as one in time;
 *  - a late refusal, or no answer at all, keeps the job in the pool with the reason;
 *  - every step is a line in ~/.dreamcontext/logs/window-open.log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-late-home-`);
});

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { resetCapacityForTests } from '../../src/lib/super/capacity.js';
import { handleSuperVerb, _setDelegateWaitsForTests } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl, sendSuperCommand } from '../../src/lib/window-control.js';
import { _setOpenLogHomeForTests } from '../../src/lib/window-open-log.js';
import { consumeCrewTicket, membersDelegating, mintCrewTicket, noteDelegating } from '../../src/lib/super/delegating.js';
import { superKey } from '../../src/lib/super/store.js';

const CHILD = 'late-child';
const until = async (cond: () => Promise<boolean> | boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('condition never held');
};

describe('window-control late answers', () => {
  beforeEach(() => resetWindowControl());

  it('an answer after the timeout reaches onLate once; the caller already heard no_window sent', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const t = mintWindowToken({ send: (f) => { frames.push(f); return true; }, sessionId: 's1', mode: 'super' }).token;
    const late: unknown[] = [];
    const r = await sendSuperCommand(t, 'delegate', {}, { timeoutMs: 20, late: { lateMs: 500, onLate: (x) => late.push(x) } });
    expect(r).toMatchObject({ ok: false, error: 'no_window', sent: true });
    expect(deliverSuperResult(t, frames[0].id, { ok: true, result: { sessionId: 'x' } })).toBe(true);
    expect(deliverSuperResult(t, frames[0].id, { ok: true, result: { sessionId: 'x' } })).toBe(false);
    expect(late).toEqual([{ ok: true, result: { sessionId: 'x' } }]);
  });

  it('no answer by the end of the late wait is late_timeout; another chat cannot answer it', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const t = mintWindowToken({ send: (f) => { frames.push(f); return true; }, sessionId: 's1', mode: 'super' }).token;
    const other = mintWindowToken({ send: () => true, sessionId: 'other', mode: 'basic' }).token;
    const late: unknown[] = [];
    await sendSuperCommand(t, 'delegate', {}, { timeoutMs: 10, late: { lateMs: 40, onLate: (x) => late.push(x) } });
    expect(deliverSuperResult(other, frames[0].id, { ok: true, result: {} })).toBe(false);
    await until(() => late.length === 1);
    expect(late[0]).toMatchObject({ ok: false, error: 'late_timeout' });
  });
});

describe('super delegate answered late', () => {
  let dir: string;
  let root: string;
  let token = '';
  const frames: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-late-'));
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    frames.length = 0;
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    resetCapacityForTests();
    _setDelegateWaitsForTests({ answerMs: 40, graceMs: 10, lateMs: 300 });
    _setOpenLogHomeForTests(dir);
    // The window never answers by itself: each test answers (or not) when it wants.
    token = mintWindowToken({ send: (f) => { frames.push(f); return true; }, vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super' }).token;
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true }));
  });
  afterEach(() => {
    _setDelegateWaitsForTests(null);
    _setOpenLogHomeForTests(null);
    resetWindowControl();
    rmSync(dir, { recursive: true, force: true });
  });

  function req(body: unknown): IncomingMessage {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
    setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
    return r;
  }
  async function delegate(body: Record<string, unknown>) {
    const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
    await handleSuperVerb(req(body), out, { verb: 'delegate' });
    return out;
  }
  const commands = () => frames.filter((f) => f.subtype === 'super_command');
  const log = () => (existsSync(join(dir, '.dreamcontext', 'logs', 'window-open.log')) ? readFileSync(join(dir, '.dreamcontext', 'logs', 'window-open.log'), 'utf-8') : '');

  it('says pending, refuses the same job again, and records the child when the window opens it late', async () => {
    const r = await delegate({ prompt: 'Build the export.', brief: 'export' });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ pending: true });
    expect(String((r.json.result as { do: string }).do)).toMatch(/Do not delegate this job again/);
    // The frame tells the window it may still act after the server's answer.
    expect((commands()[0].args as { deadline: number }).deadline).toBeGreaterThan(Date.now() + 100);

    const again = await delegate({ prompt: 'Build the export.', brief: 'export' });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('starting');
    expect(commands()).toHaveLength(1);

    expect(deliverSuperResult(token, commands()[0].id, { ok: true, result: { sessionId: CHILD, got: Date.now(), hidden: true } })).toBe(true);
    await until(async () => !!(await readSuperState(root)).children[CHILD]);
    expect((await readSuperState(root)).children[CHILD]).toMatchObject({ brief: 'export', adopted: false });
    expect(log()).toMatch(/"event":"delegate_answer".*"sent":true/);
    expect(log()).toMatch(/"event":"delegate_late".*"hidden":true/);
    // Landed: the same prompt is no longer "starting".
    await until(async () => (await delegate({ prompt: 'Build the export.' })).json.error !== 'starting');
  });

  it('a late refusal keeps the job in the pool with the reason, and records no child', async () => {
    await delegate({ prompt: 'Draft the post.', brief: 'post' });
    deliverSuperResult(token, commands()[0].id, { ok: false, error: 'tabs_full' });
    await until(async () => (await readSuperState(root)).pool.length === 1);
    const s = await readSuperState(root);
    expect(Object.keys(s.children)).toEqual([]);
    expect(s.pool[0]).toMatchObject({ prompt: 'Draft the post.' });
    expect(s.pool[0].note).toMatch(/no room for another tab/);
  });

  it('no answer at all by the end of the late wait also lands in the pool, and frees the job', async () => {
    await delegate({ prompt: 'Check the logs.', brief: 'logs' });
    await until(async () => (await readSuperState(root)).pool.length === 1, 2_000);
    expect((await readSuperState(root)).pool[0].note).toMatch(/never opened this chat/);
    expect(log()).toMatch(/"event":"delegate_late".*"error":"late_timeout"/);
  });

  it('a job the pool cannot keep (a prompt over 16 KB) is told to be delegated again if it never opens', async () => {
    const r = await delegate({ prompt: `Big brief. ${'x'.repeat(17_000)}`, brief: 'big' });
    expect(r.json.result).toMatchObject({ pending: true });
    expect(String((r.json.result as { do: string }).do)).toMatch(/delegate it again \(a prompt over 16 KB is not kept/);
    deliverSuperResult(token, commands()[0].id, { ok: false, error: 'tabs_full' });
    await until(() => /delegate_late_lost/.test(log()));
    expect((await readSuperState(root)).pool).toEqual([]);
  });

  it('a pending start no longer counts as a delegate in flight (that count marks other spawns as crew)', async () => {
    await delegate({ prompt: 'Quiet job.', brief: 'quiet' });
    expect(noteDelegating(superKey(root), 0)).toBe(0);
    expect(membersDelegating(root)).toEqual([]);
  });

  it('a hand-over gets no late wait: a timeout is unconfirmed as before, and the window may not open it later', async () => {
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: 'sup-1', enabled: true,
      children: { 'old-child': { sessionId: 'old-child', brief: 'old', adopted: false, startedAt: 1 } },
    }));
    resetSuperIndex();
    const r = await delegate({ prompt: 'Take over the job.', brief: 'heir', succeeds: 'old-child' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('delegate_unconfirmed');
    expect((commands()[0].args as { deadline: number }).deadline).toBeLessThan(Date.now() + 100);
    expect(deliverSuperResult(token, commands()[0].id, { ok: true, result: { sessionId: CHILD } })).toBe(false);
  });

  it('a crew ticket minted for a late wait still ties the child after the old 40 s', () => {
    const now = 1_000_000;
    const t = mintCrewTicket(root, 'm:rota', 'job-1', now, 6 * 60_000);
    expect(consumeCrewTicket(t, root, now + 120_000)).toBe('rota');
    const short = mintCrewTicket(root, 'm:rota', 'job-2', now);
    expect(consumeCrewTicket(short, root, now + 41_000)).toBeNull();
  });

  it('a pool job pending a late answer is refused `starting` on --from, and leaves the pool once it lands', async () => {
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: 'sup-1', enabled: true,
      pool: [{ id: 'p-late-1', title: 'kept job', prompt: 'Do the kept job.', hash: 'h', createdAt: 1 }],
    }));
    resetSuperIndex();
    const r = await delegate({ from: 'p-late-1' });
    expect(r.json.result).toMatchObject({ pending: true, from: 'p-late-1' });
    expect((await delegate({ from: 'p-late-1' })).json.error).toBe('starting');
    deliverSuperResult(token, commands()[0].id, { ok: true, result: { sessionId: CHILD } });
    await until(async () => (await readSuperState(root)).pool.length === 0);
    expect((await readSuperState(root)).children[CHILD]).toBeTruthy();
  });
});
