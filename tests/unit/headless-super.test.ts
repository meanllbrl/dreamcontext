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

const { wakeSuperHeadless, HeadlessSocket, _resetHeadlessSuperForTests, _setHeadlessStartForTests, _setHeadlessGateForTests } = await import('../../src/server/headless-super.js');
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
