/**
 * A running child always has a card the owner can see (task super-kart-kaydi-…, owner
 * 2026-10-23: "I don't see the new job on the stage"). At the record's cap of 48 cards a new
 * child's card used to be skipped with `container: null` and no word. Now:
 *  - a full record retires its oldest finished cards (Others first, then floating cards of
 *    ended/gone children) and never a card that must stay;
 *  - `delegate` / `resume` answer `card: 'not_opened'` with the reason when it still cannot;
 *  - `super state` lists a running child with no card (`no-card`) and both card counts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-room-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { MAX_CONTAINERS, emptySuperState, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, containerIdFor } from '../../src/lib/super/inbox.js';
import { makeRoom, noCardWarnings, retirableCards, roomPossible } from '../../src/lib/super/room.js';
import { resetCapacityForTests, setCapacityFactsForTests } from '../../src/lib/super/capacity.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const task = (i: number, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: `task-t${i}`, kind: 'task', ref: `t-${i}`, shape: 'square', place: 'others', ...extra });
const chat = (sid: string, place: 'float' | 'others', extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: containerIdFor('chat', sid), kind: 'chat', ref: sid, shape: 'tall', place, ...extra });
const child = (sid: string, extra: Record<string, unknown> = {}) => ({ sessionId: sid, brief: sid, adopted: false, startedAt: 1, ...extra });
const nobodyLive = () => false;

function state(over: Partial<SuperState>): SuperState {
  return { ...emptySuperState(), session: 'sup-1', enabled: true, ...over };
}
/** Fill the record up to the cap with owner-placed task cards (which must stay). */
const pinnedFill = (have: number) => Array.from({ length: MAX_CONTAINERS - have }, (_, i) => task(100 + i, { pos: { x: 0.5, y: 0.5 } }));

describe('retiring cards to make room (pure)', () => {
  it('nothing goes while the record has room', () => {
    const s = state({ containers: [task(1), task(2)] });
    expect(makeRoom(s, 1, [], nobodyLive)).toEqual([]);
    expect(s.containers).toHaveLength(2);
  });

  it('Others first, oldest first; then floating cards of ended or gone children', () => {
    const s = state({
      children: { ended: child('ended', { endedAt: 5 }), gone: child('gone', { row: 'gone' }) },
      containers: [chat('ended', 'float'), task(1), chat('gone', 'others'), task(2), ...pinnedFill(4)],
    });
    expect(retirableCards(s, [], nobodyLive)).toEqual(['task-t1', containerIdFor('chat', 'gone'), 'task-t2', containerIdFor('chat', 'ended')]);
    expect(makeRoom(s, 2, [], nobodyLive)).toEqual(['task-t1', containerIdFor('chat', 'gone')]);
    expect(s.containers).toHaveLength(MAX_CONTAINERS - 2);
  });

  it('never a card that must stay', () => {
    const live = (sid: string) => sid === 'working';
    const s = state({
      children: {
        working: child('working', { row: 'working' }),
        asking: child('asking', { row: 'done', finishedAt: 5, seenAt: 9 }),
        unseen: child('unseen', { row: 'done', finishedAt: 5 }),
        stuck: child('stuck', { row: 'stuck' }),
        seen: child('seen', { row: 'done', finishedAt: 5, seenAt: 5 }),
      },
      queue: [{ id: 'q-1', sessionId: 'asking', kind: 'question', state: 'delivered', createdAt: 1 }],
      groups: [{ id: 'grp-a', name: 'A', cards: ['task-t3', 'task-t4'], place: 'others' }],
      view: { mode: 'half', card: 'task-t5' },
      containers: [
        chat('working', 'others'), chat('asking', 'others'), chat('unseen', 'others'), chat('stuck', 'others'),
        task(3), task(4), task(5), task(6, { sizeBy: 'owner', size: 'large' }), task(7, { pos: { x: 0.2, y: 0.2 } }), task(8),
        task(9, { place: 'float' }),
        { id: 'web-auto', kind: 'web', ref: 'http://localhost:5173/', shape: 'tall', place: 'others', by: 'auto', of: 'working' },
        chat('seen', 'others'),
      ],
    });
    // task-t8 is being opened again (kept); a floating read-only card is the owner's stage.
    expect(retirableCards(s, ['task-t8'], live)).toEqual([containerIdFor('chat', 'seen')]);
  });

  it('roomPossible counts the cards that may go', () => {
    const s = state({ containers: [task(1), ...pinnedFill(1)] });
    expect(roomPossible(s, 1, [], nobodyLive)).toBe(true);
    expect(roomPossible(s, 2, [], nobodyLive)).toBe(false);
  });

  it('noCardWarnings names a running child with no card, never an ended or succeeded one', () => {
    const s = state({
      children: { a: child('a'), b: child('b'), c: child('c', { endedAt: 1 }), d: child('d', { succeededBy: 'a' }) },
      containers: [chat('b', 'others')],
    });
    const w = noCardWarnings(s, () => true);
    expect(w.map((x) => x.child)).toEqual(['a']);
    expect(w[0]).toMatchObject({ kind: 'no-card' });
    expect(w[0].message).toContain('dreamcontext super open chat a');
  });
});

