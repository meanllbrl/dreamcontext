import { findFreeSlot } from '../../../generated/grid';
import type { Board, BoardSpec, Card } from './boardTypes';

/**
 * Card edits the page's menus make, as pure functions over a card list. Each
 * returns the board's whole next card list (what the save queue and the undo
 * stack both want). Ids stay unique within a board: a copy or an arrival whose
 * id is taken gets `-2`, `-3`, … appended.
 */

/** A board's spec as the PUT wants it: the stored fields, none of the server's bookkeeping. */
export function specOf(board: Board, cards: Card[] = board.cards): BoardSpec {
  return {
    title: board.title,
    ...(board.titleKey ? { titleKey: board.titleKey } : {}),
    order: board.order,
    cards,
    body: board.body,
  };
}

/** `base`, or `base-2`, `base-3`, … whichever is free in `cards`. */
export function uniqueCardId(cards: readonly Pick<Card, 'id'>[], base: string): string {
  const taken = new Set(cards.map((c) => c.id));
  if (!taken.has(base)) return base;
  const stem = base.replace(/-\d+$/, '');
  for (let n = 2; ; n++) {
    const id = `${stem}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The card with `id` gone. */
export function removeCard(cards: readonly Card[], id: string): Card[] {
  return cards.filter((c) => c.id !== id);
}

/** `card` placed on `cards`: a fresh id when its own is taken, at the first free slot of its size. */
export function addCard(cards: readonly Card[], card: Card): Card[] {
  const at = findFreeSlot(cards, card.at.w, card.at.h);
  return [...cards, { ...card, id: uniqueCardId(cards, card.id), at }];
}

/** A copy of card `id`, same blocks and size, at the first free slot. Unknown id = unchanged. */
export function duplicateCard(cards: readonly Card[], id: string): Card[] {
  const src = cards.find((c) => c.id === id);
  if (!src) return [...cards];
  return addCard(cards, structuredClone(src));
}

/**
 * Moving card `id` from one board to another: the source's next cards and the
 * target's. The card keeps its content and size and lands on the target's
 * first free slot. Unknown id = null (nothing to move).
 */
export function moveCard(source: readonly Card[], target: readonly Card[], id: string): { source: Card[]; target: Card[] } | null {
  const card = source.find((c) => c.id === id);
  if (!card) return null;
  return { source: removeCard(source, id), target: addCard(target, structuredClone(card)) };
}

export interface MoveDeps {
  /** A FRESH server read of a board (never a cached copy). */
  fetchBoard: (slug: string) => Promise<Board>;
  /** Queue a spec on the board's save queue and wait for it to be on disk (rejects on 409 / failure). */
  saveAndWait: (slug: string, spec: BoardSpec, rev: string) => Promise<Board>;
  /** Resolves once nothing is in flight for `slug`. */
  idle: (slug: string) => Promise<void>;
  /** The board's edits not yet on disk (pending or failed), or null. */
  unsaved: (slug: string) => BoardSpec | null;
}

/** A move refused because the source or the target board holds edits that are not on disk (a failed save). */
export class MoveBlockedError extends Error {
  constructor(readonly slug: string) {
    super(`Board "${slug}" has unsaved changes.`);
    this.name = 'MoveBlockedError';
  }
}

/**
 * Move card `cardId` from board `sourceSlug` to board `targetSlug`, in an
 * order that cannot 409 against itself and never drops an edit:
 *
 * 1. BOTH boards' queues drain first (an in-flight edit on either lands).
 *    Edits still unsaved after that are a FAILED save (kept for Retry): the
 *    move is refused rather than built on a server copy that lacks them
 *    (`MoveBlockedError`, naming the board). The target is usually not on
 *    screen, so its failed edits would otherwise vanish without a word;
 * 2. the target is read fresh, gets the card, and that write is AWAITED.
 *    Should an edit reach the target's queue after the check, the card is
 *    added on top of that queued edit, never on the server copy.
 *    On a derived vault this is the write that materializes every board,
 *    and every board's rev is whatever the materialized file says now;
 * 3. only then is the source read again, fresh, for its current rev. If the
 *    user edited the source meanwhile, those queued edits are the base (the
 *    queue owns the rev then), never the server copy.
 *
 * A failure before step 3 leaves the source untouched: the card is never
 * removed from a board it did not arrive on. Returns null when the card is
 * not on the source any more. The page saves `sourceSpec` against `sourceRev`.
 */
export async function moveCardToBoard(
  deps: MoveDeps,
  sourceSlug: string,
  targetSlug: string,
  cardId: string,
): Promise<{ target: Board; sourceSpec: BoardSpec; sourceRev: string } | null> {
  await Promise.all([deps.idle(sourceSlug), deps.idle(targetSlug)]);
  if (deps.unsaved(sourceSlug)) throw new MoveBlockedError(sourceSlug);
  if (deps.unsaved(targetSlug)) throw new MoveBlockedError(targetSlug);
  const [before, target] = await Promise.all([deps.fetchBoard(sourceSlug), deps.fetchBoard(targetSlug)]);
  if (target.error) throw new Error(target.error.message);
  const card = before.cards.find((c) => c.id === cardId);
  if (!card) return null;
  const targetBase = deps.unsaved(targetSlug) ?? specOf(target);
  const saved = await deps.saveAndWait(targetSlug, { ...targetBase, cards: addCard(targetBase.cards, structuredClone(card)) }, target.rev);
  const source = await deps.fetchBoard(sourceSlug);
  const base = deps.unsaved(sourceSlug) ?? specOf(source);
  return { target: saved, sourceSpec: { ...base, cards: removeCard(base.cards, cardId) }, sourceRev: source.rev };
}
