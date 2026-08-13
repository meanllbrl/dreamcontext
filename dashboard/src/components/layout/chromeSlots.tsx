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
}

/** What a `Header` sees with no chrome above it (tests, storybook-style mounts): no slots,
 *  so it renders nothing — there is no bar to put controls in. */
const NO_SLOTS: ChromeSlots = { left: null, right: null };

const ChromeSlotsContext = createContext<ChromeSlots>(NO_SLOTS);

export const ChromeSlotsProvider = ChromeSlotsContext.Provider;

export function useChromeSlots(): ChromeSlots {
  return useContext(ChromeSlotsContext);
}
