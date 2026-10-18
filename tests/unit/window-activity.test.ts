/**
 * windowActivity + the instance-client registry: the one focus/visibility source every poll
 * follows, and the per-project clients it reaches (task: the desktop app stays light on an
 * 8GB MacBook Air — AC6).
 *
 * Driven the way the app drives React Query, in the REAL order, with no React renderer (root
 * vitest runs under plain Node): a `QueryObserver` subscribed per query is what `useQuery`
 * mounts, `qc.mount()` / `qc.unmount()` is what `QueryClientProvider`'s effect does, and the
 * registry calls are `ProjectInstance`'s mount effects — children's effects first, then the
 * provider's, then the instance's. StrictMode is its effect replay: every cleanup, then every
 * effect again.
 *
 * `window` is defined BEFORE React Query loads: query-core decides `isServer` at import time
 * and, on a "server", never starts an interval.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

(globalThis as { window?: unknown }).window ??= new EventTarget();

const { QueryObserver, focusManager } = await import('../../dashboard/node_modules/@tanstack/query-core/build/modern/index.js');
const wa = await import('../../dashboard/src/lib/windowActivity.js');
const iq = await import('../../dashboard/src/lib/instanceQueryClient.js');

type QC = ReturnType<typeof iq.createInstanceQueryClient>;

interface FakeHost {
  win: EventTarget & { setTimeout: typeof setTimeout };
  doc: EventTarget & { visibilityState: 'visible' | 'hidden'; hasFocus: () => boolean; documentElement: { dataset: Record<string, string> } };
  setHasFocus: (v: boolean) => void;
  hide: () => void;
  show: () => void;
}

function fakeHost(): FakeHost {
  let has = true;
  const win = Object.assign(new EventTarget(), { setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as 'visible' | 'hidden',
    hasFocus: () => has,
    documentElement: { dataset: {} as Record<string, string> },
  });
  return {
    win, doc,
    setHasFocus: (v) => { has = v; },
    hide: () => { doc.visibilityState = 'hidden'; has = false; doc.dispatchEvent(new Event('visibilitychange')); },
    show: () => { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); },
  };
}

/** A browser window (no shell): DOM focus events decide. */
function initBrowser(host: FakeHost) {
  return wa.initWindowActivity({ win: host.win as never, doc: host.doc as never, desktop: false, alwaysFocused: false });
}
const blur = (host: FakeHost) => { host.setHasFocus(false); host.win.dispatchEvent(new Event('blur')); };
const focus = (host: FakeHost) => { host.setHasFocus(true); host.win.dispatchEvent(new Event('focus')); };

/** What `useQuery` mounts: one observer, subscribed. Counts the queryFn's calls. */
function observe(qc: QC, key: string, extra: Record<string, unknown> = {}) {
  const calls = { n: 0 };
  const obs = new QueryObserver(qc as never, {
    queryKey: [key],
    queryFn: async () => { calls.n += 1; return calls.n; },
    ...extra,
  } as never);
  const unsub = obs.subscribe(() => {});
  return { calls, unsub, obs };
}

/** A project tab's mount, in React's order: observers, then the provider, then the instance. */
function mountTab(qc: QC, active: boolean, keys: string[], extra: Record<string, unknown> = {}) {
  const obs = keys.map((k) => observe(qc, k, extra));
  qc.mount();
  const unregister = iq.registerInstanceClient(qc);
  iq.setInstanceActive(qc, active);
  return { obs, unregister };
}

const flush = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => {
  vi.useFakeTimers();
  wa.resetWindowActivityForTests();
  iq.resetInstanceRegistryForTests();
});
afterEach(() => {
  wa.resetWindowActivityForTests();
  vi.useRealTimers();
});

describe('pollMs', () => {
  it('focused = base, visible-unfocused = ×4, hidden = base, Light mode ×2 on top, never false', async () => {
    const host = fakeHost();
    initBrowser(host);
    expect(wa.pollMs(15_000)).toBe(15_000);
    blur(host); await flush(1);
    expect(wa.getWindowActivity()).toEqual({ visible: true, focused: false, hidden: false });
    expect(wa.pollMs(15_000)).toBe(60_000);
    host.hide();
    expect(wa.getWindowActivity().hidden).toBe(true);
    expect(wa.pollMs(15_000)).toBe(15_000);
    wa.setLightPollFactor(true);
    expect(wa.pollMs(15_000)).toBe(30_000);
    host.show(); focus(host);
    expect(wa.pollMs(2_000)).toBe(4_000);
    wa.setLightPollFactor(false);
    expect(wa.pollMs(2_000)).toBe(2_000);
    expect(typeof wa.pollMs(0)).toBe('number');
  });

  it('writes data-window-active / data-window-hidden onto <html>', async () => {
    const host = fakeHost();
    initBrowser(host);
    expect(host.doc.documentElement.dataset).toMatchObject({ windowActive: 'true', windowHidden: 'false' });
    blur(host); await flush(1);
    expect(host.doc.documentElement.dataset).toMatchObject({ windowActive: 'false', windowHidden: 'false' });
    host.hide();
    expect(host.doc.documentElement.dataset).toMatchObject({ windowActive: 'false', windowHidden: 'true' });
  });

  it('drives React Query\'s focusManager from visibility', () => {
    const host = fakeHost();
    initBrowser(host);
    expect(focusManager.isFocused()).toBe(true);
    host.hide();
    expect(focusManager.isFocused()).toBe(false);
    host.show();
    expect(focusManager.isFocused()).toBe(true);
  });
});

