/**
 * A finished job always reaches the Super (task bir-is-bitince-super-e-haber-her-zaman-ulasir).
 *
 * Field 2026-11-07: the Super's process ran and answered the owner for nine hours, yet no event
 * turn went in. A second process for the same pin had registered (inbox, chat registry, live-chat
 * map, each "last wins") and, on its own exit, removed all three: the pump then read `no_socket`
 * / a `gone` chat for good. These pin: a twin that comes and goes leaves the first one delivering;
 * a recap long past is dropped instead of holding every event behind it; and events that wait
 * behind a blocker are retried and, past a few minutes, named in the state view.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-twin-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetChatRegistry, getChat, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import {
  RECAP_MAX_AGE_MS, SUPER_BLOCKED_VISIBLE_MS, _resetSuperInbox, _superInboxDrained, attachSuperInbox, deliveryBlocker, nextBatch,
  pumpSuper, startSuperInbox, superTurnEnded, superView, writeSuper, type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { findLiveChat, markLiveChatDraining, registerLiveChat, stopLiveChat, unregisterLiveChat, type LiveChatEntry } from '../../src/server/routes/agent-chat-live.js';
import { resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
const SUPER = 'sup-twin';
const W = { timeout: 10_000 };

function makeVault(state: Partial<SuperState>): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
}

const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode });
const settle = (h: ChatHandle) => { h.userSent(''); h.observe({ type: 'result' }); };
const child = (sid: string) => ({ sessionId: sid, brief: `brief of ${sid}`, adopted: true, startedAt: 1 });
const item = (o: Partial<SuperQueueItem>): SuperQueueItem => ({ id: 'q-x', sessionId: 'c1', kind: 'gone', state: 'pending', createdAt: 1, ...o });

function fakeInbox(id: string, over: Partial<SuperInbox> = {}) {
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id,
    sessionId: SUPER,
    attached: () => true,
    idle: () => true,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
    ...over,
  };
  return { inbox, delivered };
}

/** A child that has gone (no live chat): its `gone` event is true and deliverable. */
async function queueGone(id: string): Promise<void> {
  await writeSuper(root, (s) => { s.queue.push(item({ id, createdAt: Date.now() })); });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-twin-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
});
afterEach(async () => {
  vi.useRealTimers();
  let cap: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([_superInboxDrained(), new Promise((r) => { cap = setTimeout(r, 8_000); })]);
  clearTimeout(cap);
  _resetSuperInbox();
  rmSync(dir, { recursive: true, force: true });
});

describe('a second bridge for the Super pin that comes and goes', { timeout: 30_000 }, () => {
  it('leaves the first one, still running, delivering the next event', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    const first = reg(SUPER, 'super');
    settle(first);
    const a = fakeInbox('inbox-first');
    attachSuperInbox(a.inbox);
    // The twin: its own registry entry and inbox under the same pin, then its process exits.
    const twin = reg(SUPER, 'super');
    settle(twin);
    const b = fakeInbox('inbox-twin');
    const detachTwin = attachSuperInbox(b.inbox);
    twin.exited();
    detachTwin();
    // The first process is still the Super: its chat entry is back, and the inbox is its own.
    expect(getChat(SUPER)?.status).toBe('idle');
    expect(deliveryBlocker(root)).toBeNull();
    await queueGone('q-after-twin');
    void pumpSuper(root);
    await vi.waitFor(() => expect(a.delivered.map((d) => d.event.items?.map((i) => i.item)).flat()).toContain('q-after-twin'), W);
    expect(b.delivered).toHaveLength(0);
    await vi.waitFor(async () => {
      expect((await readSuperState(root)).queue.find((q) => q.id === 'q-after-twin')?.state).toBe('delivered');
    }, W);
  });

  it('a turn end settles what that bridge carried, even while the other one is current', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    settle(reg(SUPER, 'super'));
    let aOn = true;
    let bOn = false;
    const a = fakeInbox('inbox-a', { attached: () => aOn });
    const b = fakeInbox('inbox-b', { attached: () => bOn });
    attachSuperInbox(a.inbox);
    attachSuperInbox(b.inbox);
    await queueGone('q-carried');
    void pumpSuper(root);
    await vi.waitFor(() => expect(a.delivered).toHaveLength(1), W);
    await vi.waitFor(async () => expect((await readSuperState(root)).queue.find((q) => q.id === 'q-carried')?.state).toBe('delivered'), W);
    // The other window reattaches; then A's event turn ends.
    aOn = false;
    bOn = true;
    superTurnEnded(SUPER, { inboxId: 'inbox-a' });
    await vi.waitFor(async () => expect((await readSuperState(root)).queue.find((q) => q.id === 'q-carried')?.state).toBe('done'), W);
  });

  it('a chat the registry holds as gone reads no_chat, never busy', async () => {
    makeVault({ children: { c1: child('c1') } });
    await startSuperInbox([root]);
    const only = reg(SUPER, 'super');
    settle(only);
    attachSuperInbox(fakeInbox('inbox-g').inbox);
    only.exited();
    expect(deliveryBlocker(root)).toBe('no_chat');
  });

  it('the registry follows the first process again: its turns move the entry the pump reads', () => {
    const first = reg('pin-x', 'super');
    const twin = reg('pin-x', 'super');
    twin.exited();
    expect(getChat('pin-x')?.status).toBe('starting');
    first.userSent('hi');
    expect(getChat('pin-x')?.status).toBe('working');
    first.observe({ type: 'result' });
    expect(getChat('pin-x')?.status).toBe('idle');
    // When the first one exits too, the pin is gone.
    first.exited();
    expect(getChat('pin-x')?.status).toBe('gone');
  });

  it('a twin that never displaced a live process changes nothing (a respawn after an exit)', () => {
    const old = reg('pin-y', 'super');
    old.exited();
    const next = reg('pin-y', 'super');
    next.exited();
    expect(getChat('pin-y')?.status).toBe('gone');
  });
});

