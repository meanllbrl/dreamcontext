// The server starts a Super with no window (headless-super.ts, owner 2026-11-16, Ege on Telegram:
// a slept or closed Super never woke, because only a window's socket could spawn it). The real
// `startChatSession` runs here with a mocked spawn: the Super registers its injector on the
// phantom socket, the socket is cut so the child is DETACHED (what a closed window leaves), and
// a window's later reattach ADOPTS that same child instead of spawning a twin. Plus the gate: a
// member off, a session not the recorded one, and a plain chat tab holding the Super's
// conversation (stopped first, then the Super starts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const spawned: FakeChild[] = [];
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4545;
}
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawned.push(child);
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

const { wakeSuperHeadless, wakeSuperHeadlessDetail, wireSuperWake, HeadlessSocket, _resetHeadlessSuperForTests, _setHeadlessStartForTests, _setHeadlessGateForTests } = await import('../../src/server/headless-super.js');
const inboxMod = await import('../../src/lib/super/inbox.js');
const { plainOpenOfSuperRefusal } = await import('../../src/server/routes/agent-chat.js');
const { findLiveChat, registerLiveChat, unregisterLiveChat } = await import('../../src/server/routes/agent-chat-live.js');
const reg = await import('../../src/lib/assistant/chat-registry.js');
const { SUPER_STATE_REL, readSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
const { emptySuperState } = await import('../../src/lib/super/types.js');
const { _setOpenLogHomeForTests } = await import('../../src/lib/window-open-log.js');
const { withTelegramRef } = await import('../../src/lib/telegram/contract.js');

let project: string;
let root: string;
let logHome: string;
let SID: string;

async function superOn(session: string, enabled = true): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session, enabled }));
  resetSuperIndex();
  await readSuperState(root);
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), 'headless-super-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  logHome = mkdtempSync(join(tmpdir(), 'headless-super-log-'));
  _setOpenLogHomeForTests(logHome);
  spawned.length = 0;
  reg._resetChatRegistry();
  _resetHeadlessSuperForTests();
  SID = randomUUID();
  await superOn(SID);
});
afterEach(() => {
  for (const c of spawned) c.emit('close', 0);
  _setOpenLogHomeForTests(null);
  rmSync(project, { recursive: true, force: true });
  rmSync(logHome, { recursive: true, force: true });
});

