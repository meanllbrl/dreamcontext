/**
 * What the stage shows when something lands on it (jarvis plan r9: G1 and AC16). Pure: the
 * surface keeps the clock and the lists, this decides.
 *
 *  - A verb's CUE: every Super Agent verb that changes the stage gets one small, recognisable
 *    animation on the cards it touched (a delegated card flies out of the centre and leaves a
 *    glint, a closed card fades out, a grouped one pulses …) and, when the owner allows it, a
 *    short sound. Transform and opacity only, once (≤ CUE_MS), never a loop; reduced motion is a
 *    plain fade (the CSS says so).
 *  - G1, the reveal gate: a NEW card does not appear while the owner drags on the stage or typed
 *    in the super composer during the last TYPING_HOLD_MS. Held cards then come one at a time,
 *    at least REVEAL_GAP_MS apart, each with the one-time `arrive` highlight.
 */

export type SuperCueKind =
  | 'delegate' | 'open' | 'present' | 'stack' | 'float' | 'close' | 'group' | 'ungroup' | 'merge' | 'answer' | 'arrive';

/** How long a cue's class stays on a card (its animation is shorter). */
export const CUE_MS = 1100;
export const REVEAL_GAP_MS = 700;
export const TYPING_HOLD_MS = 2000;

const VERB_CUE: Record<string, SuperCueKind> = {
  delegate: 'delegate', open: 'open', half: 'present', present: 'present', stack: 'stack', float: 'float',
  close: 'close', group: 'group', ungroup: 'ungroup', merge: 'merge', answer: 'answer',
};

/** The cue for a verb the server reported (`super_cue`), or null for one with none. */
export function cueOf(verb: string): SuperCueKind | null {
  return Object.prototype.hasOwnProperty.call(VERB_CUE, verb) ? VERB_CUE[verb] : null;
}

export interface RevealInput {
  /** New card ids waiting to appear, oldest first. */
  pending: readonly string[];
  dragging: boolean;
  /** When the owner last typed in the super composer (0 = never). */
  typedAt: number;
  /** When the last held card was revealed (0 = never). */
  lastRevealAt: number;
  now: number;
}

/** G1: which held card appears now (if any), and when to ask again. */
export function revealStep(i: RevealInput): { reveal: string | null; wakeAt: number | null } {
  if (!i.pending.length) return { reveal: null, wakeAt: null };
  if (i.dragging) return { reveal: null, wakeAt: null };
  const typingUntil = i.typedAt ? i.typedAt + TYPING_HOLD_MS : 0;
  const gapUntil = i.lastRevealAt ? i.lastRevealAt + REVEAL_GAP_MS : 0;
  const at = Math.max(typingUntil, gapUntil);
  if (at > i.now) return { reveal: null, wakeAt: at };
  return { reveal: i.pending[0], wakeAt: i.pending.length > 1 ? i.now + REVEAL_GAP_MS : null };
}

/** Is a card held right now (G1)? A new card is held while anything blocks it. */
export function holdsNewCards(i: Pick<RevealInput, 'dragging' | 'typedAt' | 'now'>): boolean {
  return i.dragging || (i.typedAt > 0 && i.now - i.typedAt < TYPING_HOLD_MS);
}
