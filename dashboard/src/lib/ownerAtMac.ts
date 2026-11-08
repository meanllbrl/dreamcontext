import { api } from '../api/client';

/**
 * He wrote something himself, now (owner 2026-11-09: "writing anything yourself in any dreamcontext
 * chat on the Mac ends the automatic Telegram part"). Called from the page's TWO owner-input
 * surfaces and nowhere else:
 *  - `Composer.commit`: every gesture that takes his words out of the box (⏎, ⌥⏎ into the queue,
 *    ⏎ while a card is open, a sleeping tab's first message, a card chat, a member chat, a peer);
 *  - `SurveyCard`: his answer to a question card, whoever asked it (a child, the Super, any agent).
 * Never from a queue drain, an agent's `window send`/`super send`, a reconnect flush or a card an
 * agent answers through the window: those do not pass these two surfaces.
 *
 * The page only says "now"; the SERVER decides whether it counts (`server/mac-owner.ts`
 * `noteMacOwnerInput`: the app's own page on this Mac, never the phone link or a tailnet device),
 * so the phone link's copy of this page calling it changes nothing. Fire-and-forget: a failed call
 * leaves the automatic part on, the side it has always failed toward.
 */
export function noteOwnerWrote(text?: string): void {
  if (text !== undefined && !isOwnerText(text)) return;
  void api.post('/mac-owner/input', {}).catch(() => { /* best-effort */ });
}

/** His words, not an empty send or a slash command (mirrors `isOwnerWords`, server side). */
export function isOwnerText(text: string): boolean {
  const t = text.trim();
  return !!t && !t.startsWith('/');
}
