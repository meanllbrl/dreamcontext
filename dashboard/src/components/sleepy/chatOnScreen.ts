/**
 * Whether a phone's chat is the thing on screen (hands-free: a chat on screen does not push its
 * question or its finished turn, D2). The phone has no list screen any more: the chat is on
 * screen when the Chat page is up in the project the owner is looking at, the window is shown,
 * and no drawer covers it. A drawer beside the chat (a portrait iPad's docked one) counts as
 * covering: a push too many is accepted, a question nobody sees is not.
 */
export function chatOnScreen(o: {
  /** The Chat page is up (the surface is expanded). */
  expanded: boolean;
  /** This project is the one in front. */
  active: boolean;
  /** The window's chat drawer is on screen. */
  drawerVisible: boolean;
  /** The window itself is shown (not hidden or folded away). */
  visible: boolean;
}): boolean {
  return o.expanded && o.active && !o.drawerVisible && o.visible;
}
