/**
 * The new shell's chat drawer talks to a project's chat surface through ONE queue (D5): the
 * window queues an intent for a vault, that project's `DrawerIntentBridge` takes it and rings
 * it on the instance bus, and `AgentSurface` acts on it. Facts travel the other way: the
 * surface rings `DRAWER_SURFACE_EVENT`, the instance's `DrawerFactsBridge` adds the team rows
 * and hands the lot to the window. No instance ever portals into the drawer.
 */
import type { HomeRow } from '../components/sleepy/phoneHome';
import type { StackTab } from '../components/sleepy/phoneStack';

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
  /** A window row's Close window: its tabs close; nothing opens in their place, even in the last window. */
  | { kind: 'close-window'; windowId: string }
  /** A window row dragged: it lands before `before` (null = the end). Nothing else changes, not
   *  even which project is on screen. */
  | { kind: 'move-window'; windowId: string; before: string | null }
  /** A History row: reopen THAT chat in this project (the `OPEN_SESSION` path). */
  | { kind: 'open-session'; sessionId: string }
  /** A chat row: show that chat. A tab is selected, a running chat of the Mac is ADOPTED (never
   *  resumed beside it), a Super row opens the Super (`openChatPlan`). */
  | { kind: 'open-chat'; row: HomeRow }
  /** A chat row's close: the tab closes, as the tab strip's close does. Nothing else moves, not
   *  even which project is on screen. */
  | { kind: 'close-chat'; id: string }
  /** An AI Team member's stage (plan-r10 1, 1c): its Super, its ONE conversation, in this project.
   *  `task` (a task slug): the stage opens with that task's strip on top. */
  | { kind: 'member'; slug: string; title: string; task?: string }
  /** Project Relations: a page of this project. */
  | { kind: 'page'; page: 'relations'; id?: string };

/** A task slug a member intent may carry (the task-slug charset, no 64 cap: slugs reach ~100). */
const TASK_SLUG = /^[a-z0-9][a-z0-9-]{0,251}$/;
/** A member slug (the agents' charset). */
const MEMBER_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** The member intent, checked: a bad slug is no intent, a bad task is dropped (the stage still opens). */
export function memberIntent(slug: unknown, title: unknown, task?: unknown): Extract<DrawerIntent, { kind: 'member' }> | null {
  if (typeof slug !== 'string' || !MEMBER_SLUG.test(slug)) return null;
  const name = typeof title === 'string' && title.trim() ? title.trim() : slug;
  return typeof task === 'string' && TASK_SLUG.test(task)
    ? { kind: 'member', slug, title: name, task }
    : { kind: 'member', slug, title: name };
}

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
  /** Every tab it holds, saved ones too (`other` counts live ones only). 0: nothing to open. */
  tabs: number;
}

/** A click that opens something on the chat area: the project lands on it from its first frame
 *  (`AgentSurface`'s arrival), never on the page it would otherwise start on. */
export function landsOnChat(intent: DrawerIntent): boolean {
  return intent.kind !== 'rename-window' && intent.kind !== 'close-window' && intent.kind !== 'move-window'
    && intent.kind !== 'close-chat' && intent.kind !== 'page';
}

/** One chat tab a mounted project publishes for the drawer's chat rows: the phone stack's tab
 *  fields (so the tunnel's `homeRows` reads the same shape) and the window it sits in. */
export interface DrawerChatFact extends StackTab {
  windowId: string;
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
  /** The owner's chat tabs, each in its window (never a child of the Super). Absent until the
   *  roster is restored, like `windows`. */
  chats?: DrawerChatFact[];
  /** The tab on screen in the window on screen. */
  activeChatId?: string;
}

export function sameSurfaceState(a: DrawerSurfaceState | null, b: DrawerSurfaceState): boolean {
  return !!a && a.superOn === b.superOn && a.superSelected === b.superSelected
    && a.activeWindowId === b.activeWindowId && a.member === b.member && JSON.stringify([a.shown, a.superMarks]) === JSON.stringify([b.shown, b.superMarks])
    && JSON.stringify(a.windows ?? []) === JSON.stringify(b.windows ?? [])
    && a.activeChatId === b.activeChatId && JSON.stringify(a.chats ?? null) === JSON.stringify(b.chats ?? null);
}
