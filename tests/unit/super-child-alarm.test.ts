/**
 * A Super Agent child's question raises nothing, and a chat whose project record is not read
 * yet holds its alarm until it is (owner, 2026-10-21: children never ping; AC5).
 */
import { describe, it, expect } from 'vitest';
import { CHILD_ALARM_HOLD_MS, createChildAlarmGate } from '../../dashboard/src/components/sleepy/super/childAlarm.js';

function rig(asking = true) {
  const raised: Array<{ alarm: string; deferred: boolean }> = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const state = { asking };
  const gate = createChildAlarmGate<string>({
    raise: (alarm, deferred) => { raised.push({ alarm, deferred }); },
    stillAsking: () => state.asking,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { live: boolean }).live = false; },
  });
  const fire = () => { for (const t of timers) if (t.live) { t.live = false; t.fn(); } };
  return { gate, raised, timers, state, fire };
}

describe('the child alarm gate', () => {
  it('mode off (an ordinary chat): every fresh ask raises at once, as today', () => {
    const { gate, raised } = rig();
    gate.set(false);
    gate.ask('q1');
    expect(raised).toEqual([{ alarm: 'q1', deferred: false }]);
  });

  it('a child (delegated or adopted): no alarm, ever', () => {
    const { gate, raised } = rig();
    gate.set(true);
    gate.ask('q1');
    gate.ask('q2');
    expect(raised).toEqual([]);
    expect(gate.child).toBe(true);
  });

  it('unknown, then the record names it a child: the held question is dropped', () => {
    const { gate, raised, fire } = rig();
    gate.set(null);
    gate.ask('replayed');
    gate.set(true);
    fire();
    expect(raised).toEqual([]);
  });

  it('unknown, then the record says not a child: it rings once, late', () => {
    const { gate, raised, fire } = rig();
    gate.set(null);
    gate.ask('q');
    expect(raised).toEqual([]);
    gate.set(false);
    fire();
    expect(raised).toEqual([{ alarm: 'q', deferred: true }]);
  });

  it('no record ever: released after the hold', () => {
    const { gate, raised, timers, fire } = rig();
    gate.set(null);
    gate.ask('q');
    expect(timers[0].ms).toBe(CHILD_ALARM_HOLD_MS);
    fire();
    expect(raised).toEqual([{ alarm: 'q', deferred: true }]);
    gate.ask('next');
    expect(raised[1]).toEqual({ alarm: 'next', deferred: false });
  });

  it('a held question answered meanwhile rings nothing', () => {
    const { gate, raised, state } = rig();
    gate.set(null);
    gate.ask('q');
    state.asking = false;
    gate.set(false);
    expect(raised).toEqual([]);
  });

  it('a chat taken back (child -> not a child) rings for its next question', () => {
    const { gate, raised } = rig();
    gate.set(true);
    gate.ask('quiet');
    gate.set(false);
    gate.ask('loud');
    expect(raised).toEqual([{ alarm: 'loud', deferred: false }]);
  });
});