describe('wakeSuperHeadless', () => {
  it("starts main's Super in super mode on a phantom socket, registers its injector, then detaches; a window's reattach adopts the SAME child", async () => {
    expect(reg.chatInjector(SID)).toBeNull();
    const woke = await wakeSuperHeadless({ contextRoot: root, vault: 'acme', sessionId: SID, member: null, waitMs: 2000 });
    expect(woke).toBe('started');
    expect(spawned).toHaveLength(1);
    expect(reg.chatInjector(SID)).not.toBeNull();
    // Detached on the next tick: no holder, the child alive and adoptable.
    await new Promise((r) => setTimeout(r, 10));
    const live = findLiveChat(SID)!;
    expect(live).toBeTruthy();
    expect(live.mirror).toBeTypeOf('function'); // a Super's entry, not a plain chat's
    expect(live.holder?.()).toBeNull();
    expect(spawned[0].stdin.end).not.toHaveBeenCalled();
    // His message goes in through the injector with no window.
    const r = await reg.chatInjector(SID)!.sendOwnerText(withTelegramRef('abc123', 'Selam'), { ref: 'abc123', source: 'telegram-text' });
    expect(r.ok).toBe(true);
    expect(spawned[0].stdin.write).toHaveBeenCalled();
    // The window's Super pane comes later: it adopts this child, no second spawn.
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn(), ping: vi.fn(), terminate: vi.fn() });
    expect(live.adopt(ws as unknown as import('ws').WebSocket)).toBe(true);
    expect(spawned).toHaveLength(1);
    // Asked again: it is live, nothing spawns.
    expect(await wakeSuperHeadless({ contextRoot: root, sessionId: SID, member: null })).toBe('live');
    expect(spawned).toHaveLength(1);
  });

  it('two messages at once share one start (never a twin process)', async () => {
    const [a, b] = await Promise.all([
      wakeSuperHeadless({ contextRoot: root, sessionId: SID, member: null, waitMs: 2000 }),
      wakeSuperHeadless({ contextRoot: root, sessionId: SID, member: null, waitMs: 2000 }),
    ]);
    expect([a, b]).toEqual(['started', 'started']);
    expect(spawned).toHaveLength(1);
  });

  it('refuses what a window may not open either: a session that is not the recorded one, a Super turned off', async () => {
    expect(await wakeSuperHeadless({ contextRoot: root, sessionId: randomUUID(), member: null, waitMs: 200 })).toBe('refused');
    await superOn(SID, false);
    // Off: the record holds no live Super for the hub to wake (the hub says "Super kapalı" before).
    expect(await wakeSuperHeadless({ contextRoot: root, sessionId: randomUUID(), member: null, waitMs: 200 })).toBe('refused');
    expect(spawned).toHaveLength(0);
  });

  it("main's Super turned off (its session still recorded) is never started, and the owner's own chat on that old conversation is left alone", async () => {
    await superOn(SID, false);
    const cut = vi.fn(async () => { unregisterLiveChat(mine); });
    const mine = { conversationId: SID, projectRoot: project, busy: false, turnStartedAt: null, lastTurnEndedAt: null, adopt: () => false, supersede: () => () => {}, cut };
    registerLiveChat(mine);
    try {
      expect(await wakeSuperHeadless({ contextRoot: root, sessionId: SID, member: null, waitMs: 200 })).toBe('refused');
      expect(cut).not.toHaveBeenCalled();
      expect(spawned).toHaveLength(0);
    } finally { unregisterLiveChat(mine); }
  });

  it('a plain chat holding the conversation in the middle of a turn is left to finish (refused now, tried again later)', async () => {
    const cut = vi.fn(async () => { unregisterLiveChat(busy); });
    const busy = { conversationId: SID, projectRoot: project, busy: true, turnStartedAt: Date.now(), lastTurnEndedAt: null, adopt: () => false, supersede: () => () => {}, cut };
    registerLiveChat(busy);
    try {
      expect(await wakeSuperHeadless({ contextRoot: root, sessionId: SID, member: null, waitMs: 200 })).toBe('refused');
      expect(cut).not.toHaveBeenCalled();
      expect(spawned).toHaveLength(0);
    } finally { unregisterLiveChat(busy); }
  });

  it("the server knows the window-verb base from its listen on, so a Super it starts before any window connects still gets its window token", () => {
    const index = readFileSync(new URL('../../src/server/index.ts', import.meta.url), 'utf-8');
    const listening = index.slice(index.indexOf('const onListening = () => {'), index.indexOf('startTelegramHub()'));
    expect(listening).toMatch(/setWindowControlBase\(`http:\/\/127\.0\.0\.1:\$\{a\.port\}`\);/);
  });

  it("a member whose Super is off or unapproved is refused (the window's own gate)", async () => {
    expect(await wakeSuperHeadless({ contextRoot: root, sessionId: SID, member: 'ege', waitMs: 200 })).toBe('refused');
    expect(spawned).toHaveLength(0);
  });

  it("a member's Super is started as that member: super mode, its agent, its manifest's model", async () => {
    const calls: Array<Record<string, unknown>> = [];
    _setHeadlessStartForTests((_ws, _root, opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      reg.registerChatInjector(SID, { sessionId: SID, chatRegistryId: SID, sendOwnerText: async () => ({ ok: true }), interrupt: () => {} });
    });
    // The gate itself is pinned above; here the member's record and approval are taken as ready.
    const asked: Array<Record<string, unknown>> = [];
    _setHeadlessGateForTests((o) => { asked.push(o as unknown as Record<string, unknown>); return null; });
    mkdirSync(join(root, 'agents'), { recursive: true });
    writeFileSync(join(root, 'agents', 'ege.md'), '---\nname: Ege\nmodel: sonnet\neffort: low\n---\nPersonal trainer.\n');
    expect(await wakeSuperHeadless({ contextRoot: root, vault: 'acme', sessionId: SID, member: 'ege', waitMs: 500 })).toBe('started');
    expect(asked).toEqual([expect.objectContaining({ mode: 'super', phone: false, resumeId: SID, chatAgent: 'ege' })]);
    expect(calls).toEqual([expect.objectContaining({ mode: 'super', agent: 'ege', sessionId: SID, resumeId: '', vault: 'acme' })]);
  });

  it("a plain chat tab holding the Super's conversation (a link that landed as a tab) is stopped first, then the Super starts", async () => {
    const cut = vi.fn(async () => { unregisterLiveChat(plain); });
    const plain = {
      conversationId: SID, projectRoot: project, busy: false, turnStartedAt: null, lastTurnEndedAt: null,
      adopt: () => false, supersede: () => () => {}, cut,
    };
    registerLiveChat(plain);
    expect(await wakeSuperHeadless({ contextRoot: root, sessionId: SID, member: null, waitMs: 2000 })).toBe('started');
    expect(cut).toHaveBeenCalledTimes(1);
    expect(findLiveChat(SID)?.mirror).toBeTypeOf('function');
  });
});

