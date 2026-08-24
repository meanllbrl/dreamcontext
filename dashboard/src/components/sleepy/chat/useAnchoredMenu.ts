import { useCallback, useRef, useState } from 'react';
import { useDismissOnOutside } from '../../../lib/useDismissOnOutside';

/**
 * The composer toolbar's three menus — mode+permission, model+effort, usage — as ONE piece of
 * state.
 *
 * They are not `Popover`s, and the difference is structural rather than stylistic. A
 * `Popover` portals its menu to `<body>` and clamps it to its TRIGGER; these menus are
 * full-card-width panels that line up with the composer's own edges, so they are absolutely
 * positioned children of `.chat-cmp` (which is `position: relative`) opening upward — exactly
 * how `.chat-cmp-slash` already escapes `.chat-cmp-card`'s `overflow: hidden`.
 *
 * ONE open at a time, by construction rather than by convention: `open` is a single id, so
 * opening the model menu closes the mode menu without either of them knowing the other exists.
 * That also means the toolbar can never stack two 328px panels on top of each other.
 */

export type ComposerMenuId = 'mode' | 'model' | 'usage';

/**
 * Marks the toolbar's menu triggers as "inside" for dismissal purposes.
 *
 * Without it a pointerdown on a trigger would close the open menu and the trigger's own click
 * would immediately re-open it — so clicking the open menu's own trigger could never close it.
 * Put this attribute on every button that calls {@link ComposerMenu.toggle}.
 */
export const MENU_TRIGGER_ATTR = 'data-cmp-trigger';

export interface ComposerMenu {
  open: ComposerMenuId | null;
  /** Open `id`, or close it if it is already the open one. */
  toggle: (id: ComposerMenuId) => void;
  close: () => void;
  /**
   * Attach to whichever menu is currently rendered. ONE ref serves all three because only one
   * is ever mounted — that is the same invariant `open` already enforces.
   *
   * Everything outside this element and outside a `MENU_TRIGGER_ATTR` trigger is "outside",
   * INCLUDING the rest of the composer: reaching past an open panel to go on typing in the
   * textarea should put it away, exactly as `Popover` behaves for the Attach menu beside it.
   */
  menuRef: React.RefObject<HTMLDivElement | null>;
}

export function useAnchoredMenu(): ComposerMenu {
  const [open, setOpen] = useState<ComposerMenuId | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const toggle = useCallback((id: ComposerMenuId) => {
    setOpen((cur) => (cur === id ? null : id));
  }, []);
  const close = useCallback(() => setOpen(null), []);

  useDismissOnOutside(open !== null, close, [menuRef], {
    ignoreSelector: `[${MENU_TRIGGER_ATTR}]`,
  });

  return { open, toggle, close, menuRef };
}
