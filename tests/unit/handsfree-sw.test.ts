// The hands-free service worker (AC16): the pure decision function, the interception rule,
// and the GENERATED script itself, run in a vm sandbox with a scripted fetch and cache.
import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  ATTEMPT_TIMEOUTS_MS,
  CLOUD_HEADER,
  OFFLINE_PATH,
  SKIP_HEADER,
  serviceWorkerSource,
  swDecide,
  swIntercepts,
  type SwVerdict,
} from '../../src/server/handsfree-sw.js';

const MAX = ATTEMPT_TIMEOUTS_MS.length;

describe('swDecide (status x header x attempt)', () => {
  const statuses: Array<number | null> = [null, 200, 204, 301, 302, 400, 401, 403, 404, 423, 429, 500, 502, 503, 504];
  const asleep = new Set<number | null>([null, 404, 502, 503, 504]);

  it('a response WITH our header passes, whatever its status', () => {
    for (const s of statuses) {
      if (s === null) continue;
      for (let a = 1; a <= MAX; a++) expect(swDecide({ attempt: a, maxAttempts: MAX, status: s, hasCloudHeader: true }), `${s}@${a}`).toBe('pass');
    }
  });

  it('only 404/502/503/504 or a network error WITHOUT our header retries, then goes offline', () => {
    for (const s of statuses) {
      for (let a = 1; a <= MAX; a++) {
        const want: SwVerdict = !asleep.has(s) ? 'pass' : a < MAX ? 'retry' : 'offline';
        expect(swDecide({ attempt: a, maxAttempts: MAX, status: s, hasCloudHeader: false }), `${s}@${a}`).toBe(want);
      }
    }
  });

  it('GitHub\'s interstitial (200 HTML, no header) and its private-port 302 pass through', () => {
    expect(swDecide({ attempt: 1, maxAttempts: MAX, status: 200, hasCloudHeader: false })).toBe('pass');
    expect(swDecide({ attempt: MAX, maxAttempts: MAX, status: 0, hasCloudHeader: false })).toBe('pass'); // opaque redirect
  });

  it('retries twice before the offline page (W0: a forwarder hang made a false asleep page)', () => {
    expect(MAX).toBe(3);
  });
});

describe('swIntercepts', () => {
  const o = 'https://cs-8080.app.github.dev';
  it('takes only same-origin top-level navigations', () => {
    expect(swIntercepts('navigate', `${o}/`, o)).toBe(true);
    expect(swIntercepts('navigate', `${o}/agents?x=1`, o)).toBe(true);
    expect(swIntercepts('cors', `${o}/`, o)).toBe(false);
    expect(swIntercepts('no-cors', `${o}/assets/index.js`, o)).toBe(false);
    expect(swIntercepts('navigate', 'https://github.com/codespaces', o)).toBe(false);
  });
  it('never /api, /login, the WS or its own files', () => {
    for (const p of ['/api', '/api/health', '/api/agent/chat', '/login', '/login/x', '/handsfree-sw.js', '/handsfree-offline.html', '/manifest.webmanifest']) {
      expect(swIntercepts('navigate', `${o}${p}`, o), p).toBe(false);
    }
  });
});

// ─── The generated script, run for real ─────────────────────────────────────

interface FakeRes { status: number; ok: boolean; type: string; headers: { get(n: string): string | null }; tag: string }
function res(status: number, cloud: boolean, tag = ''): FakeRes {
  const h: Record<string, string> = cloud ? { [CLOUD_HEADER.toLowerCase()]: '1' } : {};
  return { status, ok: status >= 200 && status < 300, type: 'basic', headers: { get: (n) => h[n.toLowerCase()] ?? null }, tag };
}