// ─── Through the real route ─────────────────────────────────────────────────────

let dir: string;
let root: string;
let token = '';
const CHILD = '12345678-1234-4234-8234-123456789abc';
let answer: Record<string, unknown> = { sessionId: CHILD };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-room-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  answer = { sessionId: CHILD };
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  resetCapacityForTests();
  setCapacityFactsForTests({ availMemGb: 12, diskFreeGb: 200, load1: 1, totalMemGb: 32, swapUsedGb: 0, swapTotalGb: 4, claudeSessions: 1, heavySteps: 0 });
  token = mintWindowToken({
    send: (frame) => {
      setImmediate(() => deliverSuperResult(token, frame.id as string, { ok: true, result: answer }));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super',
  }).token;
});
afterEach(() => { _resetSuperInbox(); rmSync(dir, { recursive: true, force: true }); });

function write(over: Record<string, unknown>): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true, ...over }));
}
function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
async function verb(name: string, body: Record<string, unknown> = {}) {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  await handleSuperVerb(req(body), out, { verb: name });
  return out;
}
const result = (r: { json: Record<string, unknown> }) => r.json.result as Record<string, unknown>;

describe('delegate at a full record (the 2026-10-23 field case)', () => {
  it('retires the oldest finished card and opens the new child\'s card', async () => {
    // 6 ended children's chat cards in Others (what the Super closed by hand), the rest pinned.
    const ended = Array.from({ length: 6 }, (_, i) => `ended-${i}`);
    write({
      children: Object.fromEntries(ended.map((sid) => [sid, child(sid, { endedAt: 1 })])),
      containers: [...ended.map((sid) => chat(sid, 'others')), ...pinnedFill(6)],
    });
    const r = await verb('delegate', { prompt: 'do the thing', brief: 'thing' });
    expect(r.status).toBe(200);
    expect(result(r)).toMatchObject({ sessionId: CHILD, card: 'opened', container: containerIdFor('chat', CHILD) });
    const s = await readSuperState(root);
    expect(s.containers).toHaveLength(MAX_CONTAINERS);
    expect(s.containers.some((c) => c.ref === CHILD)).toBe(true);
    expect(s.containers.some((c) => c.ref === 'ended-0')).toBe(false);
    expect(s.containers.some((c) => c.ref === 'ended-1')).toBe(true);
  });

  it('says card: not_opened, loudly, when every card must stay; the child is still recorded', async () => {
    write({ containers: pinnedFill(0) });
    const r = await verb('delegate', { prompt: 'do the thing', brief: 'thing' });
    expect(r.status).toBe(200);
    const out = result(r);
    expect(out).toMatchObject({ sessionId: CHILD, card: 'not_opened', container: null });
    expect(out.cardError).toMatchObject({ reason: 'record_full', limit: 'record', total: 48, maxTotal: 48 });
    expect(String((out.cardError as Record<string, unknown>).todo)).toContain(`super open chat ${CHILD}`);
    expect((await readSuperState(root)).children[CHILD]).toBeDefined();
  });

  it('resume gives a running child with no card its card back', async () => {
    write({ children: { [CHILD]: child(CHILD, { row: 'working' }) }, containers: [task(1), ...pinnedFill(1)] });
    registerChat({ sessionId: CHILD, conversationId: null, vault: 'acme', mode: 'basic' }).userSent('busy');
    const r = await verb('resume', { child: CHILD });
    expect(r.status).toBe(200);
    expect(result(r)).toMatchObject({ running: true, card: 'opened', container: containerIdFor('chat', CHILD) });
    expect((await readSuperState(root)).containers.some((c) => c.id === 'task-t1')).toBe(false);
  });
});

describe('super state', () => {
  it('lists a running child with no card and both card counts', async () => {
    write({ children: { [CHILD]: child(CHILD, { row: 'working' }) }, containers: [task(1)] });
    registerChat({ sessionId: CHILD, conversationId: null, vault: 'acme', mode: 'basic' }).userSent('busy');
    const r = await verb('state');
    expect(r.status).toBe(200);
    const out = result(r);
    expect(out.cards).toEqual({ floating: 0, maxFloating: 12, total: 1, maxTotal: 48 });
    expect(out.warnings).toEqual([expect.objectContaining({ kind: 'no-card', child: CHILD })]);
  });
});
