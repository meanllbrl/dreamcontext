/**
 * One answer per card in the sleep-eval deck.
 *
 * A saved answer does not move the deck at once: the card slides out for 180 ms first, and
 * until it has left the SAME card is still in hand. A second tap, a held key's auto-repeat or
 * a swipe in that window used to post a second label for it, and the second advance then
 * skipped the next card unseen. The gate is a plain flag (a ref in the component), taken
 * before the save starts and given back only when the NEXT card is on screen (or the save
 * failed), so nothing that reads React state a render late can slip a second answer through.
 *
 * "On screen" means COMMITTED, not "the exit timer fired": the timer only queues the next
 * card's render, and a tap landing before React commits it still reaches the old card's
 * handlers. So the exit timer never opens the gate; `shown(id)`, called from a layout effect
 * keyed on the card, does. And it names the card: a handler that still closes over the card
 * that left (the window key listener re-subscribes in a passive effect, after the layout
 * effect) is refused because its answer names a card that is no longer the one shown.
 */

export interface DeckSubmitter<I extends { id: string }> {
  /**
   * Save one answer and start the card's exit. False when an answer is already under way or
   * the answer names a card other than the one on screen.
   */
  submit(input: I, dir: 'left' | 'right'): Promise<boolean>;
  /** Whether an answer for card `id` would be taken right now. */
  accepts(id: string): boolean;
  /** React has committed card `id` (null: the deck is done): it, and only it, may be answered. */
  shown(id: string | null): void;
  readonly busy: boolean;
}

export function createDeckSubmitter<I extends { id: string }>(o: {
  save: (input: I) => Promise<unknown>;
  /** The saved card starts sliding out. */
  leave: (dir: 'left' | 'right') => void;
  /** `exitMs` later: queue the next card. The gate stays shut until `shown()` reports it. */
  next: () => void;
  exitMs: number;
  onError: (err: unknown) => void;
}): DeckSubmitter<I> {
  let busy = false;
  let onScreen: string | null = null;
  const accepts = (id: string) => !busy && id === onScreen;
  return {
    async submit(input, dir) {
      if (!accepts(input.id)) return false;
      busy = true;
      try {
        await o.save(input);
      } catch (err) {
        busy = false;
        o.onError(err);
        return false;
      }
      o.leave(dir);
      setTimeout(o.next, o.exitMs);
      return true;
    },
    accepts,
    shown(id) {
      onScreen = id;
      busy = false;
    },
    get busy() { return busy; },
  };
}
