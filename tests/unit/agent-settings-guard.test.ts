/**
 * The settings write guard (owner decision 6, 2026-10-17): a change made while this window
 * could not read `~/.dreamcontext/agent-ui.json` is held and written ONCE over the real
 * settings — never the launch origin's defaults over them — for every writer (Settings, the
 * composer's "Set as default", the tab menu's auto-title). AC12 / task "the desktop app stays
 * light on an 8GB MacBook Air".
 *
 * The server is the real merge rule (`mergeAgentSettings` from launcher.ts) behind a stubbed
 * `fetch` that can be taken down and brought back; root vitest runs under plain Node, so
 * `window` and `localStorage` are shims.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  patchAgentSettings, initAgentSettingsFromServer, agentSettingsReady as _ready, readAgentSettings,
  resetAgentSettingsForTests, isAgentSettingsHydrated, AGENT_SETTINGS_EVENT, DEFAULT_AGENT_SETTINGS,
  type AgentSettings,
} from '../../dashboard/src/lib/agentSettings.js';
import * as settingsModule from '../../dashboard/src/lib/agentSettings.js';
import { savedDefaultReceipt } from '../../dashboard/src/components/sleepy/chat/defaultReceipt.js';
import { coerceAgentSettings as coerceServer, mergeAgentSettings } from '../../src/server/routes/launcher.js';
import { initWindowActivity, resetWindowActivityForTests } from '../../dashboard/src/lib/windowActivity.js';

void _ready;

function makeLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;
}

interface FakeServer {
  up: boolean;
  file: ReturnType<typeof coerceServer>;
  posts: Array<Record<string, unknown>>;
  gets: number;
  /** Hold the next POST's response until released. */
  holdPost: null | { release: () => void };
}

const g = globalThis as unknown as { window?: unknown; localStorage?: unknown; fetch: typeof fetch };
let realFetch: typeof fetch;
let realWindow: unknown;
let realStorage: unknown;
let server: FakeServer;

