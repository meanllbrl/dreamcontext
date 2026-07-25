/**
 * Links, in a window with no browser chrome.
 *
 * The desktop app is one WKWebView: no address bar, no back button, no tabs. A plain
 * `<a href="https://…">` click navigates THAT webview away and the app is gone until
 * it is quit and reopened — there is nothing to go back with. ⌘-click is worse, since
 * WKWebView raises a new-window request the shell doesn't serve.
 *
 * So every absolute link goes to the OS default browser instead. This is installed
 * once, on the document, in capture phase — chat answers, knowledge and task
 * documents, announcements, the About page all inherit it with no per-surface wiring,
 * which matters because the markdown surfaces render links the app never authored.
 *
 * Relative links are left alone: they are in-app routes and download endpoints, and
 * the router owns them.
 */

import { openExternalUrl } from './desktop';

/** Schemes the OS may be handed. Everything else stays inside the page or is dropped. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * The URL an `href` should open in the browser, or null to leave the click alone.
 *
 * Absolute-only by design. A relative href (`/tasks`, `src/server/index.ts`, `#top`)
 * is in-app and must not be handed to the OS; `javascript:`, `data:`, `blob:` and
 * `file:` are absolute but never safe to open, so the scheme is allow-listed rather
 * than deny-listed. Same-origin absolute URLs DO go to the browser: an answer that
 * writes out `http://127.0.0.1:53628` means the address, not "reload yourself".
 */
export function externalHref(href: string | null | undefined): string | null {
  const raw = (href ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Protocol-relative (`//example.com`) is absolute in effect — the browser would
    // leave the app for it — so resolve it the way the page would before giving up.
    if (!raw.startsWith('//')) return null;
    try { url = new URL(`https:${raw}`); } catch { return null; }
  }
  return EXTERNAL_SCHEMES.has(url.protocol) ? url.href : null;
}

/** The shape of a click this module reads — kept structural so it is testable without a DOM. */
interface LinkClick {
  type: string;
  button: number;
  defaultPrevented: boolean;
  target: unknown;
}

/** An element far enough along to answer "which link was clicked, and where does it point". */
interface AnchorLike {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

function isAnchorLike(value: unknown): value is AnchorLike {
  return !!value && typeof (value as AnchorLike).closest === 'function';
}

/**
 * Decide a single click: the URL to hand the OS, or null to let the page have it.
 *
 * Reads `getAttribute('href')`, never the `.href` property — the property resolves a
 * relative href against the current page, which would make every in-app link look
 * absolute and external.
 */
export function externalUrlForClick(e: LinkClick): string | null {
  if (e.defaultPrevented) return null;
  // Left click (incl. ⌘/ctrl/shift-modified — the reported break) and middle click,
  // which asks for a new tab. Right click belongs to the context menu.
  if (e.type === 'auxclick' ? e.button !== 1 : e.button !== 0) return null;
  if (!isAnchorLike(e.target)) return null;
  const anchor = e.target.closest('a[href]');
  return anchor ? externalHref(anchor.getAttribute('href')) : null;
}

/**
 * Route every external link on the page to the default browser. Returns a teardown
 * function; call once at startup.
 */
export function installExternalLinkHandler(doc: Document = document): () => void {
  const onClick = (e: Event): void => {
    const url = externalUrlForClick(e as unknown as LinkClick);
    if (!url) return;
    e.preventDefault();
    void openExternalUrl(url);
  };
  // Capture phase, so a surface that stops propagation on its own container (the chat
  // transcript does, for selection handling) can't swallow the link first.
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onClick, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('auxclick', onClick, true);
  };
}
