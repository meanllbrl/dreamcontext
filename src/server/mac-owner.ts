import type { IncomingMessage } from 'node:http';
import { isDesktop } from './desktop.js';
import { isPhoneSocket } from './phone-origin.js';
import { isLoopback, isSameOriginStrict } from './routes/agent-spawn-shared.js';

/**
 * Was this request (an HTTP call, or a chat socket's upgrade) made by the app's own page on THIS
 * Mac? The fact behind "back at the Mac" (`lib/telegram/back-at-mac.ts`), read only from what the
 * server sees: the desktop app is running, the peer is loopback and not the phone tunnel (cloudflared
 * dials from 127.0.0.1, `isLoopback` already says no for it), a tailnet device is not loopback, and
 * the page names this very origin. Unlike `isSameOriginStrict`, the `Origin` header is REQUIRED: a
 * CLI or an agent's curl sends none, so it never counts as the owner at the Mac.
 *
 * A local script that forges an Origin can pass this; what it buys is ending the automatic Telegram
 * part early (forwarding off, the Mac sleeps normally), the safe direction. Nothing here starts
 * anything or sends anything out.
 */
export function isMacOwnerRequest(req: IncomingMessage): boolean {
  if (!isDesktop() || isPhoneSocket(req) || !isLoopback(req)) return false;
  if (typeof req.headers.origin !== 'string' || !req.headers.origin) return false;
  return isSameOriginStrict(req);
}
