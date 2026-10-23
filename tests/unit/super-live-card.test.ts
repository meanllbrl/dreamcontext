/**
 * A live child is always a floating card (task super-canli-kart-sahnede, owner 2026-10-23,
 * repeated: "running jobs' cards keep not being floating on the stage"). One regression per path
 * that put a live job's card in Others or hid it:
 *  - the 45-minute tidy (it read a `gone` row, every child after an app restart, as finished, and
 *    never asked the registry);
 *  - the stage cap (a new child's card on a full stage of 12 went to Others);
 *  - resume / adopt / restart / a row turning live again (a card already in Others stayed there);
 *  - the Super's `stack` / `group` / `open --group` on a live job;
 *  - the owner's own drag to Others is kept until that run finishes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-live-card-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { MAX_FLOAT, emptySuperState, floatCount, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, containerIdFor, ensureChatContainer, writeSuper } from '../../src/lib/super/inbox.js';
import { childIsLive, floatLiveChildren, stackForLive } from '../../src/lib/super/live.js';
import { TIDY_IDLE_MS, _resetTidy, planTidy } from '../../src/lib/super/tidy.js';
import { resetCapacityForTests, setCapacityFactsForTests } from '../../src/lib/super/capacity.js';
import { handleSuperLayout, handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const NOW = 1_800_000_000_000;
const old = () => NOW - TIDY_IDLE_MS - 1;
const idle = () => false;
const chat = (sid: string, place: 'float' | 'others' = 'float', extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: containerIdFor('chat', sid), kind: 'chat', ref: sid, shape: 'tall', place, ...extra });
const pic = (i: number, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: `image-p${i}`, kind: 'image', ref: `docs/p${i}.png`, shape: 'square', place: 'float', ...extra });
const child = (sid: string, extra: Record<string, unknown> = {}) => ({ sessionId: sid, brief: sid, adopted: false, startedAt: NOW - 3 * 3600_000, ...extra });
const base = (over: Partial<SuperState> = {}): SuperState => ({ ...emptySuperState(), session: 'sup-1', enabled: true, ...over });
const cid = (sid: string) => containerIdFor('chat', sid);

describe('childIsLive', () => {
  it('working, asking, stuck, waiting, an open question or a busy process is live; done, gone and ended are not', () => {
    const s = base({
      children: {
        w: child('w', { row: 'working' }), a: child('a', { row: 'asking' }), st: child('st', { row: 'stuck' }), wt: child('wt', { row: 'waiting' }),
        q: child('q', { row: 'done' }), b: child('b', { row: 'done' }), d: child('d', { row: 'done' }), g: child('g', { row: 'gone' }),
        e: child('e', { row: 'working', endedAt: 5 }),
      } as SuperState['children'],
      queue: [{ id: 'q-1', sessionId: 'q', kind: 'question', state: 'delivered', createdAt: 1 }],
    });
    const busy = (sid: string) => sid === 'b';
    expect(['w', 'a', 'st', 'wt', 'q', 'b'].every((sid) => childIsLive(s, sid, busy))).toBe(true);
    expect(['d', 'g', 'e', 'nobody'].some((sid) => childIsLive(s, sid, busy))).toBe(false);
  });
});

describe('the 45-minute tidy never moves a live job', () => {
  it('a child whose record says done or gone but whose process works stays; a finished one goes', () => {
    const s = base({
      containers: [chat('busy'), chat('back'), chat('done')],
      children: {
        busy: child('busy', { row: 'done', rowAt: old(), finishedAt: old() }),
        // Gone since the app restarted, and registered again: its process works.
        back: child('back', { row: 'gone', rowAt: old(), finishedAt: old() }),
        done: child('done', { row: 'done', rowAt: old(), finishedAt: old() }),
      } as SuperState['children'],
    });
    expect(planTidy(s, old, NOW, (sid) => sid === 'busy' || sid === 'back')).toEqual([cid('done')]);
  });

  it('a gone child that never comes back leaves on the idle clock counted from when it went gone', () => {
    const s = base({
      containers: [chat('justGone'), chat('longGone')],
      children: {
        justGone: child('justGone', { row: 'gone', rowAt: NOW - 60_000 }),
        longGone: child('longGone', { row: 'gone', rowAt: old() }),
      } as SuperState['children'],
    });
    expect(planTidy(s, old, NOW, idle)).toEqual([cid('longGone')]);
  });

  it('a live job in a group keeps the whole group on the stage', () => {
    const s = base({
      containers: [chat('w'), pic(1)],
      groups: [{ id: 'grp-mix', name: 'Mix', cards: [cid('w'), 'image-p1'], place: 'float' }],
      children: { w: child('w', { row: 'waiting', rowAt: old() }) } as SuperState['children'],
    });
    expect(planTidy(s, old, NOW, idle)).toEqual([]);
  });
});

describe('the record invariant (every write)', () => {
  it('a live child\'s card in Others floats again; a finished one stays', () => {
    const s = base({
      containers: [chat('w', 'others'), chat('d', 'others')],
      children: { w: child('w', { row: 'working' }), d: child('d', { row: 'done' }) } as SuperState['children'],
    });
    expect(floatLiveChildren(s, idle).floated).toEqual([cid('w')]);
    expect(s.containers.map((c) => c.place)).toEqual(['float', 'others']);
  });

  it('a live child\'s card in a group in Others: the whole group floats, never broken up', () => {
    const s = base({
      containers: [chat('w'), pic(1), pic(2)],
      groups: [{ id: 'grp-x', name: 'X', cards: [cid('w'), 'image-p1', 'image-p2'], place: 'others' }],
      children: { w: child('w', { row: 'asking' }) } as SuperState['children'],
    });
    expect(floatLiveChildren(s, idle).floated).toEqual([cid('w')]);
    expect(s.groups[0]).toMatchObject({ cards: [cid('w'), 'image-p1', 'image-p2'], place: 'float' });
  });

  it('a full stage: the live card floats and the oldest non-live item goes to Others (never the agenda, a shown or owner-placed card)', () => {
    const s = base({
      containers: [
        { id: 'agenda-a', kind: 'agenda', ref: 'agenda', shape: 'square', place: 'float' },
        pic(1, { pos: { x: 0.1, y: 0.1 } }), pic(2), pic(3),
        ...Array.from({ length: MAX_FLOAT - 4 }, (_, i) => pic(10 + i)),
        chat('w', 'others'),
      ],
      view: { mode: 'half', card: 'image-p2' },
      children: { w: child('w', { row: 'working' }) } as SuperState['children'],
    });
    expect(floatCount(s)).toBe(MAX_FLOAT);
    const out = floatLiveChildren(s, idle);
    expect(out.floated).toEqual([cid('w')]);
    expect(out.stacked).toEqual(['image-p3']);
    expect(floatCount(s)).toBe(MAX_FLOAT);
  });

  it('a stage of live jobs only: the cap gives way, every live card floats', () => {
    const sids = Array.from({ length: MAX_FLOAT + 1 }, (_, i) => `w${i}`);
    const s = base({
      containers: sids.map((sid, i) => chat(sid, i === MAX_FLOAT ? 'others' : 'float')),
      children: Object.fromEntries(sids.map((sid) => [sid, child(sid, { row: 'working' })])) as SuperState['children'],
    });
    floatLiveChildren(s, idle);
    expect(floatCount(s)).toBe(MAX_FLOAT + 1);
  });

  it('nothing to bring back: an owner who floated past the cap himself keeps his stage', () => {
    const s = base({ containers: Array.from({ length: MAX_FLOAT + 2 }, (_, i) => pic(i)) });
    expect(floatLiveChildren(s, idle)).toEqual({ floated: [], stacked: [] });
    expect(floatCount(s)).toBe(MAX_FLOAT + 2);
    expect(stackForLive(s, MAX_FLOAT + 2, idle)).toEqual([]);
  });

  it('the owner\'s hold: kept while that run lasts, spent once it finished, then the card floats', () => {
    const s = base({
      containers: [chat('w', 'others', { heldAt: NOW - 1000 })],
      children: { w: child('w', { row: 'working' }) } as SuperState['children'],
    });
    floatLiveChildren(s, idle);
    expect(s.containers[0]).toMatchObject({ place: 'others', heldAt: NOW - 1000 });
    // The run he put away finished, and a new one started.
    (s.children.w as { finishedAt?: number }).finishedAt = NOW;
    floatLiveChildren(s, idle);
    expect(s.containers[0].place).toBe('float');
    expect(s.containers[0].heldAt).toBeUndefined();
  });

  it('ensureChatContainer(runs): a new child on a full stage floats; a resumed one comes back from Others', () => {
    const s = base({ containers: Array.from({ length: MAX_FLOAT }, (_, i) => pic(i)) });
    ensureChatContainer(s, 'new', 'new job', true);
    expect(s.containers.find((c) => c.ref === 'new')?.place).toBe('float');
    expect(s.containers.find((c) => c.id === 'image-p0')?.place).toBe('others');
    const r = base({ containers: [chat('back', 'others', { heldAt: 5 })], children: { back: child('back', { row: 'done' }) } as SuperState['children'] });
    ensureChatContainer(r, 'back', 'back', true);
    expect(r.containers[0].place).toBe('float');
    expect(r.containers[0].heldAt).toBeUndefined();
  });
});

// ─── Through the real routes and the store ─────────────────────────────────────

let dir: string;
let root: string;
let token = '';
const CHILD = '12345678-1234-4234-8234-123456789abc';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-live-card-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  _resetTidy();
  resetWindowControl();
  resetCapacityForTests();
  setCapacityFactsForTests({ availMemGb: 12, diskFreeGb: 200, load1: 1, totalMemGb: 32, swapUsedGb: 0, swapTotalGb: 4, claudeSessions: 1, heavySteps: 0 });
  token = mintWindowToken({
    send: (frame) => { setImmediate(() => deliverSuperResult(token, frame.id as string, { ok: true, result: { sessionId: CHILD } })); return true; },
    vault: 'acme', contextRoot: root, sessionId: 'sup-1', mode: 'super',
  }).token;
});
afterEach(() => { _resetSuperInbox(); rmSync(dir, { recursive: true, force: true }); });

function write(over: Partial<SuperState>): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sup-1', enabled: true, ...over }));
}
function req(body: unknown, withToken = true): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...(withToken ? { 'x-dreamcontext-window-token': token } : {}) }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown> = {}) {
  const out = res();
  await handleSuperVerb(req(body), out, { verb: name });
  return out;
}
async function layout(body: Record<string, unknown>) {
  const out = res();
  await handleSuperLayout(req(body, false), out, {}, root);
  return out;
}

describe('the Super\'s verbs on a live job', () => {
  it('stack and group refuse a live job\'s card (409 live_child); a finished one may go', async () => {
    write({
      containers: [chat('w'), chat('d'), pic(1)],
      children: { w: child('w', { row: 'working' }), d: child('d', { row: 'done' }) } as SuperState['children'],
    });
    const s1 = await verb('stack', { container: cid('w') });
    expect(s1.status).toBe(409);
    expect(s1.json.error).toBe('live_child');
    expect((await verb('group', { containers: [cid('w'), 'image-p1'], name: 'Mix' })).json.error).toBe('live_child');
    expect((await verb('open', { kind: 'chat', refs: ['w'], group: 'Jobs' })).json.error).toBe('live_child');
    expect((await verb('stack', { container: cid('d') })).status).toBe(200);
    const s = await readSuperState(root);
    expect(s.containers.find((c) => c.id === cid('w'))?.place).toBe('float');
    expect(s.groups).toEqual([]);
  });

  it('delegate on a full stage: the new job floats, the oldest picture goes to Others', async () => {
    write({ containers: Array.from({ length: MAX_FLOAT }, (_, i) => pic(i)) });
    const r = await verb('delegate', { prompt: 'do the thing', brief: 'thing' });
    expect(r.status).toBe(200);
    const s = await readSuperState(root);
    expect(s.containers.find((c) => c.ref === CHILD)?.place).toBe('float');
    expect(s.containers.find((c) => c.id === 'image-p0')?.place).toBe('others');
    expect(floatCount(s)).toBe(MAX_FLOAT);
  });

  it('resume of a running child whose card rests in Others brings it back', async () => {
    write({ containers: [chat(CHILD, 'others')], children: { [CHILD]: child(CHILD, { row: 'working', endedAt: 5 }) } as SuperState['children'] });
    registerChat({ sessionId: CHILD, conversationId: null, vault: 'acme', mode: 'basic' }).userSent('busy');
    const r = await verb('resume', { child: CHILD, force: true });
    expect(r.status).toBe(200);
    expect((await readSuperState(root)).containers[0].place).toBe('float');
  });
});

describe('restart and reload: a row turning live floats its card on the next write', () => {
  it('a gone child (app restart) whose card was tidied to Others is back on the stage once it runs again', async () => {
    write({ containers: [chat('g', 'others')], children: { g: child('g', { row: 'gone' }) } as SuperState['children'] });
    // The reconcile writes the row the registry now says (what happens when the child registers again).
    await writeSuper(root, (s) => { s.children.g.row = 'working'; });
    expect((await readSuperState(root)).containers[0].place).toBe('float');
  });
});

describe('the owner\'s own hand', () => {
  it('a live card he drags to Others stays there; a write later does not undo it; his float clears the hold', async () => {
    write({ containers: [chat('w')], children: { w: child('w', { row: 'working' }) } as SuperState['children'] });
    expect((await layout({ cards: [{ id: cid('w'), place: 'others' }] })).status).toBe(200);
    let s = await readSuperState(root);
    expect(s.containers[0].place).toBe('others');
    expect(typeof s.containers[0].heldAt).toBe('number');
    await writeSuper(root, (d) => { d.children.w.brief = 'still working'; });
    expect((await readSuperState(root)).containers[0].place).toBe('others');
    await layout({ cards: [{ id: cid('w'), place: 'float' }] });
    s = await readSuperState(root);
    expect(s.containers[0].place).toBe('float');
    expect(s.containers[0].heldAt).toBeUndefined();
  });

  it('a live card he grouped stays in his group, also when he floats the group back from Others', async () => {
    write({ containers: [chat('w'), pic(1)], children: { w: child('w', { row: 'working' }) } as SuperState['children'] });
    await layout({ group: { id: 'grp-mine', cards: [cid('w'), 'image-p1'], name: 'Mine' } });
    await layout({ cards: [{ id: 'grp-mine', place: 'others' }] });
    await layout({ cards: [{ id: 'grp-mine', place: 'float' }] });
    const s = await readSuperState(root);
    expect(s.groups.find((g) => g.id === 'grp-mine')?.cards).toEqual([cid('w'), 'image-p1']);
    expect(s.groups[0].place).toBe('float');
  });
});