describe('focus sources', () => {
  it('focusing an iframe is not unfocused: a blur with hasFocus() still true on the next tick counts for nothing', async () => {
    const host = fakeHost();
    initBrowser(host);
    host.win.dispatchEvent(new Event('blur')); // focus moved into an iframe; the document keeps it
    await flush(1);
    expect(wa.getWindowActivity().focused).toBe(true);
  });

  it('the shell\'s focus event wins over a DOM blur (desktop)', async () => {
    const host = fakeHost();
    let emit: (v: boolean) => void = () => {};
    wa.initWindowActivity({
      win: host.win as never, doc: host.doc as never, desktop: true, alwaysFocused: false,
      nativeFocus: async () => ({
        isFocused: async () => true,
        onFocusChanged: async (cb) => { emit = (v) => cb({ payload: v }); return () => {}; },
      }),
    });
    await flush(1);
    blur(host); await flush(1);
    expect(wa.getWindowActivity().focused).toBe(true); // the NSWindow is still key
    emit(false);
    expect(wa.getWindowActivity().focused).toBe(false);
    focus(host); // a DOM focus event no longer decides either
    expect(wa.getWindowActivity().focused).toBe(false);
    emit(true);
    expect(wa.getWindowActivity().focused).toBe(true);
  });

  it('init seeds from the shell\'s isFocused()', async () => {
    const host = fakeHost();
    wa.initWindowActivity({
      win: host.win as never, doc: host.doc as never, desktop: true, alwaysFocused: false,
      nativeFocus: async () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }),
    });
    await flush(1);
    expect(wa.getWindowActivity()).toEqual({ visible: true, focused: false, hidden: false });
  });

  it('the notch window is focused whenever it is visible', async () => {
    const host = fakeHost();
    host.setHasFocus(false);
    wa.initWindowActivity({ win: host.win as never, doc: host.doc as never, desktop: true, alwaysFocused: true });
    expect(wa.getWindowActivity().focused).toBe(true);
    host.win.dispatchEvent(new Event('blur')); await flush(1);
    expect(wa.getWindowActivity().focused).toBe(true);
    host.hide();
    expect(wa.getWindowActivity()).toEqual({ visible: false, focused: false, hidden: true });
  });
});

