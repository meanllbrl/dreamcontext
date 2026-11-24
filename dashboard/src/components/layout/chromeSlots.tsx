import { createContext, useContext } from 'react';

/**
 * The title bar's per-project slots.
 *
 * The window has ONE bar, but the collapse toggle, the search pill and the sleep tracker
 * belong to whichever PROJECT is on screen — they read that instance's query cache, bus and
 * palette state, so they cannot be hoisted into `WindowChrome` without severing them from
 * their providers. Instead the chrome publishes two mount points and the active instance's
 * `Header` portals its controls into them. Only the ACTIVE instance renders into the slots;
 * a hidden instance renders nothing, because a portal escapes the `.project-instance`
 * subtree and would ignore its `hidden`/`inert` shroud entirely.
 */
export interface ChromeSlots {
  /** Left of the chip strip: the rail toggle and the search pill. */
  left: HTMLElement | null;
  /** Right of the chip strip, before the window controls: sleep tracker + update badge. */
  right: HTMLElement | null;
  /** The new shell only: the active project's `Rail`, left of the page frame (device shells). */
  rail?: HTMLElement | null;
  /** The local new shell: the active project's page tabs, in the title bar (tek-kenar C7). */
  tabs?: HTMLElement | null;
  /** The local new shell: the active project's board explorer, under its row in the sidebar's
   *  boards mode (tek-kenar C4), and its New board / New folder above Settings. */
  boards?: HTMLElement | null;
  boardsFoot?: HTMLElement | null;
}

/** What a `Header` sees with no chrome above it (tests, storybook-style mounts): no slots,
 *  so it renders nothing — there is no bar to put controls in. */
const NO_SLOTS: ChromeSlots = { left: null, right: null };

const ChromeSlotsContext = createContext<ChromeSlots>(NO_SLOTS);

export const ChromeSlotsProvider = ChromeSlotsContext.Provider;

export function useChromeSlots(): ChromeSlots {
  return useContext(ChromeSlotsContext);
}
