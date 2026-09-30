/**
 * Where a clicked `dreamcontext://` link goes (`routeAppLink`) and how a window drains the
 * shell's take-once queue (`drainAppLinks`). The owner's rule: the EXISTING window and tab of
 * that project, never a duplicate; a document additionally opens in the small viewer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../dashboard/src/lib/desktop', () => ({
  isDesktop: () => false,
  openInboxWindow: vi.fn(), openVaultWindow: vi.fn(), openViewerWindow: vi.fn(),
  vaultWindowLabel: (v: string) => `vault-${v}`,
}));
vi.mock('../../dashboard/src/lib/windowRegistry', () => ({ thisWindowLabel: async () => '', resolveLiveWindowForVault: async () => null }));

const {
  routeAppLink, drainAppLinks, isAppLinkRouterWindow, APP_LINK_OPEN_EVENT, buildAppLink,
} = await import('../../dashboard/src/lib/appLink');
type Deps = import('../../dashboard/src/lib/appLink').AppLinkRouteDeps;

let calls: string[];
let where: { live: string[]; cold: string | null };
let own: 'focused' | 'created' | 'browser';
let emitFails: Set<string>;

function deps(): Deps {
  return {
    findOpenProject: vi.fn(async () => where),
    emitTo: vi.fn(async (label: string, event: string, payload: unknown) => {
      if (emitFails.has(label)) throw new Error('gone');
      calls.push(`emit ${label} ${event} ${(payload as { link: string }).link}`);
    }),
    openVaultWindow: vi.fn(async (vault: string, opts: { open: string }) => { calls.push(`window ${vault} ${opts.open}`); return own; }),
    vaultWindowLabel: (v: string) => `vault-${v}`,
    openViewerWindow: vi.fn(async (vault: string, path: string) => { calls.push(`viewer ${vault} ${path}`); }),
    openInboxWindow: vi.fn(async () => { calls.push('inbox'); }),
  };
}

beforeEach(() => {
  calls = [];
  where = { live: [], cold: null };
  own = 'created';
  emitFails = new Set();
});

const session = buildAppLink({ kind: 'session', vault: 'Öğrenim', claudeId: 'abcdefgh-1234' });
const withFile = buildAppLink({ kind: 'automation', vault: 'acme', slug: 'brief', file: 'automations/output/brief/r.md' });

describe('routeAppLink', () => {
  it('a live tab holds the project: the link goes THERE, no window is built', async () => {
    where = { live: ['main', 'vault-x'], cold: 'vault-y' };
    expect(await routeAppLink(session, deps())).toEqual({ to: 'holder', label: 'main', viewer: null });
    expect(calls).toEqual([`emit main ${APP_LINK_OPEN_EVENT} ${session}`]);
  });

  it('only a cold chip holds it: that window wakes it', async () => {
    where = { live: [], cold: 'vault-y' };
    await routeAppLink(session, deps());
    expect(calls).toEqual([`emit vault-y ${APP_LINK_OPEN_EVENT} ${session}`]);
  });

  it('nobody holds it: its own window is built carrying the link', async () => {
    expect(await routeAppLink(session, deps())).toEqual({ to: 'window', vault: 'Öğrenim', built: true, viewer: null });
    expect(calls).toEqual([`window Öğrenim ${session}`]);
  });

  it('the lookups missed an own window that exists: it is focused AND handed the link by event', async () => {
    own = 'focused';
    await routeAppLink(session, deps());
    expect(calls).toEqual([`window Öğrenim ${session}`, `emit vault-Öğrenim ${APP_LINK_OPEN_EVENT} ${session}`]);
  });

  it('the holder vanished between lookup and emit: falls through to its own window', async () => {
    where = { live: ['vault-gone'], cold: null };
    emitFails.add('vault-gone');
    await routeAppLink(session, deps());
    expect(calls).toEqual([`window Öğrenim ${session}`]);
  });

  it('an automation with a document: the project lands first, then the document opens in the viewer', async () => {
    where = { live: ['vault-acme'], cold: null };
    const out = await routeAppLink(withFile, deps());
    expect(out).toEqual({ to: 'holder', label: 'vault-acme', viewer: '_dream_context/automations/output/brief/r.md' });
    expect(calls).toEqual([
      `emit vault-acme ${APP_LINK_OPEN_EVENT} ${withFile}`,
      'viewer acme _dream_context/automations/output/brief/r.md',
    ]);
  });

  it('an automation with a document and no holder: own window, then viewer', async () => {
    await routeAppLink(withFile, deps());
    expect(calls).toEqual([`window acme ${withFile}`, 'viewer acme _dream_context/automations/output/brief/r.md']);
  });

  it('view opens the viewer only; inbox opens the inbox only; garbage does nothing', async () => {
    const d = deps();
    await routeAppLink('dreamcontext://project/acme/view?path=_dream_context%2Fa.md', d);
    await routeAppLink('dreamcontext://inbox', d);
    expect(await routeAppLink('dreamcontext://project/../x', d)).toEqual({ to: 'dropped' });
    expect(calls).toEqual(['viewer acme _dream_context/a.md', 'inbox']);
    expect(d.findOpenProject).not.toHaveBeenCalled();
  });
});

describe('drainAppLinks', () => {
  it('takes until the shell says null, routing each in order', async () => {
    const queue = ['a', 'b'];
    const routed: string[] = [];
    const n = await drainAppLinks(async () => queue.shift() ?? null, async (raw) => { routed.push(raw); });
    expect(n).toBe(2);
    expect(routed).toEqual(['a', 'b']);
  });
  it('an older shell without the command: nothing is taken, nothing throws', async () => {
    const route = vi.fn();
    expect(await drainAppLinks(async () => { throw new Error('command take_app_link not found'); }, route)).toBe(0);
    expect(route).not.toHaveBeenCalled();
  });
  it('one link that fails to route does not stop the next; a runaway queue is capped', async () => {
    const routed: string[] = [];
    const queue = ['bad', 'good'];
    await drainAppLinks(async () => queue.shift() ?? null, async (raw) => { if (raw === 'bad') throw new Error('x'); routed.push(raw); });
    expect(routed).toEqual(['good']);
    expect(await drainAppLinks(async () => 'again', async () => {})).toBe(16);
  });
  it('only the launcher and project windows route', () => {
    expect(isAppLinkRouterWindow('main')).toBe(true);
    expect(isAppLinkRouterWindow('vault-acme')).toBe(true);
    for (const l of ['inbox', 'viewer-1a2b3c4d', 'assistant', 'checklist-x', '']) expect(isAppLinkRouterWindow(l)).toBe(false);
  });
});
