/**
 * "Back at the Mac" (owner 2026-11-09): the owner typed a message himself in ANY dreamcontext chat
 * on this Mac, in any project: a Super, an ordinary chat, a member chat, the Assistant. It ends
 * the AUTOMATIC Telegram part machine-wide: every Super bot's forwarding and the power-only
 * keep-awake the hub started by itself (`telegram/hub.ts`, `telegram/handsfree.ts`). A hands-free
 * run started by hand (Mac panel, phone link, `/handsfree` buttons) never listens to it.
 *
 * Only server code calls {@link noteOwnerAtMac}: the chat route for one owner turn
 * ({@link macOwnerTurn}: the page marked it as his composer send AND its socket was a desktop,
 * loopback, same-origin, non-phone peer AT ITS UPGRADE, `server/mac-owner.ts`), and the AI Team
 * say/reply routes for a request with those same facts. No route body, CLI verb or agent text sets
 * the socket facts. A message from the phone link, from Telegram, an agent's `window send` or
 * `super send` (delivered by the page without the composer mark), a queued row the page drains
 * later, an app report or a server continue never reaches it. Memory only, like the presence.
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

/** One owner turn of a chat: is it "back at the Mac"? `typedAtMac` = the composer mark AND the
 *  socket's Mac facts (never a phone mirror's or the hub's frame); a Telegram turn and the
 *  server's own text never count, nor an empty event turn or a slash command. */
export function macOwnerTurn(t: { typedAtMac: boolean; telegram: boolean; server: boolean; text: string }): boolean {
  return t.typedAtMac && !t.telegram && !t.server && isOwnerWords(t.text);
}

/** Is this text an owner's words (not an event turn, not a slash command)? */
export function isOwnerWords(text: string): boolean {
  const t = text.trim();
  return !!t && !t.startsWith('/');
}
