import { useEffect } from 'react';

/** The bottom-right floater the app draws on every page: the Agent button, or the session dock
 *  when sessions exist. The dock's `--floating` copy sits over the expanded overlay, not over
 *  this page, so it is not the one to clear. */
const FLOATER_SELECTOR = '.agent-fab, .agent-dock:not(.agent-dock--floating)';

/**
 * PUBLISH THE FLOATER'S CLEARANCE on `el` (`--agents-floater-clearance`), so everything under it
 * can leave room for the button that sits over the page's bottom-right corner: the feed and the
 * thread under their last row, and the page's toast, which used to land ON the button.
 *
 * It lives at the PAGE, not the feed, because the toast is the page's and shows in every view:
 * published by the feed, the members view (where "Researcher joined your agents." appears) had
 * no clearance at all. The feed and the thread inherit it from here.
 *
 * The floater is found by class and followed with a MutationObserver because it is not this
 * page's element: it mounts, unmounts and swaps for the session dock on its own.
 */
export function useFloaterClearance(el: HTMLElement | null): void {
  useEffect(() => {
    if (!el) return;
    let floater: HTMLElement | null = null;
    const publish = () => {
      if (floater?.isConnected) {
        const h = Math.round(floater.getBoundingClientRect().height);
        el.style.setProperty('--agents-floater-clearance', `calc(${h}px + var(--space-5) + var(--space-2))`);
      } else {
        el.style.removeProperty('--agents-floater-clearance');
      }
    };
    const ro = new ResizeObserver(publish);
    const findFloater = () => {
      const next = document.querySelector<HTMLElement>(FLOATER_SELECTOR);
      if (next === floater) return;
      if (floater) ro.unobserve(floater);
      floater = next;
      if (floater) ro.observe(floater);
      publish();
    };
    findFloater();
    let frame = 0;
    const mo = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; findFloater(); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
      el.style.removeProperty('--agents-floater-clearance');
    };
  }, [el]);
}
