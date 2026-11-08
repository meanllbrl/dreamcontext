/**
 * "The owner's NEXT text means something else" (a rich ask's **Not ekle**, /gundem's **Yaz**),
 * in ONE place (end review r2 redesign of class pending-input-capture-without-liveness):
 *  - one live capture per bot: a new one replaces whatever was set before;
 *  - one lifetime: NOTE_TTL_MS from the tap; past it the capture is simply gone (what it pointed
 *    at is never touched by expiry);
 *  - spent by the first message that reaches it, whatever that message is.
 * Whether the thing a capture points at is still open is checked by its owner when it is taken.
 */
export const CAPTURE_TTL_MS = 5 * 60 * 1000;

export type Capture =
  | { kind: 'note'; askId: string; qi: number; at: number }
  | { kind: 'about'; block: string; at: number };

export class NextTextCapture {
  private slots = new Map<string, Capture>();
  constructor(private readonly now: () => number, private readonly ttlMs = CAPTURE_TTL_MS) {}

  set(key: string, c: Capture): void { this.slots.set(key, c); }

  /** The live capture of this bot, spent now; null when none or expired (expiry just drops it). */
  take(key: string): Capture | null {
    const c = this.slots.get(key);
    if (!c) return null;
    this.slots.delete(key);
    return this.now() - c.at <= this.ttlMs ? c : null;
  }

  /** Peek without spending (the turn path asks "is a note capture waiting?"). */
  peek(key: string): Capture | null {
    const c = this.slots.get(key);
    if (!c) return null;
    if (this.now() - c.at > this.ttlMs) { this.slots.delete(key); return null; }
    return c;
  }

  clear(): void { this.slots.clear(); }
}
