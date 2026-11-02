import type { Page } from '../components/layout/Sidebar';

/**
 * Switching project keeps the page (owner 2026-11-03, mdh32v): on Whiteboards, the next project
 * opens on Whiteboards; on Chat, on Chat. Each project is its own mounted instance with its own
 * page (Shell's state, remembered per project), so a switch alone showed the OTHER project's
 * last page. The project on screen publishes what it shows here; the project that comes on
 * screen reads it once and follows.
 *
 * Only the page and whether Chat is open travel, never an item id: ids are one project's own,
 * so the new project opens the page's list (or its own open item), never a blank screen.
 */
export interface ShownSurface {
  page: Page;
  /** The chat surface is open over the page (the rail's Chat). */
  chat: boolean;
}

let shown: ShownSurface | null = null;

/** The project on screen says what it shows (Shell, while active). */
export function publishShownSurface(next: ShownSurface): void {
  shown = { page: next.page, chat: next.chat };
}

/** What the project on screen last showed, or null before any project published. */
export function readShownSurface(): ShownSurface | null {
  return shown;
}

/** Tests only. */
export function _resetShownSurface(): void {
  shown = null;
}

/** What a project coming on screen does to match `carried`. */
export interface SwitchPlan {
  /** Navigate to this page (its list, no item), or null to stay on its own page. */
  navigate: Page | null;
  /** Open (true) or close (false) its chat, or null to leave it. */
  chat: boolean | null;
}

/**
 * The pure rule. `carried` is what the previous project showed; `own` is what this one shows
 * now; `canShow` says whether this project can show a page (a device shell hides some). A page
 * it cannot show keeps its own page; Chat still follows.
 */
export function planProjectSwitch(
  carried: ShownSurface | null,
  own: ShownSurface,
  canShow: (page: Page) => boolean,
): SwitchPlan {
  if (!carried) return { navigate: null, chat: null };
  const navigate = carried.page !== own.page && carried.page !== 'settings' && canShow(carried.page) ? carried.page : null;
  // A navigation collapses an open chat (AgentSurface), so it is reopened after one.
  const chat = carried.chat ? (own.chat && navigate === null ? null : true) : (own.chat ? false : null);
  return { navigate, chat };
}