function installServer(initial: Record<string, unknown>): FakeServer {
  const s: FakeServer = { up: false, file: coerceServer(initial), posts: [], gets: 0, holdPost: null };
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!s.up) throw new TypeError('fetch failed');
    if (url === '/api/launcher/agent-settings' && (!init || !init.method || init.method === 'GET')) {
      s.gets += 1;
      return new Response(JSON.stringify(s.file), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/launcher/agent-settings' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (s.holdPost === null && (s as { _hold?: boolean })._hold) {
        await new Promise<void>((r) => { s.holdPost = { release: r }; });
      }
      s.posts.push(body);
      s.file = body.merge === true ? mergeAgentSettings(s.file, body.patch as Record<string, unknown>) : coerceServer(body);
      return new Response(JSON.stringify(s.file), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return s;
}

const SAVED = {
  enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: true, hotkey: 'Alt+Space',
  renderer: 'dom', chatView: false, screenMigrated: true, titleMigrated: true,
  chatPermissionMode: 'bypass', chatDefaultModel: 'sonnet', chatDefaultEffort: 'low', lightMode: 'on',
};

beforeEach(() => {
  vi.useFakeTimers();
  realFetch = g.fetch;
  realWindow = g.window;
  realStorage = g.localStorage;
  g.window = new EventTarget();
  g.localStorage = makeLocalStorageStub();
  resetWindowActivityForTests();
  resetAgentSettingsForTests();
  server = installServer(SAVED);
});
afterEach(() => {
  resetAgentSettingsForTests();
  vi.useRealTimers();
  g.fetch = realFetch;
  if (realWindow === undefined) delete g.window; else g.window = realWindow;
  if (realStorage === undefined) delete g.localStorage; else g.localStorage = realStorage;
});

describe('settings hydration', () => {
  it('a failed boot fetch still resolves agentSettingsReady (to the local fallback), and nothing is hydrated', async () => {
    const first = await initAgentSettingsFromServer();
    expect(first).toEqual(DEFAULT_AGENT_SETTINGS);
    await expect(settingsModule.agentSettingsReady).resolves.toEqual(DEFAULT_AGENT_SETTINGS);
    expect(isAgentSettingsHydrated()).toBe(false);
  });

  it('after the boot GET rejects, a later call re-fetches and shows the server\'s values, and tells every listener', async () => {
    await initAgentSettingsFromServer();
    server.up = true;
    const heard: AgentSettings[] = [];
    (g.window as EventTarget).addEventListener(AGENT_SETTINGS_EVENT, (e) => heard.push((e as CustomEvent<AgentSettings>).detail));
    const later = await initAgentSettingsFromServer();
    expect(later.renderer).toBe('dom');
    expect(later.lightMode).toBe('on');
    expect(later.hotkey).toBe('Alt+Space');
    expect(readAgentSettings().chatView).toBe(false);
    expect(heard.at(-1)?.lightMode).toBe('on');
    expect(isAgentSettingsHydrated()).toBe(true);
    expect(server.posts).toHaveLength(0); // nothing was touched, so nothing is written
  });

  it('only a SUCCESSFUL fetch is memoized: later calls return the local copy, never a boot snapshot', async () => {
    server.up = true;
    await initAgentSettingsFromServer();
    const gets = server.gets;
    await patchAgentSettings({ renderer: 'webgl' });
    const again = await initAgentSettingsFromServer();
    expect(again.renderer).toBe('webgl');
    expect(server.gets).toBe(gets);
  });

  it('concurrent callers share ONE in-flight fetch', async () => {
    server.up = true;
    await Promise.all([initAgentSettingsFromServer(), initAgentSettingsFromServer(), initAgentSettingsFromServer()]);
    expect(server.gets).toBe(1);
  });
});

describe('the write guard', () => {
  it('Composer set-as-default + auto-title + a Settings toggle while the server is down → 0 POSTs; once it returns → exactly 1 merge POST of the touched fields over the server values', async () => {
    await initAgentSettingsFromServer();               // the boot GET rejects
    const composer = patchAgentSettings({ chatDefaultModel: 'opus', chatDefaultEffort: 'high' });
    const title = patchAgentSettings({ autoTitle: false }); // AgentSurface does not await it
    const settings = patchAgentSettings({ restoreTabs: false });
    // The UI reflects the picks at once.
    expect(readAgentSettings()).toMatchObject({ chatDefaultModel: 'opus', autoTitle: false, restoreTabs: false });
    await vi.advanceTimersByTimeAsync(30_000);          // several retries, all against a dead server
    expect(server.posts).toHaveLength(0);
    expect(await composer).toEqual({ ok: false });      // this attempt gave up; the patch is kept
    expect(await title).toEqual({ ok: false });
    expect(await settings).toEqual({ ok: false });

    server.up = true;
    await vi.advanceTimersByTimeAsync(61_000);          // the next retry finds it
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]).toEqual({
      merge: true,
      patch: { chatDefaultModel: 'opus', chatDefaultEffort: 'high', autoTitle: false, restoreTabs: false },
    });
    // Untouched fields kept the server's values — including one the dashboard does not even
    // carry (`chatPermissionMode`).
    expect(server.file).toMatchObject({
      renderer: 'dom', chatView: false, hotkey: 'Alt+Space', lightMode: 'on', chatPermissionMode: 'bypass',
      chatDefaultModel: 'opus', chatDefaultEffort: 'high', autoTitle: false, restoreTabs: false,
    });
    expect(readAgentSettings()).toMatchObject({ renderer: 'dom', lightMode: 'on', chatDefaultModel: 'opus', restoreTabs: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.posts).toHaveLength(1);               // no loop once it landed
  });

  it('"Saved as default" appears only after the POST lands, and only if the model/effort still match', async () => {
    await initAgentSettingsFromServer();               // boot failed
    server.up = true;
    (server as { _hold?: boolean })._hold = true;
    let current = { model: 'opus', effort: 'high' };
    const write = patchAgentSettings({ chatDefaultModel: 'opus', chatDefaultEffort: 'high' });
    let shown: boolean | null = null;
    void savedDefaultReceipt(write, { model: 'opus', effort: 'high' }, () => current).then((v) => { shown = v; });
    await vi.advanceTimersByTimeAsync(10);
    expect(server.holdPost).not.toBeNull();             // the POST is out, not answered
    expect(shown).toBeNull();
    server.holdPost!.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(shown).toBe(true);

    // A change between the click and the landing wins: no receipt.
    (server as { _hold?: boolean })._hold = true;
    server.holdPost = null;
    const write2 = patchAgentSettings({ chatDefaultModel: 'sonnet', chatDefaultEffort: 'low' });
    let shown2: boolean | null = null;
    void savedDefaultReceipt(write2, { model: 'sonnet', effort: 'low' }, () => current).then((v) => { shown2 = v; });
    await vi.advanceTimersByTimeAsync(10);
    current = { model: 'haiku', effort: 'low' };
    server.holdPost!.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(shown2).toBe(false);
  });

  it('a failed POST keeps the patch and retries it; the patch clears only on a 200', async () => {
    server.up = true;
    await initAgentSettingsFromServer();
    server.up = false;
    const w = patchAgentSettings({ hotkey: 'Ctrl+K' });
    await vi.advanceTimersByTimeAsync(10);
    expect(await w).toEqual({ ok: false });
    expect(server.posts).toHaveLength(0);
    server.up = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.posts).toEqual([{ merge: true, patch: { hotkey: 'Ctrl+K' } }]);
    expect(server.file.hotkey).toBe('Ctrl+K');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.posts).toHaveLength(1);
  });

  it('a POST that fails while the window is hidden is not retried until the window is seen, then follows the backoff', async () => {
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as 'visible' | 'hidden', hasFocus: () => true, documentElement: { dataset: {} },
    });
    const win = Object.assign(new EventTarget(), { setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout });
    initWindowActivity({ win: win as never, doc: doc as never, desktop: false, alwaysFocused: false });
    server.up = true;
    await initAgentSettingsFromServer();
    let posts = 0;
    const live = g.fetch;
    g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts += 1; throw new TypeError('connection refused'); }
      return live(input, init);
    }) as typeof fetch;
    const w = patchAgentSettings({ renderer: 'webgl' });
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await w).toEqual({ ok: false });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(posts).toBe(1);                             // no storm while hidden
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toBe(2);                             // seen again: one retry at once…
    await vi.advanceTimersByTimeAsync(1_900);
    expect(posts).toBe(2);                             // …then the backoff (2 s, 4 s, …)
    await vi.advanceTimersByTimeAsync(200);
    expect(posts).toBe(3);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(posts).toBe(3);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(posts).toBe(4);
  });

  it('a refused POST (4xx, e.g. the phone may not write Settings) is not retried', async () => {
    server.up = true;
    await initAgentSettingsFromServer();
    let posts = 0;
    const live = g.fetch;
    g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts += 1; return new Response(JSON.stringify({ error: 'phone_unavailable' }), { status: 403 }); }
      return live(input, init);
    }) as typeof fetch;
    expect(await patchAgentSettings({ hotkey: 'Ctrl+J' })).toEqual({ ok: false });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(posts).toBe(1);
  });

  it('a writer that re-sets a field to the value in flight is settled when it lands', async () => {
    server.up = true;
    await initAgentSettingsFromServer();
    (server as { _hold?: boolean })._hold = true;
    const first = patchAgentSettings({ chatDefaultModel: 'opus', chatDefaultEffort: 'high' });
    await vi.advanceTimersByTimeAsync(10);
    const second = patchAgentSettings({ chatDefaultModel: 'opus', chatDefaultEffort: 'high' });
    server.holdPost!.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(server.posts).toHaveLength(1);
  });

  it('a hydrated write is a field merge: two windows writing different fields keep both', async () => {
    server.up = true;
    await initAgentSettingsFromServer();
    await patchAgentSettings({ lightMode: 'off' });
    // Another window (its own module state, simulated by a direct merge POST) writes renderer.
    server.file = mergeAgentSettings(server.file, { renderer: 'webgl' });
    await patchAgentSettings({ restoreTabs: false });
    expect(server.file).toMatchObject({ lightMode: 'off', renderer: 'webgl', restoreTabs: false });
  });

  it('never rejects, so a caller that does not await it raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      g.fetch = (async () => { throw new Error('boom'); }) as typeof fetch;
      patchAgentSettings({ autoTitle: false });         // not awaited, like AgentSurface's toggle
      await vi.advanceTimersByTimeAsync(70_000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('server merge path', () => {
  it('mergeAgentSettings picks only known fields and coerces them', () => {
    const merged = mergeAgentSettings(coerceServer(SAVED), { lightMode: 'garbage', renderer: 'dom', evil: '$(rm -rf ~)', chatDefaultModel: 'a;b' });
    expect(merged).not.toHaveProperty('evil');
    expect(merged.lightMode).toBe('auto');
    expect(merged.chatDefaultModel).toBe('');
    expect(merged.hotkey).toBe('Alt+Space');
    expect(merged.chatPermissionMode).toBe('bypass');
  });

  it('an empty patch changes nothing', () => {
    expect(mergeAgentSettings(coerceServer(SAVED), {})).toEqual(coerceServer(SAVED));
  });
});
