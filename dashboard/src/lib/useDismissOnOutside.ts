import { useEffect, useId, useRef } from 'react';
import { pushOverlay, popOverlay, isTopOverlay } from './overlayStack';

/**
 * "This thing is open — close it on Esc or on a click somewhere else."
 *
 * EXTRACTED VERBATIM from `Popover`'s own effect (SkillPickerPopover.tsx), which is still its
 * first caller, because the redesigned composer's menus need the identical behaviour and two
 * copies of an overlay-arbitration rule is how one of them ends up swallowing an Esc the other
 * was supposed to get.
 *
 * The two things it does, and why neither is optional:
 *
 *   • ESC ARBITRATES LIFO. A portaled/absolute menu is a global overlay, so its Esc has to
 *     queue with the ⌘K palette, the ⌘P switcher and every slide-over. `pushOverlay` gives
 *     this instance a stable id on that stack and `isTopOverlay` is what stops a background
 *     panel's earlier-registered listener from eating an Esc meant for whatever is on top —
 *     and stops this one from eating an Esc meant for something stacked above it.
 *   • OUTSIDE-CLICK IS CAPTURE-PHASE `pointerdown`, not `click`. Capture so a stopPropagation
 *     somewhere in the tree can't strand the menu open, and `pointerdown` so the menu is gone
 *     before the click that dismissed it lands on whatever was underneath.
 *
 * `refs` are the regions that count as INSIDE. Everything else is outside.
 */
export function useDismissOnOutside(
  open: boolean,
  onClose: () => void,
  refs: Array<React.RefObject<HTMLElement | null>>,
  opts?: {
    /**
     * Extra "inside" region named by selector rather than by ref, matched with `closest()`
     * on the pointerdown target.
     *
     * Exists for a surface with ONE menu and SEVERAL triggers (the composer's toolbar): a
     * trigger that isn't in `refs` would be dismissed on pointerdown and then re-opened by
     * its own click, so the menu would never close by clicking its own trigger. Naming the
     * triggers by attribute is cheaper than threading a ref onto whichever one is live.
     * `Popover` passes nothing and is byte-identical to its pre-extraction behaviour.
     */
    ignoreSelector?: string;
  },
): void {
  // Stable per-instance id on the app's overlay stack. `useId` is called unconditionally at
  // the top of the hook, exactly as it was at the top of `Popover`'s body.
  const overlayId = useId();
  const ignoreSelector = opts?.ignoreSelector;

  // `onClose` and `refs` are fresh values at every call site on every render (an arrow and an
  // array literal). Held in refs and read WHEN A LISTENER FIRES, so the subscription below
  // still happens exactly ONCE PER OPEN, as it did before the extraction. Depending on them
  // directly would tear the listeners down and rebuild them once per render — wasteful, and a
  // real hazard: a pointerdown landing between teardown and re-add is simply missed.
  const live = useRef({ onClose, refs });
  live.current = { onClose, refs };

  useEffect(() => {
    if (!open) return;
    pushOverlay(overlayId);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (live.current.refs.some((r) => r.current?.contains(t))) return;
      if (ignoreSelector && t instanceof Element && t.closest(ignoreSelector)) return;
      live.current.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(overlayId)) return;
      e.stopPropagation();
      live.current.onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      popOverlay(overlayId);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, overlayId, ignoreSelector]);
}
