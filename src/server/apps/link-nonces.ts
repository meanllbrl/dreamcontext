/**
 * The one-time nonce behind `dreamcontext://project/<vault>/app/<slug>?n=<nonce>` (plan r19, W3).
 *
 * A notification names a place inside its app. The path stays HERE, on the server: a link holds
 * only the nonce, so nothing a link carries can steer a window. A nonce is 32 bytes, bound to one
 * app, spent on first use, and dies with the notch row it came with (`EVENT_TTL_MS`). A link
 * without a live nonce never opens anything; it lands on the Apps card.
 */

import { randomBytes } from 'node:crypto';
import { EVENT_TTL_MS } from '../../lib/assistant/notch-inbox.js';

const MAX_LIVE = 256;

const live = new Map<string, { hash: string; path: string; exp: number }>();

export function issueLinkNonce(hash: string, path: string, now = Date.now()): string {
  for (const [n, v] of live) if (v.exp <= now) live.delete(n);
  while (live.size >= MAX_LIVE) live.delete(live.keys().next().value as string);
  const nonce = randomBytes(32).toString('base64url');
  live.set(nonce, { hash, path, exp: now + EVENT_TTL_MS });
  return nonce;
}

/** The path this nonce was issued for, or null: unknown, expired, spent, or another app's. */
export function spendLinkNonce(hash: string, nonce: unknown, now = Date.now()): string | null {
  if (typeof nonce !== 'string') return null;
  const hit = live.get(nonce);
  if (!hit || hit.hash !== hash) return null;
  live.delete(nonce);
  return hit.exp > now ? hit.path : null;
}
