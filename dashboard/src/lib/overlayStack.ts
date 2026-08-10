/**
 * A tiny LIFO registry of open modal overlays (⌘K palette, ⌘P switcher, …).
 *
 * Global Escape handlers all listen on `window` in the capture phase, so when two
 * overlays are open at once the one that registered its listener FIRST would fire
 * first and swallow the Esc meant for the overlay stacked on top of it. Each
 * overlay instead pushes its id while open and its Esc handler acts only when it
 * is topmost — so Esc always closes the front-most overlay, regardless of which
 * listener the browser happens to invoke first.
 *
 * ## Why the stack is SCOPED
 *
 * That design assumed one project per window, so "front-most" and "the overlay the user
 * can see" were the same overlay. One window now holds several projects mounted at once,
 * and the background ones are only `hidden` — their Escape listeners are still registered
 * on `window` and still fire. A single flat stack breaks in both directions:
 *
 *   - open a panel in project A, switch to B, open a panel in B, switch back to A. A's
 *     panel is the one on screen, but B's entry is topmost, so Esc does NOTHING in A.
 *   - the same two panels in the other order: Esc pressed in B silently closes A's
 *     invisible panel and leaves B's open.
 *
 * So every entry records the scope (the active instance) it was pushed in, and Esc is
 * answered per scope: an overlay owns Esc when it is topmost AMONG ITS OWN SCOPE, and a
 * background project's overlay never owns Esc at all.
 *
 * An entry pushed with no scope set (`null` — the launcher, the browser build, a test, any
 * surface with no `WindowChrome` above it) belongs to every scope. There, one flat stack IS
 * correct and this behaves exactly as it did before.
 */
interface Entry {
  id: string;
  /** The active instance at push time; `null` outside a `WindowChrome`. */
  scope: string | null;
}

const stack: Entry[] = [];

/** The instance whose overlays are on screen. `null` = unscoped (single-surface window). */
let activeScope: string | null = null;

/**
 * Point the stack at the project the user is looking at. Called by `WindowChrome` on every
 * chip switch, and with `null` on unmount so a closed window leaves nothing behind.
 *
 * This is deliberately a module-level setter rather than a parameter threaded through every
 * overlay: the eight `pushOverlay` call sites include popovers that build their own ids from
 * `useId()` and know nothing about vaults, and an overlay should not have to be vault-aware
 * to be dismissible.
 */
export function setActiveOverlayScope(scope: string | null): void {
  activeScope = scope;
}

/** True when the entry answers for the scope currently on screen. */
function inActiveScope(e: Entry): boolean {
  return e.scope === null || e.scope === activeScope;
}

/** Mark an overlay as open and topmost (idempotent — re-pushing moves it to top). */
export function pushOverlay(id: string): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i !== -1) stack.splice(i, 1);
  stack.push({ id, scope: activeScope });
}

/** Mark an overlay as closed. */
export function popOverlay(id: string): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i !== -1) stack.splice(i, 1);
}

/**
 * True when `id` is the front-most open overlay OF THE PROJECT ON SCREEN — the one Esc
 * should close. An overlay left open in a backgrounded project answers `false`, however
 * recently it was pushed: it is not on screen, so Esc is not talking to it.
 */
export function isTopOverlay(id: string): boolean {
  const entry = stack.find((e) => e.id === id);
  if (!entry || !inActiveScope(entry)) return false;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (!inActiveScope(stack[i])) continue;
    return stack[i].id === id;
  }
  return false;
}

/** Test-only: drop every entry and forget the scope. */
export function resetOverlayStack(): void {
  stack.length = 0;
  activeScope = null;
}
