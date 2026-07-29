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
  appendQueued, editQueued, removeQueued, shouldDrainQueue, canSteer, nextAutoSteer,
  type QueuedMessage, type DrainProbe, type SteerProbe,
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

describe('canSteer', () => {
  /** A turn in flight over a live socket, nothing being asked — the moment steering is FOR. */
  const running: SteerProbe = { busy: true, asking: false, ended: false, socketOpen: true };

  it('steers into a turn that is in flight — the case the whole feature exists for', () => {
    expect(canSteer(running)).toBe(true);
  });

  it('is false with nothing running: there is no turn to steer, that is an ordinary send', () => {
    expect(canSteer({ ...running, busy: false })).toBe(false);
  });

  it('refuses while a card is open — a message written now talks over the question', () => {
    expect(canSteer({ ...running, asking: true })).toBe(false);
  });

  it('refuses into an ended / credential-less session (nothing is listening on that stdin)', () => {
    expect(canSteer({ ...running, ended: true })).toBe(false);
  });

  it('refuses over a closed socket — the message would be lost, not delivered', () => {
    expect(canSteer({ ...running, socketOpen: false })).toBe(false);
  });

  it('treats an absent `ended` as "not ended" (the field is optional)', () => {
    expect(canSteer({ busy: true, asking: false, socketOpen: true })).toBe(true);
  });

  /**
   * The asymmetry with `shouldDrainQueue`, pinned deliberately: `paused` is a statement about
   * the queue draining BY ITSELF after Stop, and steering is the user acting by hand this
   * instant. `canSteer` has no `paused` input at all — if one is ever added, this pair of
   * assertions is what should have to be re-argued first.
   */
  it('is exactly the complement of shouldDrainQueue on `busy`, for the same live session', () => {
    const live = { asking: false, ended: false, socketOpen: true };
    expect(canSteer({ ...live, busy: true })).toBe(true);
    expect(shouldDrainQueue({ ...live, busy: true, queueLength: 1 })).toBe(false);

    expect(canSteer({ ...live, busy: false })).toBe(false);
    expect(shouldDrainQueue({ ...live, busy: false, queueLength: 1 })).toBe(true);
  });

  it('does not care about a Stop pause: a hand-clicked "Send now" is not an auto-drain', () => {
    // `SteerProbe` has no `paused` field — this asserts the shape, not just a value, so
    // adding one silently would fail to compile here rather than change behaviour quietly.
    const probe: SteerProbe = { busy: true, asking: false, ended: false, socketOpen: true };
    expect('paused' in probe).toBe(false);
    expect(canSteer(probe)).toBe(true);
  });
});

describe('nextAutoSteer', () => {
  const running: SteerProbe & { paused?: boolean } = {
    busy: true, asking: false, ended: false, socketOpen: true,
  };
  /** A row parked by a ⏎ whose steer was refused — owed the first opening. */
  const owed = (id: string, text: string): QueuedMessage => ({ ...q(id, text), steerWhenPossible: true });

  it('picks up a row that only queued because ⏎ could not steer it at the time', () => {
    expect(nextAutoSteer([owed('a', 'now please')], running)?.id).toBe('a');
  });

  it('leaves deliberately-held rows alone — ⇡ said "next turn", and it meant it', () => {
    expect(nextAutoSteer([q('a', 'later'), q('b', 'also later')], running)).toBeNull();
  });

  it('lets an owed row overtake a held one: they asked for different things', () => {
    // Order in the strip ranks EQUALS. A ⇡ row ahead of it does not make a ⏎ row wait out
    // the turn — that is precisely the wait steering exists to remove.
    expect(nextAutoSteer([q('held', 'next turn'), owed('now', 'this turn')], running)?.id).toBe('now');
  });

  it('takes the OLDEST owed row when several are waiting', () => {
    expect(nextAutoSteer([owed('a', 'first'), owed('b', 'second')], running)?.id).toBe('a');
  });

  it('does nothing while a card is open — the same reason a manual steer is refused', () => {
    expect(nextAutoSteer([owed('a', 'x')], { ...running, asking: true })).toBeNull();
  });

  it('does nothing once the turn has settled: the ordinary drain owns that edge', () => {
    expect(nextAutoSteer([owed('a', 'x')], { ...running, busy: false })).toBeNull();
  });

  it('does NOT fire after Stop, even for an owed row — nothing automatic may outlive Stop', () => {
    // The counterpart to `canSteer` ignoring `paused`: a hand on Send now still sends this
    // row, but the session must not resume steering by itself the moment Stop lands.
    expect(nextAutoSteer([owed('a', 'x')], { ...running, paused: true })).toBeNull();
  });

  it('does not steer into an ended session or a closed socket', () => {
    expect(nextAutoSteer([owed('a', 'x')], { ...running, ended: true })).toBeNull();
    expect(nextAutoSteer([owed('a', 'x')], { ...running, socketOpen: false })).toBeNull();
  });

  it('is null for an empty queue', () => {
    expect(nextAutoSteer([], running)).toBeNull();
  });
});

describe('appendQueued — steerWhenPossible', () => {
  it('marks a row parked by a refused steer, and leaves a plain ⇡ row unmarked', () => {
    const [fallback] = appendQueued([], 'now please', 'a', 1, { steerWhenPossible: true });
    const [held] = appendQueued([], 'next turn', 'b', 2);
    expect(fallback.steerWhenPossible).toBe(true);
    // Absent, not `false` — `nextAutoSteer` finds by truthiness and the model stays minimal.
    expect('steerWhenPossible' in held).toBe(false);
  });

  it('keeps the mark through an edit — fixing a typo does not demote it to "next turn"', () => {
    const queue = appendQueued([], 'wrong', 'a', 1, { steerWhenPossible: true });
    expect(editQueued(queue, 'a', 'right')[0]).toEqual({
      id: 'a', text: 'right', ts: 1, steerWhenPossible: true,
    });
  });
});
