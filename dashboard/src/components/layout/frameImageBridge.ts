/**
 * The report page's picture bridge (2026-11-01, owner: "I can't click or zoom the pictures in
 * the reports, so I can't read them"). A project page shown on a card runs in the strict sandbox,
 * so a click on a picture inside it never reaches the app. This script, run in the page, posts the
 * click (the page's pictures in order + which one) so the host opens its own full-screen viewer.
 *
 * It asks nothing of the agent's HTML: any `<img>` of 48px or more (icons and ornaments stay
 * plain) is clickable. It only LISTENS (bubble phase, no preventDefault, no stopPropagation), so
 * the page's own click handlers and an `<a>` around the picture behave as they always did; a
 * click the page already handled (`defaultPrevented`, outside a link) or one on a button is left alone.
 *
 * The page's own scripts can read this script and post the same message, so the host trusts
 * nothing beyond "open these pictures": it keeps only `data:image/` sources (the host writes the
 * project's pictures into the page as data URLs; nothing else could load under the page's CSP),
 * capped in count and size, and reads the message only from that frame's own window.
 */
export const IMAGE_MESSAGE_KEY = '__dreamFrameImage';

/** Below this (either side, in CSS px) a picture is an icon or an ornament, not something to read. */
export const MIN_IMAGE_PX = 48;
export const MAX_IMAGES = 40;
export const MAX_IMAGE_CHARS = 16_000_000;

export const IMAGE_BRIDGE = `(function () {
  var MIN = ${MIN_IMAGE_PX}, MAX = ${MAX_IMAGES};
  function big(img) {
    var r = img.getBoundingClientRect();
    return r.width >= MIN && r.height >= MIN && !!(img.currentSrc || img.src);
  }
  document.addEventListener('mouseover', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && big(t) && !t.style.cursor && !t.closest('button')) t.style.cursor = 'zoom-in';
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    // A link around the picture is stopped by the page guard (preventDefault) before this runs, so
    // defaultPrevented there is not the page handling the click; elsewhere it still means that.
    if (!t || t.tagName !== 'IMG' || (e.defaultPrevented && !t.closest('a')) || !big(t) || t.closest('button')) return;
    var all = [].slice.call(document.images).filter(big);
    var i = all.indexOf(t);
    if (i < 0) return;
    var from = Math.max(0, Math.min(i - MAX + 1, all.length - MAX));
    all = all.slice(from, from + MAX);
    parent.postMessage({ ${IMAGE_MESSAGE_KEY}: { index: i - from, images: all.map(function (m) { return { src: m.currentSrc || m.src, alt: m.alt || '' }; }) } }, '*');
  });
})();`;

export interface PageImage { src: string; alt: string }
export interface ImageMessage { index: number; images: PageImage[] }

const SAFE_SRC = /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;

/** The pictures to open, or null for anything else (an unknown shape, a foreign source, no picture left). */
export function readImageMessage(data: unknown): ImageMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = (data as Record<string, unknown>)[IMAGE_MESSAGE_KEY];
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  if (!Array.isArray(r.images) || typeof r.index !== 'number' || !Number.isInteger(r.index)) return null;
  const images: PageImage[] = [];
  let index = -1;
  r.images.slice(0, MAX_IMAGES).forEach((it, n) => {
    if (!it || typeof it !== 'object') return;
    const { src, alt } = it as Record<string, unknown>;
    if (typeof src !== 'string' || src.length > MAX_IMAGE_CHARS || !SAFE_SRC.test(src)) return;
    if (n === r.index) index = images.length;
    images.push({ src, alt: typeof alt === 'string' ? alt.slice(0, 300) : '' });
  });
  // The clicked one must survive the filter: opening a different picture would be wrong.
  return index < 0 ? null : { index, images };
}

/**
 * Take the window's focus back from a card's frame once the viewer opens, so the NEXT click into the
 * page moves focus into it again (a window `blur`) and arms the gate below once more. `frame.blur()`
 * is not enough: WebKit (the desktop app) ignores it on a focused iframe, so focus stayed in the
 * page, the viewer handed it back there on close, and every later picture click armed nothing
 * (owner 2026-11-03: "I close it, click another picture, it does not open"). Focusing an element of
 * the host document moves it in every engine; the viewer then also returns focus THERE on close.
 */
export function releaseFrameFocus(frame: Element | null, anchor: HTMLElement | null): void {
  if (!frame || !anchor || frame.ownerDocument.activeElement !== frame) return;
  anchor.focus({ preventScroll: true });
}

/** Ms after the viewer closes in which the same page cannot open it again. */
export const REOPEN_COOLDOWN_MS = 500;
/** How long a click into the card's frame keeps the gate armed. */
export const ARM_TTL_MS = 1500;

/**
 * May a page's picture message open the viewer now? Only as the answer to a click INSIDE that card:
 * - `armedAt`: when the window last blurred INTO the card's frame while the pointer was over it (a
 *   real click does both; a page focusing itself under the chat or the viewer does not). It lives
 *   ARM_TTL_MS and an open uses it up, so closing the viewer cannot re-arm a page that posts on a timer;
 * - the top window holds a live user activation, where the browser reports one;
 * - the viewer did not just close.
 * A browser with no `userActivation` is not a pass: the arm alone gates it then.
 */
export function mayOpenFromFrame(o: { now: number; closedAt: number; active: boolean | undefined; armedAt: number | null }): boolean {
  if (o.armedAt === null || o.now - o.armedAt > ARM_TTL_MS) return false;
  if (o.now - o.closedAt < REOPEN_COOLDOWN_MS) return false;
  return o.active !== false;
}
