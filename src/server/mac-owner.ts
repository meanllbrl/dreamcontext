import type { IncomingMessage, ServerResponse } from 'node:http';
import { isDesktop } from './desktop.js';
import { isPhoneSocket } from './phone-origin.js';
import { isLoopback, isSameOriginStrict } from './routes/agent-spawn-shared.js';
import { sendJson } from './middleware.js';
import { isOwnerWords, noteOwnerAtMac } from '../lib/telegram/back-at-mac.js';

/**
 * Was this request made by the app's own page on THIS Mac? The fact behind "back at the Mac"
 * (`lib/telegram/back-at-mac.ts`), read only from what the server sees: the desktop app is
 * running, the peer is loopback and not the phone tunnel (cloudflared dials from 127.0.0.1,
 * `isLoopback` already says no for it), a tailnet device is not loopback, and the page names this
 * very origin. Unlike `isSameOriginStrict`, the `Origin` header is REQUIRED: a CLI or an agent's
 * curl sends none, so it never counts as the owner at the Mac.
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

/**
 * THE one gate every owner input on the Mac passes on its way to "back at the Mac" (owner
 * 2026-11-09): the page's composer (⏎ with or without a card open, ⌥⏎ into the queue, a sleeping
 * tab, a card chat, a member chat), its question cards (a child's, the Super's own, any agent's),
 * and the AI Team say/reply routes. Counts only when the REQUEST is the app's page on this Mac
 * ({@link isMacOwnerRequest}) and, when the words are known, they are his words (not empty, not a
 * slash command). Nothing the server releases later (a queue drain, a held message, a continue),
 * nothing from Telegram and nothing from the phone link reaches it: those are not a request from
 * this Mac's page at the moment he wrote.
 */
export function noteMacOwnerInput(req: IncomingMessage, text?: string): boolean {
  if (text !== undefined && !isOwnerWords(text)) return false;
  if (!isMacOwnerRequest(req)) return false;
  noteOwnerAtMac();
  return true;
}

/** POST /api/mac-owner/input: the page's one call when he writes or answers a card on this Mac
 *  (`dashboard/src/lib/ownerAtMac.ts`). The body carries nothing that decides: the request facts
 *  do. Always `{ ok: true }`, so the answer says nothing about the machine's state. */
export async function handleMacOwnerInput(req: IncomingMessage, res: ServerResponse): Promise<void> {
  noteMacOwnerInput(req);
  req.resume();
  sendJson(res, 200, { ok: true });
}
