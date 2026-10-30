/**
 * Does this Enter SEND, or add a line? The ONE decision for every chat composer (Super, a
 * normal chat, an AI Team member, the phone over the tunnel) — owner 2026-10-30, "pcde evet,
 * telde enter satır atlar".
 *
 * On a computer: ⏎ sends, ⇧⏎ adds a line. On a phone: ⏎ always adds a line and only the send
 * button sends, as in Slack and WhatsApp — a phone keyboard has no ⇧⏎, so the return key is
 * the only way to break a line.
 *
 * "A phone" is a finger-first device with a phone-sized screen: `(pointer: coarse)` AND a short
 * side under {@link PHONE_SHORT_SIDE} — the same short side the tunnel's phone layout uses
 * (`REMOTE_PHONE_SHORT_SIDE` in `hooks/useIsMobile.ts`). Not width alone: a narrowed desktop
 * window still sends on ⏎. A TABLET (an iPad, short side ≥ 600) keeps ⏎ = send, the choice
 * that suits the hardware keyboard most iPad typing happens on; it costs a soft-keyboard iPad
 * user ⇧⏎ for a line break, which that keyboard does have.
 *
 * Read at keydown, not subscribed: the answer cannot change mid-keystroke, and a rotation
 * never moves a screen's short side.
 *
 * An Enter that commits an IME composition (Japanese, Chinese, Korean, Turkish-Q dead keys on
 * some layouts) is never a send, on any device — Safari marks it only with `keyCode` 229.
 */

/** Below this short side, a finger-first screen is a phone. Kept equal to the tunnel's rule. */
export const PHONE_SHORT_SIDE = 600;

/** The parts of a keydown the rule reads — a React event and a DOM event both fit. */
export interface EnterKeyLike {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** Finger-first and phone-sized. SSR/JSDOM-safe: no `matchMedia` → a computer. */
export function isTouchPhone(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (!window.matchMedia('(pointer: coarse)').matches) return false;
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  return w > 0 && h > 0 && Math.min(w, h) < PHONE_SHORT_SIDE;
}

/** True when this keydown should send the draft. `phone` defaults to {@link isTouchPhone}. */
export function enterSends(e: EnterKeyLike, phone: boolean = isTouchPhone()): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return !phone;
}
