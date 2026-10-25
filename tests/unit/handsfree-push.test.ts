// Hands-free Mac mode push: the crypto (AC6) and the subscription store and routes (AC7).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { encryptAes128gcm, loadOrCreateVapid, sendPush, vapidJwt, VAPID_MAX_AGE_S, type FetchLike } from '../../src/lib/handsfree/mac/push.js';
import { PushStore, setVerifyPushOrigin, subscriptionRefusal } from '../../src/lib/handsfree/mac/push-store.js';
import * as auth from '../../src/server/handsfree-auth.js';
import { armPushNotifier, handsfreePushRoutes, setPushForTests } from '../../src/server/routes/handsfree-mac.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';

const b64u = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

// RFC 8291 Appendix A (whitespace removed).
const VEC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

describe('RFC 8291 aes128gcm (AC6)', () => {
  it('reproduces Appendix A exactly', () => {
    const out = encryptAes128gcm({ p256dh: VEC.uaPublic, auth: VEC.auth }, b64u(VEC.plaintext), { asPrivate: b64u(VEC.asPrivate), salt: b64u(VEC.salt) });
    expect(out.subarray(0, 86).toString('base64url')).toBe(VEC.header);
    expect(out.subarray(86).toString('base64url')).toBe(VEC.ciphertext);
  });

  it('refuses a malformed subscription key and an oversized payload', () => {
    expect(() => encryptAes128gcm({ p256dh: 'AAAA', auth: VEC.auth }, Buffer.from('x'))).toThrow();
    expect(() => encryptAes128gcm({ p256dh: VEC.uaPublic, auth: 'AAAA' }, Buffer.from('x'))).toThrow();
    expect(() => encryptAes128gcm({ p256dh: VEC.uaPublic, auth: VEC.auth }, Buffer.alloc(5000))).toThrow();
  });
});

describe('VAPID (AC6) and the key file (AC7)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'push-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the JWT verifies with the stored public key; aud is the endpoint origin; exp <= 12 h', () => {
    const keys = loadOrCreateVapid(dir);
    const now = 1_800_000_000;
    const jwt = vapidJwt(keys, 'https://web.push.apple.com', 'https://phone.example.com', now);
    const [h, c, sig] = jwt.split('.');
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims.aud).toBe('https://web.push.apple.com');
    expect(claims.exp - now).toBeLessThanOrEqual(12 * 3600);
    expect(VAPID_MAX_AGE_S).toBe(12 * 3600);
  });

  it('vapid.json is 0600, and the same pair comes back on the next load', () => {
    const a = loadOrCreateVapid(dir);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'vapid.json')).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(loadOrCreateVapid(dir)).toEqual(a);
  });
});

