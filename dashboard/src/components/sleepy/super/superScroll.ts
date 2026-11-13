/**
 * THE SCROLL RULE of the Super chat (owner 2026-11-13, "telegram gibi", rule C): the view moves for
 * the owner's own send, and while it sits at the bottom it follows what arrives, but never past the
 * START of the new Super answer: once that start reaches the top of the view, the view stops and
 * the rest waits below the "↓ N yeni" button. Nothing else moves it (no unread cap, no re-pin of a
 * view he left). Pure and DOM-free: the pane measures, this decides.
 *
 * The "new answer" is named by an ITEM, never by a number (r1: a scroll coordinate taken once goes
 * stale when history lands late or the window trims): the row after the newest row on screen when
 * the follow began. What he was looking at then, even a row still being written, is read. For his
 * own send it is his own message, or the row after it when his message is taller than the view.
 */

/** His input this recent owns the scroller: the follow writes nothing over a live gesture. */
export const INPUT_QUIET_MS = 300;

export interface FollowStepInput {
  scrollTop: number;
  /** scrollHeight - clientHeight. */
  maxTop: number;
  /** The new answer's start in scroll coordinates (scroll-invariant), or null when nothing new yet. */
  anchorTop: number | null;
  /** How far below the view's top the answer's start rests (the rail's clearance). */
  clearance: number;
}

/**
 * Where a following view goes now. `stop`: the answer's start has reached the top, the follow ends
 * here and the view rests (the pane unpins it). Never upward: a start already above the view only
 * stops the follow where it stands.
 */
export function followStep({ scrollTop, maxTop, anchorTop, clearance }: FollowStepInput): { top: number; stop: boolean } {
  const bottom = Math.max(0, maxTop);
  if (anchorTop === null) return { top: Math.max(scrollTop, bottom), stop: false };
  const cap = Math.max(0, anchorTop - clearance);
  if (cap >= bottom) return { top: Math.max(scrollTop, bottom), stop: false };
  return { top: Math.max(scrollTop, cap), stop: true };
}

/** A write is worth making: it moves at least a pixel, and no gesture of his is in flight. */
export function shouldWrite(from: number, to: number, lastInputAt: number, now: number): boolean {
  return Math.abs(to - from) >= 1 && now - lastInputAt >= INPUT_QUIET_MS;
}

export interface RowSpan { top: number; height: number }

/**
 * The new answer's row: the row after `after` (the newest row when the follow began; -1 when the
 * transcript was empty then). -1: nothing new has arrived yet.
 */
export function answerRowAfter(rowCount: number, after: number): number {
  return after + 1 < rowCount ? after + 1 : -1;
}

/** His own message as the anchor, unless it is taller than the view can hold with the answer's
 *  first line under it: then the row after it (the reply's start) is what must stay in view, and
 *  until that row exists there is nothing to stop at yet (-1). */
export function ownAnchorIndex(rows: readonly RowSpan[], own: number, viewHeight: number, clearance: number): number {
  if (own < 0 || own >= rows.length) return -1;
  if (rows[own].height <= viewHeight - clearance * 2) return own;
  return own + 1 < rows.length ? own + 1 : -1;
}
