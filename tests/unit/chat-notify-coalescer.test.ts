/**
 * Unit tests for notifyCoalescer.ts — the scheduling policy that turns a streaming turn's
 * one-React-commit-per-NDJSON-frame into one commit per animation frame.
 *
 * The clock is injected, so every assertion here is about POLICY (what gets absorbed, what
 * cancels what, what teardown drops) rather than about wall-clock timing: nothing sleeps,
 * and the fake clock's queues are drained by hand.
 */
import { describe, it, expect } from 'vitest';
import {
  createNotifyCoalescer, NOTIFY_BACKSTOP_MS, type CoalescerClock,
} from '../../dashboard/src/components/sleepy/chat/notifyCoalescer.js';

/** A hand-driven stand-in for rAF + setTimeout. `runFrame`/`runTimers` fire whatever is
 *  still armed; a cancelled handle is removed and fires nothing. */
function fakeClock() {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const clock: CoalescerClock = {
    frame: (cb) => { const h = next++; frames.set(h, cb); return h; },
    cancelFrame: (h) => { frames.delete(h); },
    timeout: (cb, ms) => { const h = next++; timers.set(h, { cb, ms }); return h; },
    cancelTimeout: (h) => { timers.delete(h); },
  };
  return {
    clock,
    framesArmed: () => frames.size,
    timersArmed: () => timers.size,
    timerDelays: () => [...timers.values()].map((t) => t.ms),
    runFrame: () => { const due = [...frames.values()]; frames.clear(); due.forEach((cb) => cb()); },
    runTimers: () => { const due = [...timers.values()]; timers.clear(); due.forEach((t) => t.cb()); },
  };
}

function counter() {
  const state = { n: 0 };
  return { fire: () => { state.n += 1; }, get count() { return state.n; } };
}

describe('createNotifyCoalescer — trailing flush', () => {
  it('absorbs a burst of schedules into ONE fire', () => {
    const c = fakeClock();
    const f = counter();
    const co = createNotifyCoalescer(f.fire, c.clock);

    for (let i = 0; i < 40; i += 1) co.schedule();
    expect(f.count).toBe(0);        // nothing has painted yet
    expect(co.isPending()).toBe(true);

    c.runFrame();
    expect(f.count).toBe(1);        // 40 deltas → 1 commit
    expect(co.isPending()).toBe(false);
  });

  it('arms the frame AND the timeout backstop, and the winner cancels the loser', () => {
    const c = fakeClock();
    const f = counter();
    const co = createNotifyCoalescer(f.fire, c.clock);

    co.schedule();
    expect(c.framesArmed()).toBe(1);
    expect(c.timersArmed()).toBe(1);
    expect(c.timerDelays()).toEqual([NOTIFY_BACKSTOP_MS]);

    c.runFrame();
    expect(f.count).toBe(1);
    // The backstop must be gone, or a garaged pane double-fires every frame it does paint.
    expect(c.timersArmed()).toBe(0);
    c.runTimers();
    expect(f.count).toBe(1);
  });

  it('lets the backstop win when no frame ever arrives (a garaged / backgrounded pane)', () => {
    const c = fakeClock();
    const f = counter();
    const co = createNotifyCoalescer(f.fire, c.clock);

    co.schedule();
    c.runTimers();
    expect(f.count).toBe(1);
    expect(c.framesArmed()).toBe(0);
    c.runFrame();
    expect(f.count).toBe(1);
  });

  it('can be scheduled again after a flush has landed', () => {
    const c = fakeClock();
    const f = counter();
    const co = createNotifyCoalescer(f.fire, c.clock);

    co.schedule();
    c.runFrame();
    co.schedule();
    expect(co.isPending()).toBe(true);
    c.runFrame();
    expect(f.count).toBe(2);
  });
});

describe('createNotifyCoalescer — urgent flush', () => {
  it('fires synchronously and cancels the pending trailing flush', () => {
    const c = fakeClock();
    const f = counter();
    const co = createNotifyCoalescer(f.fire, c.clock);

    co.schedule();
    co.schedule();
    co.flush();
    expect(f.count).toBe(1);        // painted NOW, not next frame
    expect(co.isPending()).toBe(false);

    // …and the absorbed deltas must not produce a second commit for the same state.
    c.runFrame();
    c.runTimers();
    expect(f.count).toBe(1);
  });

  it('fires even with nothing pending (the ordinary user-action path)', () => {
    const c = fakeClock();
    const f = counter();
    const co = createNotifyCoalescer(f.fire, c.clock);

    co.flush();
    co.flush();
    expect(f.count).toBe(2);
    expect(c.framesArmed()).toBe(0);
    expect(c.timersArmed()).toBe(0);
  });
});

describe('createNotifyCoalescer — teardown', () => {
  it('cancel() drops a pending flush without firing it', () => {
    const c = fakeClock();
    const f = counter();
    const co = createNotifyCoalescer(f.fire, c.clock);

    co.schedule();
    co.cancel();
    expect(co.isPending()).toBe(false);
    expect(c.framesArmed()).toBe(0);
    expect(c.timersArmed()).toBe(0);

    c.runFrame();
    c.runTimers();
    expect(f.count).toBe(0);        // a disposed session must never re-render its pane
  });

  it('cancel() is idempotent and safe with nothing armed', () => {
    const c = fakeClock();
    const f = counter();
    const co = createNotifyCoalescer(f.fire, c.clock);
    expect(() => { co.cancel(); co.cancel(); }).not.toThrow();
    expect(f.count).toBe(0);
  });
});