const GOOD = { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH2', keys: { p256dh: VEC.uaPublic, auth: VEC.auth } };
const HASH = 'a'.repeat(64);

describe('the subscription store (AC7)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'push-store-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts the real push services only: https, the default port, an exact host or the Windows suffix', () => {
    expect(subscriptionRefusal(GOOD)).toBeNull();
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://db5p.notify.windows.com/w/?token=x', 'https://web.push.apple.com:443/x']) {
      expect(subscriptionRefusal({ ...GOOD, endpoint }), endpoint).toBeNull();
    }
    for (const endpoint of [
      'http://web.push.apple.com/x', 'https://web.push.apple.com:8443/x', 'https://evilnotify.windows.com/x', 'https://notify.windows.com/x',
      'https://web.push.apple.com.evil.example/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://user:pw@web.push.apple.com/x', 'not a url',
    ]) expect(subscriptionRefusal({ ...GOOD, endpoint }), endpoint).not.toBeNull();
    expect(subscriptionRefusal({ ...GOOD, keys: { p256dh: 'short', auth: VEC.auth } })).not.toBeNull();
    expect(subscriptionRefusal({ ...GOOD, keys: { p256dh: VEC.uaPublic, auth: 'short' } })).not.toBeNull();
    expect(subscriptionRefusal(null)).not.toBeNull();
  });

  it('the verify-only origin is closed unless set, and then admits that exact origin only', () => {
    const local = { ...GOOD, endpoint: 'http://127.0.0.1:4555/push/x' };
    expect(subscriptionRefusal(local)).not.toBeNull();
    setVerifyPushOrigin('http://127.0.0.1:4555');
    try {
      expect(subscriptionRefusal(local)).toBeNull();
      expect(subscriptionRefusal({ ...GOOD, endpoint: 'http://127.0.0.1:4556/push/x' })).not.toBeNull();
      expect(subscriptionRefusal({ ...local, keys: { p256dh: 'short', auth: VEC.auth } })).not.toBeNull();
    } finally { setVerifyPushOrigin(null); }
    expect(subscriptionRefusal(local)).not.toBeNull();
  });

  it('push.json is 0600; one subscription per device; a signed-out device is pruned', () => {
    const s = new PushStore({ dir });
    s.put(HASH, GOOD);
    s.put(HASH, { ...GOOD, endpoint: 'https://fcm.googleapis.com/fcm/send/y' });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'push.json')).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(s.entries()).toHaveLength(1);
    expect(new PushStore({ dir }).get(HASH)?.endpoint).toBe('https://fcm.googleapis.com/fcm/send/y');
    s.put('b'.repeat(64), GOOD);
    expect(s.prune((h) => h === HASH)).toBe(1);
    expect(s.entries().map(([h]) => h)).toEqual([HASH]);
    expect(s.remove(HASH)).toBe(true);
    expect(s.entries()).toEqual([]);
  });
});

