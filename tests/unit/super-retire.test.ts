/**
 * The Super ends finished jobs on its own (task super-agent-ends-finished-told-child-sessions-…,
 * owner 2026-10-27: "buradaki eski sessionlar da kapanmıyor").
 *
 *  - due: a delegated child whose row is done (or gone after a delivered done), whose result was
 *    told (its done event delivered) or seen (seenAt >= finishedAt), nothing open, untouched for
 *    RETIRE_IDLE_MS (60 min) since the latest of its finish, the seen click, the owner's last
 *    touch of its card, the owner's focus, and the clock's own start (a restart ends nothing);
 *  - never: working, asking, stuck, waiting, an open queue item, untold, adopted, an owner-placed
 *    or owner-sized card, a card the view shows, a recent touch or focus;
 *  - the tidy clock does it (no second timer), ending each child the way `super end` does: the
 *    park primitive with `end`, then the record (card gone, endedAt, a done `ended` item).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-retire-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperChild, type SuperContainer, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, superSanitizeOpts, writeSuper } from '../../src/lib/super/inbox.js';
import { RETIRE_IDLE_MS, TIDY_IDLE_MS, _resetTidy, planRetire, retireKeep, tidyOnce, seenClickAt, touchedAt, type RetireLive } from '../../src/lib/super/tidy.js';
import { handleSuperSeen, retireChildren } from '../../src/server/routes/super.js';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatParkForTests, registerParkable, type ParkOptions, type ParkOutcome } from '../../src/server/chat-park.js';

const H = 60 * 60_000;
const NOW = 10 * H;
const FIN = NOW - 2 * H;

const card = (sid: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id: `chat-${sid}`, kind: 'chat', ref: sid, shape: 'tall', place: 'others', ...extra });
const child = (sid: string, extra: Partial<SuperChild> = {}): SuperChild =>
  ({ sessionId: sid, brief: `job ${sid}`, adopted: false, startedAt: 1, row: 'done', rowAt: FIN, finishedAt: FIN, ...extra });
/** A done event the super got: delivery stamps its batch. */
const told = (sid: string, at = FIN, extra: Partial<SuperQueueItem> = {}): SuperQueueItem =>
  ({ id: `q-${sid}-${at}`, sessionId: sid, kind: 'done', state: 'done', createdAt: at, batch: 'b-1', ...extra });

function stateWith(children: SuperChild[], queue: SuperQueueItem[], containers?: SuperContainer[], extra: Partial<SuperState> = {}): SuperState {
  return {
    ...emptySuperState(), session: 'sup', enabled: true,
    children: Object.fromEntries(children.map((c) => [c.sessionId, c])),
    queue,
    containers: containers ?? children.map((c) => card(c.sessionId)),
    ...extra,
  };
}

const gone: RetireLive = { status: 'gone', ownerAt: 0 };
const untouched = () => NOW - 2 * H;

