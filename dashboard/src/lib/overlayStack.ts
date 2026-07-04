/**
 * A tiny LIFO registry of open modal overlays (⌘K palette, ⌘P switcher, …).
 *
 * Global Escape handlers all listen on `window` in the capture phase, so when two
 * overlays are open at once the one that registered its listener FIRST would fire
 * first and swallow the Esc meant for the overlay stacked on top of it. Each
 * overlay instead pushes its id while open and its Esc handler acts only when it
 * is topmost — so Esc always closes the front-most overlay, regardless of which
 * listener the browser happens to invoke first.
 */
const stack: string[] = [];

/** Mark an overlay as open and topmost (idempotent — re-pushing moves it to top). */
export function pushOverlay(id: string): void {
  const i = stack.indexOf(id);
  if (i !== -1) stack.splice(i, 1);
  stack.push(id);
}

/** Mark an overlay as closed. */
export function popOverlay(id: string): void {
  const i = stack.indexOf(id);
  if (i !== -1) stack.splice(i, 1);
}

/** True when `id` is the front-most open overlay — the one Esc should close. */
export function isTopOverlay(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}
