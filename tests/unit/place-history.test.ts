/**
 * Navigation B, C1: the window's places (dashboard/src/lib/placeHistory.ts). One back/forward list
 * across projects, a chat place per project, last item per page, recent places pruned at 7 days,
 * read-merge-written so two windows never drop each other's memory.
 */
import { describe, it, expect } from 'vitest';
import {
  createPlaceHistory, samePlace, PLACE_MEMORY_MS, type Place, type PlaceStorage,
} from '../../dashboard/src/lib/placeHistory';

const page = (vault: string, p: string, id: string | null = null, label: string | null = null): Place =>
  ({ vault, kind: 'page', page: p as never, id, label });
const chat = (vault: string): Place => ({ vault, kind: 'chat' });
const none = () => false;

function mem(): PlaceStorage & { raw: string | null } {
  const s = { raw: null as string | null, read: () => s.raw, write: (r: string) => { s.raw = r; } };
  return s;
}

function make(now = { t: 1_000 }, storage: PlaceStorage | null = null) {
  return { h: createPlaceHistory({ now: () => now.t, storage }), now };
}

describe('placeHistory: equality', () => {
  it('a null id matches any id on the same page; two ids are two places; one chat place per project', () => {
    expect(samePlace(page('a', 'whiteboards', 'x'), page('a', 'whiteboards', null))).toBe(true);
    expect(samePlace(page('a', 'whiteboards', 'x'), page('a', 'whiteboards', 'y'))).toBe(false);
    expect(samePlace(page('a', 'tasks'), page('b', 'tasks'))).toBe(false);
    expect(samePlace(chat('a'), chat('a'))).toBe(true);
    expect(samePlace(chat('a'), page('a', 'tasks'))).toBe(false);
  });
});

describe('placeHistory: record', () => {
  it('appends, truncates forward like a browser, and fills an equal entry in place', () => {
    const { h } = make();
    h.record(page('a', 'whiteboards'));
    h.record(page('a', 'whiteboards', 'x', 'Launch plan'));
    expect(h.entries().list).toEqual([page('a', 'whiteboards', 'x', 'Launch plan')]);
    h.record(page('b', 'whiteboards'));
    h.record(page('b', 'tasks'));
    expect(h.beginStep(-1, none)?.target).toEqual(page('b', 'whiteboards'));
    h.commitStep();
    h.record(page('b', 'knowledge'));
    expect(h.entries().list.map((p) => (p.kind === 'page' ? p.page : 'chat'))).toEqual(['whiteboards', 'whiteboards', 'knowledge']);
  });

  it('a null id never overwrites a known one (nor its label)', () => {
    const { h } = make();
    h.record(page('a', 'tasks', 't1', 'Fix login'));
    h.record(page('a', 'tasks', null, null));
    expect(h.entries().list).toEqual([page('a', 'tasks', 't1', 'Fix login')]);
  });

  it('item X then item Y are two entries', () => {
    const { h } = make();
    h.record(page('a', 'whiteboards', 'x'));
    h.record(page('a', 'whiteboards', 'y'));
    expect(h.entries().list).toHaveLength(2);
  });

  it('switching chats inside one project is one chat place', () => {
    const { h } = make();
    h.record(chat('a'));
    h.record(chat('a'));
    expect(h.entries().list).toEqual([chat('a')]);
  });
});

describe('placeHistory: steps', () => {
  it('beginStep skips what skip rejects, and peek agrees with it', () => {
    const { h } = make();
    h.record(page('a', 'tasks'));
    h.record(page('gone', 'tasks'));
    h.record(page('b', 'tasks'));
    const skip = (p: Place) => p.vault === 'gone';
    expect(h.peekBack(skip)).toEqual(page('a', 'tasks'));
    expect(h.beginStep(-1, skip)?.target).toEqual(page('a', 'tasks'));
    h.commitStep();
    expect(h.peekForward(skip)).toEqual(page('b', 'tasks'));
    expect(h.peekBack(skip)).toBeNull();
  });

  it('abort puts the cursor back; commitStepAt fills the entry with what settled', () => {
    const { h } = make();
    h.record(page('a', 'whiteboards'));
    h.record(page('b', 'tasks'));
    h.beginStep(-1, none);
    h.abortStep();
    expect(h.entries().cursor).toBe(1);
    h.beginStep(-1, none);
    h.commitStepAt(page('a', 'whiteboards', 'x', 'X'));
    expect(h.entries()).toEqual({ list: [page('a', 'whiteboards', 'x', 'X'), page('b', 'tasks')], cursor: 0 });
  });

  it('a second step before the first commits walks on and keeps the first origin', () => {
    const { h } = make();
    h.record(page('a', 'tasks'));
    h.record(page('b', 'tasks'));
    h.record(page('c', 'tasks'));
    h.beginStep(-1, none);
    const second = h.beginStep(-1, none);
    expect(second).toEqual({ target: page('a', 'tasks'), previous: 2 });
    h.abortStep();
    expect(h.entries().cursor).toBe(2);
  });
});

