/**
 * When a board widget has to re-render.
 *
 * Excalidraw renders every embeddable it has initialised on EVERY render of its App: each pan or
 * zoom frame, each poll tick that touches the page, each pointer move. Unmemoised, a board with
 * twenty widgets re-renders twenty React subtrees per frame (measured: ~1,800 widget renders in a
 * 3 s pan). A widget's output depends only on its element and on whether it is the active
 * embeddable, so the slot re-renders when one of those changed and never on a mere frame.
 *
 * The element is compared by identity AND by `version`: Excalidraw's `mutateElement` changes an
 * element IN PLACE during a drag or a resize (same object, new width / height, bumped version),
 * so identity alone would freeze a widget mid-resize.
 *
 * No React, no CSS, no Excalidraw import: root vitest imports this file.
 */

export interface WidgetSlotProps<E extends { version: number }> {
  element: E;
  /** The element's version when this slot was rendered: in-place mutation bumps it. */
  version: number;
  active: boolean;
}

export function widgetSlotProps<E extends { version: number }>(element: E, active: boolean): WidgetSlotProps<E> {
  return { element, version: element.version, active };
}

/** `React.memo`'s equality: true when the slot would render the same thing. */
export function sameWidgetSlot<E extends { version: number }>(a: WidgetSlotProps<E>, b: WidgetSlotProps<E>): boolean {
  return a.element === b.element && a.version === b.version && a.active === b.active;
}
