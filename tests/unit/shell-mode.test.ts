/**
 * The new shell's gate (task codex-tarzi-yeni-kabuk W1, D2): settled ONCE per window from the
 * server, then frozen; classic whatever the switch says on the phone, on Mac mode's tunnel, and
 * when the server cannot answer. The layout writes are server-only and debounced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const env = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  gets: 0,
  posts: [] as unknown[],
  failGet: false,
  mobile: false,
  macPhone: false,
}));

vi.mock('../../dashboard/src/api/client.js', () => ({
  api: {
    get: async () => { env.gets += 1; if (env.failGet) throw new Error('offline'); return { view: 'list', ...env.stored }; },
    post: async (_p: string, body: Record<string, unknown>) => { env.posts.push(body); env.stored = { ...env.stored, ...body }; return { view: 'list', ...env.stored }; },
  },
}));
vi.mock('../../dashboard/src/hooks/useIsMobile.js', () => ({ readIsMobile: () => env.mobile }));
vi.mock('../../dashboard/src/lib/phoneSurface.js', () => ({ isMacPhoneSurface: () => env.macPhone }));

const prefs = await import('../../dashboard/src/lib/launcherPrefs.js');
const ux = await import('../../dashboard/src/lib/uxMode.js');

beforeEach(() => {
  (globalThis as any).window = globalThis;
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => {} };
  Object.assign(env, { stored: {}, gets: 0, posts: [], failGet: false, mobile: false, macPhone: false });
  prefs.resetLauncherPrefsForTests();
  ux.resetShellModeForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe('shell gate', () => {
  it('is unsettled (null) until the server answers, then frozen', async () => {
    env.stored = { shell: 'new' };
    expect(ux.readShellModeFrozen()).toBeNull();
    expect(await ux.settleShellMode()).toBe('new');
    env.stored = { shell: 'classic' };
    expect(await ux.settleShellMode()).toBe('new');
    expect(ux.readShellModeFrozen()).toBe('new');
    expect(env.gets).toBe(1);
  });

  it('never chosen = the default (classic before W3)', async () => {
    expect(ux.DEFAULT_SHELL).toBe('classic');
    expect(await ux.settleShellMode()).toBe('classic');
  });

  it('a failed read settles classic', async () => {
    env.stored = { shell: 'new' };
    env.failGet = true;
    expect(await ux.settleShellMode()).toBe('classic');
  });

  it('a server that never answers settles classic after the cap, never a blank window', async () => {
    vi.useFakeTimers();
    env.stored = { shell: 'new' };
    const hang = vi.spyOn((await import('../../dashboard/src/api/client.js')).api, 'get').mockImplementation(() => new Promise(() => {}));
    const settled = ux.settleShellMode();
    await vi.advanceTimersByTimeAsync(ux.SETTLE_CAP_MS + 10);
    expect(await settled).toBe('classic');
    hang.mockRestore();
  });

  it('classic on the phone, without asking the server', async () => {
    env.stored = { shell: 'new' };
    env.mobile = true;
    expect(await ux.settleShellMode()).toBe('classic');
    expect(env.gets).toBe(0);
  });

  it('classic on Mac mode\'s tunnel (the Mac phone surface, a remote computer included)', async () => {
    env.stored = { shell: 'new' };
    env.macPhone = true;
    expect(await ux.settleShellMode()).toBe('classic');
  });

  it('no provider (notch, viewer, inbox, checklist windows) reads classic', () => {
    const Probe = () => createElement('i', null, ux.useShellMode());
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<i>classic</i>');
    expect(renderToStaticMarkup(createElement(ux.ShellModeContext.Provider, { value: 'new' }, createElement(Probe)))).toBe('<i>new</i>');
  });

  it('the provider draws nothing while pending, so no window paints one shell then swaps', () => {
    expect(renderToStaticMarkup(createElement(ux.ShellModeProvider, null, createElement('b', null, 'x')))).toBe('');
  });
});

describe('the Settings switch and the layout writes', () => {
  it('writeShellMode returns what the server stored', async () => {
    expect(await prefs.writeShellMode('new')).toBe('new');
    expect(env.posts).toEqual([{ shell: 'new' }]);
  });

  it('layout writes are debounced into one POST that carries only layout keys', async () => {
    vi.useFakeTimers();
    prefs.writeLayoutPrefs({ lastVault: 'acme' });
    prefs.writeLayoutPrefs({ lastVault: 'globex' });
    prefs.writeLayoutPrefs({ drawerOpen: false });
    expect(env.posts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(prefs.LAYOUT_WRITE_DEBOUNCE_MS + 10);
    expect(env.posts).toEqual([{ lastVault: 'globex', drawerOpen: false }]);
    expect(env.posts[0]).not.toHaveProperty('shell');
    expect(prefs.readLayoutPrefs().lastVault).toBe('globex');
  });
});
