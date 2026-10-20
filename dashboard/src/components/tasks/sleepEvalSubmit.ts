/**
 * One answer per card in the sleep-eval deck.
 *
 * A saved answer does not move the deck at once: the card slides out for 180 ms first, and
 * until it has left the SAME card is still in hand. A second tap, a held key's auto-repeat or
 * a swipe in that window used to post a second label for it, and the second advance then
 * skipped the next card unseen. The gate is a plain flag (a ref in the component), taken
 * before the save starts and given back only when the card has left (or the save failed), so
 * nothing that reads React state a render late can slip a second answer through.
 */

export interface DeckSubmitter<I> {
  /** Save one answer and start the card's exit. False when an answer is already under way. */
  submit(input: I, dir: 'left' | 'right'): Promise<boolean>;
  /** The card has left: the next one may be answered. */
  release(): void;
  readonly busy: boolean;
}

export function createDeckSubmitter<I>(o: {
  save: (input: I) => Promise<unknown>;
  /** Starts the exit; must call `release()` once the next card is in place. */
  advance: (dir: 'left' | 'right') => void;
  onError: (err: unknown) => void;
}): DeckSubmitter<I> {
  let busy = false;
  return {
    async submit(input, dir) {
      if (busy) return false;
      busy = true;
      try {
        await o.save(input);
      } catch (err) {
        busy = false;
        o.onError(err);
        return false;
      }
      o.advance(dir);
      return true;
    },
    release() { busy = false; },
    get busy() { return busy; },
  };
}
