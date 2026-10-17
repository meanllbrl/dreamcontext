import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  DEVICE_COOKIE,
  DEVICE_TTL_MS,
  HandsfreeAuth,
  HandsfreeAuthStore,
  LoginLimiter,
  deviceCookieHeader,
  effWords,
  generatePassphrase,
  hashPassphrase,
  hasValidDeviceSession,
  isValidVerifier,
  loginClientKey,
  normalizePassphrase,
  setMacHandsfreeAuthForTests,
  sha256Hex,
  verifyPassphrase,
  type ScryptVerifier,
} from '../../src/server/handsfree-auth.js';

let dir: string;
let clock: number;
const now = () => clock;
let verifier: ScryptVerifier;
const PASS = 'abacus zoom yodel t-shirt zebra kettle';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hf-auth-'));
  clock = 1_800_000_000_000;
  verifier ??= await hashPassphrase(PASS);
});

afterEach(() => {
  setMacHandsfreeAuthForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function service(): HandsfreeAuth {
  const auth = new HandsfreeAuth({ dir, now, sleep: async () => {} });
  auth.store.setPassphrase(verifier);
  return auth;
}

// scrypt (N=2^15) is deliberately slow; on a loaded machine these exceed the 5 s default.
describe('passphrase', { timeout: 30_000 }, () => {
  it('uses the full EFF large wordlist', () => {
    const words = effWords();
    expect(words).toHaveLength(7776);
    expect(new Set(words).size).toBe(7776);
    expect(words[0]).toBe('abacus');
    expect(words[7775]).toBe('zoom');
  });

  it('generates six words from that list', () => {
    const list = new Set(effWords());
    const p = generatePassphrase();
    const parts = p.split(' ');
    expect(parts).toHaveLength(6);
    for (const w of parts) expect(list.has(w)).toBe(true);
    expect(generatePassphrase()).not.toBe(p);
  });

  it('verifies through scrypt and forgives phone keyboard spelling', async () => {
    expect(verifier.algo).toBe('scrypt');
    expect(JSON.stringify(verifier)).not.toContain('abacus');
    expect(await verifyPassphrase(PASS, verifier)).toBe(true);
    expect(await verifyPassphrase('  Abacus  ZOOM yodel t shirt zebra-kettle ', verifier)).toBe(true);
    expect(await verifyPassphrase('abacus zoom yodel t-shirt zebra kettles', verifier)).toBe(false);
    expect(normalizePassphrase('A-b  c')).toBe('a b c');
  });

  it('refuses verifiers whose parameters would make a login a DoS', () => {
    expect(isValidVerifier(verifier)).toBe(true);
    expect(isValidVerifier({ ...verifier, N: 1 << 20 })).toBe(false);
    expect(isValidVerifier({ ...verifier, N: 3000 })).toBe(false);
    expect(isValidVerifier({ ...verifier, r: 64 })).toBe(false);
    expect(isValidVerifier(null)).toBe(false);
  });
});

describe('device store', () => {
  it('a new passphrase bumps the generation, signs every device out and survives a restart', () => {
    const store = new HandsfreeAuthStore({ dir, now });
    expect(store.setPassphrase(verifier)).toEqual({ generation: 1 });
    const id = store.createDevice();
    expect(store.isValidDevice(id)).toBe(true);
    expect(store.setPassphrase(verifier)).toEqual({ generation: 2 });
    expect(store.isValidDevice(id)).toBe(false);

    const reloaded = new HandsfreeAuthStore({ dir, now });
    expect(reloaded.generation).toBe(2);
    expect(reloaded.passphraseVerifier).toEqual(verifier);
  });

  it('stores only the sha256 of a device id, for 30 days', () => {
    const store = new HandsfreeAuthStore({ dir, now });
    store.setPassphrase(verifier);
    const id = store.createDevice();
    expect(Buffer.from(id, 'base64url')).toHaveLength(32);
    const file = readFileSync(join(dir, 'auth.json'), 'utf-8');
    expect(file).not.toContain(id);
    expect(file).toContain(sha256Hex(id));

    expect(new HandsfreeAuthStore({ dir, now }).isValidDevice(id)).toBe(true);
    clock += DEVICE_TTL_MS - 1;
    expect(store.isValidDevice(id)).toBe(true);
    clock += 2;
    expect(store.isValidDevice(id)).toBe(false);
  });

  it('forgets one device on logout', () => {
    const store = new HandsfreeAuthStore({ dir, now });
    store.setPassphrase(verifier);
    const a = store.createDevice();
    const b = store.createDevice();
    store.revokeDevice(a);
    expect(store.isValidDevice(a)).toBe(false);
    expect(store.isValidDevice(b)).toBe(true);
  });

  it('reads a corrupt file as no verifiers (fail closed)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'auth.json'), '{not json');
    const store = new HandsfreeAuthStore({ dir, now });
    expect(store.passphraseVerifier).toBeNull();
  });
});

describe('login limiter', () => {
  it('locks a client for 60 s after 5 failures, doubling to 1 h, and survives a restart', () => {
    const lim = new LoginLimiter({ dir, now });
    for (let i = 0; i < 4; i++) lim.recordFailure('xff:1.2.3.4');
    expect(lim.check('xff:1.2.3.4')).toMatchObject({ allowed: true });
    lim.recordFailure('xff:1.2.3.4');
    expect(lim.check('xff:1.2.3.4')).toEqual({ allowed: false, retryAfterMs: 60_000 });

    const restarted = new LoginLimiter({ dir, now });
    expect(restarted.check('xff:1.2.3.4')).toEqual({ allowed: false, retryAfterMs: 60_000 });

    clock += 60_000;
    expect(restarted.check('xff:1.2.3.4')).toMatchObject({ allowed: true });
    restarted.recordFailure('xff:1.2.3.4');
    expect(restarted.check('xff:1.2.3.4')).toEqual({ allowed: false, retryAfterMs: 120_000 });
    for (let i = 0; i < 10; i++) restarted.recordFailure('xff:1.2.3.4');
    expect(restarted.check('xff:1.2.3.4')).toEqual({ allowed: false, retryAfterMs: 3_600_000 });

    // Another client is untouched.
    expect(restarted.check('xff:5.6.7.8')).toMatchObject({ allowed: true });
  });

  it('a success clears the client', () => {
    const lim = new LoginLimiter({ dir, now });
    for (let i = 0; i < 4; i++) lim.recordFailure('k');
    lim.recordSuccess('k');
    lim.recordFailure('k');
    expect(lim.check('k')).toMatchObject({ allowed: true });
  });

  it('past 30 failures an hour slows every attempt but never closes the door', () => {
    const lim = new LoginLimiter({ dir, now });
    for (let i = 0; i < 30; i++) lim.recordFailure(`xff:10.0.0.${i}`);
    expect(lim.check('xff:owner')).toEqual({ allowed: true, delayMs: 0 });
    for (let i = 0; i < 4; i++) lim.recordFailure(`xff:10.0.1.${i}`);
    expect(lim.check('xff:owner')).toEqual({ allowed: true, delayMs: 2000 });
    for (let i = 0; i < 500; i++) lim.recordFailure(`xff:10.1.${i >> 8}.${i & 255}`);
    expect(lim.check('xff:owner')).toEqual({ allowed: true, delayMs: 10_000 });
    clock += 60 * 60_000 + 1;
    expect(lim.check('xff:owner')).toEqual({ allowed: true, delayMs: 0 });
  });

  it('off a phone socket, keys clients on the X-Forwarded-For value', () => {
    const req = (h: Record<string, string>, remote = '127.0.0.1') =>
      ({ headers: h, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;
    expect(loginClientKey(req({ 'x-forwarded-for': '203.0.113.9' }))).toBe('xff:203.0.113.9');
    expect(loginClientKey(req({}))).toBe('direct:127.0.0.1');
  });
});

describe('attemptLogin', { timeout: 30_000 }, () => {
  it('signs in with the passphrase and mints a device session', async () => {
    const auth = service();
    const out = await auth.attemptLogin(PASS, 'xff:1.1.1.1');
    expect(out.ok).toBe(true);
    if (out.ok) expect(auth.store.isValidDevice(out.deviceId)).toBe(true);
  });

  it('checks the limiter before scrypt: a locked client is refused without a verify', async () => {
    const auth = service();
    for (let i = 0; i < 5; i++) {
      expect(await auth.attemptLogin('wrong words', 'xff:9.9.9.9')).toMatchObject({ ok: false, status: 401 });
    }
    // Even the RIGHT passphrase is refused while locked: proof no scrypt ran.
    expect(await auth.attemptLogin(PASS, 'xff:9.9.9.9')).toMatchObject({ ok: false, status: 429, retryAfterMs: 60_000 });
    // The owner from another network is not locked out.
    expect(await auth.attemptLogin(PASS, 'xff:8.8.8.8')).toMatchObject({ ok: true });
  });

  it('applies the global delay through the injected sleep', async () => {
    const slept: number[] = [];
    const auth = new HandsfreeAuth({ dir, now, sleep: async (ms) => { slept.push(ms); } });
    auth.store.setPassphrase(verifier);
    for (let i = 0; i < 31; i++) auth.limiter.recordFailure(`xff:10.0.0.${i}`);
    expect(await auth.attemptLogin(PASS, 'xff:owner')).toMatchObject({ ok: true });
    expect(slept).toEqual([500]);
  });

  it('runs at most two scrypts at once and sheds the excess queue', async () => {
    const auth = service();
    const outs = await Promise.all(Array.from({ length: 24 }, (_, i) => auth.attemptLogin('wrong', `xff:c${i}`)));
    const busy = outs.filter((o) => !o.ok && o.error === 'busy').length;
    const verified = outs.filter((o) => !o.ok && o.error === 'invalid_passphrase').length;
    expect(busy).toBe(24 - 2 - 16);
    expect(verified).toBe(18);
  });

  it('answers not_configured before any verifier was pushed', async () => {
    const auth = new HandsfreeAuth({ dir, now });
    expect(await auth.attemptLogin(PASS, 'k')).toMatchObject({ ok: false, status: 503, error: 'not_configured' });
  });
});

describe('device cookie', () => {
  it('is __Host- prefixed, HttpOnly, Secure, SameSite=Lax, Path=/', () => {
    const h = deviceCookieHeader('abc');
    expect(h.startsWith(`${DEVICE_COOKIE}=abc;`)).toBe(true);
    expect(DEVICE_COOKIE).toBe('__Host-dc_hf_session');
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) expect(h).toContain(part);
    expect(h).not.toContain('Domain=');
  });

  it('hasValidDeviceSession reads the cookie against the Mac store, on a phone socket only', async () => {
    const { markPhoneSocket } = await import('../../src/server/phone-origin.js');
    const auth = service();
    setMacHandsfreeAuthForTests(auth);
    const id = auth.store.createDevice();
    const phone = {};
    markPhoneSocket(phone);
    const req = (cookie?: string, socket: object = phone) => ({ socket, headers: cookie ? { cookie } : {} }) as unknown as IncomingMessage;
    expect(hasValidDeviceSession(req(`other=1; ${DEVICE_COOKIE}=${id}`))).toBe(true);
    expect(hasValidDeviceSession(req(`${DEVICE_COOKIE}=${id}x`))).toBe(false);
    expect(hasValidDeviceSession(req())).toBe(false);
    // The desktop never authenticates by cookie.
    expect(hasValidDeviceSession(req(`${DEVICE_COOKIE}=${id}`, {}))).toBe(false);
  });
});

describe('Mac mode: QR login token (AC4)', () => {
  it('is 256-bit, single-use, kept only as a hash, and a newer mint invalidates the older', async () => {
    const auth = new HandsfreeAuth({ dir, now });
    const t1 = auth.issueLoginToken();
    expect(Buffer.from(t1, 'base64url').length).toBe(32);
    // Only the hash is held: the raw token appears nowhere in the service's state.
    expect(JSON.stringify(auth)).not.toContain(t1);
    const t2 = auth.issueLoginToken();
    expect(auth.consumeLoginToken(t1)).toBe('invalid');
    expect(auth.consumeLoginToken(t2)).toBe('ok');
    expect(auth.consumeLoginToken(t2)).toBe('invalid');
  });

  it('expires after 5 minutes', () => {
    const auth = new HandsfreeAuth({ dir, now });
    const t = auth.issueLoginToken();
    clock += 5 * 60_000;
    expect(auth.consumeLoginToken(t)).toBe('expired');
    expect(auth.consumeLoginToken(t)).toBe('invalid');
  });

  it('a concurrent double-consume yields exactly one ok (lookup and delete are synchronous)', async () => {
    const auth = new HandsfreeAuth({ dir, now });
    const t = auth.issueLoginToken();
    const results = await Promise.all([0, 1, 2, 3].map(() => Promise.resolve().then(() => auth.consumeLoginToken(t))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
  });
});

describe('Mac mode: passphrase, devices and the limiter (AC2/AC5/AC11)', () => {
  it('setPassphrase stores only the scrypt verifier and signs every device out', async () => {
    const auth = new HandsfreeAuth({ dir, now });
    auth.store.setPassphrase(verifier);
    const id = auth.store.createDevice('iPhone · Safari');
    expect(auth.store.isValidDevice(id)).toBe(true);
    const onDisk = readFileSync(join(dir, 'auth.json'), 'utf8');
    expect(onDisk).not.toContain(PASS);
    expect(onDisk).not.toContain(id);
    auth.store.setPassphrase(await hashPassphrase('another six word pass phrase here'));
    expect(auth.store.isValidDevice(id)).toBe(false);
    expect(auth.store.listDevices()).toEqual([]);
  });

  it('lists devices by label, never by id; revokeAllLocal clears them', () => {
    const auth = new HandsfreeAuth({ dir, now });
    auth.store.setPassphrase(verifier);
    const id = auth.store.createDevice('Android · Chrome');
    const list = auth.store.listDevices();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('Android · Chrome');
    expect(JSON.stringify(list)).not.toContain(id);
    expect(auth.store.revokeAllLocal()).toBe(1);
    expect(auth.store.isValidDevice(id)).toBe(false);
  });

  it('a phone socket keys the limiter on cf-connecting-ip and ignores X-Forwarded-For', async () => {
    const { markPhoneSocket } = await import('../../src/server/phone-origin.js');
    const sock = { remoteAddress: '127.0.0.1' };
    markPhoneSocket(sock);
    const r = (h: Record<string, string>) => ({ socket: sock, headers: h }) as unknown as IncomingMessage;
    expect(loginClientKey(r({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' }))).toBe('cf:198.51.100.7');
    expect(loginClientKey(r({ 'x-forwarded-for': '1.2.3.4' }))).toBe('cf:unknown');
    // Off the phone listener nothing changes.
    expect(loginClientKey({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4' } } as unknown as IncomingMessage)).toBe('xff:1.2.3.4');
  });

  it('scrypt never runs more than MAX_SCRYPT at once, however many logins arrive', async () => {
    const { MAX_SCRYPT } = await import('../../src/server/handsfree-auth.js');
    let active = 0;
    let peak = 0;
    const auth = new HandsfreeAuth({
      dir, now, sleep: async () => {},
      verify: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return false; },
    });
    auth.store.setPassphrase(verifier);
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => auth.attemptLogin('x', `cf:10.0.0.${i}`)));
    expect(peak).toBeLessThanOrEqual(MAX_SCRYPT);
    expect(peak).toBe(MAX_SCRYPT);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
  });

  it('a Mac logout revokes that device only', async () => {
    const { handleHandsfreeLogout } = await import('../../src/server/handsfree-auth.js');
    const { markPhoneSocket } = await import('../../src/server/phone-origin.js');
    const mac = new HandsfreeAuth({ dir, now });
    mac.store.setPassphrase(verifier);
    setMacHandsfreeAuthForTests(mac);
    const a = mac.store.createDevice();
    const b = mac.store.createDevice();
    const sock = {};
    markPhoneSocket(sock);
    const res = { setHeader() {}, writeHead() { return res; }, end() {} } as never;
    handleHandsfreeLogout({ socket: sock, headers: { cookie: `${DEVICE_COOKIE}=${a}` } } as unknown as IncomingMessage, res);
    expect(mac.store.isValidDevice(a)).toBe(false);
    expect(mac.store.isValidDevice(b)).toBe(true);
  });
});
