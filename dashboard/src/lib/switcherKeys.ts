/**
 * Where a key goes while the ⌘P project switcher is open.
 *
 * The switcher's input takes focus, but a composer, a terminal or the whiteboard behind it can
 * still hold or regain it (a frame passes before the focus lands; a pane may refocus itself).
 * Letters then leak into that surface and Enter opens the first row. So while the switcher is
 * open, every key aimed OUTSIDE it is claimed by it: text and nav keys are routed into the
 * switcher, nothing reaches the page behind.
 *
 * Pure so a test can prove the routing without a DOM.
 */
export type SwitcherKeyRoute =
  | { kind: 'pass' }              // aimed inside the switcher, or a chord it doesn't own (⌘P, ⌘1-9, Esc)
  | { kind: 'type'; text: string }
  | { kind: 'backspace' }
  | { kind: 'enter'; shift: boolean }
  | { kind: 'move'; dir: 1 | -1 }
  | { kind: 'swallow' };          // owned by the switcher, no effect (keeps the page behind quiet)

export interface SwitcherKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** The event target sits inside the switcher dialog. */
  inside: boolean;
  /** The event is aimed at ANOTHER modal (⌘K palette, a dialog) stacked over or beside it. */
  otherModal?: boolean;
  /** The event is part of an IME composition. */
  composing?: boolean;
}

export function routeSwitcherKey(k: SwitcherKeyInput): SwitcherKeyRoute {
  if (k.inside || k.composing || k.otherModal) return { kind: 'pass' };
  // Chords and Esc keep their own owners (⌘P toggle, ⌘1-9, CommandModal's Esc).
  if (k.metaKey || k.ctrlKey || k.altKey || k.key === 'Escape') return { kind: 'pass' };
  if (k.key === 'Enter') return { kind: 'enter', shift: false };
  if (k.key === 'Backspace') return { kind: 'backspace' };
  if (k.key === 'ArrowDown') return { kind: 'move', dir: 1 };
  if (k.key === 'ArrowUp') return { kind: 'move', dir: -1 };
  if (k.key.length === 1) return { kind: 'type', text: k.key };
  if (k.key === 'Tab') return { kind: 'pass' };
  return { kind: 'swallow' };
}
