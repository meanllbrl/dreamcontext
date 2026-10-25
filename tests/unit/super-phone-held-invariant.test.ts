/**
 * A phone never holds a Super child (hands-free sekmeler W1, AC12): the record-side invariant.
 *
 *  - the store's single write path ends every child a write ARMS (an `endedAt` cleared, or
 *    `enabled` false→true over kept children) while the phone-held probe says a remote screen
 *    holds it, and takes back only what that write added for it (cards, note, open items);
 *  - hand-over skips (and names) a phone-held candidate and ends a phone-held kept child;
 *  - `super adopt`, `super resume`, `send` and `answer` refuse a phone-held chat with 409
 *    `phone_held` and write nothing;
 *  - the socket gate (`isHandedOverChild`) reads the write in flight: a hand-over is "on" before
 *    its commit, a take-back "off" only after it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-phone-held-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import {
  PhoneHeldError, SUPER_STATE_REL, isHandedOverChild, readSuperState, resetSuperIndex, setPhoneHoldsProbe, updateSuperState,
} from '../../src/lib/super/store.js';
import { _resetSuperInbox, noteChatStarted, writeSuper } from '../../src/lib/super/inbox.js';
import { disableSuper, enableSuper } from '../../src/lib/super/handover.js';
import { SUPER_VERB_HANDLERS, type SuperCaller } from '../../src/server/routes/super.js';
import { resetWindowControl } from '../../src/lib/window-control.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';

let dir: string;
let root: string;
const SESSION = 'sess-super';
const held = new Set<string>();
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-phone-held-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  held.clear();
  setPhoneHoldsProbe((sid) => held.has(sid));
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  setPhoneHoldsProbe(null);
  _resetSuperInbox();
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

const reg = (sid: string) => registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode: 'basic' });

async function seed(extra: Partial<SuperState>): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SESSION, ...extra }));
  await readSuperState(root);
}

function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}

async function verb(name: keyof typeof SUPER_VERB_HANDLERS, body: Record<string, unknown>) {
  const r = res();
  const caller = { token: 't', who: { contextRoot: root }, state: await readSuperState(root) } as unknown as SuperCaller;
  await SUPER_VERB_HANDLERS[name](caller, body, r);
  return r;
}

const child = (extra: Record<string, unknown> = {}) => ({ sessionId: 'x', brief: 'job', adopted: true, startedAt: 1, ...extra });
const chatCard = (sid: string) => ({ id: `chat-${sid}`, kind: 'chat', ref: sid, shape: 'tall', place: 'float' });

describe('the store ends a child a write arms while a phone holds it', () => {
  it('a raw writeSuper that reopens a phone-held ended child: ended again, no card, no note, its open items closed', async () => {
    await seed({ enabled: true, children: { kid: child({ sessionId: 'kid', endedAt: 5 }) }, notes: { kid: 'takeback' } });
    held.add('kid');
    const demoted: string[][] = [];
    const after = await writeSuper(root, (s) => {
      delete s.children.kid.endedAt;
      s.containers.push(chatCard('kid') as never);
      s.notes.kid = 'handover';
      s.queue.push({ id: 'q-new', sessionId: 'kid', kind: 'question', requestId: 'r1', state: 'pending', createdAt: 9 });
    }, { onDemoted: (ids) => demoted.push(ids) });
    expect(after.children.kid.endedAt).toBeTypeOf('number');
    expect(after.containers.some((c) => c.ref === 'kid')).toBe(false);
    expect(after.notes.kid).toBe('takeback');
    expect(after.queue.find((q) => q.id === 'q-new')?.state).toBe('done');
    expect(demoted).toEqual([['kid']]);
    expect(isHandedOverChild('kid')).toBe(false);
  });

  it('a card the owner already had stays; only what this write added goes', async () => {
    await seed({ enabled: true, children: { kid: child({ sessionId: 'kid', endedAt: 5 }) }, containers: [chatCard('kid') as never] });
    held.add('kid');
    const after = await writeSuper(root, (s) => { delete s.children.kid.endedAt; });
    expect(after.children.kid.endedAt).toBeTypeOf('number');
    expect(after.containers.map((c) => c.id)).toContain('chat-kid');
  });

  it('re-hand-over (enabled false→true) over a kept child is arming too: the store ends it even when the caller did not look', async () => {
    await seed({ enabled: false, children: { kept: child({ sessionId: 'kept' }) } });
    held.add('kept');
    // A stand-in for a hand-over with its own kept-child check REMOVED: only the store guards.
    const after = await updateSuperState(root, (s) => { s.enabled = true; });
    expect(after.children.kept.endedAt).toBeTypeOf('number');
    expect(isHandedOverChild('kept')).toBe(false);
  });

  it('not demoted while not handed over; demoted at the next hand-over', async () => {
    await seed({ enabled: false, children: { kid: child({ sessionId: 'kid', endedAt: 5 }) } });
    held.add('kid');
    const open = await writeSuper(root, (s) => { delete s.children.kid.endedAt; });
    expect(open.children.kid.endedAt).toBeUndefined();
    const on = await writeSuper(root, (s) => { s.enabled = true; });
    expect(on.children.kid.endedAt).toBeTypeOf('number');
  });

  it('an already armed child is not the store\'s to end (the socket gate keeps it); a throwing probe ends only NEWLY armed ones', async () => {
    await seed({ enabled: true, children: { old: child({ sessionId: 'old' }), back: child({ sessionId: 'back', endedAt: 3 }) } });
    setPhoneHoldsProbe(() => { throw new Error('probe broke'); });
    const after = await writeSuper(root, (s) => { delete s.children.back.endedAt; });
    expect(after.children.old.endedAt).toBeUndefined();
    expect(after.children.back.endedAt).toBeTypeOf('number');
  });

  it('the owner reopening a phone-held ended child (Past chats on the phone): stays ended, no card, the phone keeps it', async () => {
    await seed({ enabled: true, children: { kid: child({ sessionId: 'kid', endedAt: 5 }) } });
    held.add('kid');
    await noteChatStarted('kid');
    const s = await readSuperState(root);
    expect(s.children.kid.endedAt).toBeTypeOf('number');
    expect(s.containers.some((c) => c.ref === 'kid')).toBe(false);
    expect(s.notes.kid).toBeUndefined();
  });
});

describe('hand-over skips what a remote screen holds', () => {
  it('a phone-held candidate is not adopted and is named; a free one is', async () => {
    reg('free'); reg('remote');
    held.add('remote');
    const { state, skipped } = await enableSuper(root, { adopt: ['free', 'remote'], titles: { remote: 'On the iPad' } });
    expect(Object.keys(state.children)).toEqual(['free']);
    expect(skipped).toEqual([{ id: 'remote', title: 'On the iPad', reason: 'phone_held' }]);
    expect(state.containers.some((c) => c.ref === 'remote')).toBe(false);
  });

  it('a phone-held KEPT child is ended (its worktree stays), skipped, and gets no card', async () => {
    reg('kept');
    const wt = join(process.env.HOME as string, '.claude-worktrees', 'acme-kept');
    await seed({ enabled: false, children: { kept: child({ sessionId: 'kept', worktree: wt, branch: 'super/x' }) } });
    held.add('kept');
    const { state, skipped } = await enableSuper(root, { adopt: [], titles: {} });
    expect(state.children.kept.endedAt).toBeTypeOf('number');
    expect(state.children.kept.worktree).toBe(wt);
    expect(state.children.kept.branch).toBe('super/x');
    expect(skipped.map((x) => [x.id, x.reason])).toEqual([['kept', 'phone_held']]);
    expect(state.containers.some((c) => c.ref === 'kept')).toBe(false);
  });

  it('ids the hand-over could not adopt for other reasons are named too (gone, another project)', async () => {
    registerChat({ sessionId: 'beta-chat', conversationId: null, vault: 'beta', mode: 'basic' });
    const { skipped } = await enableSuper(root, { adopt: ['beta-chat', 'never-seen'], titles: {} });
    expect(skipped.map((x) => [x.id, x.reason]).sort()).toEqual([['beta-chat', 'other_vault'], ['never-seen', 'gone']]);
  });

  it('after a take-back the rule is off: a former child is free again until the next hand-over', async () => {
    reg('a');
    await enableSuper(root, { adopt: ['a'], titles: {} });
    expect(isHandedOverChild('A')).toBe(true);
    await disableSuper(root);
    expect(isHandedOverChild('a')).toBe(false);
  });
});

describe('the Super\'s verbs refuse a phone-held chat (409 phone_held), writing nothing', () => {
  it('super adopt', async () => {
    reg('remote');
    await seed({ enabled: true });
    held.add('remote');
    const before = JSON.stringify(await readSuperState(root));
    const r = await verb('adopt', { chat: 'remote', force: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('phone_held');
    expect(JSON.stringify(await readSuperState(root))).toBe(before);
  });

  it('super adopt racing a phone open: the in-write check throws PhoneHeldError and nothing lands', async () => {
    reg('racer');
    await seed({ enabled: true });
    let calls = 0;
    setPhoneHoldsProbe((sid) => sid === 'racer' && ++calls > 1);
    const before = JSON.stringify(await readSuperState(root));
    await expect(verb('adopt', { chat: 'racer', force: true })).rejects.toBeInstanceOf(PhoneHeldError);
    expect(JSON.stringify(await readSuperState(root))).toBe(before);
  });

  it('super resume --force of a phone-held ended child', async () => {
    reg('kid');
    await seed({ enabled: true, children: { kid: child({ sessionId: 'kid', endedAt: 5 }) } });
    held.add('kid');
    const r = await verb('resume', { child: 'kid', force: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('phone_held');
    expect((await readSuperState(root)).children.kid.endedAt).toBe(5);
  });

  it('send and answer', async () => {
    reg('kid');
    await seed({ enabled: true, children: { kid: child({ sessionId: 'kid' }) } });
    held.add('kid');
    const s = await verb('send', { child: 'kid', text: 'go on' });
    expect([s.status, s.json.error]).toEqual([409, 'phone_held']);
    const a = await verb('answer', { child: 'kid', requestId: 'r1', choices: ['Yes'] });
    expect([a.status, a.json.error]).toEqual([409, 'phone_held']);
  });
});

describe('the socket gate reads the write in flight', () => {
  it('a hand-over is "on" before its commit; a take-back is "off" only after it', async () => {
    reg('c1');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const real = fsp.rename.bind(fsp);
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (...a: Parameters<typeof fsp.rename>) => { await gate; return real(...a); });
    const writing = enableSuper(root, { adopt: ['c1'], titles: {} });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(isHandedOverChild('c1')).toBe(true);
    release();
    await writing;
    expect(isHandedOverChild('C1')).toBe(true);

    let release2: () => void = () => {};
    const gate2 = new Promise<void>((r) => { release2 = r; });
    spy.mockImplementation(async (...a: Parameters<typeof fsp.rename>) => { await gate2; return real(...a); });
    spy.mockClear();
    const back = disableSuper(root);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(isHandedOverChild('c1')).toBe(true);
    release2();
    await back;
    expect(isHandedOverChild('c1')).toBe(false);
    spy.mockRestore();
  });

  it('a write that fails leaves no pending entry behind', async () => {
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('disk full'));
    await expect(updateSuperState(root, (s) => { s.enabled = true; s.children.z = child({ sessionId: 'z' }) as never; })).rejects.toThrow('disk full');
    expect(isHandedOverChild('z')).toBe(false);
    spy.mockRestore();
  });
});
