/**
 * Navigation B, C7: ⌘K across projects (dashboard/src/lib/recallFanout.ts). Groups land per
 * project as each answers, 3 at a time; a hung read times out as failed and frees its slot; a
 * newer query drops older answers.
 */
import { describe, it, expect } from 'vitest';
import { fanOutRecall, RECALL_PARALLEL, RECALL_PER_VAULT } from '../../dashboard/src/lib/recallFanout';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('recall fan-out', () => {
  it('delivers each project as it lands (not in list order), at most 3 reads at once', async () => {
    const reads = new Map<string, ReturnType<typeof deferred<string[]>>>();
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const done = fanOutRecall<string>({
      vaults: ['a', 'b', 'c', 'd'],
      read: (v) => { inFlight += 1; peak = Math.max(peak, inFlight); const d = deferred<string[]>(); reads.set(v, d); return d.promise.finally(() => { inFlight -= 1; }); },
      current: () => true,
      onGroup: (v) => order.push(v),
      onFailed: () => {},
      timeoutMs: 10_000,
    });
    await tick();
    expect([...reads.keys()]).toEqual(['a', 'b', 'c']);
    reads.get('c')!.resolve(['c1']);
    await tick();
    expect(order).toEqual(['c']);
    expect([...reads.keys()]).toEqual(['a', 'b', 'c', 'd']);
    reads.get('a')!.resolve(['a1']);
    reads.get('b')!.resolve([]);
    reads.get('d')!.resolve(['d1']);
    await done;
    expect(order).toEqual(['c', 'a', 'b', 'd']);
    expect(peak).toBe(RECALL_PARALLEL);
  });

  it('a hung read times out as failed and frees its slot; an error fails too', async () => {
    const timers: Array<() => void> = [];
    const failed: string[] = [];
    const got: string[] = [];
    const done = fanOutRecall<string>({
      vaults: ['hung', 'err', 'ok', 'late'],
      read: (v) => (v === 'hung' ? new Promise(() => {}) : v === 'err' ? Promise.reject(new Error('moved')) : Promise.resolve([v])),
      current: () => true,
      onGroup: (v) => got.push(v),
      onFailed: (v) => failed.push(v),
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
    });
    await tick();
    expect(failed).toEqual(['err']);
    expect(got).toEqual(['ok', 'late']);
    timers[0](); // the hung read's timeout
    await done;
    expect(failed).toEqual(['err', 'hung']);
  });

  it('a newer query stops older reads launching and drops their late answers', async () => {
    let live = true;
    const got: string[] = [];
    const first = deferred<string[]>();
    const done = fanOutRecall<string>({
      vaults: ['a', 'b', 'c', 'd', 'e'],
      read: (v) => (v === 'a' ? first.promise : new Promise(() => {})),
      current: () => live,
      onGroup: (v) => got.push(v),
      onFailed: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await tick();
    live = false;
    first.resolve(['a1']);
    await tick();
    expect(got).toEqual([]);
    void done;
  });

  it('caps each project at RECALL_PER_VAULT hits', async () => {
    let hits: string[] = [];
    await fanOutRecall<string>({
      vaults: ['a'],
      read: async () => Array.from({ length: 20 }, (_, i) => `h${i}`),
      current: () => true,
      onGroup: (_v, h) => { hits = h; },
      onFailed: () => {},
    });
    expect(hits).toHaveLength(RECALL_PER_VAULT);
  });
});
