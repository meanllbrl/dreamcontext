/**
 * Rows, not turns (plan r4 D5, D6, D10, D15-D18, AC1-AC6), through the REAL registry and inbox
 * on a fake clock:
 *  - a child's turn end opens no super turn; it settles into `done` 30 s later with exactly one
 *    `done` item, `settling` while the window runs; a restart inside the window adds no second;
 *  - only question / done / gone / stuck reach the super: an error turn is `stuck`, an owner
 *    Stop or a limit switch is `done`, a stale child is `stuck` once and back to working when it
 *    moves; a permission never reaches it;
 *  - what piles up while the super is busy goes in ONE batch; a batch whose process exits goes
 *    to the successor, dropped after two exits; a `done` whose child works again is never sent;
 *  - a steered turn spends no question attempt, and the owner lease holds the pump 15 s;
 *  - while an escalation or the super's own ask is open nothing is delivered, recap included;
 *  - a v1 record from main reads (idle items dropped) and every registered child gets a row;
 *    the sweep stops on disable and reset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-rows-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STALE_MS, _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { DONE_SETTLE_MS, OWNER_LEASE_MS, STALE_SWEEP_MS, emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, _sweepArmed, attachSuperInbox, reconcileRows, startSuperInbox,
  superOwnerSpoke, superTurnEnded, type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { disableSuper } from '../../src/lib/super/handover.js';
import { resetWindowControl } from '../../src/lib/window-control.js';

const SUPER = 'sup-1';
let dir: string;
let root: string;

const W = { timeout: 10_000 };
const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode });
const child = (sid: string, row?: string) => ({ sessionId: sid, brief: `brief of ${sid}`, adopted: true, startedAt: 1, ...(row ? { row } : {}) });
const askQuestion = (h: ChatHandle, requestId: string) => h.observe({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which database?', options: [{ label: 'postgres' }] }] } },
});
const askPermission = (h: ChatHandle, requestId: string) => h.observe({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } },
});

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await _superInboxDrained();
  }
}
/** The clock moves in steps, the inbox's real file I/O drained after each: a timer re-armed
 *  after a read (the sweep) is armed at the time it would be, not after one big jump. */
async function advance(ms: number, step = 5_000): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, left));
    await drain();
  }
}

function makeVault(state: Partial<SuperState> | Record<string, unknown>): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
}

