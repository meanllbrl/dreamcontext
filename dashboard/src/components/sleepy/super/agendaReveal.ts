/**
 * The header pill's "needs you" jumps to the agenda's first pink row (plan super-v3 D13, v3-4).
 *
 * The pill opens the agenda if it is not on the stage, then asks every mounted agenda to show its
 * first waiting row. An agenda that mounts a moment later (just opened by the same press) takes a
 * request still fresh; with no waiting row drawn, the chat scrolls to the record's head question
 * instead, so the press is never dead.
 */
import { revealQuestion } from './superQuestions';

export const REVEAL_AGENDA_WAITING_EVENT = 'super:reveal-agenda-waiting';
/** How long a request waits for an agenda that is still mounting (ms). */
export const REVEAL_FRESH_MS = 1500;

let pending: { at: number; headId: string | null } | null = null;

export function revealAgendaWaiting(headId: string | null, now = Date.now()): void {
  if (typeof window === 'undefined') return;
  const mine = { at: now, headId };
  pending = mine;
  window.dispatchEvent(new CustomEvent(REVEAL_AGENDA_WAITING_EVENT, { detail: { headId } }));
  // No agenda answered (none mounted, none could be drawn): the chat shows the head question.
  window.setTimeout(() => { if (pending === mine) { pending = null; revealFallback(headId); } }, REVEAL_FRESH_MS);
}

/** A request an agenda that just mounted should still answer; taking it clears it. */
export function takePendingReveal(now = Date.now()): { headId: string | null } | null {
  const p = pending;
  if (!p || now - p.at > REVEAL_FRESH_MS) { pending = null; return null; }
  pending = null;
  return { headId: p.headId };
}

/** Clear a request an agenda already answered (so a remount does not jump again). */
export function clearPendingReveal(): void { pending = null; }

/**
 * Show the first waiting row inside `root`: scrolled into view, focused for the keyboard, and
 * marked for a moment. Returns false when the agenda draws no waiting row.
 */
export function showFirstWaitingRow(root: HTMLElement | null): boolean {
  const row = root?.querySelector<HTMLElement>('.super-agenda-row[data-group="waiting"]');
  if (!row) return false;
  row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  const target = row.querySelector<HTMLElement>('button, [tabindex]') ?? row;
  target.focus({ preventScroll: true });
  row.dataset.flash = 'true';
  window.setTimeout(() => { delete row.dataset.flash; }, 1200);
  return true;
}

/** The fallback when no agenda can show a pink row: the chat scrolls to the head question. */
export function revealFallback(headId: string | null): void {
  if (headId) revealQuestion(headId);
}
