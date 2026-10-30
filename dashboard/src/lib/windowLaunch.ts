/**
 * How this window was launched, kept after `App.tsx` takes `&open=` off the URL. A window built
 * to land a link opens on that link's page; the new shell's open-on-Chat (6b) must not cover it.
 */
let openedForLink = false;

/** `App.tsx`, before it strips `&open=`. */
export function markOpenedForLink(): void {
  openedForLink = true;
}

export function wasOpenedForLink(): boolean {
  return openedForLink;
}
