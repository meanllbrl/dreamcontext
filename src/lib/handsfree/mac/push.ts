import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hands-free Mac mode — Web Push, hand-rolled on node:crypto (no dependency).
 *
 *  - {@link encryptAes128gcm}: RFC 8291 message encryption (aes128gcm, one record), pinned by the
 *    RFC's Appendix A test vector.
 *  - {@link vapidJwt}: RFC 8292 VAPID, an ES256 JWT whose `aud` is the push service's origin.
 *  - {@link loadOrCreateVapid}: the server's P-256 key pair, `vapid.json` 0600 in the 0700 Mac dir.
 *  - {@link sendPush}: one POST to the subscription's endpoint; never follows a redirect, never
 *    throws, never logs the endpoint (it is a bearer capability for that phone).
 */

const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF (RFC 5869) with one expand block, which is all aes128gcm needs (lengths <= 32). */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

export interface PushKeys {
  /** The user agent's P-256 public key, uncompressed (65 bytes), base64url. */
  p256dh: string;
  /** The 16-byte authentication secret, base64url. */
  auth: string;
}

/** Record size written into the header (one record always fits: payloads are capped far below). */
const RECORD_SIZE = 4096;

/**
 * RFC 8291 §3-4: encrypt `plaintext` for one subscription as a single aes128gcm record.
 * `fixed` (tests only) pins the ephemeral key and the salt to reproduce Appendix A.
 */
export function encryptAes128gcm(keys: PushKeys, plaintext: Buffer, fixed?: { asPrivate: Buffer; salt: Buffer }): Buffer {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('push: p256dh is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('push: auth is not 16 bytes');
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error('push: payload too large for one record');

  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // The last (only) record ends with the 0x02 delimiter and carries no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// ─── VAPID ──────────────────────────────────────────────────────────────────

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (the phone's applicationServerKey). */
  publicKey: string;
  /** The private key as a JWK `d`, base64url. */
  privateKey: string;
}

/** A VAPID JWT lives at most 12 hours. */
export const VAPID_MAX_AGE_S = 12 * 60 * 60;

function privateKeyObject(v: VapidKeys): KeyObject {
  const pub = fromB64u(v.publicKey);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: v.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** RFC 8292: the ES256 JWT for one push service (`aud` = its origin), signed with our key. */
export function vapidJwt(keys: VapidKeys, aud: string, sub: string, nowS: number = Math.floor(Date.now() / 1000)): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: nowS + VAPID_MAX_AGE_S, sub })));
  const data = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(data), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64u(sig)}`;
}

function newVapid(): VapidKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string };
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pubJwk.x), fromB64u(pubJwk.y)])), privateKey: jwk.d };
}

function isVapid(v: unknown): v is VapidKeys {
  const o = v as Partial<VapidKeys> | null;
  return !!o && typeof o.publicKey === 'string' && typeof o.privateKey === 'string'
    && fromB64u(o.publicKey).length === 65 && fromB64u(o.privateKey).length === 32;
}

/** The server's VAPID pair, created once in `dir` (`vapid.json`, 0600; `dir` is the 0700 Mac dir). */
export function loadOrCreateVapid(dir: string): VapidKeys {
  const file = join(dir, 'vapid.json');
  if (existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (isVapid(v)) { try { chmodSync(file, 0o600); } catch { /* best-effort */ } return v; }
    } catch { /* corrupt: a new pair below (every subscription is re-made against it) */ }
  }
  const v = newVapid();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return v;
}

// ─── Sending ────────────────────────────────────────────────────────────────

export interface PushSubscriptionLike {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendOutcome {
  ok: boolean;
  status: number | null;
  /** 404/410: the push service forgot this subscription; 403: it was made for another VAPID key
   *  (a new pair after a corrupt vapid.json or an uninstall). Either way it can never deliver: drop
   *  it, and the phone re-subscribes on its next start (PushOptIn's resync). */
  gone: boolean;
  /** A throw (network, timeout): its error name, for the log. */
  error?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer; redirect: 'manual'; signal: AbortSignal }) => Promise<{ status: number }>;

/** One push. Never throws: a failure is an outcome. `sub` is the VAPID contact (https or mailto). */
export async function sendPush(
  subscription: PushSubscriptionLike,
  payload: unknown,
  opts: { vapid: VapidKeys; contact: string; ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<SendOutcome> {
  try {
    const body = encryptAes128gcm({ p256dh: subscription.p256dh, auth: subscription.auth }, Buffer.from(JSON.stringify(payload)));
    const aud = new URL(subscription.endpoint).origin;
    const jwt = vapidJwt(opts.vapid, aud, opts.contact);
    const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    const res = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(opts.ttl ?? 3600),
        Urgency: opts.urgency ?? 'high',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: `vapid t=${jwt}, k=${opts.vapid.publicKey}`,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 403 || res.status === 404 || res.status === 410 };
  } catch (err) {
    return { ok: false, status: null, gone: false, error: (err as Error)?.name ?? 'Error' };
  }
}
