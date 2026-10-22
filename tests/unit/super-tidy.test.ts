/**
 * The Super stage tidies itself (owner 2026-10-22, 19:39: "Kullanılmayan, artık önemli olmayan
 * kartlar kalabalık oluşturuyor; bir de başlıkları yok").
 *
 *  - a floating card or group nobody touched for TIDY_IDLE_MS goes to Others, never closed;
 *  - a finished child's card the owner saw in the agenda goes at once;
 *  - never: what the owner placed or sized, what the view shows, a server-opened card, a chat
 *    whose child works or asks or has an open queue item; a group only when all its cards may;
 *  - touched = opened by the super, changed by anyone, opened by the owner (layout `touch`);
 *  - `super open --titles "a|b|c"` labels each ref.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-tidy-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TIDY_IDLE_MS, _resetTidy, planTidy, refreshMarks, tidyOnce, touchCards } from '../../src/lib/super/tidy.js';
import { superSanitizeOpts, writeSuper } from '../../src/lib/super/inbox.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { GROUP_ID_RE, emptySuperState, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
const SUPER = 'sup-tidy';
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

const card = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'chat', ref: `ref-${id}`, shape: 'tall', place: 'float', ...extra });

function makeVault(state: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    containers: [card('chat-a'), card('chat-b'), card('chat-c', { pos: { x: 0.9, y: 0.1 } }), card('task-d', { kind: 'task', shape: 'square' })],
    ...state,
  }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-tidy-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

function req(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}
async function layout(body: Record<string, unknown>) {
  const r = res();
  await handleSuperLayout(req(body), r, {}, root);
  return r;
}
const state = () => readSuperState(root);


const NOW = 1_800_000_000_000;
const io = { read: (r: string) => readSuperState(r, superSanitizeOpts()), write: (r: string, fn: (s: SuperState) => void) => writeSuper(r, fn) };
const child = (sid: string, extra: Record<string, unknown> = {}) => ({ sessionId: sid, brief: 'job', adopted: false, startedAt: NOW - 3 * 3600_000, ...extra });
const base = (extra: Partial<SuperState> = {}): SuperState => ({ ...emptySuperState(), session: SUPER, enabled: true, ...extra });
const old = () => NOW - TIDY_IDLE_MS - 1;

beforeEach(() => _resetTidy());

describe('planTidy (pure)', () => {
  it('an untouched card goes; a recent one, a placed one, a sized one and a shown one stay', () => {
    const s = base({
      containers: [card('task-a', { kind: 'task' }), card('task-b', { kind: 'task' }), card('task-c', { kind: 'task', pos: { x: 0.1, y: 0.1 } }),
        card('task-d', { kind: 'task', sizeBy: 'owner', size: 'medium' }), card('task-e', { kind: 'task' }), card('web-f', { kind: 'web', by: 'auto' })],
      view: { mode: 'half', card: 'task-e' },
    });
    const at = (id: string) => (id === 'task-b' ? NOW - 60_000 : old());
    expect(planTidy(s, at, NOW)).toEqual(['task-a']);
  });

  it('a chat: never while its child works or has an open question; at once when finished and seen', () => {
    const s = base({
      containers: [card('chat-w', { ref: 'w' }), card('chat-q', { ref: 'q' }), card('chat-s', { ref: 's' }), card('chat-u', { ref: 'u' })],
      children: {
        w: child('w', { row: 'working', rowAt: old() }),
        q: child('q', { row: 'done', rowAt: old(), finishedAt: old() }),
        s: child('s', { row: 'done', rowAt: NOW - 1000, finishedAt: NOW - 1000, seenAt: NOW - 500 }),
        u: child('u', { row: 'done', rowAt: NOW - 1000, finishedAt: NOW - 1000 }),
      } as SuperState['children'],
      queue: [{ id: 'q1', sessionId: 'q', kind: 'question', state: 'pending', createdAt: NOW }] as SuperState['queue'],
    });
    // Touched a moment before he saw it: only the finished job he saw goes (an unseen one is still news).
    expect(planTidy(s, () => NOW - 2000, NOW)).toEqual(['chat-s']);
    // Long untouched: an unseen finished job goes too, never the working child or the one asking.
    for (const k of ['q', 'u', 's']) (s.children[k] as { rowAt: number }).rowAt = old();
    expect(planTidy(s, old, NOW)).toEqual(['chat-s', 'chat-u']);
  });

  it('a seen job\'s card the owner brought back stays (touched after he saw it), on the idle clock', () => {
    const s = base({
      containers: [card('chat-s', { ref: 's' }), card('chat-t', { ref: 't' }), card('image-x', { kind: 'image' })],
      groups: [{ id: 'grp-back', name: 'Back', cards: ['chat-t', 'image-x'], place: 'float' }],
      children: {
        s: child('s', { row: 'done', rowAt: NOW - 5000, finishedAt: NOW - 5000, seenAt: NOW - 4000 }),
        t: child('t', { row: 'done', rowAt: NOW - 5000, finishedAt: NOW - 5000, seenAt: NOW - 4000 }),
      } as SuperState['children'],
    });
    // Seen at NOW-4000; the cards and the group were touched before that: they go.
    const before = (id: string) => (id === 'image-x' ? old() : NOW - 6000);
    expect(planTidy(s, before, NOW)).toEqual(['chat-s', 'grp-back']);
    // He brought them back after seeing them: they stay.
    expect(planTidy(s, (id) => (id === 'image-x' ? old() : NOW - 1000), NOW)).toEqual([]);
  });

  it('a group goes only when every card may, and only once the group itself is idle', () => {
    const s = base({
      containers: [card('image-a', { kind: 'image' }), card('image-b', { kind: 'image' }), card('image-c', { kind: 'image' }), card('chat-w', { ref: 'w' })],
      groups: [{ id: 'grp-one', name: 'Pics', cards: ['image-a', 'image-b'], place: 'float' }, { id: 'grp-two', name: 'Mixed', cards: ['image-c', 'chat-w'], place: 'float' }],
      children: { w: child('w', { row: 'working' }) } as SuperState['children'],
    });
    expect(planTidy(s, old, NOW)).toEqual(['grp-one']);
    expect(planTidy(s, (id) => (id === 'grp-one' ? NOW : old()), NOW)).toEqual([]);
  });

  it('a new or changed card is touched when the marks refresh', () => {
    const s = base({ containers: [card('task-a', { kind: 'task' })] });
    const m = refreshMarks(new Map(), s, NOW - 2 * TIDY_IDLE_MS);
    expect(planTidy(s, (id) => m.get(id)?.at, NOW)).toEqual(['task-a']);
    s.containers[0].title = 'Renamed';
    refreshMarks(m, s, NOW);
    expect(planTidy(s, (id) => m.get(id)?.at, NOW)).toEqual([]);
  });
});

describe('the clock on a real record', () => {
  it('moves what is due to Others, never closes it, and a touch keeps a card', async () => {
    makeVault({ containers: [card('task-a', { kind: 'task' }), card('task-b', { kind: 'task' })] });
    expect(await tidyOnce(root, io, NOW)).toEqual([]);
    touchCards(root, ['task-b'], NOW + TIDY_IDLE_MS);
    expect(await tidyOnce(root, io, NOW + TIDY_IDLE_MS + 1)).toEqual(['task-a']);
    const s = await state();
    expect(s.containers.map((k) => [k.id, k.place])).toEqual([['task-a', 'others'], ['task-b', 'float']]);
  });

  it('the owner\'s layout `touch` keeps a card, and changes nothing on the record', async () => {
    makeVault({ containers: [card('task-a', { kind: 'task' })] });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    await tidyOnce(root, io, NOW);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + TIDY_IDLE_MS);
    const before = JSON.stringify(await state());
    expect((await layout({ touch: ['task-a'] })).status).toBe(200);
    expect(JSON.stringify(await state())).toBe(before);
    expect(await tidyOnce(root, io, NOW + TIDY_IDLE_MS + 1)).toEqual([]);
    vi.restoreAllMocks();
  });

  it('`super open` touches what it opens', async () => {
    makeVault({ containers: [] });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    await verb('open', { kind: 'task', ref: 'ship-it' });
    await tidyOnce(root, io, NOW);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + TIDY_IDLE_MS);
    await verb('open', { kind: 'task', ref: 'ship-it' });
    expect(await tidyOnce(root, io, NOW + TIDY_IDLE_MS + 1)).toEqual([]);
    expect(await tidyOnce(root, io, NOW + 2 * TIDY_IDLE_MS + 1)).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('a handed-back stage is left alone', async () => {
    makeVault({ containers: [card('task-a', { kind: 'task' })], enabled: false });
    await tidyOnce(root, io, NOW);
    expect(await tidyOnce(root, io, NOW + 2 * TIDY_IDLE_MS)).toEqual([]);
  });
});

describe('super open --titles', () => {
  it('labels each ref in order; an empty one leaves the label; more labels than refs is refused', async () => {
    makeVault({ containers: [] });
    const r = await verb('open', { kind: 'image', refs: ['a/A-agac.png', 'a/B-org.png', 'a/c.png'], titles: ['Önce: liste', '', 'Sonra'] });
    expect(r.status).toBe(200);
    const s = await state();
    expect(s.containers.map((k) => k.title)).toEqual(['Önce: liste', undefined, 'Sonra']);
    expect((await verb('open', { kind: 'image', refs: ['x.png'], titles: ['a', 'b'] })).status).toBe(400);
  });
});