describe('retireKeep / planRetire (pure)', () => {
  it('a done, told, untouched child is due after an hour; the bar is 60 minutes', () => {
    expect(RETIRE_IDLE_MS).toBe(H);
    expect(RETIRE_IDLE_MS).toBeGreaterThan(TIDY_IDLE_MS);
    const s = stateWith([child('a')], [told('a')]);
    expect(retireKeep(s, 'a', untouched, gone, NOW)).toBeNull();
    expect(retireKeep(s, 'a', untouched, { status: 'idle', ownerAt: 0 }, NOW)).toBeNull();
    expect(planRetire(s, untouched, () => gone, NOW)).toEqual(['a']);
  });

  it('a gone row (parked after its done) counts; a chat that died mid-work does not', () => {
    // done at FIN, delivered; then parked → row gone, finishedAt kept (setRow never restamps done → gone).
    const parked = stateWith([child('a', { row: 'gone' })], [told('a'), { id: 'g', sessionId: 'a', kind: 'gone', state: 'done', createdAt: FIN + 1 }]);
    expect(retireKeep(parked, 'a', untouched, gone, NOW)).toBeNull();
    // working → gone stamps finishedAt at the gone: an older done event does not tell this one.
    const died = stateWith([child('a', { row: 'gone', finishedAt: FIN + 5 })], [told('a', FIN)]);
    expect(retireKeep(died, 'a', untouched, gone, NOW)).toBe('untold');
  });

  it('seen by the owner counts as told; a result newer than his seen click does not', () => {
    const seen = stateWith([child('a', { seenAt: FIN + 1 })], []);
    expect(retireKeep(seen, 'a', untouched, gone, NOW)).toBeNull();
    const newer = stateWith([child('a', { seenAt: FIN - 1 })], []);
    expect(retireKeep(newer, 'a', untouched, gone, NOW)).toBe('untold');
    // a done item dropped as stale without being sent (the child was parked first) has no batch
    const dropped = stateWith([child('a', { row: 'gone' })], [told('a', FIN, { batch: undefined })]);
    expect(retireKeep(dropped, 'a', untouched, gone, NOW)).toBe('untold');
    // an undelivered done (pending) is open, not told
    const pending = stateWith([child('a')], [told('a', FIN, { state: 'pending' })]);
    expect(retireKeep(pending, 'a', untouched, gone, NOW)).toBe('open_item');
  });

  it('never: working, asking, stuck, waiting, an open queue item, adopted, ended, the super', () => {
    for (const row of ['working', 'asking', 'stuck', 'waiting'] as const) {
      expect(retireKeep(stateWith([child('a', { row })], [told('a')]), 'a', untouched, gone, NOW)).toBe(row);
    }
    const q = stateWith([child('a')], [told('a'), { id: 'o', sessionId: 'a', kind: 'owner', state: 'escalated', createdAt: FIN }]);
    expect(retireKeep(q, 'a', untouched, gone, NOW)).toBe('open_item');
    expect(retireKeep(stateWith([child('a', { adopted: true })], [told('a')]), 'a', untouched, gone, NOW)).toBe('adopted');
    expect(retireKeep(stateWith([child('a', { endedAt: FIN })], [told('a')]), 'a', untouched, gone, NOW)).toBe('ended');
    const sup = stateWith([child('sup')], [told('sup')]);
    expect(retireKeep(sup, 'sup', untouched, gone, NOW)).toBe('unknown');
    // the registry says it works or asks right now, whatever the row says
    const s = stateWith([child('a')], [told('a')]);
    for (const status of ['working', 'asking', 'starting', 'stale']) {
      expect(retireKeep(s, 'a', untouched, { status, ownerAt: 0 }, NOW)).toBe(status);
    }
  });

  it('owner wins: a card he placed, sized or the view shows; his recent touch, seen click or focus', () => {
    const placed = stateWith([child('a')], [told('a')], [card('a', { place: 'float', pos: { x: 0.1, y: 0.1 } })]);
    expect(retireKeep(placed, 'a', untouched, gone, NOW)).toBe('owner_placed');
    const sized = stateWith([child('a')], [told('a')], [card('a', { place: 'float', size: 'large', sizeBy: 'owner' })]);
    expect(retireKeep(sized, 'a', untouched, gone, NOW)).toBe('owner_placed');
    const shown = stateWith([child('a')], [told('a')], [card('a', { place: 'float' })], { view: { mode: 'half', card: 'chat-a' } });
    expect(retireKeep(shown, 'a', untouched, gone, NOW)).toBe('shown');
    const s = stateWith([child('a')], [told('a')]);
    expect(retireKeep(s, 'a', () => NOW - 59 * 60_000, gone, NOW)).toBe('recent');
    expect(retireKeep(s, 'a', untouched, { status: 'idle', ownerAt: NOW - 5 * 60_000 }, NOW)).toBe('recent');
    const seenLate = stateWith([child('a', { seenAt: NOW - 10 * 60_000 })], [told('a')]);
    expect(retireKeep(seenLate, 'a', untouched, gone, NOW)).toBe('recent');
    // finished under an hour ago
    const fresh = stateWith([child('a', { finishedAt: NOW - 30 * 60_000 })], [told('a', NOW - 30 * 60_000)]);
    expect(retireKeep(fresh, 'a', untouched, gone, NOW)).toBe('recent');
    // the clock started (server restart) under an hour ago: nothing is ended yet
    expect(retireKeep(s, 'a', untouched, gone, NOW, NOW - 10 * 60_000)).toBe('recent');
    // a card never seen by the clock counts as touched now
    expect(retireKeep(s, 'a', () => undefined, gone, NOW)).toBe('recent');
  });
});

