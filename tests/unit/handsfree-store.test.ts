// The dashboard's hands-free store (lane G) talks only to the LAPTOP's routes, and only from the
// desktop app. On the phone's cloud page `/api/handsfree/status` is a transfer route: a device
// cookie sent there is a credential mismatch, so the store must not send even a first request.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fetchCalls: string[] = [];
const vaultHeaders: Array<string | null> = [];
const g = globalThis as unknown as { window?: unknown; fetch: typeof fetch };
const realFetch = g.fetch;

beforeEach(() => {
  fetchCalls.length = 0;
  vaultHeaders.length = 0;
  g.window = { addEventListener: () => {}, removeEventListener: () => {}, setTimeout, clearTimeout };
  g.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push(url);
    vaultHeaders.push((init?.headers as Record<string, string> | undefined)?.['X-Dreamcontext-Vault'] ?? null);
    return new Response(JSON.stringify({ phase: 'home', offers: ['go'], warnings: [], job: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  g.fetch = realFetch;
  delete g.window;
});

describe('handsfree store host gate', () => {
  it('off the desktop app (the phone on the cloud): no request at all, the store is unavailable', async () => {
    const store = await import('../../dashboard/src/components/handsfree/handsfreeStore.js');
    store.setHandsfreeHostProbeForTests(() => false);
    const off = store.subscribeHandsfree(() => {});
    await store.refreshHandsfreeStatus();
    store.adoptHandsfreeJob(null);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCalls).toEqual([]);
    expect(store.handsfreeSnapshot().unavailable).toBe(true);
    off();
  });

  it('in the desktop app: the status is read from the laptop route', async () => {
    const store = await import('../../dashboard/src/components/handsfree/handsfreeStore.js');
    store.setHandsfreeHostProbeForTests(() => true);
    const off = store.subscribeHandsfree(() => {});
    await store.refreshHandsfreeStatus();
    expect(fetchCalls[0]).toBe('/api/handsfree/status');
    expect(store.handsfreeSnapshot()).toMatchObject({ unavailable: false, status: { phase: 'home' } });
    off();
    store.setHandsfreeHostProbeForTests(null);
  });
});

describe('r14: the status is read for the project on screen', () => {
  it('the read names the window\'s project; a project switch re-reads at once for the new one', async () => {
    const store = await import('../../dashboard/src/components/handsfree/handsfreeStore.js');
    store.setHandsfreeHostProbeForTests(() => true);
    const off = store.subscribeHandsfree(() => {});
    await store.refreshHandsfreeStatus();
    expect(vaultHeaders.at(-1)).toBeNull(); // no project yet (the launcher)
    store.setHandsfreeVault('hf-smoke');
    await new Promise((r) => setTimeout(r, 10));
    expect(vaultHeaders.at(-1)).toBe('hf-smoke');
    store.setHandsfreeVault('dreamcontext');
    await new Promise((r) => setTimeout(r, 10));
    expect(vaultHeaders.at(-1)).toBe('dreamcontext');
    const n = fetchCalls.length;
    store.setHandsfreeVault('dreamcontext'); // the same project: no extra read
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCalls.length).toBe(n);
    off();
    store.setHandsfreeHostProbeForTests(null);
  });

  it('r16: a project switch while a read is IN FLIGHT still reads for the new project (no poll timer needed)', async () => {
    const store = await import('../../dashboard/src/components/handsfree/handsfreeStore.js');
    store.setHandsfreeHostProbeForTests(() => true);
    // A fake api whose FIRST status request answers only when the test releases it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const asked: Array<string | null> = [];
    g.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const vault = (init?.headers as Record<string, string> | undefined)?.['X-Dreamcontext-Vault'] ?? null;
      asked.push(vault);
      if (asked.length === 1) await gate;
      const body = { phase: 'away', offers: ['return'], warnings: [], job: null, here: { vault, inTrip: vault === 'B' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    // No poll can rescue it: setTimeout is a no-op for this test.
    g.window = { addEventListener: () => {}, removeEventListener: () => {}, setTimeout: () => 0, clearTimeout: () => {} };
    const off = store.subscribeHandsfree(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(asked).toEqual([null]); // the first read (no project yet) is out and held
    store.setHandsfreeVault('A'); // the window shows A, then B, while that read is still in flight
    store.setHandsfreeVault('B');
    await new Promise((r) => setTimeout(r, 5));
    expect(asked).toEqual([null]); // deduped: nothing new while one read is out
    release();
    for (let i = 0; i < 50 && store.handsfreeSnapshot().status?.here?.vault !== 'B'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(asked).toEqual([null, 'B']); // exactly one more read, for the project on screen
    expect(store.handsfreeSnapshot().status?.here).toEqual({ vault: 'B', inTrip: true });
    expect(store.handsfreeView(store.handsfreeSnapshot().status, 'B')).toBe('trip');
    off();
    store.setHandsfreeHostProbeForTests(null);
  });

  it('handsfreeView: the trip view only for the project the answer names AND is in the trip', async () => {
    const { handsfreeView } = await import('../../dashboard/src/components/handsfree/handsfreeStore.js');
    const st = (here?: { vault: string | null; inTrip: boolean }, phase = 'away') => ({ phase, unreadable: null, ...(here ? { here } : {}) }) as never;
    expect(handsfreeView(st({ vault: 'hf', inTrip: true }), 'hf')).toBe('trip');
    expect(handsfreeView(st({ vault: 'dc', inTrip: false }), 'dc')).toBe('other');
    expect(handsfreeView(st({ vault: 'hf', inTrip: true }), 'dc')).toBe('other'); // another tab's answer
    expect(handsfreeView(st({ vault: null, inTrip: false }), '')).toBe('other');
    expect(handsfreeView(st(undefined), 'dc')).toBe('trip'); // a server a build behind
    expect(handsfreeView(st({ vault: 'dc', inTrip: false }, 'home'), 'dc')).toBe('home');
    expect(handsfreeView(null, 'dc')).toBe('home');
  });
});

