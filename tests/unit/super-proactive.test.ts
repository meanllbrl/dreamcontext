/**
 * The cards the server opens and settles by itself (jarvis plan r9, S1-S3, G2-G6). Pure edits
 * of a record: no timer, the clock is a parameter.
 */
import { describe, it, expect } from 'vitest';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { AUTO_FLOAT_BUDGET, DISMISS_MS, applySignal, autoContainerId, noteDismissed, settleChild } from '../../src/lib/super/proactive.js';

const child = (id: string) => ({ sessionId: id, brief: '', adopted: true, startedAt: 1 });
function state(over: Partial<SuperState> = {}): SuperState {
  return { ...emptySuperState(), session: 'sup', enabled: true, children: { k1: child('k1'), k2: child('k2'), k3: child('k3') }, ...over };
}
const web = (url: string) => ({ kind: 'devserver' as const, url });

describe('applySignal', () => {
  it('S1: a dev-server pin opens one automatic, floating web card; a repeat is the same card (G4)', () => {
    const s = state();
    expect(applySignal(s, 'k1', web('http://localhost:5173/'), 0)).toBe(true);
    expect(applySignal(s, 'k1', web('http://localhost:5173/'), 0)).toBe(false);
    expect(s.containers).toEqual([{ id: autoContainerId('web', 'http://localhost:5173/'), kind: 'web', ref: 'http://localhost:5173/', shape: 'tall', place: 'float', by: 'auto', of: 'k1', title: 'localhost:5173' }]);
    expect(s.view).toEqual({ mode: 'float' });
  });

  it('S2: a browser call opens one browser card per child', () => {
    const s = state();
    applySignal(s, 'k1', { kind: 'browser' }, 0);
    applySignal(s, 'k1', { kind: 'browser' }, 0);
    expect(s.containers.map((c) => [c.kind, c.ref])).toEqual([['browser', 'k1']]);
  });

  it('not handed over, or not a child: nothing', () => {
    expect(applySignal(state({ enabled: false }), 'k1', { kind: 'browser' }, 0)).toBe(false);
    expect(applySignal(state(), 'stranger', { kind: 'browser' }, 0)).toBe(false);
  });

  it('G3: a third automatic card sends the oldest movable one to Others', () => {
    const s = state();
    applySignal(s, 'k1', { kind: 'browser' }, 0);
    applySignal(s, 'k2', { kind: 'browser' }, 0);
    applySignal(s, 'k3', { kind: 'browser' }, 0);
    expect(s.containers.filter((c) => c.place === 'float')).toHaveLength(AUTO_FLOAT_BUDGET);
    expect(s.containers[0].place).toBe('others');
  });

  it('G2/G6: the owner\'s dropped card and a viewed card are never pushed out; the view never changes', () => {
    const s = state();
    applySignal(s, 'k1', { kind: 'browser' }, 0);
    applySignal(s, 'k2', { kind: 'browser' }, 0);
    s.containers[0].pos = { x: 0.1, y: 0.1 };
    s.view = { mode: 'half', card: s.containers[1].id };
    applySignal(s, 'k3', { kind: 'browser' }, 0);
    expect(s.containers.map((c) => c.place)).toEqual(['float', 'float', 'float']);
    expect(s.view).toEqual({ mode: 'half', card: s.containers[1].id });
  });

  it('G3: a full stage puts the new automatic card straight into Others; a full record skips it', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `task-${i}`, kind: 'task' as const, ref: `t${i}`, shape: 'square' as const, place: 'float' as const }));
    const s = state({ containers: many });
    applySignal(s, 'k1', web('http://localhost:3000/'), 0);
    expect(s.containers.at(-1)?.place).toBe('others');
    const full = state({ containers: Array.from({ length: 48 }, (_, i) => ({ id: `task-${i}`, kind: 'task' as const, ref: `t${i}`, shape: 'square' as const, place: 'others' as const })) });
    expect(applySignal(full, 'k1', web('http://localhost:3000/'), 0)).toBe(false);
  });

  it('G5: a card the owner closed is not reopened automatically for DISMISS_MS', () => {
    const s = state();
    applySignal(s, 'k1', web('http://localhost:5173/'), 0);
    noteDismissed(s, s.containers, 1000);
    s.containers = [];
    expect(applySignal(s, 'k1', web('http://localhost:5173/'), 1000 + DISMISS_MS - 1)).toBe(false);
    expect(applySignal(s, 'k1', web('http://localhost:5173/'), 1000 + DISMISS_MS + 1)).toBe(true);
  });

  it('a pin withdrawn sends the child\'s automatic web cards to Others', () => {
    const s = state();
    applySignal(s, 'k1', web('http://localhost:5173/'), 0);
    applySignal(s, 'k1', { kind: 'devserver-drop' }, 0);
    expect(s.containers[0].place).toBe('others');
  });
});

describe('settleChild', () => {
  it('idle: the live browser goes to Others; gone: it closes, the chat card and the auto cards go to Others', () => {
    const s = state({ containers: [{ id: 'chat-a', kind: 'chat', ref: 'k1', shape: 'tall', place: 'float' }] });
    applySignal(s, 'k1', { kind: 'browser' }, 0);
    applySignal(s, 'k1', web('http://localhost:5173/'), 0);
    expect(settleChild(s, 'k1', 'idle', 0)).toBe(true);
    expect(s.containers.find((c) => c.kind === 'browser')?.place).toBe('others');
    expect(settleChild(s, 'k1', 'gone', 0)).toBe(true);
    expect(s.containers.some((c) => c.kind === 'browser')).toBe(false);
    expect(s.containers.map((c) => c.place)).toEqual(['others', 'others']);
  });

  it('G6: the owner\'s dropped card stays where he put it', () => {
    const s = state({ containers: [{ id: 'chat-a', kind: 'chat', ref: 'k1', shape: 'tall', place: 'float', pos: { x: 0.5, y: 0.5 } }] });
    expect(settleChild(s, 'k1', 'gone', 0)).toBe(false);
    expect(s.containers[0].place).toBe('float');
  });
});
