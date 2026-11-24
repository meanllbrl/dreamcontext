/**
 * The Super stage's presentation queue (task super-sahnesinde-sunum-sirasi…, owner 2026-11-14:
 * "I was looking at one, you opened this and mine was gone; it should have joined the queue").
 *
 *  - AC1: whoever opened the presentation he looks at, a new present joins the END of the queue;
 *  - AC2: next / closing passes the head, even a picture question still open (owner 2026-11-18);
 *  - the waiting strip's ✕ drops the head; a closed question's or stale item never survives a read;
 *  - AC5: leaving keeps the rest waiting, resume opens the head;
 *  - AC6: an unseen item's cards are never put in Others, closed or retired;
 *  - AC7: a remote screen sends the same step;
 *  - AC9: a layout picked on the item on screen is that item's alone.
 */
import { describe, it, expect } from 'vitest';
import {
  PRESENT_ITEM_STALE_MS, SUPER_STATE_VERSION, emptySuperState, ownerQueueStep, presentCards, queueCounter, queuedCards,
  type SuperContainer, type SuperState,
} from '../../src/lib/super/types.js';
import { sanitizeSuperState } from '../../src/lib/super/store.js';
import { planOthersClose, planTidy, presentSpent } from '../../src/lib/super/tidy.js';
import { stackForLive } from '../../src/lib/super/live.js';
import { retirableCards } from '../../src/lib/super/room.js';
import { autoContainerId, settleChild } from '../../src/lib/super/proactive.js';
import { settleAskShows } from '../../src/lib/super/ask-show.js';
import { applyOwnerLayout } from '../../src/server/routes/super.js';
import { checkRemoteLayout } from '../../src/server/routes/super-remote.js';

const img = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer => ({ id, kind: 'image', ref: `${id}.png`, shape: 'square', place: 'float', ...extra });
const stage = (over: Partial<SuperState> = {}): SuperState => ({ ...emptySuperState(), ...over });
/** The record as the store writes it (the queue settles against the cards). */
const store = (s: SuperState): SuperState => sanitizeSuperState(JSON.parse(JSON.stringify(s)));
const never = () => false;
/** A recent item time: an item older than PRESENT_ITEM_STALE_MS leaves on read. */
const T = Date.now();

describe('presentCards queues instead of replacing (AC1, D1, D6)', () => {
  it('a present over a Super-opened presentation: the view still shows [a], [b] waits, 1/2', () => {
    const s = stage({ containers: [img('image-a'), img('image-b')] });
    expect(presentCards(s, ['image-a'])).toMatchObject({ shown: true });
    // The Super opened [a]: no owner mark at all. Old code replaced it with [b].
    expect(s.view.by).toBeUndefined();
    const r = presentCards(s, ['image-b']);
    expect(r).toMatchObject({ shown: false, at: 2, of: 2 });
    expect(s.view).toMatchObject({ mode: 'present', cards: ['image-a'] });
    expect(s.presentQueue?.items.map((i) => i.cards)).toEqual([['image-a'], ['image-b']]);
    expect(queueCounter(s.presentQueue)).toMatchObject({ at: 1, of: 2, waiting: 1, showing: true });
  });
  it('a picture question while a presentation is up joins the queue too (ask --show)', () => {
    const s = stage({
      containers: [img('image-a'), img('image-b'), img('image-c')],
      queue: [{ id: 'q1', sessionId: 'sup', kind: 'ask', state: 'escalated', createdAt: 1 }],
      askShows: [{ item: 'q1', cards: ['image-b', 'image-c'], opened: [], via: 'show' }],
    });
    presentCards(s, ['image-a']);
    settleAskShows(s, s.queue[0]);
    expect(s.view).toMatchObject({ mode: 'present', cards: ['image-a'] });
    expect(s.presentQueue?.items[1]).toMatchObject({ cards: ['image-b', 'image-c'], ask: 'q1' });
  });
  it('the owner\'s own presentation and his held side by side are not replaced either', () => {
    const own = stage({ containers: [img('image-a'), img('image-b')], view: { mode: 'present', cards: ['image-a'], by: 'owner', ownerAt: Date.now() } });
    // His presentation counts as the first: 1/2 on the stage, the new one 2/2.
    expect(presentCards(own, ['image-b'])).toMatchObject({ shown: false, at: 2, of: 2 });
    expect(own.view.cards).toEqual(['image-a']);
    const half = stage({ containers: [img('image-a'), img('image-b')], view: { mode: 'half', card: 'image-a', by: 'owner', ownerAt: Date.now() } });
    expect(presentCards(half, ['image-b']).shown).toBe(false);
    expect(half.view).toMatchObject({ mode: 'half', card: 'image-a' });
  });
  it('nothing presented: it opens at once, ahead of what waits (D6)', () => {
    const s = stage({ containers: [img('image-a'), img('image-b'), img('image-c')] });
    presentCards(s, ['image-a']);
    presentCards(s, ['image-b']);
    ownerQueueStep(s, 'leave', s.presentQueue!.items[0].id);
    expect(s.view.mode).toBe('float');
    expect(presentCards(s, ['image-c']).shown).toBe(true);
    expect(s.view.cards).toEqual(['image-c']);
    expect(s.presentQueue?.items.map((i) => i.cards[0])).toEqual(['image-c', 'image-b']);
  });
  it('the same cards again update their item, never a second one (D5)', () => {
    const s = stage({ containers: [img('image-a'), img('image-b'), img('image-c')] });
    presentCards(s, ['image-a']);
    presentCards(s, ['image-b', 'image-c']);
    const r = presentCards(s, ['image-c', 'image-b'], 'filmstrip');
    expect(r).toMatchObject({ shown: false, at: 2, of: 2 });
    expect(s.presentQueue?.items).toHaveLength(2);
    expect(s.presentQueue?.items[1]).toMatchObject({ cards: ['image-c', 'image-b'], layout: 'filmstrip' });
  });
});

