/**
 * useChartSize follows the element it is given (the foundation bug lane E hit):
 * the hook's ref is a callback ref built by `followElement`, so a chart that
 * first renders an empty state (no plot element) and mounts its plot when the
 * data arrives is still observed, measured and drawn; a swapped or unmounted
 * plot disconnects its observer. React's side is the plain callback-ref
 * contract (node on mount, null on unmount); this drives that contract with
 * fake nodes and a fake ResizeObserver. The browser half (a legacy line card
 * whose cache arrives after the page opened draws) is the WebKit check.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { followElement } = await import('../../dashboard/src/components/lab/chart/useChartSize.js');

interface FakeObserver { cb: ResizeObserverCallback; observed: Element[]; disconnected: boolean }
let observers: FakeObserver[] = [];
const original = globalThis.ResizeObserver;

beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = class {
    private o: FakeObserver;
    constructor(cb: ResizeObserverCallback) {
      this.o = { cb, observed: [], disconnected: false };
      observers.push(this.o);
    }
    observe(el: Element) { this.o.observed.push(el); }
    unobserve() {}
    disconnect() { this.o.disconnected = true; }
  } as unknown as typeof ResizeObserver;
});
afterEach(() => { globalThis.ResizeObserver = original; });

const node = (name: string) => ({ name }) as unknown as Element;
const fire = (o: FakeObserver, width: number, height: number) =>
  o.cb([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);

function harness() {
  const sizes: Array<[number, number]> = [];
  const attached: Array<string | null> = [];
  const ref = followElement<Element>((w, h) => sizes.push([w, h]), (n) => attached.push(n ? (n as unknown as { name: string }).name : null));
  return { ref, sizes, attached };
}

describe('followElement: the chart size ref follows its node', () => {
  it('empty state first, plot later: the late plot is observed and measured (the empty -> data transition)', () => {
    const { ref, sizes } = harness();
    // First render: the chart shows its empty state, so React never calls the ref.
    expect(observers).toHaveLength(0);
    expect(ref.current).toBeNull();
    // Data arrives: the plot div mounts and React calls the ref with it.
    const plot = node('plot');
    ref(plot as never);
    expect(ref.current).toBe(plot);
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toEqual([plot]);
    fire(observers[0], 480.7, 210.2);
    expect(sizes).toEqual([[480, 210]]);
  });

  it('a swapped node disconnects the old observer and observes the new one', () => {
    const { ref, attached } = harness();
    const a = node('a');
    const b = node('b');
    ref(a as never);
    ref(b as never);
    expect(observers).toHaveLength(2);
    expect(observers[0].disconnected).toBe(true);
    expect(observers[1].observed).toEqual([b]);
    expect(observers[1].disconnected).toBe(false);
    expect(attached).toEqual(['a', 'b']);
  });

  it('unmount (null) disconnects and reports the detach; a re-mount is observed again', () => {
    const { ref, attached } = harness();
    ref(node('a') as never);
    ref(null);
    expect(observers[0].disconnected).toBe(true);
    expect(ref.current).toBeNull();
    ref(node('c') as never);
    expect(observers).toHaveLength(2);
    expect(attached).toEqual(['a', null, 'c']);
  });

  it('the same node again is a no-op (no duplicate observer)', () => {
    const { ref } = harness();
    const a = node('a');
    ref(a as never);
    ref(a as never);
    expect(observers).toHaveLength(1);
    expect(observers[0].disconnected).toBe(false);
  });

  it('is readable as a RefObject (.current) by ChartFrame and useMarkHover', () => {
    const { ref } = harness();
    const a = node('a');
    ref(a as never);
    const asObject: { current: Element | null } = ref;
    expect(asObject.current).toBe(a);
  });
});
