/**
 * Capacity (plan-r7 D11, AC9) and `super delegate` (AC3):
 *  - `availMemGb` comes from `vm_stat` on macOS (free + inactive + purgeable + speculative pages
 *    times the page size), `os.freemem()` elsewhere; disk and load beside it; memoized a minute;
 *  - a 9th live child is refused with `held` and the machine facts; nothing reaches the window;
 *  - a delegation goes to the window as a `super_command`, and the child it opened is recorded
 *    with its brief and a chat container.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-capacity-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { MAX_LIVE_CHILDREN, emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { parseVmStat, readCapacityFacts, resetCapacityForTests, type CapacityDeps } from '../../src/lib/super/capacity.js';
import { handleSuperVerb, DEV_SERVER_LINE } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                           50000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         90000.
Pages purgeable:                           1000.
`;
const GB = 1024 ** 3;

describe('machine facts', () => {
  beforeEach(() => resetCapacityForTests());

  it('parses a vm_stat sample: free + inactive + purgeable + speculative pages × page size', () => {
    expect(parseVmStat(VM_STAT)).toBe((10000 + 50000 + 1000 + 5000) * 16384);
    expect(parseVmStat('not vm_stat')).toBeNull();
  });

  function deps(over: Partial<CapacityDeps> = {}): CapacityDeps & { calls: { vm: number } } {
    const calls = { vm: 0 };
    return {
      platform: 'darwin',
      vmStat: async () => { calls.vm += 1; return VM_STAT; },
      freeMem: () => 0.5 * GB,
      statfs: async () => ({ bavail: 25 * 1024 * 1024, bsize: 4096 }),
      loadavg: () => [2.345, 1, 1],
      worktreeRoot: join(tmpdir(), 'no-such-dir-for-capacity', '.claude-worktrees'),
      now: () => 1_000,
      ...over,
      calls,
    } as CapacityDeps & { calls: { vm: number } };
  }

  it('on macOS availMemGb comes from vm_stat, not os.freemem()', async () => {
    const f = await readCapacityFacts(deps());
    expect(f.availMemGb).toBe(Math.round((66000 * 16384 / GB) * 10) / 10);
    expect(f.diskFreeGb).toBe(100);
    expect(f.load1).toBe(2.3);
  });

  it('elsewhere (or when vm_stat fails) it is os.freemem()', async () => {
    expect((await readCapacityFacts(deps({ platform: 'linux' }))).availMemGb).toBe(0.5);
    resetCapacityForTests();
    expect((await readCapacityFacts(deps({ vmStat: async () => { throw new Error('no vm_stat'); } }))).availMemGb).toBe(0.5);
  });

  it('is memoized for a minute', async () => {
    const d = deps();
    for (let i = 0; i < 5; i += 1) await readCapacityFacts(d);
    expect(d.calls.vm).toBe(1);
  });

  it('never spawns synchronously', () => {
    // Code only: the header comment names `execFileSync` to say it is not used.
    const src = readFileSync(new URL('../../src/lib/super/capacity.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/execFileSync|execSync|spawnSync/);
  });
});

describe('super delegate', () => {
  let dir: string;
  let root: string;
  let token = '';
  const frames: Array<Record<string, unknown>> = [];
  let answer: { ok: true; result: unknown } | { ok: false; error: string } = { ok: true, result: { sessionId: 'new-child' } };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-capacity-'));
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    frames.length = 0;
    answer = { ok: true, result: { sessionId: 'new-child' } };
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    resetWindowControl();
    resetCapacityForTests();
    token = mintWindowToken({
      send: (frame) => { frames.push(frame); setImmediate(() => deliverSuperResult(token, frame.id, answer)); return true; },
      vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super',
    }).token;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function write(children: string[]): void {
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: 'sup-1', enabled: true,
      children: Object.fromEntries(children.map((id) => [id, { sessionId: id, brief: '', adopted: false, startedAt: 1 }])),
    }));
  }
  function req(body: unknown): IncomingMessage {
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
    setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
    return r;
  }
  function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
    const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
    (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
    return out;
  }
  async function delegate(body: Record<string, unknown>) {
    const r = res();
    await handleSuperVerb(req(body), r, { verb: 'delegate' });
    return r;
  }

  it('opens the child through the window and records it with its brief and a container', async () => {
    write([]);
    const r = await delegate({ prompt: 'Write the migration for the users table.', brief: 'users migration', mode: 'develop' });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ sessionId: 'new-child' });
    // The state push after the write rides the same socket; the command is the one super_command.
    const commands = frames.filter((f) => f.subtype === 'super_command');
    expect(commands).toEqual([expect.objectContaining({
      verb: 'delegate',
      // K10 (jarvis plan r9): every delegated prompt starts with the pin-your-dev-server line.
      args: expect.objectContaining({ prompt: `${DEV_SERVER_LINE}\n\nWrite the migration for the users table.`, mode: 'develop', brief: 'users migration', title: 'users migration' }),
    })]);
    const deadline = (commands[0].args as { deadline: number }).deadline;
    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline).toBeLessThanOrEqual(Date.now() + 30_000);
    const s = await readSuperState(root);
    expect(s.children['new-child']).toMatchObject({ adopted: false, brief: 'users migration' });
    expect(s.containers.find((c) => c.kind === 'chat' && c.ref === 'new-child')).toBeTruthy();
  });

  it('a 9th live child is held, with the machine facts, and nothing reaches the window', async () => {
    const ids = Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => `live-${i}`);
    write(ids);
    for (const id of ids) registerChat({ sessionId: id, conversationId: null, vault: 'acme', mode: 'basic' }).userSent('busy');
    const r = await delegate({ prompt: 'one more' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'held', held: true, live: MAX_LIVE_CHILDREN, max: MAX_LIVE_CHILDREN });
    expect(r.json.machine).toBeDefined();
    expect(frames.filter((f) => f.subtype === 'super_command')).toHaveLength(0);
  });

  it('8 delegated children the registry has not seen yet (< 60 s old) are live: the 9th is held', async () => {
    const now = Date.now();
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: 'sup-1', enabled: true,
      children: Object.fromEntries(Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => [`fresh-${i}`, { sessionId: `fresh-${i}`, brief: '', adopted: false, startedAt: now - 1_000 }])),
    }));
    const r = await delegate({ prompt: 'one more, fast' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'held', live: MAX_LIVE_CHILDREN });
    expect(frames.filter((f) => f.subtype === 'super_command')).toHaveLength(0);
  });

  it('an unregistered child older than 60 s, or an adopted one, does not count', async () => {
    const old = Date.now() - 61_000;
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: 'sup-1', enabled: true,
      children: Object.fromEntries(Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => [`c-${i}`, { sessionId: `c-${i}`, brief: '', adopted: i % 2 === 0, startedAt: i % 2 === 0 ? Date.now() : old }])),
    }));
    expect((await delegate({ prompt: 'go' })).status).toBe(200);
  });

  it('idle or closed children do not count against the cap', async () => {
    const ids = Array.from({ length: MAX_LIVE_CHILDREN }, (_, i) => `done-${i}`);
    write(ids);
    for (const id of ids) { const h = registerChat({ sessionId: id, conversationId: null, vault: 'acme', mode: 'basic' }); h.userSent('x'); h.observe({ type: 'result' }); }
    expect((await delegate({ prompt: 'go' })).status).toBe(200);
  });

  it('a window that answers without a session id is "unconfirmed" (the child may exist), not "no window"', async () => {
    write([]);
    answer = { ok: true, result: {} };
    const r = await delegate({ prompt: 'go' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('delegate_unconfirmed');
  });

  it('a window that refuses leaves nothing recorded', async () => {
    write([]);
    answer = { ok: false, error: 'no_window' };
    const r = await delegate({ prompt: 'go' });
    expect(r.status).toBe(409);
    expect(Object.keys((await readSuperState(root)).children)).toEqual([]);
  });

  it('bad arguments are refused before anything is sent', async () => {
    write([]);
    expect((await delegate({ prompt: '' })).status).toBe(400);
    expect((await delegate({ prompt: 'x', mode: 'super' })).status).toBe(400);
    expect((await delegate({ prompt: 'x', mode: 'assistant' })).status).toBe(400);
    expect((await delegate({ prompt: 'x', effort: 'turbo' })).status).toBe(400);
    expect(frames.filter((f) => f.subtype === 'super_command')).toHaveLength(0);
  });
});