describe('the owner\'s steps (AC2, AC4, AC5)', () => {
  const three = () => {
    const s = stage({ containers: [img('image-a'), img('image-b'), img('image-c')] });
    for (const id of ['image-a', 'image-b', 'image-c']) presentCards(s, [id]);
    return s;
  };
  it('next opens the next item, the last one floats the stage and empties the queue', () => {
    const s = three();
    const [a, b, c] = s.presentQueue!.items.map((i) => i.id);
    expect(ownerQueueStep(s, 'next', b)).toBe(false);
    expect(ownerQueueStep(s, 'next', a)).toBe(true);
    expect(s.view.cards).toEqual(['image-b']);
    expect(queueCounter(s.presentQueue)).toMatchObject({ at: 2, of: 3 });
    ownerQueueStep(s, 'next', b);
    ownerQueueStep(s, 'next', c);
    expect(s.view).toEqual({ mode: 'float' });
    expect(s.presentQueue).toMatchObject({ items: [], seen: 0 });
  });
  it('leave floats the stage with the rest waiting; resume opens the first waiting', () => {
    const s = three();
    ownerQueueStep(s, 'leave', s.presentQueue!.items[0].id);
    expect(s.view.mode).toBe('float');
    expect(queueCounter(s.presentQueue)).toMatchObject({ waiting: 2, showing: false });
    expect(ownerQueueStep(s, 'resume', s.presentQueue!.items[0].id)).toBe(true);
    expect(s.view.cards).toEqual(['image-b']);
    expect(queueCounter(s.presentQueue)).toMatchObject({ at: 2, of: 3, showing: true });
  });
  it('a seen picture question leaves the queue even while still open: closing it never brings the strip back', () => {
    const s = stage({ containers: [img('image-a'), img('image-b')] });
    presentCards(s, ['image-a'], undefined, 'q1');
    presentCards(s, ['image-b']);
    ownerQueueStep(s, 'next', s.presentQueue!.items[0].id);
    expect(s.view.cards).toEqual(['image-b']);
    expect(s.presentQueue?.items.map((i) => i.ask ?? '-')).toEqual(['-']);
    ownerQueueStep(s, 'next', s.presentQueue!.items[0].id);
    expect(s.view).toEqual({ mode: 'float' });
    expect(queueCounter(s.presentQueue)).toMatchObject({ waiting: 0 });
  });
  it('the field case: Continue, then closing a lone open question\'s presentation empties the queue', () => {
    const s = stage({ containers: [img('image-a'), img('image-b')], view: { mode: 'half', card: 'image-b', by: 'owner', ownerAt: Date.now() } });
    presentCards(s, ['image-a'], undefined, 'q1');
    expect(queueCounter(s.presentQueue)).toMatchObject({ waiting: 1, showing: false });
    const id = s.presentQueue!.items[0].id;
    expect(ownerQueueStep(s, 'resume', id)).toBe(true);
    applyOwnerLayout(s, { exit: { cards: ['image-a'], closing: [] } });
    expect(s.view.mode).toBe('float');
    expect(queueCounter(s.presentQueue)).toMatchObject({ waiting: 0 });
  });
  it('drop (the strip\'s ✕) takes the waiting head off unseen and leaves the stage as it is', () => {
    const s = stage({ containers: [img('image-a'), img('image-b'), img('image-c')], view: { mode: 'half', card: 'image-c', by: 'owner', ownerAt: Date.now() } });
    presentCards(s, ['image-a'], undefined, 'q1');
    presentCards(s, ['image-b']);
    const [a, b] = s.presentQueue!.items.map((i) => i.id);
    expect(ownerQueueStep(s, 'drop', b)).toBe(false);
    expect(ownerQueueStep(s, 'drop', a)).toBe(true);
    expect(s.view).toMatchObject({ mode: 'half', card: 'image-c' });
    expect(s.presentQueue!.items.map((i) => i.id)).toEqual([b]);
    applyOwnerLayout(s, { queue: { op: 'drop', item: b } });
    expect(s.presentQueue!.items).toEqual([]);
    expect(s.view).toMatchObject({ mode: 'half', card: 'image-c' });
  });
  it('drop on the item on screen passes it and floats the stage', () => {
    const s = stage({ containers: [img('image-a'), img('image-b')] });
    presentCards(s, ['image-a']);
    presentCards(s, ['image-b']);
    ownerQueueStep(s, 'drop', s.presentQueue!.items[0].id);
    expect(s.view).toEqual({ mode: 'float' });
    expect(queueCounter(s.presentQueue)).toMatchObject({ waiting: 1, showing: false });
  });
  it('closing the presentation through the layout door passes the item and opens the next', () => {
    const s = three();
    applyOwnerLayout(s, { exit: { cards: ['image-a'], closing: [] } });
    expect(s.view.cards).toEqual(['image-b']);
    const st = store(s);
    expect(st.view).toMatchObject({ mode: 'present', cards: ['image-b'] });
    expect(queueCounter(st.presentQueue)).toMatchObject({ at: 2, of: 3, showing: true });
  });
  it('closing the item\'s card (its ✕) opens the next once the store settles', () => {
    const s = store(three());
    applyOwnerLayout(s, { closed: ['image-a'] });
    const st = store(s);
    expect(st.view).toMatchObject({ mode: 'present', cards: ['image-b'] });
    expect(queueCounter(st.presentQueue)).toMatchObject({ at: 2, of: 3, showing: true });
  });
  it('a question closing passes its item; on screen, the next opens', () => {
    const s = stage({
      containers: [img('image-a'), img('image-b')],
      queue: [{ id: 'q1', sessionId: 'sup', kind: 'ask', state: 'escalated', createdAt: 1 }],
      askShows: [{ item: 'q1', cards: ['image-a'], opened: [], via: 'show' }],
    });
    settleAskShows(s, s.queue[0]);
    presentCards(s, ['image-b']);
    expect(s.view).toMatchObject({ cards: ['image-a'], ask: 'q1' });
    s.queue[0].state = 'done';
    settleAskShows(s, null);
    expect(s.view.cards).toEqual(['image-b']);
  });
});

