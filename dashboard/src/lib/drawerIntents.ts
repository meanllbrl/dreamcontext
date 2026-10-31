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
  /** A new chat tab in this project's window on screen. */
  | { kind: 'new-tab' }
  /** "+" on a project row, ⌘N or New chat window's pick: a new named chat window (W3, D8). */
  | { kind: 'new-window' }
  /** A chat window row: show that window's chats (not the stage). */
  | { kind: 'open-window'; windowId?: string }
  /** A window row's Rename (inline in the drawer; a blank name reverts). */
  | { kind: 'rename-window'; windowId: string; name: string }
  /** A window row's Close window: its tabs close; the last window empties to a fresh tab. */
  | { kind: 'close-window'; windowId: string }
  /** A History row: reopen THAT chat in this project (the `OPEN_SESSION` path). */
  | { kind: 'open-session'; sessionId: string }
  /** An AI Team member's conversation: opens in the chat area, never on the AI Team page. */
  | { kind: 'member'; slug: string; title: string }
  /** Project Relations: a page of this project. */
  | { kind: 'page'; page: 'relations'; id?: string };

export interface PendingDrawerIntent {
  intent: DrawerIntent;
  nonce: number;
  /** Epoch ms it was queued; stale after `DRAWER_INTENT_TTL_MS`. */
  at: number;
}

/** One chat window as the drawer's row draws it: its name and its own ring and count. */
export interface DrawerWindowFact {
  id: string;
  name: string;
  working: number;
  asking: number;
  flagged: number;
  other: number;
}

export interface DrawerSurfaceState {
  superOn: boolean;
  superSelected: boolean;
  /** The project's chat windows, in order (W3). Absent from a surface that predates them. */
  windows?: DrawerWindowFact[];
  /** The window on screen. */
  activeWindowId?: string;
  /** The owner's chats alone, for the project's ring: the Super's never count there. */
  shown?: { live: number; asking: number; working: number; flagged: number };
  /** The AI Team member whose conversation the chat area shows. */
  member?: string;
  /** The Super Agent row's marks (`superRowMarks`). */
  superMarks?: { working: number; asking: boolean };
}

export function sameSurfaceState(a: DrawerSurfaceState | null, b: DrawerSurfaceState): boolean {
  return !!a && a.superOn === b.superOn && a.superSelected === b.superSelected
    && a.activeWindowId === b.activeWindowId && a.member === b.member && JSON.stringify([a.shown, a.superMarks]) === JSON.stringify([b.shown, b.superMarks])
    && JSON.stringify(a.windows ?? []) === JSON.stringify(b.windows ?? []);
}