// Owner 2026-11-22 (Telegram, the app's window closed): the Super Agent gave an AI Team member a
// job and nothing started, because only a window spawned a stopped member's Super and an event
// was only written to a Super a window's socket held. Now team mail wakes it on the server, and
// a detached Super takes its events.
describe('the wake for team mail (no window)', () => {
  afterEach(async () => { vi.restoreAllMocks(); await inboxMod._superInboxDrained(); inboxMod._resetSuperInbox(); _setHeadlessStartForTests(null); _setHeadlessGateForTests(null); });
  /** The clock past the start grace, then a pump (what the inbox's own scheduled retry does). */
  async function passGrace(r: string, superId: 'main' | `m:${string}` = 'main'): Promise<void> {
    const t = Date.now() + 31_000;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    await inboxMod.pumpSuper(r, superId);
  }

  it('names its outcome: gate for what the window may not open, start_failed for a start that throws', async () => {
    _setHeadlessGateForTests(() => 409);
    expect(await wakeSuperHeadlessDetail({ contextRoot: root, sessionId: SID, member: null, waitMs: 200, cause: 'team' })).toBe('gate');
    _setHeadlessGateForTests(() => null);
    _setHeadlessStartForTests(() => { throw new Error('spawn ENOENT'); });
    expect(await wakeSuperHeadlessDetail({ contextRoot: root, sessionId: SID, member: null, waitMs: 200, cause: 'team' })).toBe('start_failed');
    expect(spawned).toHaveLength(0);
  });

  it('with no waker wired (no desktop), a stopped Super holding team mail is not started', async () => {
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: SID, enabled: true,
      queue: [{ id: 'q-done-0000000d', sessionId: SID, kind: 'done', state: 'pending', createdAt: Date.now(), team: 'team-j2', text: 'Done.' }],
    }));
    resetSuperIndex();
    await readSuperState(root);
    inboxMod.wireSuperInbox();
    wireSuperWake({ wake: false });
    await inboxMod.pumpSuper(root);
    await new Promise((r) => setTimeout(r, 50));
    expect(spawned).toHaveLength(0);
  });

  it('a stopped Super holding a team done is started by the pump (detached) and the event is written to it', async () => {
    const { createAgent } = await import('../../src/lib/agents/store.js');
    createAgent(root, { slug: 'rota', title: 'Rota', prompt: 'Rota works.' }, { approve: { now: new Date() } });
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: SID, enabled: true,
      team: [{ id: 'team-j1', member: 'rota', runId: new Date(Date.now() - 1000).toISOString(), jobKind: 'run', queued: false, brief: 'routes', startedAt: Date.now() - 1000, request: 'q-req-0000000a', told: 'done' }],
      queue: [{ id: 'q-done-0000000b', sessionId: SID, kind: 'done', state: 'pending', createdAt: Date.now(), team: 'team-j1', text: 'Three routes.' }],
    }));
    resetSuperIndex();
    await readSuperState(root);
    inboxMod.wireSuperInbox();
    wireSuperWake({ wake: true });
    await inboxMod.pumpSuper(root);
    await vi.waitFor(() => expect(spawned).toHaveLength(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 10));
    // Detached: no window's socket holds it.
    expect(findLiveChat(SID)?.holder?.()).toBeNull();
    const log = readFileSync(join(logHome, '.dreamcontext', 'logs', 'window-open.log'), 'utf-8');
    expect(log).toMatch(/"cause":"team"/);
    // A child given no prompt is `starting` until its grace passes; then the done goes in on stdin.
    await passGrace(root);
    await vi.waitFor(() => expect(spawned[0].stdin.write.mock.calls.some(([t]) => String(t).includes('q-done-0000000b'))).toBe(true), { timeout: 5000 });
  });

  it('a stopped member holding the Super Agent\'s request is started as that member and the request written to it', async () => {
    const { createAgent } = await import('../../src/lib/agents/store.js');
    const { MEMBER_SUPER_DIR } = await import('../../src/lib/super/store.js');
    createAgent(root, { slug: 'rota', title: 'Rota', prompt: 'Rota works.' }, { approve: { now: new Date() } });
    _setHeadlessGateForTests(() => null);
    const RS = randomUUID();
    mkdirSync(join(root, MEMBER_SUPER_DIR), { recursive: true });
    writeFileSync(join(root, MEMBER_SUPER_DIR, 'rota.json'), JSON.stringify({
      ...emptySuperState(), session: RS, enabled: true, member: 'rota',
      queue: [{ id: 'q-mreq-0000000c', sessionId: RS, kind: 'request', state: 'pending', createdAt: Date.now(), text: 'Which cities open first?' }],
    }));
    resetSuperIndex();
    await readSuperState(root, 'm:rota');
    inboxMod.wireSuperInbox();
    wireSuperWake({ wake: true });
    await inboxMod.pumpSuper(root, 'm:rota');
    await vi.waitFor(() => expect(spawned).toHaveLength(1), { timeout: 5000 });
    const log = readFileSync(join(logHome, '.dreamcontext', 'logs', 'window-open.log'), 'utf-8');
    expect(log).toMatch(/"member":"rota"/);
    await passGrace(root, 'm:rota');
    await vi.waitFor(() => expect(spawned[0].stdin.write.mock.calls.some(([t]) => String(t).includes('q-mreq-0000000c'))).toBe(true), { timeout: 5000 });
  });

  it("a stopped member whose child the relaunch cut is started as that member (no window, no request, no Telegram message) and the restart written to it", async () => {
    const { createAgent } = await import('../../src/lib/agents/store.js');
    const { MEMBER_SUPER_DIR } = await import('../../src/lib/super/store.js');
    createAgent(root, { slug: 'rota', title: 'Rota', prompt: 'Rota works.' }, { approve: { now: new Date() } });
    _setHeadlessGateForTests(() => null);
    const RS = randomUUID();
    const CH = randomUUID();
    mkdirSync(join(root, MEMBER_SUPER_DIR), { recursive: true });
    writeFileSync(join(root, MEMBER_SUPER_DIR, 'rota.json'), JSON.stringify({
      ...emptySuperState(), session: RS, enabled: true, member: 'rota',
      children: { [CH]: { sessionId: CH, brief: 'neon screens', startedAt: Date.now() - 120_000, row: 'working', resuming: Date.now() - 40_000, awaited: true, origin: 'vkf6e4' } },
      queue: [{ id: 'q-rst-0000002a', sessionId: CH, kind: 'restarted', state: 'pending', createdAt: Date.now() - inboxMod.CHILD_WAKE_GRACE_MS - 1_000 }],
    }));
    resetSuperIndex();
    await readSuperState(root, 'm:rota');
    inboxMod.wireSuperInbox();
    wireSuperWake({ wake: true });
    await inboxMod.pumpSuper(root, 'm:rota');
    await vi.waitFor(() => expect(spawned).toHaveLength(1), { timeout: 5000 });
    const log = readFileSync(join(logHome, '.dreamcontext', 'logs', 'window-open.log'), 'utf-8');
    expect(log).toMatch(/"member":"rota"[^\n]*"cause":"child"/);
    await passGrace(root, 'm:rota');
    await vi.waitFor(() => expect(spawned[0].stdin.write.mock.calls.some(([t]) => String(t).includes('q-rst-0000002a'))).toBe(true), { timeout: 5000 });
  });
});

