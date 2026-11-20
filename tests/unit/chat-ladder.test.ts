/**
 * Navigation B, C5: the shared Chat ladder (dashboard/src/lib/chatLadder.ts) both the project
 * switch's carry and the window's Chat landing use. It keeps asking until the chat opens, its
 * instance leaves the screen, or the bound passes; it only ever asks the surface to expand.
 */
import { describe, it, expect } from 'vitest';
import { runChatLadder, CHAT_LADDER_STEPS_MS } from '../../dashboard/src/lib/chatLadder';

function fake() {
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    setTimer: (fn: () => void, ms: number) => { timers.push({ at: ms, fn }); return timers.length - 1; },
    clearTimer: () => {},
    runTo(ms: number) { for (const t of timers.filter((x) => x.at <= ms).sort((a, b) => a.at - b.at)) t.fn(); timers.splice(0, timers.length, ...timers.filter((x) => x.at > ms)); },
  };
}

describe('chat ladder', () => {
  it('asks at once, then on each step past 2.5 s up to the bound, until the chat opens', () => {
    const f = fake();
    let asks = 0;
    let open = false;
    runChatLadder(new EventTarget(), 20_000, { isOpen: () => open, stillActive: () => true, ask: () => { asks += 1; }, ...f });
    expect(asks).toBe(1);
    f.runTo(CHAT_LADDER_STEPS_MS[CHAT_LADDER_STEPS_MS.length - 1]);
    expect(asks).toBe(1 + CHAT_LADDER_STEPS_MS.length);
    f.runTo(5_500);
    expect(asks).toBeGreaterThan(1 + CHAT_LADDER_STEPS_MS.length);
    open = true;
    const before = asks;
    f.runTo(20_000);
    expect(asks).toBe(before);
  });

  it('stops when its instance leaves the screen, and when cancelled', () => {
    const f = fake();
    let asks = 0;
    let active = true;
    runChatLadder(new EventTarget(), 20_000, { isOpen: () => false, stillActive: () => active, ask: () => { asks += 1; }, ...f });
    active = false;
    f.runTo(20_000);
    expect(asks).toBe(1);
    const g = fake();
    let n = 0;
    const stop = runChatLadder(new EventTarget(), 20_000, { isOpen: () => false, stillActive: () => true, ask: () => { n += 1; }, ...g });
    stop();
    g.runTo(20_000);
    expect(n).toBe(1);
  });
});
