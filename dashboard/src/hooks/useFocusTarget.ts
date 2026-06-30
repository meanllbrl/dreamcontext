import { useEffect, useRef } from 'react';

/**
 * A navigation focus request raised by the Shell. `id` is the page-specific
 * identity to open (knowledge slug, feature slug, task slug, core filename);
 * `nonce` is bumped on EVERY `navigate()` call so repeated navigations to the
 * same id still re-fire.
 */
export interface FocusTarget {
  id: string | null;
  nonce: number;
}

/**
 * Open a Shell-navigated focus target on the destination page.
 *
 * The ⌘K command palette (and the Brain map) call `navigate(page, focusId)`,
 * which the Shell records as `{ focusId, nonce }`. Pages are mounted fresh when
 * the active page changes, so on a cross-page jump this fires once on mount with
 * the target already set; on a same-page jump (palette open over the page) the
 * page does NOT remount, so we key the effect on `nonce` to re-fire. An empty /
 * null id is ignored (a plain sidebar click navigates with `focusId = null`).
 */
export function useFocusTarget(focus: FocusTarget | undefined, open: (id: string) => void): void {
  // Keep the latest `open` without making it an effect dependency, so the effect
  // fires strictly on navigation (nonce), never on every render.
  const openRef = useRef(open);
  openRef.current = open;
  const nonce = focus?.nonce ?? 0;
  useEffect(() => {
    const id = focus?.id;
    if (id) openRef.current(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
}
