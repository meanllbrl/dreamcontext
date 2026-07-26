/**
 * Unit tests for the Chat message queue's pure algebra (chatQueue.ts) — the "⏎ while Claude is
 * working queues it" feature.
 *
 * The two things that carry real risk, and are pinned hardest:
 *   • WHEN a drain is allowed. An interrupt's own `result` frame is a busy→idle edge like any
 *     other, so a missing pause clause means pressing Stop fires the next queued message in the
 *     same breath — the user's own words, sent as the consequence of asking everything to stop.
 *     Likewise a session that EXITED must keep its rows: they are the only copy of that text.
 *   • that an emptied edit DELETES the row instead of leaving an entry that can never be sent.
 */
import { describe, it, expect } from 'vitest';
import {
  appendQueued, editQueued, removeQueued, shouldDrainQueue,
  type QueuedMessage, type DrainProbe,
} from '../../dashboard/src/components/sleepy/chat/chatQueue.js';

const q = (id: string, text: string): QueuedMessage => ({ id, text, ts: 0 });

describe('appendQueued', () => {
  it('appends to the end — the queue is FIFO, not a stack', () => {
    const one = appendQueued([], 'first', 'q1', 10);
    const two = appendQueued(one, 'second', 'q2', 20);
    expect(two.map((e) => e.text)).toEqual(['first', 'second']);
    expect(two.map((e) => e.id)).toEqual(['q1', 'q2']);
    expect(two[1].ts).toBe(20);
  });

  it('trims the text it stores', () => {
    expect(appendQueued([], '  run the tests\n', 'q1', 0)[0].text).toBe('run the tests');
  });

  it('refuses whitespace-only text, returning the SAME array (no re-render, no dead row)', () => {
    const before: QueuedMessage[] = [q('q1', 'keep me')];
    expect(appendQueued(before, '   \n\t ', 'q2', 0)).toBe(before);
    expect(appendQueued([], '', 'q1', 0)).toEqual([]);
  });

  it('does not mutate the queue it was given', () => {
    const before = [q('q1', 'a')];
    appendQueued(before, 'b', 'q2', 0);
    expect(before).toHaveLength(1);
  });

  it('keeps a duplicate — sending the same instruction twice is a legitimate ask', () => {
    const twice = appendQueued(appendQueued([], 'go', 'q1', 0), 'go', 'q2', 0);
    expect(twice).toHaveLength(2);
  });
});

describe('editQueued', () => {
  it('rewrites only the addressed row', () => {
    const next = editQueued([q('q1', 'a'), q('q2', 'b')], 'q2', 'b-edited');
    expect(next.map((e) => e.text)).toEqual(['a', 'b-edited']);
  });

  it('trims the rewritten text', () => {
    expect(editQueued([q('q1', 'a')], 'q1', '  b  ')[0].text).toBe('b');
  });

  it('DELETES the row when the edit empties it (select-all-delete-save is how a row is dropped)', () => {
    expect(editQueued([q('q1', 'a'), q('q2', 'b')], 'q1', '')).toEqual([q('q2', 'b')]);
    expect(editQueued([q('q1', 'a')], 'q1', '   \n ')).toEqual([]);
  });

  it('is a no-op for an id that is no longer queued (it already went out)', () => {
    const before = [q('q1', 'a')];
    expect(editQueued(before, 'gone', 'whatever')).toEqual(before);
  });

  it('preserves the row identity and timestamp across an edit', () => {
    const next = editQueued([{ id: 'q1', text: 'a', ts: 1234 }], 'q1', 'b');
    expect(next[0]).toEqual({ id: 'q1', text: 'b', ts: 1234 });
  });
});

describe('removeQueued', () => {
  it('drops one row by id', () => {
    expect(removeQueued([q('q1', 'a'), q('q2', 'b')], 'q1')).toEqual([q('q2', 'b')]);
  });

  it('clears everything when no id is given', () => {
    expect(removeQueued([q('q1', 'a'), q('q2', 'b')])).toEqual([]);
  });

  it('never treats a missing id as "clear all"', () => {
    const before = [q('q1', 'a'), q('q2', 'b')];
    expect(removeQueued(before, 'nope')).toEqual(before);
  });
});

describe('shouldDrainQueue', () => {
  const idle: DrainProbe = {
    busy: false, asking: false, paused: false, ended: false, socketOpen: true, queueLength: 1,
  };

  it('drains an idle, connected session that has something queued', () => {
    expect(shouldDrainQueue(idle)).toBe(true);
  });

  it('waits while a turn is in flight — that is the whole point of the queue', () => {
    expect(shouldDrainQueue({ ...idle, busy: true })).toBe(false);
  });

  it('waits while a card is open: sending on top of a question is talking over it', () => {
    expect(shouldDrainQueue({ ...idle, asking: true })).toBe(false);
  });

  it('does NOT drain after an interrupt — Stop must not fire the next queued message', () => {
    // The regression this exists for: the interrupt's own `result` frame is a busy→idle edge.
    expect(shouldDrainQueue({ ...idle, paused: true })).toBe(false);
  });

  it('does not spend the queue into an ended / credential-less session', () => {
    expect(shouldDrainQueue({ ...idle, ended: true })).toBe(false);
  });

  it('does not drain over a closed socket (the message would be lost, not sent)', () => {
    expect(shouldDrainQueue({ ...idle, socketOpen: false })).toBe(false);
  });

  it('is false for an empty queue whatever else is true', () => {
    expect(shouldDrainQueue({ ...idle, queueLength: 0 })).toBe(false);
  });

  it('treats absent paused/ended as "not paused, not ended" (the fields are optional)', () => {
    expect(shouldDrainQueue({ busy: false, asking: false, socketOpen: true, queueLength: 2 })).toBe(true);
  });
});
