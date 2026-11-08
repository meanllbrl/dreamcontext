/**
 * A modal's focus rules (end review M6), pure so they are tested without a DOM: which controls
 * Tab reaches inside it, and Tab wrapping at both ends (a focus that left is brought back).
 */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab can reach inside `root`, in order (a hidden one is skipped). */
export function focusablesIn(root: { querySelectorAll(sel: string): ArrayLike<HTMLElement> } | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');
}

/** Tab past the last control goes to the first, Shift+Tab before the first to the last, and a
 *  focus that left the modal is brought back: the page under it is not reachable. */
export function trapTab(
  e: Pick<KeyboardEvent, 'shiftKey' | 'preventDefault'>,
  root: ({ querySelectorAll(sel: string): ArrayLike<HTMLElement>; contains(n: Node | null): boolean }) | null,
  active: Element | null = typeof document === 'undefined' ? null : document.activeElement,
): void {
  const items = focusablesIn(root);
  if (!root || !items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const inside = !!active && root.contains(active);
  if (!inside || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}