describe('sendPush (AC7)', () => {
  const vapidDir = mkdtempSync(join(tmpdir(), 'push-send-'));
  const vapid = loadOrCreateVapid(vapidDir);
  const sub = { endpoint: GOOD.endpoint, p256dh: GOOD.keys.p256dh, auth: GOOD.keys.auth };

  it('posts an aes128gcm body with the VAPID header, never following a redirect', async () => {
    let seen: Parameters<FetchLike> | null = null;
    const out = await sendPush(sub, { kind: 'turn' }, { vapid, contact: 'https://phone.example.com', fetchImpl: async (...a) => { seen = a; return { status: 201 }; } });
    expect(out).toEqual({ ok: true, status: 201, gone: false });
    const [url, init] = seen!;
    expect(url).toBe(GOOD.endpoint);
    expect(init.redirect).toBe('manual');
    expect(init.headers['Content-Encoding']).toBe('aes128gcm');
    expect(init.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(init.headers.Urgency).toBe('high');
  });

  it('404/410 says gone, and 403 (a subscription made for another VAPID key); a redirect, a 5xx or a throw is a failure, never an exception', async () => {
    expect((await sendPush(sub, {}, { vapid, contact: 'x', fetchImpl: async () => ({ status: 410 }) })).gone).toBe(true);
    expect((await sendPush(sub, {}, { vapid, contact: 'x', fetchImpl: async () => ({ status: 404 }) })).gone).toBe(true);
    expect(await sendPush(sub, {}, { vapid, contact: 'x', fetchImpl: async () => ({ status: 403 }) })).toEqual({ ok: false, status: 403, gone: true });
    expect(await sendPush(sub, {}, { vapid, contact: 'x', fetchImpl: async () => ({ status: 302 }) })).toEqual({ ok: false, status: 302, gone: false });
    expect(await sendPush(sub, {}, { vapid, contact: 'x', fetchImpl: async () => ({ status: 503 }) })).toEqual({ ok: false, status: 503, gone: false });
    expect(await sendPush(sub, {}, { vapid, contact: 'x', fetchImpl: async () => { throw new TypeError('net'); } })).toEqual({ ok: false, status: null, gone: false, error: 'TypeError' });
  });
});

describe('the push routes (AC7): the device comes from the cookie, a signed-out device loses its subscription', { timeout: 60_000 }, () => {
  let home: string;
  const saved = process.env.HOME;

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'push-routes-')); process.env.HOME = home; });
  afterEach(async () => {
    auth.setMacHandsfreeAuthForTests(null);
    setPushForTests({ store: null, vapid: null, send: null });
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  function call(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, req: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve) => {
      let status = 0;
      const res = {
        setHeader() {}, writeHead(c: number) { status = c; return res; },
        end(b?: string) { resolve({ status, body: b ? JSON.parse(b) : {} }); },
      } as unknown as ServerResponse;
      void handler(req, res);
    });
  }

  it('subscribe stores under the cookie device; logout, revoke-all and a password change drop it', async () => {
    const mac = new auth.HandsfreeAuth({ dir: join(home, 'mac') });
    (await import('node:fs')).mkdirSync(join(home, 'mac'), { recursive: true });
    mac.store.setPassphrase(await auth.hashPassphrase('a b c d e f'));
    auth.setMacHandsfreeAuthForTests(mac);
    const store = new PushStore({ dir: join(home, 'mac') });
    setPushForTests({ store });
    armPushNotifier();

    const sock = {};
    markPhoneSocket(sock);
    const subscribe = async (id: string, body: unknown = { ...GOOD, deviceHash: 'f'.repeat(64) }) => {
      const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
      Object.assign(r, { method: 'PUT', url: '/api/handsfree/push/subscription', socket: sock, headers: { cookie: `${auth.DEVICE_COOKIE}=${id}` } });
      return call(handsfreePushRoutes.subscribe, r);
    };

    const a = mac.store.createDevice('iPhone');
    const b = mac.store.createDevice('iPad');
    expect((await subscribe(a)).status).toBe(200);
    expect((await subscribe(b)).status).toBe(200);
    // Keyed by the COOKIE's device, whatever the body says.
    expect(store.entries().map(([h]) => h).sort()).toEqual([auth.sha256Hex(a), auth.sha256Hex(b)].sort());
    expect(store.get('f'.repeat(64))).toBeNull();
    // Refused: a bad endpoint, a too-large body, no cookie, a desktop socket.
    expect((await subscribe(a, { ...GOOD, endpoint: 'https://evilnotify.windows.com/x' })).status).toBe(400);
    expect((await subscribe(a, { ...GOOD, pad: 'x'.repeat(5000) })).status).toBe(400);
    expect((await subscribe('nope')).status).toBe(404);

    // Logout of one device drops ITS subscription only.
    const res = { setHeader() {}, writeHead() { return res; }, end() {} } as never;
    auth.handleHandsfreeLogout({ socket: sock, headers: { cookie: `${auth.DEVICE_COOKIE}=${a}` } } as unknown as IncomingMessage, res);
    expect(store.entries().map(([h]) => h)).toEqual([auth.sha256Hex(b)]);
    // Revoke-all drops the rest.
    mac.store.revokeAllLocal();
    expect(store.entries()).toEqual([]);
    // A password change too.
    const c = mac.store.createDevice('iPhone');
    expect((await subscribe(c)).status).toBe(200);
    mac.store.setPassphrase(await auth.hashPassphrase('g h i j k l'));
    expect(store.entries()).toEqual([]);
  });

  it('the key route answers the VAPID public key to a signed-in phone only', async () => {
    const mac = new auth.HandsfreeAuth({ dir: join(home, 'mac') });
    (await import('node:fs')).mkdirSync(join(home, 'mac'), { recursive: true });
    auth.setMacHandsfreeAuthForTests(mac);
    const vapid = loadOrCreateVapid(join(home, 'mac'));
    setPushForTests({ vapid });
    const id = mac.store.createDevice('iPhone');
    const sock = {};
    markPhoneSocket(sock);
    const ok = await call(handsfreePushRoutes.key, { method: 'GET', socket: sock, headers: { cookie: `${auth.DEVICE_COOKIE}=${id}` } } as unknown as IncomingMessage);
    expect(ok).toEqual({ status: 200, body: { publicKey: vapid.publicKey } });
    const desk = await call(handsfreePushRoutes.key, { method: 'GET', socket: {}, headers: { cookie: `${auth.DEVICE_COOKIE}=${id}` } } as unknown as IncomingMessage);
    expect(desk.status).toBe(404);
  });
});
