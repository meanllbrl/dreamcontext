import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PushSubscriptionLike } from './push.js';

/**
 * Hands-free Mac mode — the phones' push subscriptions, `push.json` 0600 in the 0700 Mac dir.
 *
 * One subscription per DEVICE, keyed by the sha256 of its device id (the same hash a chat socket
 * is tagged with), so a signed-out device's subscription is found and dropped with it. The
 * endpoint must be a real push service (an SSRF guard: the server POSTs to it); it is a bearer
 * capability for that phone, so it is never logged.
 */

export interface StoredSubscription extends PushSubscriptionLike {
  createdAt: number;
}

/** The push services browsers use. Exact hosts, plus Windows' dot-anchored suffix. */
const PUSH_HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
const PUSH_HOST_SUFFIXES = ['.notify.windows.com'];

const B64U_RE = /^[A-Za-z0-9_-]+$/;

/** VERIFY ONLY: one extra exact origin (a local fake push service) the end-to-end verify may
 *  subscribe; set by the server only for a scratch HOME under the temp dir. Null otherwise. */
let verifyOrigin: string | null = null;
export function setVerifyPushOrigin(origin: string | null): void { verifyOrigin = origin; }
const HASH_RE = /^[0-9a-f]{64}$/;

/** Why a subscription body is refused, or null when it is usable. */
export function subscriptionRefusal(body: unknown): string | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return 'The body must be a push subscription.';
  const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
  const keys = (b.keys && typeof b.keys === 'object' ? b.keys : {}) as Record<string, unknown>;
  let url: URL;
  try { url = new URL(endpoint); } catch { return 'The endpoint is not a URL.'; }
  if (endpoint.length > 1024) return 'The endpoint is too long.';
  if (verifyOrigin && url.origin === verifyOrigin && !url.username && !url.password) return keysRefusal(keys);
  if (url.protocol !== 'https:') return 'The endpoint must be https.';
  if (url.port !== '' && url.port !== '443') return 'The endpoint must use the default https port.';
  if (url.username || url.password) return 'The endpoint must not carry credentials.';
  const host = url.hostname.toLowerCase();
  if (!PUSH_HOSTS.has(host) && !PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)) {
    return 'The endpoint is not a known push service.';
  }
  return keysRefusal(keys);
}

function keysRefusal(keys: Record<string, unknown>): string | null {
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys.auth === 'string' ? keys.auth : '';
  if (!B64U_RE.test(p256dh) || Buffer.from(p256dh, 'base64url').length !== 65) return 'keys.p256dh is not a P-256 public key.';
  if (!B64U_RE.test(auth) || Buffer.from(auth, 'base64url').length !== 16) return 'keys.auth is not 16 bytes.';
  return null;
}

export class PushStore {
  private readonly file: string;
  private readonly now: () => number;
  private subs: Record<string, StoredSubscription>;

  constructor(opts: { dir: string; now?: () => number }) {
    this.file = join(opts.dir, 'push.json');
    this.now = opts.now ?? Date.now;
    this.subs = PushStore.load(this.file);
  }

  private static load(file: string): Record<string, StoredSubscription> {
    if (!existsSync(file)) return {};
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, StoredSubscription>;
      const out: Record<string, StoredSubscription> = {};
      for (const [k, v] of Object.entries(raw ?? {})) {
        if (HASH_RE.test(k) && v && subscriptionRefusal({ endpoint: v.endpoint, keys: { p256dh: v.p256dh, auth: v.auth } }) === null) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.subs), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best-effort */ }
  }

  /** Store (replace) the device's subscription. The body must pass {@link subscriptionRefusal}. */
  put(deviceHash: string, body: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
    if (!HASH_RE.test(deviceHash)) throw new Error('push-store: not a device hash');
    this.subs = { ...this.subs, [deviceHash]: { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, createdAt: this.now() } };
    this.save();
  }

  remove(deviceHash: string): boolean {
    if (!(deviceHash in this.subs)) return false;
    const { [deviceHash]: _gone, ...rest } = this.subs;
    this.subs = rest;
    this.save();
    return true;
  }

  get(deviceHash: string): StoredSubscription | null {
    return this.subs[deviceHash] ?? null;
  }

  /** Every stored subscription, by device hash. */
  entries(): Array<[string, StoredSubscription]> {
    return Object.entries(this.subs);
  }

  /** Drop every subscription whose device is no longer signed in. Returns how many went. */
  prune(isValidDevice: (deviceHash: string) => boolean): number {
    const keep: Record<string, StoredSubscription> = {};
    let gone = 0;
    for (const [k, v] of Object.entries(this.subs)) {
      if (isValidDevice(k)) keep[k] = v;
      else gone++;
    }
    if (gone) { this.subs = keep; this.save(); }
    return gone;
  }
}