describe('the live-chat map', () => {
  const entry = (id: string): LiveChatEntry => ({ conversationId: id, projectRoot: '/p', busy: false, turnStartedAt: null, lastTurnEndedAt: null } as unknown as LiveChatEntry);

  it('a twin that unregisters puts the first, still running, back', () => {
    const first = entry('conv-1');
    const twin = entry('conv-1');
    registerLiveChat(first);
    registerLiveChat(twin);
    expect(findLiveChat('conv-1')).toBe(twin);
    unregisterLiveChat(twin);
    expect(findLiveChat('conv-1')).toBe(first);
    unregisterLiveChat(first);
    expect(findLiveChat('conv-1')).toBeNull();
  });

  it('stopping a conversation stops a displaced process too, and nothing comes back', async () => {
    const cuts: string[] = [];
    const mk = (name: string): LiveChatEntry => {
      const e = { ...entry('conv-3'), cut: async () => { cuts.push(name); unregisterLiveChat(e); } } as LiveChatEntry;
      return e;
    };
    const first = mk('first');
    const twin = mk('twin');
    registerLiveChat(first);
    registerLiveChat(twin);
    expect(await stopLiveChat('conv-3', { timeoutMs: 2000 })).toBe(true);
    expect(cuts.sort()).toEqual(['first', 'twin']);
    expect(findLiveChat('conv-3')).toBeNull();
  });

  it('a displaced one that drains (a respawn superseding it) never comes back', () => {
    const old = entry('conv-2');
    const next = entry('conv-2');
    registerLiveChat(old);
    registerLiveChat(next);
    markLiveChatDraining(old);
    expect(findLiveChat('conv-2')).toBe(next);
    unregisterLiveChat(next);
    expect(findLiveChat('conv-2')).toBeNull();
    unregisterLiveChat(old);
  });
});

describe('a solo item that can no longer matter', () => {
  it('a recap past RECAP_MAX_AGE_MS is dropped and the events behind it go', () => {
    const now = 10 * RECAP_MAX_AGE_MS;
    const state: SuperState = {
      ...emptySuperState(), session: SUPER, enabled: true,
      queue: [item({ id: 'q-recap', sessionId: SUPER, kind: 'recap', createdAt: now - RECAP_MAX_AGE_MS - 1 }), item({ id: 'q-gone', createdAt: now - 1000 })],
    };
    const { items, drop } = nextBatch(state, undefined, now);
    expect(drop).toContain('q-recap');
    expect(items.map((q) => q.id)).toEqual(['q-gone']);
  });

  it('a fresh recap still goes first and alone', () => {
    const now = 10 * RECAP_MAX_AGE_MS;
    const state: SuperState = {
      ...emptySuperState(), session: SUPER, enabled: true,
      queue: [item({ id: 'q-recap', sessionId: SUPER, kind: 'recap', createdAt: now - 60_000 }), item({ id: 'q-gone', createdAt: now - 1000 })],
    };
    expect(nextBatch(state, undefined, now).items.map((q) => q.id)).toEqual(['q-recap']);
  });
});

describe('events waiting behind a blocker', { timeout: 30_000 }, () => {
  it('a long turn of the Super\'s own is ordinary waiting, never shown as blocked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(60_000_000);
    makeVault({ children: { c1: child('c1') }, queue: [item({ id: 'q-busy', createdAt: 60_000_000 - 1000 })] });
    await startSuperInbox([root]);
    reg(SUPER, 'super').userSent('a long job');
    attachSuperInbox(fakeInbox('inbox-busy', { idle: () => false }).inbox);
    await pumpSuper(root);
    vi.setSystemTime(60_000_000 + SUPER_BLOCKED_VISIBLE_MS * 3);
    await pumpSuper(root);
    expect(deliveryBlocker(root)).toBe('busy');
    expect(superView(root, await readSuperState(root)).blocked).toBeUndefined();
  });

  it('are named in the state view after a few minutes, and cleared once delivered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(50_000_000);
    makeVault({ children: { c1: child('c1') }, queue: [item({ id: 'q-wait', createdAt: 50_000_000 - 1000 })] });
    await startSuperInbox([root]);
    settle(reg(SUPER, 'super'));
    // No bridge attached: nothing can go.
    await pumpSuper(root);
    expect(deliveryBlocker(root)).toBe('no_socket');
    expect(superView(root, await readSuperState(root)).blocked).toBeUndefined();
    vi.setSystemTime(50_000_000 + SUPER_BLOCKED_VISIBLE_MS + 1);
    await pumpSuper(root);
    expect(superView(root, await readSuperState(root)).blocked).toEqual({ reason: 'no_socket', since: 50_000_000 });
    const a = fakeInbox('inbox-late');
    attachSuperInbox(a.inbox);
    await vi.waitFor(() => expect(a.delivered).toHaveLength(1), W);
    await vi.waitFor(async () => expect(superView(root, await readSuperState(root)).blocked).toBeUndefined(), W);
  });
});
