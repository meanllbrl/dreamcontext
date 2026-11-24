/**
 * Changing project: the one being left keeps its paint until the arriving one is drawn
 * (dashboard/src/components/layout/useInstanceHold.ts). The rule under test is WHEN it lets go:
 * two looks alike on a drawn project, a streaming chat's drift counted as alike, a hard cap, and
 * an end at once when the owner moves again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_CAP_MS, holdInstance } from '../../dashboard/src/components/layout/useInstanceHold';

interface FakeEl { dataset: Record<string, string>; style: { pointerEvents: string }; count: number; getElementsByTagName(): { length: number } }
const el = (count = 0): FakeEl => {
  const self: FakeEl = { dataset: {}, style: { pointerEvents: '' }, count, getElementsByTagName: () => ({ length: self.count }) };
  return self;
};
const hold = (old: FakeEl, next: FakeEl) => holdInstance(old as unknown as HTMLElement, next as unknown as HTMLElement);
/** The fade's end is a promise: let it settle. */
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('holdInstance', () => {
  it('a project opened for the first time is held until two looks find it drawn and alike', async () => {
    const old = el(); const next = el(20);
    hold(old, next);
    expect(old.dataset.holding).toBe('hold');
    // A click on the project still on screen must not fall through to the one behind it.
    expect(next.style.pointerEvents).toBe('none');
    vi.advanceTimersByTime(50); // 20 elements: an empty frame
    next.count = 900;
    vi.advanceTimersByTime(50); // drawn, but it just grew
    await settle();
    expect(old.dataset.holding).toBe('hold');
    vi.advanceTimersByTime(50); // drawn and alike
    await settle();
    expect(old.dataset.holding).toBeUndefined();
    expect(next.style.pointerEvents).toBe('');
  });

  it('a streaming answer does not keep it held: a small drift counts as alike', async () => {
    const old = el(); const next = el(1000);
    hold(old, next);
    vi.advanceTimersByTime(50);
    next.count = 1012;
    vi.advanceTimersByTime(50);
    await settle();
    expect(old.dataset.holding).toBeUndefined();
  });

  it('a project that never settles is let go at the cap', async () => {
    const old = el(); const next = el(0);
    hold(old, next);
    for (let t = 0; t < HOLD_CAP_MS - 50; t += 50) { next.count += 400; vi.advanceTimersByTime(50); }
    await settle();
    expect(old.dataset.holding).toBe('hold');
    vi.advanceTimersByTime(160);
    await settle();
    expect(old.dataset.holding).toBeUndefined();
  });

  it('ending it lets go at once and nothing fires afterwards', async () => {
    const old = el(); const next = el(1000);
    const end = hold(old, next);
    end();
    expect(old.dataset.holding).toBeUndefined();
    old.dataset.holding = 'someone-else';
    vi.advanceTimersByTime(HOLD_CAP_MS + 200);
    await settle();
    expect(old.dataset.holding).toBe('someone-else');
  });
});