describe('a layout he picks is the item\'s own (AC9, D8)', () => {
  it('queue [a,b,c], a shown, filmstrip picked: a in filmstrip, 1/3, b untouched', () => {
    const s = stage({ containers: ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].map((x) => img(`image-${x}`)) });
    presentCards(s, ['image-a1', 'image-a2']);
    presentCards(s, ['image-b1', 'image-b2']);
    presentCards(s, ['image-c1', 'image-c2']);
    applyOwnerLayout(s, { presentLayout: { layout: 'filmstrip', cards: ['image-a1', 'image-a2'] } });
    const st = store(s);
    expect(st.view).toMatchObject({ mode: 'present', cards: ['image-a1', 'image-a2'], layout: 'filmstrip' });
    expect(st.presentQueue?.items.map((i) => i.cards[0])).toEqual(['image-a1', 'image-b1', 'image-c1']);
    expect(queueCounter(st.presentQueue)).toMatchObject({ at: 1, of: 3, showing: true });
    expect(st.presentQueue?.items[0]).toMatchObject({ layout: 'filmstrip', layoutBy: 'owner' });
    expect(st.presentQueue?.items[1].layout).toBeUndefined();
  });
});

describe('an unseen item is never swept (AC6)', () => {
  const child = { sessionId: 'kid-1', brief: 'job', adopted: false, startedAt: 1, row: 'done', finishedAt: 5, sentAt: 10 } as unknown as SuperState['children'][string];
  it('a picture whose job moved on 90 s ago stays on the stage while its presentation waits', () => {
    const now = Date.now();
    const s = stage({
      containers: [img('image-a'), img('image-b', { forChild: 'kid-1', forAt: 1 })],
      children: { 'kid-1': { ...child, endedAt: now - 120_000 } as SuperState['children'][string] },
    });
    presentCards(s, ['image-a']);
    presentCards(s, ['image-b']);
    expect(queuedCards(s).has('image-b')).toBe(true);
    // Old code: tidied to Others once the job moved on LOOK_GRACE_MS ago.
    expect(planTidy(s, () => 0, now, never)).not.toContain('image-b');
    s.containers[1].place = 'others';
    expect(planOthersClose(s, () => 0, now + 10 * 86_400_000, 0, never)).not.toContain('image-b');
    expect(retirableCards(s, [], () => false)).not.toContain('image-b');
  });
  it('a child that goes away never closes its queued browser card, nor stacks its queued chat', () => {
    const browser: SuperContainer = { id: autoContainerId('browser', 'kid-1'), kind: 'browser', ref: 'kid-1', shape: 'square', place: 'float' };
    const chat: SuperContainer = { id: 'chat-kid', kind: 'chat', ref: 'kid-1', shape: 'square', place: 'float' };
    const s = stage({ containers: [img('image-a'), browser, chat] });
    presentCards(s, ['image-a']);
    presentCards(s, [browser.id, chat.id]);
    settleChild(s, 'kid-1', 'gone', Date.now());
    expect(s.containers.map((c) => [c.id, c.place])).toEqual([['image-a', 'float'], [browser.id, 'float'], ['chat-kid', 'float']]);
  });
  it('the live cap never stacks a queued card, and a queued presentation is never ended for him', () => {
    const many = Array.from({ length: 14 }, (_, i) => img(`image-${i}`));
    const s = stage({ containers: many });
    presentCards(s, ['image-13']);
    presentCards(s, ['image-0']);
    stackForLive(s, 2, never);
    expect(s.containers.find((c) => c.id === 'image-0')?.place).toBe('float');
    expect(presentSpent(s, () => 0, Date.now() + 86_400_000, never)).toBe(false);
  });
});