function loadWorker(script: Array<FakeRes | 'throw'>) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const calls: Array<{ url: string; init: { headers: Record<string, string>; redirect: string; cache: string; credentials: string } }> = [];
  const store = new Map<string, Map<string, FakeRes>>();
  let i = 0;
  const offlineRes = res(200, true, 'offline-page');
  const sandbox = {
    self: {
      addEventListener: (n: string, fn: (e: unknown) => void) => { handlers[n] = fn; },
      skipWaiting: () => undefined,
      clients: { claim: async () => undefined },
      location: { origin: 'https://cs-8080.app.github.dev' },
    },
    fetch: async (url: string, init: never) => {
      calls.push({ url, init });
      if (url === OFFLINE_PATH) return offlineRes;
      const next = script[Math.min(i++, script.length - 1)];
      if (next === 'throw') throw new TypeError('network');
      return next;
    },
    caches: {
      open: async (name: string) => {
        if (!store.has(name)) store.set(name, new Map());
        const c = store.get(name)!;
        return { put: async (k: string, v: FakeRes) => { c.set(k, v); } };
      },
      match: async (k: string, o?: { cacheName?: string }) => (o?.cacheName ? store.get(o.cacheName)?.get(k) : undefined) ?? null,
      keys: async () => [...store.keys()],
      delete: async (k: string) => store.delete(k),
    },
    Response: { error: () => res(0, false, 'error') },
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
  };
  runInNewContext(serviceWorkerSource('testver'), sandbox);
  return { handlers, calls, store };
}

async function install(w: ReturnType<typeof loadWorker>) {
  let p: Promise<unknown> = Promise.resolve();
  w.handlers.install({ waitUntil: (x: Promise<unknown>) => { p = x; } });
  await p;
}

async function navigate(w: ReturnType<typeof loadWorker>, path = '/', mode = 'navigate'): Promise<FakeRes | null> {
  let out: Promise<FakeRes> | null = null;
  const request = { mode, url: `https://cs-8080.app.github.dev${path}`, headers: { get: (n: string) => (n.toLowerCase() === 'accept' ? 'text/html' : null) } };
  w.handlers.fetch({ request, respondWith: (p: Promise<FakeRes>) => { out = p; } });
  return out ? await out : null;
}

describe('the generated service worker', () => {
  it('caches only the offline page at install, under a versioned name', async () => {
    const w = loadWorker([res(200, true)]);
    await install(w);
    expect([...w.store.keys()]).toEqual(['dc-hf-offline-testver']);
    expect([...w.store.get('dc-hf-offline-testver')!.keys()]).toEqual([OFFLINE_PATH]);
  });

  it('deletes older caches on activate', async () => {
    const w = loadWorker([res(200, true)]);
    w.store.set('dc-hf-offline-old', new Map());
    await install(w);
    let p: Promise<unknown> = Promise.resolve();
    w.handlers.activate({ waitUntil: (x: Promise<unknown>) => { p = x; } });
    await p;
    expect([...w.store.keys()]).toEqual(['dc-hf-offline-testver']);
  });

  it('re-issues a navigation with the anti-phishing skip header, no-store, manual redirects', async () => {
    const w = loadWorker([res(200, true, 'app')]);
    const r = await navigate(w);
    expect(r?.tag).toBe('app');
    const call = w.calls.at(-1)!;
    expect(call.init.headers[SKIP_HEADER]).toBe('true');
    expect(call.init.headers.Accept).toBe('text/html');
    expect(call.init.redirect).toBe('manual');
    expect(call.init.cache).toBe('no-store');
    expect(call.init.credentials).toBe('include');
  });

  it('passes our own 503 (sealed page) untouched', async () => {
    const w = loadWorker([res(503, true, 'sealed')]);
    await install(w);
    expect((await navigate(w))?.tag).toBe('sealed');
  });

  it('passes a non-asleep foreign answer (GitHub\'s interstitial) through', async () => {
    const w = loadWorker([res(200, false, 'interstitial')]);
    await install(w);
    expect((await navigate(w))?.tag).toBe('interstitial');
  });

  it('a transient failure followed by our answer never shows the offline page', async () => {
    const w = loadWorker(['throw', res(504, false), res(200, true, 'app')]);
    await install(w);
    const before = w.calls.length;
    expect((await navigate(w))?.tag).toBe('app');
    expect(w.calls.length - before).toBe(3);
  });

  it('shows the cached offline page only after every attempt saw 404 or a network error', async () => {
    const w = loadWorker([res(404, false), 'throw', res(404, false)]);
    await install(w);
    const before = w.calls.length;
    expect((await navigate(w))?.tag).toBe('offline-page');
    expect(w.calls.length - before).toBe(3);
  });

  it('never touches /api, /login or a non-navigation', async () => {
    const w = loadWorker([res(404, false)]);
    expect(await navigate(w, '/api/health')).toBeNull();
    expect(await navigate(w, '/login')).toBeNull();
    expect(await navigate(w, '/assets/x.js', 'no-cors')).toBeNull();
    expect(w.calls.length).toBe(0);
  });
});
