/**
 * The new shell's chat drawer talks to a project's chat surface through ONE queue (D5): the
 * window queues an intent for a vault, that project's `DrawerIntentBridge` takes it and rings
 * it on the instance bus, and `AgentSurface` acts on it. Facts travel the other way: the
 * surface rings `DRAWER_SURFACE_EVENT`, the instance's `DrawerFactsBridge` adds the team rows
 * and hands the lot to the window. No instance ever portals into the drawer.
 */

/** Window → surface, on the instance bus. Detail: {@link DrawerIntent}. */
export const DRAWER_INTENT_EVENT = 'dc-drawer-intent';
/** Intent bridge → the instance's Shell (a page to open). Detail: `{ page, id }`. */
export const DRAWER_PAGE_EVENT = 'dc-drawer-page';
/** Surface → its instance's facts bridge. Detail: {@link DrawerSurfaceState}. */
export const DRAWER_SURFACE_EVENT = 'dc-drawer-surface';

export type DrawerIntent =
  /** The Super Agent row: open the stage, handing over first (and starting a chat first when
   *  the project has none, F2). */
  | { kind: 'super' }
  /** "+" on a project row, or New chat window's pick: a new chat tab in this project. */
  | { kind: 'new-tab' }
  /** A chat window row: show the chat (not the stage). One window per project until W3. */
  | { kind: 'open-window'; windowId?: string }
  /** A History row: reopen THAT chat in this project (the `OPEN_SESSION` path). */
  | { kind: 'open-session'; sessionId: string }
  /** Project Relations, or an AI Team member's conversation: a page of this project. */
  | { kind: 'page'; page: 'relations' | 'automations'; id?: string };

export interface PendingDrawerIntent {
  intent: DrawerIntent;
  nonce: number;
  /** Epoch ms it was queued; stale after `DRAWER_INTENT_TTL_MS`. */
  at: number;
}

export interface DrawerSurfaceState {
  superOn: boolean;
  superSelected: boolean;
}

export function sameSurfaceState(a: DrawerSurfaceState | null, b: DrawerSurfaceState): boolean {
  return !!a && a.superOn === b.superOn && a.superSelected === b.superSelected;
}