function fakeInbox() {
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const flags = { busy: false };
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`,
    sessionId: SUPER,
    attached: () => true,
    idle: () => !flags.busy,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
  };
  return { inbox, delivered, flags };
}

/** A handed-over vault with `children` registered and working, the super chat idle and attached. */
async function boot(children: string[], over: Record<string, unknown> = {}) {
  makeVault({ children: Object.fromEntries(children.map((sid) => [sid, child(sid, 'working')])), ...over });
  const sup = reg(SUPER, 'super');
  sup.userSent('');
  sup.observe({ type: 'result' });
  const hs = children.map((sid) => { const h = reg(sid); h.userSent('go'); return h; });
  await startSuperInbox([root]);
  const fi = fakeInbox();
  const detach = attachSuperInbox(fi.inbox);
  await drain();
  return { sup, hs, detach, ...fi };
}

const items = async (kind: string, sid?: string) => (await readSuperState(root)).queue.filter((q) => q.kind === kind && (!sid || q.sessionId === sid));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.now() });
  dir = mkdtempSync(join(tmpdir(), 'super-rows-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
});
afterEach(async () => {
  await drain().catch(() => undefined);
  vi.useRealTimers();
  _resetSuperInbox();
  rmSync(dir, { recursive: true, force: true });
});

describe('rows, not turns (AC1)', { timeout: 30_000 }, () => {
  it('5 children each ending 3 turns within 10 s open 0 super turns; 30 s later each has exactly one done', async () => {
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
    const { hs, delivered } = await boot(ids);
    for (let round = 0; round < 3; round += 1) {
      for (const h of hs) h.observe({ type: 'result' });
      await advance(1_000);
      if (round < 2) for (const h of hs) h.userSent('next step');
      await advance(2_000);
    }
    expect(delivered).toHaveLength(0);
    const mid = await readSuperState(root);
    for (const sid of ids) expect(mid.children[sid]).toMatchObject({ row: 'working', settling: true });
    expect(await items('done')).toHaveLength(0);
    await advance(DONE_SETTLE_MS);
    const s = await readSuperState(root);
    for (const sid of ids) {
      expect(s.children[sid].row).toBe('done');
      expect(s.children[sid].settling).toBeUndefined();
      expect(await items('done', sid)).toHaveLength(1);
    }
    // Done items reach the super, batched (never one turn per turn end).
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThanOrEqual(ids.length);
    expect(delivered.every((d) => d.event.kind === 'batch')).toBe(true);
  });

  it('a server restart inside the settle window produces exactly one done, never two', async () => {
    const { hs } = await boot(['c1']);
    hs[0].observe({ type: 'result' });
    await advance(10_000);
    // The inbox's timers and memory go; the record and the registry stay.
    _resetSuperInbox();
    resetSuperIndex();
    await startSuperInbox([root]);
    attachSuperInbox(fakeInbox().inbox);
    await drain();
    expect((await readSuperState(root)).children.c1).toMatchObject({ row: 'working', settling: true });
    await advance(DONE_SETTLE_MS);
    expect(await items('done', 'c1')).toHaveLength(1);
    await reconcileRows(root);
    await advance(STALE_SWEEP_MS);
    expect(await items('done', 'c1')).toHaveLength(1);
  });

  it('a restart that re-registers the child fresh (no last turn) still settles it once, via the sweep', async () => {
    const { hs } = await boot(['c1']);
    hs[0].observe({ type: 'result' });
    await advance(5_000);
    _resetSuperInbox();
    _resetChatRegistry();
    resetSuperIndex();
    const sup = reg(SUPER, 'super');
    sup.userSent('');
    sup.observe({ type: 'result' });
    reg('c1');
    await startSuperInbox([root]);
    attachSuperInbox(fakeInbox().inbox);
    await drain();
    // `starting` is not work: the row stays as it was until the clock says idle.
    expect((await readSuperState(root)).children.c1.row).toBe('working');
    await advance(STALE_SWEEP_MS + DONE_SETTLE_MS + STALE_SWEEP_MS);
    expect((await readSuperState(root)).children.c1.row).toBe('done');
    expect(await items('done', 'c1')).toHaveLength(1);
  });
});

describe('only decisions reach the super (AC2)', { timeout: 30_000 }, () => {
  it('an error turn is stuck/error; an owner Stop and a limit switch are done', async () => {
    const { hs } = await boot(['err', 'stop', 'lim']);
    hs[0].observe({ type: 'result', is_error: true });
    hs[1].interrupted();
    hs[1].observe({ type: 'result', is_error: true });
    hs[2].markLimited();
    hs[2].observe({ type: 'result', is_error: true });
    await advance(DONE_SETTLE_MS + 100);
    const s = await readSuperState(root);
    expect(s.children.err).toMatchObject({ row: 'stuck', stuckReason: 'error' });
    expect(s.children.stop.row).toBe('done');
    expect(s.children.lim.row).toBe('done');
    expect(await items('stuck')).toHaveLength(1);
    expect((await items('stuck'))[0].sessionId).toBe('err');
    expect(await items('done')).toHaveLength(2);
  });

  it('a stale child is stuck once per episode, the sweep stays armed while it is the only row, and it is working again when it moves', async () => {
    const { hs } = await boot(['c1']);
    expect(_sweepArmed(root)).toBe(true);
    await advance(STALE_MS + STALE_SWEEP_MS + 100);
    let s = await readSuperState(root);
    expect(s.children.c1).toMatchObject({ row: 'stuck', stuckReason: 'stale' });
    expect(_sweepArmed(root)).toBe(true);
    await advance(STALE_SWEEP_MS * 3);
    expect(await items('stuck', 'c1')).toHaveLength(1);
    // It moves (a frame, no status change: only the clock and the sweep see it).
    hs[0].observe({ type: 'assistant', message: { content: [] } });
    await advance(STALE_SWEEP_MS + 100);
    s = await readSuperState(root);
    expect(s.children.c1.row).toBe('working');
  });

  it('a child that starts a turn and asks at once keeps its permission open (verify finding: the working write raced the asking one)', async () => {
    const { hs } = await boot(['c1']);
    hs[0].observe({ type: 'result' });
    await advance(1_000);
    hs[0].userSent('do it');
    askPermission(hs[0], 'perm-race');
    await drain();
    await advance(1_000);
    const q = (await items('permission', 'c1')).find((x) => x.requestId === 'perm-race');
    expect(q?.state).toBe('pending');
    expect((await readSuperState(root)).children.c1.row).toBe('asking');
  });

  it('a permission never reaches the super', async () => {
    const { hs, delivered } = await boot(['c1']);
    askPermission(hs[0], 'perm-1');
    await advance(1_000);
    expect(delivered).toHaveLength(0);
    expect(await items('permission', 'c1')).toHaveLength(1);
  });
});

describe('batching (AC3)', { timeout: 30_000 }, () => {
  it('4 children finishing while the super is busy produce ONE turn with all four', async () => {
    const ids = ['c1', 'c2', 'c3', 'c4'];
    const { hs, delivered, flags } = await boot(ids);
    flags.busy = true;
    for (const h of hs) h.observe({ type: 'result' });
    await advance(DONE_SETTLE_MS + 100);
    expect(delivered).toHaveLength(0);
    flags.busy = false;
    superTurnEnded(SUPER);
    await drain();
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    expect(delivered[0].event.kind).toBe('batch');
    expect(delivered[0].event.items?.map((i) => i.child).sort()).toEqual(ids);
    expect(delivered[0].text.split('\n')[0]).toMatch(/^\[super events\] batch=\S+ items=4$/);
  });

  it('a super that dies mid-batch hands its successor the same items; after two exits they are dropped', async () => {
    const { hs, delivered, detach } = await boot(['c1', 'c2']);
    for (const h of hs) h.observe({ type: 'result' });
    // Both settle at the same instant; whatever went, collect it.
    await advance(DONE_SETTLE_MS + 100);
    expect(delivered.length).toBeGreaterThan(0);
    const firstIds = delivered[0].event.items!.map((i) => i.item).sort();
    detach();
    await drain();
    for (const q of (await readSuperState(root)).queue.filter((x) => firstIds.includes(x.id))) {
      expect(q).toMatchObject({ state: 'pending', exits: 1 });
    }
    const second = fakeInbox();
    const detach2 = attachSuperInbox(second.inbox);
    await drain();
    await vi.waitFor(() => expect(second.delivered.length).toBeGreaterThan(0), W);
    expect(second.delivered[0].event.items!.map((i) => i.item).sort()).toEqual(expect.arrayContaining(firstIds));
    detach2();
    await drain();
    for (const q of (await readSuperState(root)).queue.filter((x) => firstIds.includes(x.id))) expect(q.state).toBe('done');
    const third = fakeInbox();
    attachSuperInbox(third.inbox);
    await drain();
    expect(third.delivered.flatMap((d) => d.event.items ?? []).filter((i) => firstIds.includes(i.item))).toEqual([]);
  });

  it('a done whose child started working again before delivery is never delivered', async () => {
    const { hs, delivered, flags } = await boot(['c1']);
    flags.busy = true;
    hs[0].observe({ type: 'result' });
    await advance(DONE_SETTLE_MS + 100);
    expect((await items('done', 'c1'))[0]?.state).toBe('pending');
    hs[0].userSent('one more thing');
    await drain();
    expect((await readSuperState(root)).children.c1.row).toBe('working');
    flags.busy = false;
    superTurnEnded(SUPER);
    await drain();
    expect(delivered).toHaveLength(0);
    expect((await items('done', 'c1'))[0].state).toBe('done');
  });
});

describe('owner first (AC4)', { timeout: 30_000 }, () => {
  it('a steered turn spends no question attempt, and the owner lease holds the pump 15 s', async () => {
    const { hs, delivered } = await boot(['c1']);
    askQuestion(hs[0], 'req-1');
    await drain();
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    superOwnerSpoke(SUPER);
    superTurnEnded(SUPER);
    await drain();
    const q = (await items('question', 'c1'))[0];
    expect(q.state).toBe('pending');
    expect(q.attempts).toBeUndefined();
    expect(delivered).toHaveLength(1);
    await advance(OWNER_LEASE_MS + 200);
    await vi.waitFor(() => expect(delivered).toHaveLength(2), W);
  });
});

describe('a single question (AC5)', { timeout: 30_000 }, () => {
  it('while the super\'s own ask is open nothing is delivered, recap included; when it closes they go', async () => {
    const { delivered } = await boot([], {
      children: { c1: child('c1', 'done') },
      queue: [
        { id: 'q-ask', sessionId: SUPER, kind: 'ask', state: 'escalated', ownerText: 'Ship it?', createdAt: 1 },
        { id: 'q-rec', sessionId: SUPER, kind: 'recap', state: 'pending', createdAt: 2 },
        { id: 'q-d', sessionId: 'c1', kind: 'done', state: 'pending', createdAt: 3 },
      ],
    });
    await advance(5_000);
    expect(delivered).toHaveLength(0);
    superOwnerSpoke(SUPER);
    await drain();
    expect((await readSuperState(root)).queue.find((q) => q.id === 'q-ask')?.state).toBe('done');
    await advance(OWNER_LEASE_MS + 200);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    expect(delivered[0].text).toMatch(/^\[super recap\]/);
    superTurnEnded(SUPER);
    await drain();
    await vi.waitFor(() => expect(delivered).toHaveLength(2), W);
    expect(delivered[1].event.items?.map((i) => i.item)).toEqual(['q-d']);
  });

  it('an escalation whose child stopped asking never blocks', async () => {
    const { delivered } = await boot([], {
      children: { c1: child('c1', 'done'), c2: child('c2', 'done') },
      queue: [
        { id: 'q-esc', sessionId: 'c1', kind: 'question', requestId: 'gone-req', state: 'escalated', ownerText: 'Which?', createdAt: 1 },
        { id: 'q-d', sessionId: 'c2', kind: 'done', state: 'pending', createdAt: 2 },
      ],
    });
    await drain();
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    expect((await readSuperState(root)).queue.find((q) => q.id === 'q-esc')?.state).toBe('done');
  });
});

describe('one data source (AC6) and the sweep\'s death (D17)', { timeout: 30_000 }, () => {
  it('a v1 record from main reads with containers, children and session intact; idle items drop; registered children get a row', async () => {
    makeVault({
      children: { c1: child('c1'), c2: child('c2'), c3: child('c3') },
      containers: [{ id: 'chat-c1', kind: 'chat', ref: 'c1', title: 'c1' }],
      queue: [
        { id: 'q-i', sessionId: 'c2', kind: 'idle', state: 'pending', createdAt: 1 },
        { id: 'q-q', sessionId: 'c1', kind: 'question', requestId: 'r1', state: 'pending', createdAt: 2 },
      ],
    });
    const s = await readSuperState(root);
    expect(s.session).toBe(SUPER);
    expect(Object.keys(s.children).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(s.containers.map((c) => c.id)).toEqual(['chat-c1']);
    expect(s.queue.map((q) => q.id)).toEqual(['q-q']);
    expect(s.pool).toEqual([]);
    expect(s.ownerBatches).toEqual([]);
    // c1 works, c2 is idle (a restart mid-turn must not leave it in Calisiyor), c3 not registered.
    const sup = reg(SUPER, 'super');
    sup.userSent('');
    sup.observe({ type: 'result' });
    reg('c1').userSent('go');
    const h2 = reg('c2');
    h2.userSent('x');
    h2.observe({ type: 'result' });
    await startSuperInbox([root]);
    await drain();
    const after = await readSuperState(root);
    expect(after.children.c1.row).toBe('working');
    expect(after.children.c2.row).toBe('done');
    expect(after.children.c3.row).toBeUndefined();
    expect(after.queue.filter((q) => q.kind === 'done')).toEqual([]);
  });

  it('the sweep is armed only while a row works, and stops on disable and on reset', async () => {
    await boot(['c1']);
    expect(_sweepArmed(root)).toBe(true);
    await disableSuper(root);
    await drain();
    expect(_sweepArmed(root)).toBe(false);
    _resetSuperInbox();
    resetSuperIndex();
    _resetChatRegistry();
    await boot(['c2']);
    expect(_sweepArmed(root)).toBe(true);
    _resetSuperInbox();
    expect(_sweepArmed(root)).toBe(false);
  });
});
