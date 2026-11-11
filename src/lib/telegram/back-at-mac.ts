/**
 * "Back at the Mac" (owner 2026-11-09): the owner typed a message himself in ANY dreamcontext chat
 * on this Mac, in any project: a Super, an ordinary chat, a member chat, the Assistant. It ends
 * the AUTOMATIC Telegram part machine-wide: every Super bot's forwarding and the power-only
 * keep-awake the hub started by itself (`telegram/hub.ts`, `telegram/handsfree.ts`). A hands-free
 * run started by hand (Mac panel, phone link, `/handsfree` buttons) never listens to it.
 *
 * Only server code calls {@link noteOwnerAtMac}, and only through ONE gate, `noteMacOwnerInput`
 * (`server/mac-owner.ts`): the request must be the app's own page on this Mac (desktop, loopback,
 * same-origin with an Origin, not the phone tunnel). The page reaches it from its two owner-input
 * surfaces, the composer's send (every gesture: ⏎, ⌥⏎ into the queue, ⏎ while a card is open, a
 * sleeping tab) and the question card's answer (`dashboard/src/lib/ownerAtMac.ts`), and the AI Team
 * say/reply routes call it with his text. No route body, CLI verb or agent text sets the facts. A
 * message from the phone link, from Telegram, an agent's `window send` or `super send`, a queued
 * row drained later, an app report or a server continue never reaches it. Memory only.
 */

type Listener = (at: number) => void;
const listeners = new Set<Listener>();

/** Be told each time the owner writes on the Mac. Returns the unsubscribe. */
export function onOwnerAtMac(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The owner wrote a message on the Mac just now. Server-only. */
export function noteOwnerAtMac(at = Date.now()): void {
  for (const fn of [...listeners]) {
    try { fn(at); } catch { /* a listener's failure is its own */ }
  }
}

/** Is this text an owner's words (not an event turn, not a slash command)? */
export function isOwnerWords(text: string): boolean {
  const t = text.trim();
  return !!t && !t.startsWith('/');
}

// ─── "Mac'e dönünce hatırlat" (sahip-karti-yerinde K7) ──────────────────────────────────────

/** The owner-question banner path (index.ts sets the SAME function `setOwnerQuestionSinks` gets):
 *  a routable macOS banner, held (history row only) while the open notch covers it. */
export type OwnerCardRemindBanner = (title: string, body: string, link: string | null) => boolean | 'held';
let remindBanner: OwnerCardRemindBanner | null = null;

/** The server wires the banner (index.ts). Null unwires it (tests). */
export function setOwnerCardRemindBanner(fn: OwnerCardRemindBanner | null): void { remindBanner = fn; }

/** ONE desktop notification naming the cards he asked to be reminded of; a click opens the
 *  Super's stage. False when no banner path is wired. */
export function postOwnerCardRemind(title: string, body: string, link: string | null): boolean | 'held' {
  if (!remindBanner) return false;
  try { return remindBanner(title, body, link); } catch { return false; }
}
