// The dashboard's hands-free store (lane G) talks only to the LAPTOP's routes, and only from the
// desktop app. On the phone's cloud page `/api/handsfree/status` is a transfer route: a device
// cookie sent there is a credential mismatch, so the store must not send even a first request.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fetchCalls: string[] = [];
const g = globalThis as unknown as { window?: unknown; fetch: typeof fetch };
const realFetch = g.fetch;

beforeEach(() => {
  fetchCalls.length = 0;
  g.window = { addEventListener: () => {}, removeEventListener: () => {}, setTimeout, clearTimeout };
  g.fetch = vi.fn(async (url: string) => {
    fetchCalls.push(url);
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
