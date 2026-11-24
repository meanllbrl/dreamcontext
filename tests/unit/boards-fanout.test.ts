/**
 * The sidebar's board lists (tek-kenar C6): 3 reads at a time, each racing 8 s; a failure or a
 * timeout marks only that project; stale after 30 s; a refresh is due when asked.
 */
import { describe, expect, it } from 'vitest';
import { BOARDS_STALE_MS, boardsDue, fanOutBoards, toSidebarBoards } from '../../dashboard/src/components/layout/newshell/boardsFanout';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('fanOutBoards', () => {
  it('reads at most 3 at once and hears each project as it lands', async () => {
    let running = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const read = (v: string) => new Promise<{ slug: string; name: string }[]>((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      resolvers.push(() => { running -= 1; resolve([{ slug: `${v}-b`, name: v }]); });
    });
    const got: string[] = [];
    const done = fanOutBoards(['a', 'b', 'c', 'd', 'e'], read, (v, e) => { if (e.state === 'ok') got.push(v); }, { setTimer: () => 0 });
    await tick();
    expect(peak).toBe(3);
    while (resolvers.length) { resolvers.shift()!(); await tick(); }
    await done;
    expect(got.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(peak).toBe(3);
  });

  it('a failed or timed-out read marks that project only and frees its slot', async () => {
    const timers: Array<() => void> = [];
    const read = (v: string) => (v === 'slow' ? new Promise<never>(() => {}) : v === 'bad' ? Promise.reject(new Error('x')) : Promise.resolve([{ slug: 's', name: 'S' }]));
    const states: Record<string, string> = {};
    const done = fanOutBoards(['slow', 'bad', 'ok1', 'ok2'], read, (v, e) => { states[v] = e.state; }, { parallel: 1, setTimer: (fn) => { timers.push(fn); return 0; } });
    await tick();
    expect(states).toEqual({});
    timers[0](); // the 8 s race of `slow` expires
    await done;
    expect(states).toEqual({ slow: 'failed', bad: 'failed', ok1: 'ok', ok2: 'ok' });
  });
});

describe('boardsDue and the list shape', () => {
  it('reads missing, stale or refresh-asked projects, never one in flight', () => {
    const now = 100_000;
    const cache = new Map([
      ['fresh', { state: 'ok' as const, boards: [], at: now - 1_000 }],
      ['stale', { state: 'ok' as const, boards: [], at: now - BOARDS_STALE_MS - 1 }],
      ['asked', { state: 'ok' as const, boards: [], at: now }],
    ]);
    expect(boardsDue(['fresh', 'stale', 'asked', 'new', 'busy'], cache, new Set(['asked']), now, new Set(['busy']))).toEqual(['stale', 'asked', 'new']);
  });

  it('accepts both answer shapes and keeps only slug and name', () => {
    expect(toSidebarBoards([{ slug: 'a', name: 'A', elements: 3 }])).toEqual([{ slug: 'a', name: 'A' }]);
    expect(toSidebarBoards({ whiteboards: [{ slug: 'b' }] })).toEqual([{ slug: 'b', name: 'b' }]);
    expect(toSidebarBoards(null)).toEqual([]);
  });
});
