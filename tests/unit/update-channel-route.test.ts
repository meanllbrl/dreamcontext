/**
 * Settings → "Beta programı" (plan npmsiz-beta C10): GET reads the channel and whether the build
 * in place stays until stable passes it; POST is the owner's own click in the app (owner key) and
 * takes only `{channel: "stable"|"beta"}`. The phone (Mac mode) is refused both (`deny(INSTALL)`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  handleLauncherUpdateChannelGet, handleLauncherUpdateChannelPost, resetStableVersionCache, updateChannelView,
} from '../../src/server/routes/launcher.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { readUpdateChannel, setUpdateChannel, updateChannelPath } from '../../src/lib/update-channel.js';
import { ROUTE_POLICY } from '../../src/lib/handsfree/mac/route-policy.js';

const KEY = 'c3'.repeat(32);
const PORT = 4173;
const OWNER_CLICK = {
  host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin',
  'content-type': 'application/json', [OWNER_KEY_HEADER]: KEY,
};
type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string | null) => Promise<void>;

let home: string;
const saved = { HOME: process.env.HOME, DESKTOP: process.env.DREAMCONTEXT_DESKTOP, APPV: process.env.DREAMCONTEXT_APP_VERSION };
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-channel-route-'));
  process.env.HOME = home;
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterAll(() => {
  setOwnerKey(null);
  for (const [k, v] of [['HOME', saved.HOME], ['DREAMCONTEXT_DESKTOP', saved.DESKTOP], ['DREAMCONTEXT_APP_VERSION', saved.APPV]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => { setOwnerKey(KEY); resetStableVersionCache(); rmSync(updateChannelPath(home), { force: true }); });

function req(method: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url: '/', headers, socket: { remoteAddress: '127.0.0.1', setTimeout() {} }, setTimeout() {},
  }) as unknown as IncomingMessage;
}
async function call(h: Handler, method: string, headers: Record<string, string>, body?: unknown) {
  let status = 0;
  let out: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; }, setHeader() {},
    end(data?: string) { try { out = JSON.parse(String(data)); } catch { out = {}; } },
  } as unknown as ServerResponse;
  await h(req(method, headers, body), res, {}, null);
  return { status, body: out };
}

describe('POST /api/launcher/update-channel', () => {
  it('the owner\'s click turns Beta on and off, writing the one record', async () => {
    const on = await call(handleLauncherUpdateChannelPost, 'POST', OWNER_CLICK, { channel: 'beta' });
    expect(on.status).toBe(200);
    expect(on.body.channel).toBe('beta');
    expect(readUpdateChannel(home)).toBe('beta');
    const off = await call(handleLauncherUpdateChannelPost, 'POST', OWNER_CLICK, { channel: 'stable' });
    expect(off.body.channel).toBe('stable');
    expect(JSON.parse(readFileSync(updateChannelPath(home), 'utf-8'))).toEqual({ channel: 'stable' });
  });

  it('refuses an agent\'s loopback call without the owner key, and writes nothing', async () => {
    const { [OWNER_KEY_HEADER]: _k, ...noKey } = OWNER_CLICK;
    for (const headers of [noKey, { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json' }, { ...OWNER_CLICK, [OWNER_KEY_HEADER]: 'd4'.repeat(32) }]) {
      const r = await call(handleLauncherUpdateChannelPost, 'POST', headers, { channel: 'beta' });
      expect(r.status).toBe(403);
      expect(r.body.error === 'owner_page_only' || r.body.error === 'forbidden').toBe(true);
    }
    expect(existsSync(updateChannelPath(home))).toBe(false);
  });

  it('refuses anything but {channel: stable|beta}: no URL, no extra key, no other name', async () => {
    for (const body of [{ channel: 'nightly' }, { channel: 'beta', url: 'https://evil.example/feed.json' }, { url: 'x' }, {}, 'beta', ['beta']]) {
      const r = await call(handleLauncherUpdateChannelPost, 'POST', OWNER_CLICK, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(existsSync(updateChannelPath(home))).toBe(false);
  });

  it('outside the desktop app it is refused', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    try {
      const r = await call(handleLauncherUpdateChannelPost, 'POST', OWNER_CLICK, { channel: 'beta' });
      expect(r.status).toBe(403);
    } finally { process.env.DREAMCONTEXT_DESKTOP = '1'; }
  });
});

describe('the Beta row\'s view', () => {
  const release = (tag: string) => async () => ({ tag_name: tag });

  it('on Beta: beta, and no stable lookup', async () => {
    setUpdateChannel('beta', home);
    let asked = 0;
    const v = await updateChannelView({ home, env: { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_APP_VERSION: '0.43.0' }, fetchRelease: async () => { asked++; return { tag_name: 'v0.42.0' }; } });
    expect(v).toMatchObject({ channel: 'beta', appVersion: '0.43.0', staysUntilStable: false, desktop: true });
    expect(asked).toBe(0);
  });

  it('off Beta on a build newer than stable: it stays until stable passes it (never a downgrade)', async () => {
    const v = await updateChannelView({ home, env: { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_APP_VERSION: '0.43.0' }, fetchRelease: release('v0.42.9') });
    expect(v).toMatchObject({ channel: 'stable', appVersion: '0.43.0', stableVersion: '0.42.9', staysUntilStable: true });
  });

  it('off Beta once stable caught up: a plain off', async () => {
    const v = await updateChannelView({ home, env: { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_APP_VERSION: '0.43.0' }, fetchRelease: release('v0.43.0') });
    expect(v.staysUntilStable).toBe(false);
  });

  it('offline: no stable version, no "stays" claim', async () => {
    const v = await updateChannelView({ home, env: { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_APP_VERSION: '0.43.0' }, fetchRelease: async () => null });
    expect(v).toMatchObject({ stableVersion: null, staysUntilStable: false });
  });

  // Edge-case review W1 r1 (Minor): one offline moment must not hide the line for 6 h.
  it('a failed lookup is asked again after 5 min; a good answer is kept for 6 h', async () => {
    const env = { DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_APP_VERSION: '0.43.0' };
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(t0);
      let asked = 0;
      const offline = async () => { asked++; throw new Error('offline'); };
      expect((await updateChannelView({ home, env, fetchRelease: offline })).stableVersion).toBeNull();
      now.mockReturnValue(t0 + 4 * 60_000);
      await updateChannelView({ home, env, fetchRelease: offline });
      expect(asked).toBe(1);
      now.mockReturnValue(t0 + 6 * 60_000);
      const v = await updateChannelView({ home, env, fetchRelease: release('v0.42.9') });
      expect(v).toMatchObject({ stableVersion: '0.42.9', staysUntilStable: true });
      now.mockReturnValue(t0 + 5 * 60 * 60_000);
      const kept = await updateChannelView({ home, env, fetchRelease: async () => { asked++; return { tag_name: 'v0.50.0' }; } });
      expect(kept.stableVersion).toBe('0.42.9');
      expect(asked).toBe(1);
    } finally { now.mockRestore(); }
  });

  it('GET answers the same view', async () => {
    process.env.DREAMCONTEXT_APP_VERSION = '0.1.0';
    resetStableVersionCache();
    const r = await call(handleLauncherUpdateChannelGet, 'GET', { host: `127.0.0.1:${PORT}` });
    expect(r.status).toBe(200);
    expect(r.body.channel).toBe('stable');
  });
});

describe('Mac mode (the phone) cannot reach the switch', () => {
  it('both routes are deny(INSTALL)', () => {
    for (const k of ['GET /api/launcher/update-channel', 'POST /api/launcher/update-channel']) {
      const rule = ROUTE_POLICY[k];
      expect(rule, k).toBeDefined();
      expect(rule.allow).toBe(false);
      expect(rule.why).toMatch(/installs, updates or downloads software/);
    }
  });
});