describe('placeHistory: memory', () => {
  it('lastItemOn answers the item open when the window last LEFT that page (null for Whiteboards)', () => {
    const { h } = make();
    h.leave('a', 'tasks' as never, { id: 't1', label: 'One' });
    h.leave('a', 'tasks' as never, { id: 't2', label: 'Two' });
    h.leave('a', 'whiteboards' as never, { id: 'x', label: null });
    expect(h.lastItemOn('a', 'tasks' as never)).toEqual({ id: 't2', label: 'Two' });
    expect(h.lastItemOn('a', 'whiteboards' as never)).toBeNull();
    expect(h.lastItemOn('b', 'tasks' as never)).toBeNull();
  });

  it('delta 1: record never writes the last item; open X then leave -> X; leave with X closed -> null', () => {
    const now = { t: 1_000 };
    const { h } = make(now);
    h.record(page('a', 'tasks', 't1', 'One'));
    expect(h.lastItemOn('a', 'tasks' as never)).toBeNull();
    h.leave('a', 'tasks' as never, { id: 't1', label: 'One' });
    expect(h.lastItemOn('a', 'tasks' as never)).toEqual({ id: 't1', label: 'One' });
    // Open X, close X, leave within 50 ms: the store says nothing is open, so the memory clears.
    now.t += 50;
    h.leave('a', 'tasks' as never, null);
    expect(h.lastItemOn('a', 'tasks' as never)).toBeNull();
  });

  it('delta 1: a cold B landing on another page keeps B\'s memory for its stored page', () => {
    const storage = mem();
    const now = { t: 1_000 };
    const one = createPlaceHistory({ now: () => now.t, storage });
    one.leave('b', 'knowledge' as never, { id: 'k1', label: 'Doc' });
    // B mounts cold elsewhere and lands on Tasks: no leave of Knowledge is written by the landing.
    now.t += 10;
    one.record(page('b', 'tasks'));
    expect(one.lastItemOn('b', 'knowledge' as never)?.id).toBe('k1');
  });

  it('a cleared item stays cleared through another window\'s older stored item', () => {
    const storage = mem();
    const now = { t: 1_000 };
    const one = createPlaceHistory({ now: () => now.t, storage });
    const two = createPlaceHistory({ now: () => now.t, storage });
    one.leave('a', 'tasks' as never, { id: 't1', label: null });
    now.t += 5;
    two.leave('a', 'tasks' as never, null);
    const three = createPlaceHistory({ now: () => now.t, storage });
    expect(three.lastItemOn('a', 'tasks' as never)).toBeNull();
  });

  it('lastHere and recent: distinct places of the project, newest first, lastHere excluded, 7-day prune', () => {
    const now = { t: 1_000 };
    const { h } = make(now);
    h.record(page('a', 'tasks', 't1'));
    now.t += 10;
    h.record(page('b', 'tasks'));
    now.t += 10;
    h.record(page('a', 'knowledge', 'k1'));
    now.t += 10;
    h.record(chat('a'));
    expect(h.lastHere('a')).toEqual(chat('a'));
    expect(h.recent('a')).toEqual([page('a', 'knowledge', 'k1'), page('a', 'tasks', 't1')]);
    h.leave('a', 'tasks' as never, { id: 't1', label: null });
    now.t += PLACE_MEMORY_MS + 1;
    expect(h.lastHere('a')).toBeNull();
    expect(h.recent('a')).toEqual([]);
    expect(h.lastItemOn('a', 'tasks' as never)).toBeNull();
  });

  it('read-merge-write: another window\'s memory survives this one\'s write', () => {
    const storage = mem();
    const now = { t: 5_000 };
    const one = createPlaceHistory({ now: () => now.t, storage });
    const two = createPlaceHistory({ now: () => now.t, storage });
    one.leave('a', 'tasks' as never, { id: 't1', label: null });
    now.t += 1;
    two.leave('b', 'knowledge' as never, { id: 'k1', label: null });
    const three = createPlaceHistory({ now: () => now.t, storage });
    expect(three.lastItemOn('a', 'tasks' as never)?.id).toBe('t1');
    expect(three.lastItemOn('b', 'knowledge' as never)?.id).toBe('k1');
    // The back/forward stack itself is a session's: a new window starts empty.
    expect(three.entries().list).toEqual([]);
  });

  it('unreadable storage starts empty and memory-only works without storage', () => {
    const storage = mem();
    storage.raw = '{not json';
    const h = createPlaceHistory({ now: () => 1, storage });
    h.leave('a', 'tasks' as never, { id: 't', label: null });
    expect(h.lastItemOn('a', 'tasks' as never)?.id).toBe('t');
    const bare = createPlaceHistory({ now: () => 1, storage: null });
    bare.leave('a', 'tasks' as never, { id: 't', label: null });
    expect(bare.lastItemOn('a', 'tasks' as never)?.id).toBe('t');
  });
});
