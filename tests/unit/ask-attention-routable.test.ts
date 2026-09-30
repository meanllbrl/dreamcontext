/**
 * The "Claude is asking" banner is posted ROUTABLE first: `POST /api/notify` with a link to the
 * exact chat, falling back to the Tauri notification plugin only when the server did not post.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const desktop = vi.hoisted(() => ({
  isDesktop: vi.fn(() => true),
  bounceDockIcon: vi.fn(async () => {}),
  sendDesktopNotification: vi.fn(async () => true),
  openInboxWindow: vi.fn(), openVaultWindow: vi.fn(), openViewerWindow: vi.fn(),
  vaultWindowLabel: (v: string) => `vault-${v}`,
}));
vi.mock('../../dashboard/src/lib/desktop', () => desktop);
vi.mock('../../dashboard/src/lib/windowRegistry', () => ({ thisWindowLabel: async () => '', resolveLiveWindowForVault: async () => null }));
vi.mock('../../dashboard/src/lib/chime.js', () => ({ playAskChime: vi.fn() }));

const { raiseAskAttention, askAlarmLink } = await import('../../dashboard/src/lib/attention');

let posts: Array<{ title: string; body: string; link?: string }>;
let answer: () => Promise<Response>;
let n = 0;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  desktop.isDesktop.mockReturnValue(true);
  posts = [];
  answer = async () => ({ ok: true, json: async () => ({ posted: true }) }) as Response;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    expect(url).toBe('/api/notify');
    posts.push(JSON.parse(init.body));
    return answer();
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A fresh source each time so the per-project throttle never swallows a case. */
const vault = () => `proj-${++n}`;
const ID = '0b1d3c97-6daf-4943-96d5-8614e7d0960e';

describe('ask banner', () => {
  it('posted by the server: one routable banner to the exact chat, the plugin untouched', async () => {
    const v = vault();
    raiseAskAttention({ source: v, detail: 'Pick one', sessionId: ID });
    await flush();
    expect(posts).toEqual([{ title: `Claude is asking · ${v}`, body: 'Pick one', link: `dreamcontext://project/${v}/session/${ID}` }]);
    expect(desktop.sendDesktopNotification).not.toHaveBeenCalled();
  });

  it('server says posted:false: falls back to the Tauri plugin', async () => {
    answer = async () => ({ ok: true, json: async () => ({ posted: false }) }) as Response;
    raiseAskAttention({ source: vault(), sessionId: ID });
    await flush();
    expect(posts).toHaveLength(1);
    expect(desktop.sendDesktopNotification).toHaveBeenCalledTimes(1);
  });

  it('the request fails or is refused: falls back to the Tauri plugin', async () => {
    answer = async () => { throw new Error('offline'); };
    raiseAskAttention({ source: vault() });
    await flush();
    answer = async () => ({ ok: false, json: async () => ({}) }) as Response;
    raiseAskAttention({ source: vault() });
    await flush();
    expect(desktop.sendDesktopNotification).toHaveBeenCalledTimes(2);
  });

  it('off desktop no request is made (the route is desktop-gated)', async () => {
    desktop.isDesktop.mockReturnValue(false);
    raiseAskAttention({ source: vault() });
    await flush();
    expect(posts).toHaveLength(0);
    expect(desktop.sendDesktopNotification).toHaveBeenCalledTimes(1);
  });

  it('link: session when the id is known, project otherwise, none for a hidden or missing vault', () => {
    expect(askAlarmLink({ source: 'Öğrenim', sessionId: ID })).toBe(`dreamcontext://project/%C3%96%C4%9Frenim/session/${ID}`);
    expect(askAlarmLink({ source: 'acme' })).toBe('dreamcontext://project/acme');
    expect(askAlarmLink({ source: 'acme', sessionId: '../../x' })).toBe('dreamcontext://project/acme');
    expect(askAlarmLink({ source: '__assistant__', sessionId: ID })).toBeNull();
    expect(askAlarmLink({})).toBeNull();
  });
});
