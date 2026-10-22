/**
 * The Super Agent's "New session" (task super-agent-devrini-…): two small in-memory facts about
 * the super PANE, keyed by its pin id (= `state.session`), shared by the super inbox (which
 * delivers the `[super fresh]` turn) and the chat bridge (which rotates the pane).
 *
 *  - The FRESH LATCH: the `[super fresh]` turn was written into the pane. Taken at that turn's
 *    main `result`: if the super wrote no handoff record, the bridge writes a fallback one and
 *    rotates anyway, so the button never does nothing (pattern an-unreachable-tool-degrades).
 *    Cleared — never taken — on Stop, on exit and on a refused or errored turn.
 *  - ROTATING: the pane is between `/clear` and the fresh session's first finished turn. The
 *    pump delivers nothing meanwhile (a child event must reach a session that has read its
 *    handoff), the owner's route refuses a second press, and the window greys the button.
 *    Cleared at the continue turn's result, on a failed run, Stop, exit, or after
 *    {@link ROTATE_HOLD_MAX_MS} by a real timer — and every change is pushed to the window
 *    through {@link onRotatingChanged} (the window never polls).
 *
 * Memory only, on purpose: a restart loses both, and that is the safe direction — no rotation
 * nobody asked for, and the inbox's sweep frees the button.
 */

export const ROTATE_HOLD_MAX_MS = 120_000;

const latches = new Map<string, { batch: string; at: number }>();
const rotating = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
let changed: ((session: string) => void) | null = null;

export function markFreshDelivered(session: string, batch: string, now = Date.now()): void {
  latches.set(session, { batch, at: now });
}

/** Take (and clear) the latch: the fresh turn's result is being decided. */
export function takeFreshDelivered(session: string): { batch: string } | null {
  const l = latches.get(session);
  if (!l) return null;
  latches.delete(session);
  return { batch: l.batch };
}

export function clearFresh(session: string): void {
  latches.delete(session);
}

export function hasFreshLatch(session: string): boolean {
  return latches.has(session);
}

/** The one hook every rotating change calls (the server wires it to push + pump). */
export function onRotatingChanged(fn: ((session: string) => void) | null): void {
  changed = fn;
}

function notify(session: string): void {
  try { changed?.(session); } catch { /* a push is best effort; never break the bridge */ }
}

export function startRotating(session: string, now = Date.now()): void {
  const had = rotating.get(session);
  if (had) clearTimeout(had.timer);
  const timer = setTimeout(() => stopRotating(session), ROTATE_HOLD_MAX_MS);
  timer.unref?.();
  rotating.set(session, { at: now, timer });
  notify(session);
}

export function stopRotating(session: string): void {
  const had = rotating.get(session);
  if (!had) return;
  clearTimeout(had.timer);
  rotating.delete(session);
  notify(session);
}

export function isRotating(session: string | null | undefined): boolean {
  return !!session && rotating.has(session);
}

/** Tests only. The hook stays: the inbox registers it once, at import. */
export function _resetFreshSession(): void {
  for (const r of rotating.values()) clearTimeout(r.timer);
  rotating.clear();
  latches.clear();
}
