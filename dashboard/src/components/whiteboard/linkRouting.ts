/**
 * Element links on a whiteboard (D3, "Element links").
 *
 * Excalidraw's fallback for a clicked element link is `window.open(…, _self|_blank)` followed by
 * `.location = url`. In the desktop shell that can replace the app window with a page that has
 * no back button, and a relative `/api/...` link would point the window at our own server. So
 * `onLinkOpen` ALWAYS prevents the default as its first statement, before anything that could
 * throw, and only then decides where the link goes:
 *
 *   - `dreamcontext://` goes to the in-app handler;
 *   - an absolute http/https/mailto/tel link to ANOTHER origin goes to `openExternalUrl`;
 *   - everything else (relative, same-origin, `javascript:`, `data:`…) is dropped with a toast.
 *
 * No React, no CSS, no Excalidraw import: root vitest imports this file.
 */
import { externalHref } from '../../lib/externalLinks';
import { WIDGET_LINK_PREFIX } from '../../lib/whiteboardWidgets';
import { parseWidgetLink } from './widgetModel';

export type LinkRoute =
  | { to: 'internal'; kind: string; id: string }
  | { to: 'external'; url: string }
  | { to: 'drop'; reason: 'relative' | 'same-origin' | 'scheme' | 'malformed' };

/** Where a link goes. Pure: no side effects, no globals. */
export function routeElementLink(link: string | null | undefined, ownOrigin: string): LinkRoute {
  const raw = (link ?? '').trim();
  if (raw.startsWith(WIDGET_LINK_PREFIX)) {
    const parsed = parseWidgetLink(raw);
    return parsed ? { to: 'internal', ...parsed } : { to: 'drop', reason: 'malformed' };
  }
  const url = externalHref(raw);
  if (!url) {
    // externalHref already refuses relative hrefs and non-allow-listed schemes; say which.
    let absolute = false;
    try { new URL(raw); absolute = true; } catch { /* relative */ }
    return { to: 'drop', reason: absolute ? 'scheme' : 'relative' };
  }
  let origin: string | null = null;
  try { origin = new URL(url).origin; } catch { /* mailto/tel have an opaque origin */ }
  if (origin && origin !== 'null' && origin === ownOrigin) return { to: 'drop', reason: 'same-origin' };
  return { to: 'external', url };
}

export interface LinkOpenDeps {
  ownOrigin: string;
  openExternal: (url: string) => void;
  openInternal: (kind: string, id: string) => void;
  toast: (message: string) => void;
  /** The toast text for a dropped link. */
  droppedMessage?: string;
}

/**
 * The `onLinkOpen` handler. `preventDefault()` is the FIRST statement, so a throw anywhere below
 * it can never re-enable Excalidraw's `window.open` fallback.
 */
export function handleLinkOpen(
  element: { link?: string | null },
  event: { preventDefault(): void },
  deps: LinkOpenDeps,
): LinkRoute {
  event.preventDefault();
  let route: LinkRoute;
  try {
    route = routeElementLink(element.link, deps.ownOrigin);
  } catch {
    route = { to: 'drop', reason: 'malformed' };
  }
  if (route.to === 'internal') deps.openInternal(route.kind, route.id);
  else if (route.to === 'external') deps.openExternal(route.url);
  else deps.toast(deps.droppedMessage ?? 'This link cannot be opened from a whiteboard.');
  return route;
}

/** The selector of the anchor Excalidraw renders in its link popup. */
export const HYPERLINK_SELECTOR = '.excalidraw-hyperlinkContainer-link';

/** The DOM shape the guard reads off an event target: kept structural for tests. */
interface AnchorLike { closest(selector: string): { getAttribute(name: string): string | null } | null }

function hyperlinkAnchor(target: unknown) {
  const t = target as Partial<AnchorLike> | null;
  return t && typeof t.closest === 'function' ? t.closest(HYPERLINK_SELECTOR) : null;
}

/**
 * The link popup's anchor, taken before ANY other listener sees the click.
 *
 * WHY `window`, CAPTURE PHASE. The app installs a document-level capture `click`/`auxclick`
 * handler (`installExternalLinkHandler`, main.tsx) that hands every absolute http(s) href to
 * the OS. Excalidraw's popup is a real `<a href>` and only calls `onLinkOpen` from React's
 * `onClick`, which runs AFTER that document handler. So a same-origin absolute link
 * (`http://127.0.0.1:<port>/api/…`) was opened with `window.open` before `onLinkOpen` ever
 * ran. A capture listener on `window` fires before anything on `document`: here the click is
 * cancelled and stopped, and routed through `onClick` (which the canvas wires to
 * `handleLinkOpen`) instead. A middle-click (`auxclick`) is cancelled and routed nowhere.
 *
 * `scope` is the board's own wrapper, so another board's popup is left to its own guard.
 * Returns the uninstaller.
 */
export function installHyperlinkGuard(
  win: EventTarget,
  scope: { contains(node: never): boolean },
  onClick: (href: string | null, event: { preventDefault(): void }) => void,
): () => void {
  const onEvent = (event: Event) => {
    const anchor = hyperlinkAnchor(event.target);
    if (!anchor || !scope.contains(anchor as never)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'click') onClick(anchor.getAttribute('href'), event);
  };
  win.addEventListener('click', onEvent, true);
  win.addEventListener('auxclick', onEvent, true);
  return () => {
    win.removeEventListener('click', onEvent, true);
    win.removeEventListener('auxclick', onEvent, true);
  };
}
