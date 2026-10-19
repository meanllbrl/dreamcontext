/**
 * The owner's routes, as the window calls them (plan-r7 D4, the wire in the task's W2 brief).
 * Every call goes through the vault-scoped client (`useApi()`), so the server knows which
 * project's Super Agent it is; the server guards them all with `requireSuperOwner` (this
 * machine's desktop window, never cross-site, never the phone).
 *
 * After the first paint the window never asks for the state again: the server PUSHES it as
 * `_meta{subtype:'super_state'}` down the Super Agent's own socket after every store write.
 */
import type { ApiClient } from '../../../api/client';
import { readSuperStateView, type SuperStateView } from '../../../lib/superTypes';
import type { LayoutPatch } from './superLayout';

/** `GET /api/super/state` — the first paint after a reload. Null when unreadable. */
export async function fetchSuperState(api: ApiClient): Promise<SuperStateView | null> {
  try {
    return readSuperStateView(await api.get<unknown>('/super/state'));
  } catch {
    return null;
  }
}

/** `POST /api/super/enable` — hand over: adopt these chats. Answers the session to resume or
 *  the one just minted, and the state after the write. */
export async function enableSuper(api: ApiClient, body: { adopt: string[]; titles: Record<string, string> }): Promise<{ session: string; state: SuperStateView | null }> {
  const r = await api.post<{ session?: unknown; state?: unknown }>('/super/enable', body);
  if (typeof r?.session !== 'string' || !r.session) throw new Error('the server named no Super Agent session');
  return { session: r.session, state: readSuperStateView(r.state) };
}

/** `POST /api/super/disable` — take it back. */
export async function disableSuper(api: ApiClient): Promise<SuperStateView | null> {
  const r = await api.post<{ state?: unknown }>('/super/disable', {});
  return readSuperStateView(r?.state);
}

/** `POST /api/super/layout` — the owner's gesture as a PATCH (plan-r8 F3, §0 C3): a drop, a
 *  card stacked or brought back, a close, and the view only when the gesture changes it. */
export async function postSuperLayout(api: ApiClient, patch: LayoutPatch): Promise<SuperStateView | null> {
  const r = await api.post<{ state?: unknown }>('/super/layout', patch);
  return readSuperStateView(r?.state);
}

/** `POST /api/super/activity` — the owner is typing to the Super Agent (no text is ever sent). */
export async function postSuperActivity(api: ApiClient): Promise<void> {
  await api.post<unknown>('/super/activity', {});
}

/** `POST /api/super/recap` — the window came back after a long absence. */
export async function postSuperRecap(api: ApiClient): Promise<boolean> {
  const r = await api.post<{ queued?: unknown }>('/super/recap', {});
  return r?.queued === true;
}

/** The owner-activity lease is posted at most this often (the server holds it 15 s). */
export const ACTIVITY_POST_GAP_MS = 5_000;

/** A timer the lease can be handed (tests inject a fake clock and scheduler). */
export interface LeaseTimer {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}

const realTimer: LeaseTimer = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The owner-activity lease (D7): every keystroke in the Super Agent's composer calls `typed()`.
 *
 * At most one POST per {@link ACTIVITY_POST_GAP_MS}, and only while someone types (a hidden
 * window, which nobody can type into, posts nothing). LEADING edge: the first keystroke after a
 * quiet gap posts at once. TRAILING edge: keystrokes that came after the last post schedule ONE
 * more post for when the gap elapses (last post + 5 s) — without it the server's 15 s lease was
 * measured from the START of a burst and could end up to 5 s before the owner's last keystroke,
 * letting a child's question through while they were still writing. With it the lease always
 * runs at least 15 s past the last keystroke. A single keystroke still posts once.
 *
 * `dispose()` cancels a pending trailing post (the surface unmounting, or take-back).
 */
export function createActivityLease(
  post: () => void,
  now: () => number = () => Date.now(),
  gapMs: number = ACTIVITY_POST_GAP_MS,
  timer: LeaseTimer = realTimer,
): { typed: () => void; dispose: () => void } {
  let last = -Infinity;
  let pending: unknown = null;
  let disposed = false;
  const fire = () => {
    last = now();
    try { post(); } catch { /* best-effort: the next keystroke after the gap tries again */ }
  };
  return {
    typed: () => {
      if (disposed) return;
      const t = now();
      if (t - last >= gapMs) {
        if (pending !== null) { timer.cancel(pending); pending = null; }
        fire();
        return;
      }
      if (pending !== null) return;  // one trailing post already covers this keystroke
      pending = timer.schedule(() => {
        pending = null;
        if (!disposed) fire();
      }, Math.max(0, last + gapMs - t));
    },
    dispose: () => {
      disposed = true;
      if (pending !== null) { timer.cancel(pending); pending = null; }
    },
  };
}
