/**
 * Hand over and take back (plan-r7 D17, AC1/AC2 server half, AC9 adoption).
 *
 *  - enable adopts only THIS vault's registered, live chats and drops the super's own id, any
 *    `super`/`assistant` chat and any Assistant delegation; each child gets a `chat` container
 *    and the hand-over note; the session is minted once and resumed after;
 *  - disable sets take-back notes, CLEARS a hand-over note that was never delivered (read from
 *    memory), and keeps the queue;
 *  - adopting 10 open chats is never refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-handover-home-`);
});

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { clearSuperNote, peekSuperNote, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { _resetSuperInbox, superQueueHead, wireSuperInbox, writeSuper } from '../../src/lib/super/inbox.js';
import { disableSuper, enableSuper } from '../../src/lib/super/handover.js';
import { handleSuperDisable, handleSuperEnable } from '../../src/server/routes/super.js';
import { resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-handover-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  _resetSuperInbox();
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

const reg = (sid: string, o: { vault?: string; mode?: string; origin?: 'assistant' } = {}) =>
  registerChat({ sessionId: sid, conversationId: null, vault: o.vault ?? 'acme', mode: o.mode ?? 'basic', ...(o.origin ? { origin: o.origin } : {}) });

describe('hand over', () => {
  it('adopts only this vault\'s registered, live, ordinary chats', async () => {
    reg('mine-1');
    reg('mine-2');
    reg('other-vault', { vault: 'beta' });
    reg('an-assistant', { mode: 'assistant' });
    reg('a-delegation', { origin: 'assistant' });
    reg('closed').exited();
    const { session, state } = await enableSuper(root, {
      adopt: ['mine-1', 'mine-2', 'other-vault', 'an-assistant', 'a-delegation', 'closed', 'never-registered', '../bad id'],
      titles: { 'mine-1': 'Fix the login page' },
    });
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(state.children).sort()).toEqual(['mine-1', 'mine-2']);
    expect(state.children['mine-1']).toMatchObject({ adopted: true, brief: 'Fix the login page' });
    expect(state.enabled).toBe(true);
    expect(state.notes).toEqual({ 'mine-1': 'handover', 'mine-2': 'handover' });
    expect(state.containers.filter((c) => c.kind === 'chat').map((c) => c.ref).sort()).toEqual(['mine-1', 'mine-2']);
    expect(state.queue.filter((q) => q.kind === 'handover' && q.state === 'pending')).toHaveLength(1);
    expect(state.queue[0].sessionId).toBe(session);
    // The notes are in memory for the per-message path.
    expect(peekSuperNote('mine-1')).toBe('handover');
  });

  it('never adopts the super session itself, nor a super-mode chat', async () => {
    const first = await enableSuper(root, { adopt: [], titles: {} });
    reg(first.session, { mode: 'super' });
    reg('impostor', { mode: 'super' });
    reg('mine');
    const { state } = await enableSuper(root, { adopt: [first.session, 'impostor', 'mine'], titles: {} });
    expect(Object.keys(state.children)).toEqual(['mine']);
  });

  it('a second hand-over resumes the same session and keeps the layout', async () => {
    reg('a');
    const one = await enableSuper(root, { adopt: ['a'], titles: {} });
    await writeSuper(root, (s) => { const c = s.containers.find((k) => k.ref === 'a')!; c.shape = 'square'; c.pos = { x: 0.1, y: 0.9 }; s.view = { mode: 'half', card: c.id }; });
    await disableSuper(root);
    reg('b');
    const two = await enableSuper(root, { adopt: ['a', 'b'], titles: {} });
    expect(two.session).toBe(one.session);
    expect(two.state.containers.find((c) => c.ref === 'a')).toMatchObject({ shape: 'square', pos: { x: 0.1, y: 0.9 } });
    expect(two.state.view).toMatchObject({ mode: 'half' });
    expect(Object.keys(two.state.children).sort()).toEqual(['a', 'b']);
  });

  it('adopting 10 open chats is not refused (the cap binds only `super delegate`)', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `chat-${i}`);
    for (const id of ids) reg(id).userSent('working on it');
    const { state } = await enableSuper(root, { adopt: ids, titles: {} });
    expect(Object.keys(state.children)).toHaveLength(10);
    // Ten chat cards, and the agenda card the hand-over opens.
    expect(state.containers.filter((c) => c.kind === 'chat')).toHaveLength(10);
    expect(state.containers.filter((c) => c.kind === 'agenda')).toHaveLength(1);
  });

  it('the owner route answers {session, state} with the vault name', async () => {
    reg('mine');
    const r = res();
    await handleSuperEnable(req({ adopt: ['mine'], titles: {} }), r, {}, root);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: { vault: 'acme', enabled: true, children: { mine: { sessionId: 'mine' } } } });
    expect(typeof r.json.session).toBe('string');
  });
});

describe('take back', () => {
  it('sets take-back notes, keeps the queue, and parks the session', async () => {
    reg('a');
    reg('b');
    const { session } = await enableSuper(root, { adopt: ['a', 'b'], titles: {} });
    // `a` heard the hand-over (its next message carried the note); `b` never wrote again.
    await clearSuperNote(root, 'a', 'handover');
    const state = await disableSuper(root);
    expect(state.enabled).toBe(false);
    expect(state.session).toBe(session);
    expect(state.notes).toEqual({ a: 'takeback' });
    expect(peekSuperNote('a')).toBe('takeback');
    expect(peekSuperNote('b')).toBeNull();
    expect(state.queue.length).toBeGreaterThan(0);
  });

  it('decides "delivered" from memory: a note cleared in memory but not yet on disk still gets a take-back', async () => {
    reg('a');
    await enableSuper(root, { adopt: ['a'], titles: {} });
    // The clear's in-memory half runs synchronously; its persist is still in flight.
    const clearing = clearSuperNote(root, 'a', 'handover');
    const state = await disableSuper(root);
    await clearing;
    expect(state.notes).toEqual({ a: 'takeback' });
    expect((await readSuperState(root)).notes).toEqual({ a: 'takeback' });
    expect(peekSuperNote('a')).toBe('takeback');
  });

  it('the owner route answers {state}', async () => {
    reg('a');
    await enableSuper(root, { adopt: ['a'], titles: {} });
    const r = res();
    await handleSuperDisable(req({}), r, {}, root);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: { enabled: false, vault: 'acme' } });
  });
});

function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173' }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}

function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

describe('a child already asking at hand-over (M3)', () => {
  const permission = (h: ReturnType<typeof reg>, id: string) => h.observe({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm publish' } } });
  const question = (h: ReturnType<typeof reg>, id: string) => h.observe({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] } } });

  it('a permission is the queue head at once; a question is a pending item; neither twice', async () => {
    permission(reg('p'), 'perm-1');
    question(reg('q'), 'ask-1');
    const { state } = await enableSuper(root, { adopt: ['p', 'q'], titles: {} });
    expect(superQueueHead(state)).toMatchObject({ sessionId: 'p', kind: 'permission', requestId: 'perm-1', state: 'pending' });
    expect(state.queue.filter((x) => x.sessionId === 'q')).toEqual([expect.objectContaining({ kind: 'question', requestId: 'ask-1', state: 'pending' })]);
    // A second hand-over (or the status-change path) never queues the same request again.
    await disableSuper(root);
    const again = await enableSuper(root, { adopt: ['p', 'q'], titles: {} });
    expect(again.state.queue.filter((x) => x.requestId === 'perm-1')).toHaveLength(1);
    expect(again.state.queue.filter((x) => x.requestId === 'ask-1')).toHaveLength(1);
  });

  it('items answered in the child\'s own tab while the mode was off are dropped at the next hand-over (w5 Minor 5)', async () => {
    const p = reg('p');
    const q = reg('q');
    permission(p, 'perm-old');
    question(q, 'ask-old');
    await enableSuper(root, { adopt: ['p', 'q'], titles: {} });
    // The super agent escalated q's question to the owner; then the owner took the screen back.
    await writeSuper(root, (s) => { const it = s.queue.find((x) => x.requestId === 'ask-old'); if (it) { it.state = 'escalated'; it.ownerText = 'Which?'; } });
    await disableSuper(root);
    // While off, both are answered in the chats' own tabs (the registry path ignores them), and
    // p asks something new.
    p.answered('perm-old');
    q.answered('ask-old');
    permission(p, 'perm-new');
    const { state } = await enableSuper(root, { adopt: ['p', 'q'], titles: {} });
    expect(state.queue.find((x) => x.requestId === 'perm-old')?.state).toBe('done');
    expect(state.queue.find((x) => x.requestId === 'ask-old')?.state).toBe('done');
    expect(superQueueHead(state)).toMatchObject({ sessionId: 'p', kind: 'permission', requestId: 'perm-new', state: 'pending' });
    // Nothing for q is open any more; p has exactly its current ask.
    expect(state.queue.filter((x) => x.sessionId === 'q' && x.state !== 'done')).toEqual([]);
    expect(state.queue.filter((x) => x.sessionId === 'p' && x.state !== 'done').map((x) => x.requestId)).toEqual(['perm-new']);
  });

  it('with nothing asked any more, the strip has no head at all after the second hand-over', async () => {
    const p = reg('p');
    permission(p, 'perm-x');
    await enableSuper(root, { adopt: ['p'], titles: {} });
    await disableSuper(root);
    p.answered('perm-x');
    const { state } = await enableSuper(root, { adopt: ['p'], titles: {} });
    expect(superQueueHead(state)).toBeNull();
  });

  it('a child still asking the same thing keeps its one item', async () => {
    const p = reg('p');
    permission(p, 'perm-same');
    await enableSuper(root, { adopt: ['p'], titles: {} });
    await disableSuper(root);
    const { state } = await enableSuper(root, { adopt: ['p'], titles: {} });
    expect(state.queue.filter((x) => x.requestId === 'perm-same')).toEqual([expect.objectContaining({ state: 'pending' })]);
  });

  it('an ask the status-change path already queued is not queued again by the hand-over', async () => {
    wireSuperInbox();
    const h = reg('p');
    await enableSuper(root, { adopt: ['p'], titles: {} });
    permission(h, 'perm-2');
    await vi.waitFor(async () => expect((await readSuperState(root)).queue.some((x) => x.requestId === 'perm-2')).toBe(true));
    const { state } = await enableSuper(root, { adopt: ['p'], titles: {} });
    expect(state.queue.filter((x) => x.requestId === 'perm-2')).toHaveLength(1);
  });
});

describe('caller-given ids never reach Object.prototype', () => {
  it('`__proto__`, `constructor` and `prototype` are never adopted', async () => {
    const { state } = await enableSuper(root, { adopt: ['__proto__', 'constructor', 'prototype'], titles: {} });
    expect(Object.keys(state.children)).toEqual([]);
    expect(({} as Record<string, unknown>).brief).toBeUndefined();
  });
});
