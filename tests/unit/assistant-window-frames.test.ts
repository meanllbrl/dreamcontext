/**
 * Window moves land in ONE step (`set_frames`), animated or not — never setSize-then-setPosition.
 *
 * - `lib/windowFrames.ts`: the wrapper, its fallback (only where the command itself is missing),
 *   and the reduced-motion rule.
 * - `components/assistant/seatGuard.ts`: the notch's heal guard never fights an animation, and
 *   still recovers when one errors or never reports back.
 * - `components/assistant/tile.ts`: one move for every existing window, new windows built AT
 *   their tile, overlapping tiles never open a window twice.
 * - `components/assistant/Notch.tsx`: root vitest runs in plain Node with no jsdom, so the
 *   seat → min-size pairing is pinned by reading the source (as agent-thread-reply-ui does).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Win = {
  label: string;
  setPosition: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  unminimize: ReturnType<typeof vi.fn>;
};
const makeWin = (label: string): Win => ({
  label,
  setPosition: vi.fn(async () => {}),
  setSize: vi.fn(async () => {}),
  unminimize: vi.fn(async () => {}),
});

const windows = vi.hoisted(() => new Map<string, unknown>());
const core = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined) }));
const desktop = vi.hoisted(() => ({
  openVaultWindow: vi.fn(async (_vault: string, _at?: unknown) => {}),
  vaultWindowLabel: (vault: string) => `vault-${vault}`,
}));

vi.mock('../../dashboard/node_modules/@tauri-apps/api/core.js', () => core);
vi.mock('../../dashboard/node_modules/@tauri-apps/api/window.js', () => ({
  Window: { getByLabel: async (l: string) => windows.get(l) ?? null },
  LogicalPosition: class { constructor(public x: number, public y: number) {} },
  LogicalSize: class { constructor(public width: number, public height: number) {} },
  currentMonitor: async () => ({
    scaleFactor: 2,
    workArea: { position: { x: 0, y: 50 }, size: { width: 2000, height: 1000 } },
  }),
}));
vi.mock('../../dashboard/node_modules/@tauri-apps/api/webviewWindow.js', () => ({
  WebviewWindow: { getByLabel: async (l: string) => windows.get(l) ?? null },
}));
vi.mock('../../dashboard/src/lib/desktop', () => desktop);

const { setFrames, frameMotionMs } = await import('../../dashboard/src/lib/windowFrames');
const guard = await import('../../dashboard/src/components/assistant/seatGuard');
const { tileWindows, tileRects } = await import('../../dashboard/src/components/assistant/tile');

const reducedMotion = (on: boolean) =>
  vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: on && q.includes('reduce') }) });

beforeEach(() => {
  vi.clearAllMocks();
  windows.clear();
  core.invoke.mockResolvedValue(undefined);
  desktop.openVaultWindow.mockImplementation(async (vault: string) => { windows.set(`vault-${vault}`, makeWin(`vault-${vault}`)); });
  guard.resetSeatGuard();
  reducedMotion(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('setFrames', () => {
  it('sends every item in ONE set_frames call with the animateMs key', async () => {
    const items = [{ label: 'a', x: 1, y: 2, width: 3, height: 4 }, { label: 'b', x: 5, y: 6, width: 7, height: 8, min: 'window-seat' as const }];
    await setFrames(items, 200);
    expect(core.invoke).toHaveBeenCalledTimes(1);
    expect(core.invoke).toHaveBeenCalledWith('set_frames', { items, animateMs: 200 });
  });

  it('falls back to setPosition + setSize for EVERY item when invoke rejects, a min request included', async () => {
    core.invoke.mockRejectedValue(new Error('not allowed by ACL'));
    const a = makeWin('a'); const b = makeWin('b');
    windows.set('a', a); windows.set('b', b);
    await setFrames([
      { label: 'a', x: 10, y: 20, width: 300, height: 400, min: 'window-seat' },
      { label: 'b', x: 30, y: 40, width: 500, height: 600 },
    ], 200);
    expect(a.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 10, y: 20 }));
    expect(a.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 300, height: 400 }));
    expect(b.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 30, y: 40 }));
    expect(b.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 500, height: 600 }));
  });

  it('does not fall back when the command resolved (Rust ran; it owns the frame)', async () => {
    const a = makeWin('a'); windows.set('a', a);
    await setFrames([{ label: 'a', x: 0, y: 0, width: 1, height: 1 }], 0);
    expect(a.setPosition).not.toHaveBeenCalled();
    expect(a.setSize).not.toHaveBeenCalled();
  });

  it('animates 200ms, and 0ms under prefers-reduced-motion', () => {
    expect(frameMotionMs()).toBe(200);
    reducedMotion(true);
    expect(frameMotionMs()).toBe(0);
  });
});

describe('seat guard', () => {
  const at = { x: 100, y: 0, width: 300, height: 38 };
  const facade = (frame = { ...at, width: 580, height: 560 }) => ({
    isVisible: vi.fn(async () => true),
    frame: vi.fn(async () => frame),
    apply: vi.fn(async () => {}),
  });

  it('heals a drifted frame when nothing is in flight (the Space-switch regression)', async () => {
    const w = facade(); guard.setSeatWindow(w);
    guard.claimSeat(at);
    expect(await guard.healSeat()).toBe(true);
    expect(w.apply).toHaveBeenCalledWith(at);
  });

  it('is a no-op while a flight is open, and runs ONE heal after the last flight ends', async () => {
    const w = facade(); guard.setSeatWindow(w);
    guard.claimSeat(at);
    let land1!: () => void; let land2!: () => void;
    const f1 = guard.withFlight(() => new Promise<void>((r) => { land1 = r; }));
    const f2 = guard.withFlight(() => new Promise<void>((r) => { land2 = r; }));
    expect(await guard.healSeat()).toBe(false);
    land1(); await f1;
    expect(guard.flying()).toBe(true);
    expect(await guard.healSeat()).toBe(false);
    expect(w.apply).not.toHaveBeenCalled();
    land2(); await f2;
    await vi.waitFor(() => expect(w.apply).toHaveBeenCalledTimes(1));
    expect(w.apply).toHaveBeenCalledWith(at);
  });

  it('a rejected frame change still ends its flight', async () => {
    const w = facade(); guard.setSeatWindow(w);
    guard.claimSeat(at);
    await expect(guard.withFlight(async () => { throw new Error('set_frames failed'); })).rejects.toThrow('set_frames failed');
    expect(guard.flying()).toBe(false);
    await vi.waitFor(() => expect(w.apply).toHaveBeenCalledTimes(1));
  });

  it('a flight older than 2s is treated as ended', async () => {
    vi.useFakeTimers();
    const w = facade(); guard.setSeatWindow(w);
    guard.claimSeat(at);
    void guard.withFlight(() => new Promise<void>(() => { /* never lands */ }));
    expect(await guard.healSeat()).toBe(false);
    vi.advanceTimersByTime(2001);
    expect(guard.flying()).toBe(false);
    expect(await guard.healSeat()).toBe(true);
  });

  it('holds nothing when popped out, and a superseded seat change cannot claim the frame', async () => {
    const w = facade(); guard.setSeatWindow(w);
    const old = guard.claimSeat(null);
    guard.claimSeat(null);
    expect(guard.wantSeat(old, at)).toBe(false);
    expect(await guard.healSeat()).toBe(false);
    expect(w.apply).not.toHaveBeenCalled();
  });
});