describe('instance registry', () => {
  it('a client created hidden and taken through a window hidden → visible makes 0 calls', async () => {
    const host = fakeHost();
    initBrowser(host);
    const qc = iq.createInstanceQueryClient();
    const tab = mountTab(qc, false, ['tasks'], { refetchOnWindowFocus: true });
    await flush(10);
    const base = tab.obs[0].calls.n; // the mount fetch
    await flush(10_000);
    host.hide(); await flush(20_000);
    host.show(); await flush(1_000);
    expect(tab.obs[0].calls.n - base).toBe(0);
  });

  it('a hidden project client with refetchOnWindowFocus:true makes 0 focus and 0 default-interval calls over 2 min, refocus included', async () => {
    const host = fakeHost();
    initBrowser(host);
    const visible = iq.createInstanceQueryClient();
    const hidden = iq.createInstanceQueryClient();
    const a = mountTab(visible, true, ['knowledge']);
    const b = mountTab(hidden, false, ['tasks'], { refetchOnWindowFocus: true });
    await flush(10);
    const b0 = b.obs[0].calls.n;
    for (let i = 0; i < 4; i += 1) {
      await flush(20_000);
      blur(host); await flush(12_000);
      focus(host); await flush(100);
    }
    host.hide(); await flush(5_000); host.show(); await flush(1_000);
    expect(b.obs[0].calls.n - b0).toBe(0);
    expect(a.obs[0].calls.n).toBeGreaterThan(1);
  });

  it('a tab hidden 60 s then activated refetches its stale queries within 1 s and leaves fresh ones alone', async () => {
    const host = fakeHost();
    initBrowser(host);
    const qc = iq.createInstanceQueryClient();
    const tab = mountTab(qc, true, ['stale']);
    const fresh = observe(qc, 'fresh', { staleTime: Infinity });
    await flush(10);
    iq.setInstanceActive(qc, false);
    const s0 = tab.obs[0].calls.n;
    const f0 = fresh.calls.n;
    await flush(60_000);
    expect(tab.obs[0].calls.n).toBe(s0);
    iq.setInstanceActive(qc, true);
    await flush(1_000);
    expect(tab.obs[0].calls.n).toBe(s0 + 1);
    expect(fresh.calls.n).toBe(f0);
  });

  it('a retry paused while the WINDOW was hidden resumes when its tab is activated', async () => {
    const host = fakeHost();
    initBrowser(host);
    const qc = iq.createInstanceQueryClient();
    let n = 0;
    const obs = new QueryObserver(qc as never, {
      queryKey: ['flaky'],
      queryFn: async () => { n += 1; if (n === 1) throw new Error('first try fails'); return n; },
      retryDelay: 500,
    } as never);
    obs.subscribe(() => {});
    qc.mount();
    iq.registerInstanceClient(qc);
    iq.setInstanceActive(qc, true);
    host.hide();                 // the failed first try waits for a seen window to retry
    await flush(2_000);
    expect(n).toBe(1);
    iq.setInstanceActive(qc, false); // the owner moved to another project meanwhile
    host.show(); await flush(2_000);
    expect(n).toBe(1);           // a hidden tab does not hear the window coming back
    iq.setInstanceActive(qc, true);
    await flush(1_000);
    expect(n).toBe(2);
    expect(obs.getCurrentResult().data).toBe(2);
  });

  it('StrictMode: a tab restored hidden, then activated, then the window hidden → visible gives exactly one focus refetch', async () => {
    const host = fakeHost();
    initBrowser(host);
    const qc = iq.createInstanceQueryClient();
    // First effect pass.
    const o1 = observe(qc, 'tasks');
    qc.mount();
    const un1 = iq.registerInstanceClient(qc);
    iq.setInstanceActive(qc, false);
    // StrictMode replay: every cleanup, then every effect again.
    o1.unsub(); qc.unmount(); un1();
    const o2 = new QueryObserver(qc as never, { queryKey: ['tasks'], queryFn: async () => { o1.calls.n += 1; return o1.calls.n; } } as never);
    o2.subscribe(() => {});
    qc.mount();
    iq.registerInstanceClient(qc);
    iq.setInstanceActive(qc, false);
    await flush(30_000);
    const hidden0 = o1.calls.n;
    host.hide(); await flush(1_000); host.show(); await flush(1_000);
    expect(o1.calls.n).toBe(hidden0); // still hidden: deaf to the window
    iq.setInstanceActive(qc, true);
    await flush(1_000);
    const afterActivate = o1.calls.n;
    expect(afterActivate).toBe(hidden0 + 1);
    await flush(6_000); // stale again (staleTime 5 s), before the 15 s interval
    host.hide(); await flush(100); host.show(); await flush(500);
    expect(o1.calls.n).toBe(afterActivate + 1);
  });

  it('switching tabs then refocusing: the newly active tab refetches, then polls at the focused cadence', async () => {
    const host = fakeHost();
    initBrowser(host);
    const a = iq.createInstanceQueryClient();
    const b = iq.createInstanceQueryClient();
    const ta = mountTab(a, true, ['a']);
    const tb = mountTab(b, false, ['b']);
    await flush(10);
    blur(host); await flush(1);
    iq.setInstanceActive(a, false);
    iq.setInstanceActive(b, true);
    await flush(1_000);
    const b0 = tb.obs[0].calls.n;
    await flush(11_000);
    focus(host);                // after ≥ 10 s unfocused
    await flush(1_000);
    expect(tb.obs[0].calls.n).toBeGreaterThanOrEqual(b0 + 1);
    const b1 = tb.obs[0].calls.n;
    await flush(60_000);        // focused cadence: every 15 s
    expect(tb.obs[0].calls.n - b1).toBeGreaterThanOrEqual(3);
    const a0 = ta.obs[0].calls.n;
    await flush(60_000);
    expect(ta.obs[0].calls.n).toBe(a0);
  });

  it('a visible-but-unfocused window polls the default interval at ×4', async () => {
    const host = fakeHost();
    initBrowser(host);
    const qc = iq.createInstanceQueryClient();
    const tab = mountTab(qc, true, ['p']);
    await flush(10);
    const f0 = tab.obs[0].calls.n;
    await flush(120_000);
    const focusedPerMin = (tab.obs[0].calls.n - f0) / 2;
    blur(host); await flush(1);
    const u0 = tab.obs[0].calls.n;
    await flush(240_000);
    const unfocusedPerMin = (tab.obs[0].calls.n - u0) / 4;
    expect(focusedPerMin).toBeGreaterThanOrEqual(4);
    expect(unfocusedPerMin).toBeLessThanOrEqual(focusedPerMin * 0.3);
  });
});