// The wake's bounds (end review r1): only mail the next batch would deliver wakes; a member
// holding an open request is woken by its own children's results; three failed starts tell the
// owner once per item, and new mail after the last backoff opens a new cycle.
describe('the wake for team mail: what wakes and how often', () => {
  afterEach(async () => { vi.restoreAllMocks(); await inboxMod._superInboxDrained(); inboxMod._resetSuperInbox(); });

  async function memberRecord(queue: unknown[], children: Record<string, unknown> = {}): Promise<string> {
    const { createAgent } = await import('../../src/lib/agents/store.js');
    const { MEMBER_SUPER_DIR } = await import('../../src/lib/super/store.js');
    createAgent(root, { slug: 'rota', title: 'Rota', prompt: 'Rota works.' }, { approve: { now: new Date() } });
    const RS = randomUUID();
    mkdirSync(join(root, MEMBER_SUPER_DIR), { recursive: true });
    writeFileSync(join(root, MEMBER_SUPER_DIR, 'rota.json'), JSON.stringify({
      ...emptySuperState(), session: RS, enabled: true, member: 'rota', children,
      queue: (queue as Array<Record<string, unknown>>).map((q) => ({ sessionId: RS, ...q })),
    }));
    resetSuperIndex();
    await readSuperState(root, 'm:rota');
    return RS;
  }

  it('a member holding an open request is woken by its own child\'s done; without an open request it is not', async () => {
    const CH = randomUUID();
    const kids = { [CH]: { sessionId: CH, brief: 'routes', startedAt: Date.now() - 1000, row: 'done' } };
    const calls: string[] = [];
    inboxMod.setSuperWaker(async (o) => { calls.push(o.superId); return 'live'; });
    await memberRecord([
      { id: 'q-req-00000010', kind: 'request', state: 'delivered', createdAt: Date.now() - 5000, acceptedAt: Date.now() - 4000, text: 'Plan the routes.' },
      { id: 'q-done-00000011', sessionId: CH, kind: 'done', state: 'pending', createdAt: Date.now() - inboxMod.CHILD_WAKE_GRACE_MS - 1_000 },
    ], kids);
    await inboxMod.pumpSuper(root, 'm:rota');
    expect(calls).toEqual(['m:rota']);
    const state = await readSuperState(root, 'm:rota');
    expect(inboxMod.wakeCause(state)).toBe('child');
    expect(inboxMod.wakeCause({ ...state, queue: state.queue.filter((q) => q.kind !== 'request') })).toBeNull();
  });

  // Owner 2026-11-22 ("AI team üyeleri açılmıyor"): Ege's child, cut by the app's relaunch at
  // 17:42, waited `restarted` for 33 minutes with no window, until he wrote to Ege on Telegram.
  it("a stopped member is woken by its own child's events: a relaunch's cut child, a question, a result he waits on (after the window's grace)", async () => {
    const CH = randomUUID();
    const kids = { [CH]: { sessionId: CH, brief: 'neon screens', startedAt: Date.now() - 60_000, row: 'working', awaited: true, origin: 'vkf6e4' } };
    const calls: Array<{ superId: string; member: string | null; cause: string }> = [];
    inboxMod.setSuperWaker(async (o) => { calls.push({ superId: o.superId, member: o.member, cause: o.cause }); return 'live'; });
    await memberRecord([{ id: 'q-rst-00000020', sessionId: CH, kind: 'restarted', state: 'pending', createdAt: Date.now() }], kids);
    // Inside the grace a window coming up gets it first: nothing started yet.
    await inboxMod.pumpSuper(root, 'm:rota');
    expect(calls).toEqual([]);
    const t = Date.now() + inboxMod.CHILD_WAKE_GRACE_MS + 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    await inboxMod.pumpSuper(root, 'm:rota');
    expect(calls).toEqual([{ superId: 'm:rota', member: 'rota', cause: 'child' }]);
    // The same rule for each kind that needs the member's turn, and none for a result nobody waits on.
    const s = await readSuperState(root, 'm:rota');
    const only = (q: Record<string, unknown>, ch: Record<string, unknown> = kids[CH]) => ({ ...s, children: { [CH]: ch }, queue: [{ sessionId: CH, state: 'pending', createdAt: 0, ...q }] }) as never;
    expect(inboxMod.wakeCause(only({ id: 'q-stk-00000022', kind: 'stuck' }, { ...kids[CH], row: 'stuck' }))).toBe('child');
    expect(inboxMod.wakeCause(only({ id: 'q-don-00000023', kind: 'done' }, { ...kids[CH], row: 'done' }))).toBe('child');
    expect(inboxMod.wakeCause(only({ id: 'q-gon-00000024', kind: 'gone' }, { ...kids[CH], row: 'gone' }))).toBe('child');
    const quiet = { ...kids[CH], awaited: undefined, origin: undefined, row: 'done' };
    expect(inboxMod.wakeCause(only({ id: 'q-don-00000025', kind: 'done' }, quiet))).toBeNull();
    expect(inboxMod.wakeCause(only({ id: 'q-gon-00000026', kind: 'gone' }, { ...quiet, row: 'gone' }))).toBeNull();
    // No longer true (the child moved on, its question no longer asked): wakes nothing.
    expect(inboxMod.wakeCause(only({ id: 'q-stk-00000029', kind: 'stuck' }))).toBeNull();
    expect(inboxMod.wakeCause(only({ id: 'q-qst-00000021', kind: 'question', text: 'Which shade?' }))).toBeNull();
    // Another session's item (not its child) never wakes it.
    expect(inboxMod.wakeCause({ ...s, children: {}, queue: [{ id: 'q-rst-00000027', sessionId: CH, kind: 'restarted', state: 'pending', createdAt: 0 }] } as never)).toBeNull();
  });

  it("main's Super goes through the same gate: its awaited child's done wakes it with no window", async () => {
    const CH = randomUUID();
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
      ...emptySuperState(), session: SID, enabled: true,
      children: { [CH]: { sessionId: CH, brief: 'routes', startedAt: Date.now() - 60_000, row: 'done', awaited: true, origin: 'abc123' } },
      queue: [{ id: 'q-don-00000028', sessionId: CH, kind: 'done', state: 'pending', createdAt: Date.now() - inboxMod.CHILD_WAKE_GRACE_MS - 1_000 }],
    }));
    resetSuperIndex();
    await readSuperState(root);
    const calls: Array<{ superId: string; cause: string }> = [];
    inboxMod.setSuperWaker(async (o) => { calls.push({ superId: o.superId, cause: o.cause }); return 'live'; });
    await inboxMod.pumpSuper(root);
    expect(calls).toEqual([{ superId: 'main', cause: 'child' }]);
  });

  it('a team question waiting behind his own open question wakes nothing', async () => {
    const s = { ...emptySuperState(), session: SID, enabled: true, queue: [
      { id: 'q-ask-00000012', sessionId: SID, kind: 'ask', state: 'escalated', createdAt: 1, ownerText: 'Which city?' },
      { id: 'q-qst-00000013', sessionId: SID, kind: 'question', state: 'pending', createdAt: 2, team: 'team-j9', text: 'North or south?' },
    ] } as never;
    expect(inboxMod.wakeCause(s)).toBeNull();
  });

  it('three failed starts tell the owner once, items marked; new mail after the last backoff opens a new cycle', async () => {
    let tries = 0;
    const lines: string[] = [];
    inboxMod.setSuperWaker(async () => { tries += 1; return 'start_failed'; });
    inboxMod.setSuperOwnerLineSink(async (_r, line) => { lines.push(line); });
    await memberRecord([{ id: 'q-req-00000014', kind: 'request', state: 'pending', createdAt: Date.now(), text: 'Plan the routes.' }]);
    let t = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    for (const step of inboxMod.WAKE_BACKOFF_MS) {
      await inboxMod.pumpSuper(root, 'm:rota');
      t += step + 100;
    }
    await inboxMod._superInboxDrained();
    expect(tries).toBe(inboxMod.MAX_WAKE_TRIES);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Rota');
    expect((await readSuperState(root, 'm:rota')).queue.find((q) => q.id === 'q-req-00000014')?.wakeTold).toBe(true);
    // Nothing new: no more starts and no second line.
    t += 10 * 60_000;
    await inboxMod.pumpSuper(root, 'm:rota');
    expect(tries).toBe(inboxMod.MAX_WAKE_TRIES);
    expect(lines).toHaveLength(1);
    // A new request (never told) after the wait: a new bounded cycle starts.
    const { writeSuper } = await import('../../src/lib/super/inbox.js');
    await writeSuper(root, 'm:rota', (d) => { d.queue.push({ id: 'q-req-00000015', sessionId: d.session as string, kind: 'request', state: 'pending', createdAt: t, text: 'And the depots?' }); });
    await inboxMod.pumpSuper(root, 'm:rota');
    expect(tries).toBe(inboxMod.MAX_WAKE_TRIES + 1);
  });
});