describe('the store and a remote screen (AC7)', () => {
  it('the queue survives a write: unknown cards dropped, an empty item leaves, ids kept', () => {
    const st = sanitizeSuperState({
      v: SUPER_STATE_VERSION, containers: [img('image-a'), img('image-b')],
      view: { mode: 'present', cards: ['image-a'] },
      presentQueue: { items: [{ id: 'pq1', cards: ['image-a'], at: T }, { id: 'pq2', cards: ['image-zz'], at: T }, { id: 'BAD', cards: ['image-b'] }, { id: 'pq3', cards: ['image-b', 'image-zz'], at: T }], seen: 0, seq: 3, showing: 'pq1' },
    });
    expect(st.presentQueue).toEqual({ items: [{ id: 'pq1', cards: ['image-a'], at: T }, { id: 'pq3', cards: ['image-b'], at: T }], seen: 0, seq: 3, showing: 'pq1' });
  });
  it('another view passes the item it showed (seen), the rest keep waiting, his view stays', () => {
    const st = sanitizeSuperState({
      v: SUPER_STATE_VERSION, containers: [img('image-a'), img('image-b'), img('image-c')],
      view: { mode: 'half', card: 'image-c' },
      presentQueue: { items: [{ id: 'pq1', cards: ['image-a'], at: T }, { id: 'pq2', cards: ['image-b'], at: T }], seen: 0, seq: 2, showing: 'pq1' },
    });
    expect(st.presentQueue).toEqual({ items: [{ id: 'pq2', cards: ['image-b'], at: T }], seen: 1, seq: 2 });
    expect(st.view).toEqual({ mode: 'half', card: 'image-c' });
    // Alone, it leaves the queue entirely: no "1 presentation waiting" for one he already saw.
    const lone = sanitizeSuperState({
      v: SUPER_STATE_VERSION, containers: [img('image-a'), img('image-b')],
      view: { mode: 'half', card: 'image-b' },
      presentQueue: { items: [{ id: 'pq1', cards: ['image-a'], at: T }], seen: 0, seq: 1, showing: 'pq1' },
    });
    expect(queueCounter(lone.presentQueue)).toMatchObject({ waiting: 0 });
    expect(lone.view).toEqual({ mode: 'half', card: 'image-b' });
  });
  it('a head never shown keeps waiting under another view', () => {
    const st = sanitizeSuperState({
      v: SUPER_STATE_VERSION, containers: [img('image-a'), img('image-b')],
      view: { mode: 'half', card: 'image-b' },
      presentQueue: { items: [{ id: 'pq1', cards: ['image-a'], at: T }], seen: 0, seq: 1 },
    });
    expect(st.presentQueue).toEqual({ items: [{ id: 'pq1', cards: ['image-a'], at: T }], seen: 0, seq: 1 });
  });
  it('the field case (owner 2026-11-21): a presentation he saw and left by opening a chat never comes back', () => {
    let s = stage({ containers: [img('image-a'), img('image-b'), img('image-c')] });
    presentCards(s, ['image-a']);
    presentCards(s, ['image-b']);
    s = store(s);
    // He looks at [a], then opens another card side by side (not a queue button).
    s = store(applyOwnerLayout(s, { view: { mode: 'half', card: 'image-c' } }));
    expect(s.presentQueue?.items.map((i) => i.cards)).toEqual([['image-b']]);
    // Back on the stage, Continue opens [b]; passing it ends the queue. [a] never returns
    // (the old record kept it as unseen and opened it again here).
    s = store(applyOwnerLayout(s, { view: { mode: 'float' } }));
    ownerQueueStep(s, 'resume', s.presentQueue!.items[0].id);
    expect(s.view.cards).toEqual(['image-b']);
    ownerQueueStep(s, 'next', s.presentQueue!.items[0].id);
    s = store(s);
    expect(s.view).toEqual({ mode: 'float' });
    expect(queueCounter(s.presentQueue)).toMatchObject({ waiting: 0 });
  });
  it('an item whose question is over, or gone from the queue, leaves on the next read', () => {
    const SID = '11111111-2222-4333-8444-555555555555';
    const now = Date.now();
    const st = sanitizeSuperState({
      v: SUPER_STATE_VERSION, session: SID, containers: [img('image-a'), img('image-b'), img('image-c')],
      view: { mode: 'float' },
      queue: [
        { id: 'q-done-1', sessionId: SID, kind: 'ask', state: 'done', createdAt: now },
        { id: 'q-open-1', sessionId: SID, kind: 'ask', state: 'escalated', createdAt: now },
      ],
      presentQueue: { items: [
        { id: 'pq1', cards: ['image-a'], ask: 'q-done-1', at: now },
        { id: 'pq2', cards: ['image-b'], ask: 'q-gone-1', at: now },
        { id: 'pq3', cards: ['image-c'], ask: 'q-open-1', at: now },
      ], seen: 0, seq: 3 },
    }, { now });
    expect(st.presentQueue?.items.map((i) => i.id)).toEqual(['pq3']);
  });
  it('a stale unseen item (from an earlier day) never survives a read, the one on screen stays', () => {
    const now = Date.now();
    const old = now - PRESENT_ITEM_STALE_MS - 1;
    const st = sanitizeSuperState({
      v: SUPER_STATE_VERSION, containers: [img('image-a'), img('image-b')],
      view: { mode: 'float' },
      presentQueue: { items: [{ id: 'pq1', cards: ['image-a'], at: old }], seen: 0, seq: 1 },
    }, { now });
    expect(queueCounter(st.presentQueue)).toMatchObject({ waiting: 0 });
    const shown = sanitizeSuperState({
      v: SUPER_STATE_VERSION, containers: [img('image-a'), img('image-b')],
      view: { mode: 'present', cards: ['image-a'] },
      presentQueue: { items: [{ id: 'pq1', cards: ['image-a'], at: old }, { id: 'pq2', cards: ['image-b'], at: old }], seen: 0, seq: 2, showing: 'pq1' },
    }, { now });
    expect(shown.presentQueue).toMatchObject({ items: [{ id: 'pq1' }], showing: 'pq1' });
    expect(shown.view).toMatchObject({ mode: 'present', cards: ['image-a'] });
  });
  it('a remote screen\'s step is checked key by key and reaches the same queue', () => {
    expect(checkRemoteLayout({ queue: { op: 'next', item: 'pq4' } }).patch).toEqual({ queue: { op: 'next', item: 'pq4' } });
    expect(() => checkRemoteLayout({ queue: { op: 'skip', item: 'pq4' } })).toThrow();
    expect(checkRemoteLayout({ queue: { op: 'drop', item: 'pq4' } }).patch).toEqual({ queue: { op: 'drop', item: 'pq4' } });
    expect(() => checkRemoteLayout({ queue: { op: 'next', item: 'pq4', extra: 1 } })).toThrow();
    const s = stage({ containers: [img('image-a'), img('image-b')] });
    presentCards(s, ['image-a']);
    presentCards(s, ['image-b']);
    applyOwnerLayout(s, checkRemoteLayout({ queue: { op: 'next', item: s.presentQueue!.items[0].id } }).patch);
    expect(s.view.cards).toEqual(['image-b']);
  });
});
