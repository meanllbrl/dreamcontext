/**
 * The Whiteboard page's memory survives a desktop relaunch (whiteboardPrefs.ts): the app gets a
 * new loopback origin, so localStorage is empty, and the tabs, the last board, the viewports and
 * the panel must come back from the server's per-machine copy (owner, 2026-10-07).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const prefs = await import('../../dashboard/src/components/whiteboard/whiteboardPrefs.js');
const place = await import('../../dashboard/src/components/whiteboard/boardPlace.js');

function fakeServer(initial: Record<string, unknown> = {}) {
  let file: Record<string, unknown> = { ...initial };
  const saves: Record<string, string>[] = [];
  return {
    saves,
    get file() { return file; },
    transport: {
      load: async () => file,
      save: async (values: Record<string, string>) => { saves.push(values); file = { ...values }; },
    },
  };
}

beforeEach(() => {
  store.clear();
  prefs.resetWhiteboardPrefsForTest();
  vi.useRealTimers();
});

describe('whiteboardPrefs', () => {
  it('brings everything back after a relaunch empties localStorage', async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    await prefs.hydrateWhiteboardPrefs('acme', server.transport);
    prefs.writeWhiteboardPref('acme', 'tabs', 'dreamcontext:whiteboard-tabs:acme', '{"tabs":["a","b"]}');
    place.writeLastBoard('acme', 'q3-plan');
    place.writeViewport('acme', 'q3-plan', { scrollX: 10, scrollY: -4, zoom: 1.5 });
    place.writePanelOpen('acme', true);
    expect(server.saves).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(server.saves).toHaveLength(1);

    // Relaunch: a new origin (empty localStorage) and a fresh app run.
    store.clear();
    prefs.resetWhiteboardPrefsForTest();
    await prefs.hydrateWhiteboardPrefs('acme', server.transport);
    expect(prefs.readWhiteboardPref('acme', 'tabs', 'dreamcontext:whiteboard-tabs:acme')).toBe('{"tabs":["a","b"]}');
    expect(place.readLastBoard('acme')).toBe('q3-plan');
    expect(place.readViewport('acme', 'q3-plan')).toEqual({ scrollX: 10, scrollY: -4, zoom: 1.5 });
    expect(place.readPanelOpen('acme')).toBe(true);
  });

  it('falls back to localStorage before the server copy is read or when it has nothing', async () => {
    place.writeLastBoard('acme', 'growth');
    expect(place.readLastBoard('acme')).toBe('growth');
    await prefs.hydrateWhiteboardPrefs('acme', fakeServer().transport);
    expect(place.readLastBoard('acme')).toBe('growth');
  });

  it('never writes to the server when its copy could not be read', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    await prefs.hydrateWhiteboardPrefs('acme', { load: async () => { throw new Error('404'); }, save });
    expect(prefs.isWhiteboardPrefsHydrated('acme')).toBe(false);
    place.writeLastBoard('acme', 'q3-plan');
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
    expect(place.readLastBoard('acme')).toBe('q3-plan');
  });

  it('keeps projects apart, coalesces a burst and skips an unchanged value', async () => {
    vi.useFakeTimers();
    const a = fakeServer();
    const b = fakeServer({ lastBoard: 'roadmap', junk: 7 });
    await prefs.hydrateWhiteboardPrefs('acme', a.transport);
    await prefs.hydrateWhiteboardPrefs('globex', b.transport);
    expect(place.readLastBoard('globex')).toBe('roadmap');
    expect(place.readLastBoard('acme')).toBeNull();
    for (let i = 0; i < 5; i++) place.writeViewport('acme', 'q3-plan', { scrollX: i, scrollY: 0, zoom: 1 });
    vi.advanceTimersByTime(400);
    expect(a.saves).toHaveLength(1);
    place.writeViewport('acme', 'q3-plan', { scrollX: 4, scrollY: 0, zoom: 1 });
    vi.advanceTimersByTime(400);
    expect(a.saves).toHaveLength(1);
    expect(b.saves).toHaveLength(0);
  });

  it('sends a waiting write at once when the window goes away', async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    await prefs.hydrateWhiteboardPrefs('acme', server.transport);
    place.writePanelOpen('acme', true);
    prefs.flushWhiteboardPrefs();
    expect(server.saves).toEqual([{ agentPanel: '1' }]);
  });
});