describe('HeadlessSocket', () => {
  it('drops what it is sent, keeps a spawn refusal, never answers a ping, closes once', () => {
    const s = new HeadlessSocket();
    const closes = vi.fn();
    s.on('close', closes);
    s.send(JSON.stringify({ type: 'assistant' }));
    expect(s.refusal).toBeNull();
    s.send(JSON.stringify({ type: '_meta', subtype: 'error', code: 'agent_refused' }));
    expect(s.refusal).toBe('agent_refused');
    const pong = vi.fn();
    s.on('pong', pong);
    s.ping();
    expect(pong).not.toHaveBeenCalled();
    s.terminate();
    s.close();
    expect(closes).toHaveBeenCalledTimes(1);
    expect(s.readyState).toBe(s.CLOSED);
  });
});

describe("plainOpenOfSuperRefusal: a Super's own conversation runs only as that Super", () => {
  it('a desktop open of the recorded session in any other mode is refused 409; super mode, the phone and other sessions pass', () => {
    expect(plainOpenOfSuperRefusal({ mode: 'basic', phone: false, contextRoot: root, resumeId: SID, sessionId: '' })).toBe(409);
    expect(plainOpenOfSuperRefusal({ mode: 'plan', phone: false, contextRoot: root, resumeId: '', sessionId: SID })).toBe(409);
    expect(plainOpenOfSuperRefusal({ mode: 'super', phone: false, contextRoot: root, resumeId: SID, sessionId: '' })).toBeNull();
    expect(plainOpenOfSuperRefusal({ mode: 'basic', phone: true, contextRoot: root, resumeId: SID, sessionId: '' })).toBeNull();
    expect(plainOpenOfSuperRefusal({ mode: 'basic', phone: false, contextRoot: root, resumeId: randomUUID(), sessionId: '' })).toBeNull();
  });

  it('a Super turned off frees its old conversation for a plain tab', async () => {
    await superOn(SID, false);
    expect(plainOpenOfSuperRefusal({ mode: 'basic', phone: false, contextRoot: root, resumeId: SID, sessionId: '' })).toBeNull();
  });
});