// ── Through the server: the tidy clock's retire half ending like `super end` ─────────

let dir: string;
let root: string;

function seed(s: SuperState): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(s));
}

/** A live idle child whose park answer we pick. */
function liveChild(sid: string, answer: ParkOutcome = 'parked') {
  const calls: Array<{ reason: string; opts?: ParkOptions }> = [];
  const h = registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode: 'basic' });
  h.userSent('');
  h.observe({ type: 'result' });
  registerParkable({
    id: sid, kind: 'chat', projectRoot: dir,
    exempt: () => null, busy: () => false, asking: () => false,
    backgroundTasks: () => 0, idleSince: () => 0, focusedAt: () => 0,
    park: async (reason, opts) => { calls.push({ reason, opts }); return answer; },
  });
  return calls;
}

const IO = {
  read: (r: string) => readSuperState(r, superSanitizeOpts()),
  write: (r: string, fn: (s: SuperState) => void) => writeSuper(r, fn),
};

describe('retireChildren (server)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'super-retire-'));
    root = join(dir, 'acme', '_dream_context');
    mkdirSync(join(root, 'state'), { recursive: true });
    _resetChatRegistry();
    resetSuperIndex();
    _resetSuperInbox();
    _resetChatParkForTests();
    _resetTidy();
    process.env.DREAMCONTEXT_SUPER_RETIRE_MS = '1';
  });
  afterEach(() => {
    delete process.env.DREAMCONTEXT_SUPER_RETIRE_MS;
    _resetChatParkForTests();
    _resetTidy();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The tidy clock has seen the vault and its cards, two hours ago. */
  const prime = async () => { await tidyOnce(root, IO, Date.now() - 2 * H); await new Promise((r) => setTimeout(r, 5)); };

  it('a parked child (no process) is recorded ended: card gone, endedAt, a done ended item', async () => {
    const t = Date.now() - 2 * H;
    seed(stateWith([child('a', { finishedAt: t, rowAt: t, row: 'gone' })], [told('a', t)]));
    await prime();
    expect(await retireChildren(root, ['a'])).toEqual(['a']);
    const s = await readSuperState(root);
    expect(typeof s.children.a.endedAt).toBe('number');
    expect(s.children.a.row).toBe('done');
    expect(s.containers.some((c) => c.ref === 'a')).toBe(false);
    expect(s.queue.find((q) => q.kind === 'ended')).toMatchObject({ sessionId: 'a', state: 'done', brief: 'job a' });
  });

  it('a live idle child goes through the park primitive with `end`; a refusal keeps it', async () => {
    const t = Date.now() - 2 * H;
    seed(stateWith([child('a', { finishedAt: t }), child('b', { finishedAt: t })], [told('a', t), told('b', t)]));
    const a = liveChild('a');
    const b = liveChild('b', 'focused');
    await prime();
    expect(await retireChildren(root, ['a', 'b'])).toEqual(['a']);
    expect(a).toEqual([{ reason: 'super-retire', opts: { end: true } }]);
    expect(b).toHaveLength(1);
    const s = await readSuperState(root);
    expect(typeof s.children.a.endedAt).toBe('number');
    expect(s.children.b.endedAt).toBeUndefined();
    expect(s.containers.map((c) => c.ref)).toEqual(['b']);
  });

  it('re-checks on the fresh record: a child that got a question since the plan is kept', async () => {
    const t = Date.now() - 2 * H;
    seed(stateWith([child('a', { finishedAt: t })], [told('a', t), { id: 'qq', sessionId: 'a', kind: 'question', state: 'pending', createdAt: t + 1 }]));
    await prime();
    expect(await retireChildren(root, ['a'])).toEqual([]);
    expect((await readSuperState(root)).children.a.endedAt).toBeUndefined();
  });

  it('runs on the tidy clock: only through a TidyIo with retire, and never in the first tick after a start', async () => {
    const t = Date.now() - 2 * H;
    seed(stateWith([child('a', { finishedAt: t, row: 'gone' }), child('b', { finishedAt: t, row: 'stuck' })], [told('a', t), told('b', t)]));
    const ended: string[][] = [];
    const how = { ...IO, retire: { live: (_r: string, _s: string) => gone, end: async (_r: string, sids: string[]) => { ended.push(sids); return retireChildren(root, sids); } } };
    // Without the retire half, the clock only tidies.
    await tidyOnce(root, IO);
    expect((await readSuperState(root)).children.a.endedAt).toBeUndefined();
    _resetTidy();
    // With a real bar: the clock just started, so nothing is due yet.
    process.env.DREAMCONTEXT_SUPER_RETIRE_MS = String(H);
    await tidyOnce(root, how);
    expect(ended).toEqual([]);
    // With the bar passed (verify-only override), the done+told one ends, the stuck one stays.
    process.env.DREAMCONTEXT_SUPER_RETIRE_MS = '1';
    await new Promise((r) => setTimeout(r, 5));
    await tidyOnce(root, how);
    expect(ended).toEqual([['a']]);
    const s = await readSuperState(root);
    expect(typeof s.children.a.endedAt).toBe('number');
    expect(s.children.b.endedAt).toBeUndefined();
  });

  it("tidy's own move to Others is not a touch: the moved card keeps its clock", async () => {
    const t = Date.now() - 2 * H;
    // On the stage, untouched past the 45-minute bar by an injected clock.
    seed(stateWith([child('a', { finishedAt: t, rowAt: t })], [told('a', t)], [card('a', { place: 'float' })]));
    process.env.DREAMCONTEXT_SUPER_RETIRE_MS = String(H);
    const first = Date.now();
    await tidyOnce(root, IO, first);
    const later = first + TIDY_IDLE_MS + 1;
    const moved = await tidyOnce(root, IO, later);
    expect(moved).toEqual(['chat-a']);
    // The next tick sees the new place; the card's touch time is still `first`, not `later`.
    await tidyOnce(root, IO, later + 1);
    expect(touchedAt(root, 'chat-a')).toBe(first);
  });

  it("the owner's seen click in the agenda starts the clock again, and is not a card touch", async () => {
    const t = Date.now() - 2 * H;
    seed(stateWith([child('a', { finishedAt: t })], [told('a', t)], [card('a', { id: 'chat-a' })]));
    await prime();
    process.env.DREAMCONTEXT_SUPER_RETIRE_MS = String(H);
    const before = await readSuperState(root);
    expect(retireKeep(before, 'a', (id) => touchedAt(root, id), gone, Date.now() + H, 0)).toBeNull();
    const saved = process.env.DREAMCONTEXT_DESKTOP;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(r, { headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
    setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify({ children: [{ id: 'a', at: t }] })); });
    let status = 0;
    const out = { writeHead: (st: number) => { status = st; }, setHeader: () => undefined, end: () => undefined } as unknown as ServerResponse;
    await handleSuperSeen(r, out, {}, root);
    if (saved === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = saved;
    expect(status).toBe(200);
    // Seen just now: an hour from the click it is due, a minute before that it is not.
    const clicked = seenClickAt(root, 'a');
    expect(Date.now() - clicked).toBeLessThan(5_000);
    // Not a card touch: the tidy's "seen goes to Others at once" path still compares touches with seenAt.
    expect(touchedAt(root, 'chat-a')).toBeLessThan(clicked - H);
    const s = await readSuperState(root);
    const live = { status: 'gone', ownerAt: seenClickAt(root, 'a') };
    expect(retireKeep(s, 'a', (id) => touchedAt(root, id), live, clicked + H - 60_000, 0)).toBe('recent');
    expect(retireKeep(s, 'a', (id) => touchedAt(root, id), live, clicked + H, 0)).toBeNull();
  });
});