describe('tileWindows', () => {
  it('moves every pre-existing window in ONE setFrames call and builds missing windows at their tile', async () => {
    const a = makeWin('vault-a'); const c = makeWin('vault-c');
    windows.set('vault-a', a); windows.set('vault-c', c);
    const out = await tileWindows(['a', 'b', 'c', 'd'], 'grid');
    expect(out.ok).toBe(true);
    const rects = tileRects(4, 'grid', { x: 0, y: 25, width: 1000, height: 500 });
    expect(desktop.openVaultWindow.mock.calls).toEqual([['b', rects[1]], ['d', rects[3]]]);
    const frameCalls = core.invoke.mock.calls.filter(([cmd]) => cmd === 'set_frames');
    expect(frameCalls).toHaveLength(1);
    expect(frameCalls[0][1]).toEqual({
      items: [{ label: 'vault-a', ...rects[0] }, { label: 'vault-c', ...rects[2] }],
      animateMs: 200,
    });
    expect(a.unminimize).toHaveBeenCalled();
    expect(c.unminimize).toHaveBeenCalled();
    expect(a.setPosition).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, result: { layout: 'grid', placed: ['a', 'b', 'c', 'd'].map((vault, i) => ({ vault, ...rects[i] })) } });
  });

  it('two overlapping tiles open each missing window once', async () => {
    const [x, y] = await Promise.all([tileWindows(['a', 'b'], 'columns'), tileWindows(['a', 'b'], 'rows')]);
    expect(x.ok && y.ok).toBe(true);
    expect(desktop.openVaultWindow.mock.calls.map(([v]) => v)).toEqual(['a', 'b']);
    // The second tile found both windows and moved them together.
    const frameCalls = core.invoke.mock.calls.filter(([cmd]) => cmd === 'set_frames');
    expect(frameCalls).toHaveLength(1);
    expect((frameCalls[0][1] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('lands in one frame under reduced motion', async () => {
    reducedMotion(true);
    windows.set('vault-a', makeWin('vault-a'));
    await tileWindows(['a'], 'columns');
    expect(core.invoke).toHaveBeenCalledWith('set_frames', expect.objectContaining({ animateMs: 0 }));
  });
});

describe('Notch seats (source scan)', () => {
  const src = readFileSync(join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/assistant/Notch.tsx'), 'utf-8');
  const body = (name: string) => {
    const start = src.indexOf(name);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n}\n', start));
  };

  it('the notch seat (dock, expand/collapse) clears the min size; the window seat (pop-out) sets window-seat', () => {
    expect(body('async function seat(')).toMatch(/applyFrame\(f, ms, 'clear'\)/);
    expect(body('async function seatWindow(')).toMatch(/applyFrame\(f, ms, 'window-seat'\)/);
  });

  it('never moves the window with setSize/setPosition — every frame goes through setFrames', () => {
    expect(src).not.toMatch(/\.setSize\(|\.setPosition\(/);
    expect(src).toMatch(/withFlight\(async \(\) => setFrames\(/);
  });

  it('autoPop and goHome land their frame in one step (0ms) behind the CSS animation', () => {
    const autoPop = src.slice(src.indexOf('const autoPop'), src.indexOf('const goHome'));
    const goHome = src.slice(src.indexOf('const goHome'), src.indexOf('const wasActive'));
    expect(autoPop).toMatch(/seatWindow\([^;]*, false, 0, gen\)/);
    expect(goHome).toMatch(/seat\(false, geo, 0, gen\)/);
  });

  it('pop-out and dock claim their seat change at the click, so the later one always wins', () => {
    const popOut = src.slice(src.indexOf('const popOut'), src.indexOf('const dock'));
    const dock = src.slice(src.indexOf('const dock'), src.indexOf('WHILE IT WORKS'));
    expect(popOut).toMatch(/const gen = claimSeat\(null\);[\s\S]*seatWindow\([^;]*frameMotionMs\(\), gen\)/);
    expect(dock).toMatch(/const gen = claimSeat\(null\);[\s\S]*seat\(true, geo, frameMotionMs\(\), gen\)/);
  });
});
