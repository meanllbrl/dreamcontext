// The phone installs Mac mode as an app (AC10) and can zoom (AC17): the manifest, index.html,
// the icons, and which notification step the drawer offers.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pushOptInState, resyncPush, type PushEnv } from '../../dashboard/src/components/handsfree/phone/PushOptIn.js';

const DASH = join(__dirname, '..', '..', 'dashboard');

/** PNG width and height from the IHDR chunk. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('the manifest and index.html (AC10)', () => {
  const manifest = JSON.parse(readFileSync(join(DASH, 'public', 'manifest.webmanifest'), 'utf8')) as {
    id: string; start_url: string; scope: string; display: string; description: string;
    icons: Array<{ src: string; sizes: string; type: string }>;
  };

  it('is standalone, has an id, starts at / and names no cloud machine', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.description).not.toMatch(/cloud/i);
  });

  it('carries real 192 and 512 PNG icons', () => {
    for (const size of [192, 512]) {
      const icon = manifest.icons.find((i) => i.sizes === `${size}x${size}`);
      expect(icon, String(size)).toBeDefined();
      expect(icon!.type).toBe('image/png');
      expect(pngSize(join(DASH, 'public', icon!.src))).toEqual([size, size]);
    }
  });

  it('index.html links the manifest, a 180 apple-touch-icon and the status-bar style', () => {
    const html = readFileSync(join(DASH, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="\/icons\/apple-touch-icon-180.png" \/>/);
    expect(pngSize(join(DASH, 'public', 'icons', 'apple-touch-icon-180.png'))).toEqual([180, 180]);
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
    expect(existsSync(join(DASH, 'public', 'icons', 'icon-192.png'))).toBe(true);
  });
});

describe('pinch zoom is not blocked (AC17)', () => {
  it('the viewport meta allows scaling', () => {
    const html = readFileSync(join(DASH, 'index.html'), 'utf8');
    const meta = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(meta).toContain('width=device-width');
    expect(meta).not.toMatch(/maximum-scale\s*=\s*1(\.0)?\b|user-scalable\s*=\s*(no|0)/i);
  });
});

describe('the drawer\'s notification step (AC10)', () => {
  const base: PushEnv = { phone: true, hostname: 'phone.example.com', standalone: true, pushSupported: true, permission: 'default', subscribed: false };

  it('Safari tab: add to Home Screen; installed: the button; on; blocked', () => {
    expect(pushOptInState({ ...base, standalone: false })).toBe('install');
    expect(pushOptInState(base)).toBe('off');
    expect(pushOptInState({ ...base, permission: 'granted', subscribed: true })).toBe('on');
    expect(pushOptInState({ ...base, permission: 'granted', subscribed: false })).toBe('off');
    expect(pushOptInState({ ...base, permission: 'denied' })).toBe('blocked');
  });

  it('a quick tunnel address says notifications need a fixed address (no button), even installed', () => {
    expect(pushOptInState({ ...base, hostname: 'quiet-lake-1234.trycloudflare.com' })).toBe('quick');
    expect(pushOptInState({ ...base, hostname: 'quiet-lake-1234.trycloudflare.com', standalone: false })).toBe('quick');
  });

  it('nothing off the phone, and nothing for a browser without web push', () => {
    expect(pushOptInState({ ...base, phone: false })).toBe('hidden');
    expect(pushOptInState({ ...base, pushSupported: false })).toBe('hidden');
  });
});

// The Mac drops a device's subscription on Return, logout, a revoke and a new sign-in (a new device
// id), and a new VAPID pair kills the old one: "on" must mean the Mac holds THIS device's copy.
describe('resyncPush: the app hands its subscription back to the Mac on every start', () => {
  const KEY = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i));
  const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
  const OLD = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 200 - i));

  function stand(opts: { permission?: string; sub?: Uint8Array | null; putStatus?: number; keyStatus?: number }) {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const mk = (key: Uint8Array, tag: string) => ({
      options: { applicationServerKey: key.buffer.slice(0) },
      unsubscribe: vi.fn(async () => { current = null; return true; }),
      toJSON: () => ({ endpoint: `https://web.push.apple.com/${tag}`, keys: { p256dh: 'p', auth: 'a' } }),
    });
    let current: ReturnType<typeof mk> | null = opts.sub ? mk(opts.sub, opts.sub === OLD ? 'old' : 'cur') : null;
    const subscribe = vi.fn(async (o: { applicationServerKey: Uint8Array }) => { current = mk(new Uint8Array(o.applicationServerKey), 'new'); return current; });
    const reg = { pushManager: { getSubscription: async () => current, subscribe } };
    vi.stubGlobal('window', { PushManager: {}, Notification: {} });
    vi.stubGlobal('Notification', { permission: opts.permission ?? 'granted' });
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => reg } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      if (url.endsWith('/push/key')) return { ok: (opts.keyStatus ?? 200) === 200, json: async () => ({ publicKey: b64u(KEY) }) };
      return { ok: (opts.putStatus ?? 200) === 200 };
    }));
    return { calls, subscribe, sub: () => current };
  }
  afterEach(() => { vi.unstubAllGlobals(); });

  it('already subscribed for the current key: PUTs that same subscription, and says on', async () => {
    const s = stand({ sub: KEY });
    expect(await resyncPush()).toBe(true);
    const put = s.calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/api/handsfree/push/subscription');
    expect(JSON.parse(put!.body!).endpoint).toBe('https://web.push.apple.com/cur');
    expect(s.subscribe).not.toHaveBeenCalled();
  });

  it('a subscription made for an older key is replaced, and the NEW one goes to the Mac', async () => {
    const s = stand({ sub: OLD });
    expect(await resyncPush()).toBe(true);
    expect(s.subscribe).toHaveBeenCalledTimes(1);
    expect(Array.from(new Uint8Array(s.subscribe.mock.calls[0][0].applicationServerKey))).toEqual(Array.from(KEY));
    expect(JSON.parse(s.calls.find((c) => c.method === 'PUT')!.body!).endpoint).toBe('https://web.push.apple.com/new');
  });

  it('the Mac refusing the copy, or no key, says off (the row offers the button again)', async () => {
    stand({ sub: KEY, putStatus: 500 });
    expect(await resyncPush()).toBe(false);
    vi.unstubAllGlobals();
    stand({ sub: KEY, keyStatus: 404 });
    expect(await resyncPush()).toBe(false);
  });

  it('never subscribes on its own: no browser subscription, or no permission, is off with no request', async () => {
    let s = stand({ sub: null });
    expect(await resyncPush()).toBe(false);
    expect(s.calls).toEqual([]);
    expect(s.subscribe).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    s = stand({ sub: KEY, permission: 'default' });
    expect(await resyncPush()).toBe(false);
    expect(s.calls).toEqual([]);
  });
});
