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
  setHandsfreeAuthForTests,
  sha256Hex,
  transferAuthorization,
  transferKeyFromSecret,
  verifyPassphrase,
  type ScryptVerifier,
} from '../../src/server/handsfree-auth.js';

let dir: string;
let clock: number;
const now = () => clock;
let verifier: ScryptVerifier;
const PASS = 'abacus zoom yodel t-shirt zebra kettle';
const TRANSFER_SECRET = 'transfer-secret-for-tests';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hf-auth-'));
  clock = 1_800_000_000_000;
  verifier ??= await hashPassphrase(PASS);
});

afterEach(() => {
  setHandsfreeAuthForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function push(generation: number, v = verifier) {
  return { generation, passphrase: v, transferSha256: sha256Hex(TRANSFER_SECRET) };
}

function service(): HandsfreeAuth {
  const auth = new HandsfreeAuth({ dir, now, sleep: async () => {} });
  auth.store.installVerifiers(push(1));
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

describe('verifier store', () => {
  it('only lets the generation go up, and a higher one signs every device out', () => {
    const store = new HandsfreeAuthStore({ dir, now });
    expect(store.installVerifiers(push(1))).toMatchObject({ ok: true, generation: 1, changed: true });
    const id = store.createDevice();
    expect(store.isValidDevice(id)).toBe(true);

    // Idempotent re-push of the same generation keeps the devices.
    expect(store.installVerifiers(push(1))).toMatchObject({ ok: true, changed: false });
    expect(store.isValidDevice(id)).toBe(true);

    // Same generation, different content: refused. Lower: refused.
    expect(store.installVerifiers({ ...push(1), transferSha256: sha256Hex('other') })).toMatchObject({ ok: false, error: 'generation_conflict' });
    expect(store.installVerifiers(push(0))).toMatchObject({ ok: false });

    // A password change (higher generation) revokes all.
    expect(store.installVerifiers(push(2))).toMatchObject({ ok: true, generation: 2 });
    expect(store.isValidDevice(id)).toBe(false);
    expect(store.installVerifiers(push(1))).toMatchObject({ ok: false, error: 'stale_generation', generation: 2 });
  });

  it('revoke-all needs a higher generation and survives a restart', () => {
    const store = new HandsfreeAuthStore({ dir, now });
    store.installVerifiers(push(3));
    const id = store.createDevice();
    expect(store.revokeAllDevices(3)).toMatchObject({ ok: false, error: 'stale_generation' });
    expect(store.isValidDevice(id)).toBe(true);
    expect(store.revokeAllDevices(4)).toMatchObject({ ok: true, generation: 4 });

    const reloaded = new HandsfreeAuthStore({ dir, now });
    expect(reloaded.generation).toBe(4);
    expect(reloaded.isValidDevice(id)).toBe(false);
    expect(reloaded.passphraseVerifier).toEqual(verifier);
  });

  it('stores only the sha256 of a device id, for 30 days', () => {
    const store = new HandsfreeAuthStore({ dir, now });
    store.installVerifiers(push(1));
    const id = store.createDevice();
    expect(Buffer.from(id, 'base64url')).toHaveLength(32);
    const file = readFileSync(join(dir, 'auth.json'), 'utf-8');
    expect(file).not.toContain(id);
    expect(file).toContain(sha256Hex(id));
    expect(file).not.toContain(TRANSFER_SECRET);

    expect(new HandsfreeAuthStore({ dir, now }).isValidDevice(id)).toBe(true);
    clock += DEVICE_TTL_MS - 1;
    expect(store.isValidDevice(id)).toBe(true);
    clock += 2;
    expect(store.isValidDevice(id)).toBe(false);
  });

  it('forgets one device on logout', () => {
    const store = new HandsfreeAuthStore({ dir, now });
    store.installVerifiers(push(1));
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
    expect(store.transferKey()).toBeNull();
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

  it('keys clients on the single X-Forwarded-For value the forwarder sets', () => {
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
    auth.store.installVerifiers(push(1));
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

  it('hasValidDeviceSession reads the cookie against the store', () => {
    const auth = service();
    setHandsfreeAuthForTests(auth);
    const id = auth.store.createDevice();
    const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as IncomingMessage;
    expect(hasValidDeviceSession(req(`other=1; ${DEVICE_COOKIE}=${id}`))).toBe(true);
    expect(hasValidDeviceSession(req(`${DEVICE_COOKIE}=${id}x`))).toBe(false);
    expect(hasValidDeviceSession(req())).toBe(false);
  });
});

describe('transfer proof', () => {
  const key = transferKeyFromSecret(TRANSFER_SECRET);

  it('the stored value is sha256 of the secret, and the secret never rides the header', () => {
    expect(key.toString('hex')).toBe(sha256Hex(TRANSFER_SECRET));
    const auth = service();
    const header = transferAuthorization(key, auth.issueNonce(), 'POST', '/api/handsfree/trip');
    expect(header).not.toContain(TRANSFER_SECRET);
    expect(header).not.toContain(key.toString('hex'));
  });

  it('accepts a proof once, bound to its method and target', () => {
    const auth = service();
    const nonce = auth.issueNonce();
    const header = transferAuthorization(key, nonce, 'POST', '/api/handsfree/trip');
    expect(auth.verifyTransferProof(header, 'GET', '/api/handsfree/trip')).toBe(false);
    expect(auth.verifyTransferProof(header, 'POST', '/api/handsfree/seal')).toBe(false);
    expect(auth.verifyTransferProof(header, 'POST', '/api/handsfree/trip')).toBe(true);
    expect(auth.verifyTransferProof(header, 'POST', '/api/handsfree/trip')).toBe(false); // replay
  });

  it('refuses a forged, expired or keyless proof', () => {
    const auth = service();
    const wrongKey = transferKeyFromSecret('not-it');
    expect(auth.verifyTransferProof(transferAuthorization(wrongKey, auth.issueNonce(), 'GET', '/x'), 'GET', '/x')).toBe(false);
    // A nonce the server did not sign.
    expect(auth.verifyTransferProof(transferAuthorization(key, `${clock.toString(36)}.aaaa.bbbb`, 'GET', '/x'), 'GET', '/x')).toBe(false);
    // Expired.
    const old = auth.issueNonce();
    clock += 121_000;
    expect(auth.verifyTransferProof(transferAuthorization(key, old, 'GET', '/x'), 'GET', '/x')).toBe(false);
    // The raw secret as a bearer is not a proof.
    expect(auth.verifyTransferProof(`Bearer ${TRANSFER_SECRET}`, 'GET', '/x')).toBe(false);
    // No transfer key installed.
    const bare = new HandsfreeAuth({ dir: mkdtempSync(join(tmpdir(), 'hf-auth-bare-')), now });
    expect(bare.verifyTransferProof(transferAuthorization(key, bare.issueNonce(), 'GET', '/x'), 'GET', '/x')).toBe(false);
  });

  it('a nonce from another server process is refused', () => {
    const a = service();
    const b = new HandsfreeAuth({ dir, now });
    expect(b.verifyTransferProof(transferAuthorization(key, a.issueNonce(), 'GET', '/x'), 'GET', '/x')).toBe(false);
  });
});
