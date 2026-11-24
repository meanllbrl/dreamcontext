/**
 * What a live-link guest sees of a whiteboard (tunel-paylasim C7, D5): the board's own drawing,
 * never the brain behind its cards. {@link guestElements} projects the scene:
 *
 *  - deleted elements and HTML frames (`iframe`) are gone;
 *  - a widget keeps its geometry and `{kind, title}` only (plus a `note`'s own text and a `todo`'s
 *    items, which live in the board file itself); its link becomes `dreamcontext://<kind>` (the
 *    viewer's widget marker), never its ref, slug, path, url or HTML body. No title: the kind
 *    alone, never a fallback to `ref`, `url` or `markdown`;
 *  - every other element loses its `customData` and keeps its `link` only when it is http(s);
 *  - a non-widget embeddable loses its link (the viewer draws no third-party frame).
 *
 * {@link guestPictureIds} lists the file ids the projected scene draws, the only ids
 * `/__share/files/:id` serves.
 */
import { WIDGET_LINK_PREFIX, widgetPayloadOf, type WhiteboardElement, type WidgetKind } from './widgets.js';

/** The widget payload a guest sees. */
export interface GuestWidget {
  v: 1;
  kind: WidgetKind;
  title?: string;
  markdown?: string;
  items?: Array<{ text: string; done: boolean }>;
  size?: string;
  color?: string;
}

const HTTP_LINK = /^https?:\/\//i;
const TITLE_MAX = 200;
const NOTE_MAX = 20_000;
const ITEMS_MAX = 200;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

function guestWidget(el: WhiteboardElement): GuestWidget | null {
  const dc = widgetPayloadOf(el);
  if (!dc) return null;
  const out: GuestWidget = { v: 1, kind: dc.kind };
  const title = str(dc.title, TITLE_MAX);
  if (title) out.title = title;
  if (typeof dc.size === 'string') out.size = dc.size;
  if (typeof dc.color === 'string') out.color = dc.color;
  if (dc.kind === 'note') {
    const md = str(dc.markdown, NOTE_MAX);
    if (md) out.markdown = md;
  }
  if (dc.kind === 'todo' && Array.isArray(dc.items)) {
    out.items = dc.items.slice(0, ITEMS_MAX).map((it) => ({
      text: typeof it?.text === 'string' ? it.text.slice(0, TITLE_MAX) : '',
      done: it?.done === true,
    }));
  }
  return out;
}

/** The scene a guest draws: see the module doc. */
export function guestElements(elements: readonly WhiteboardElement[]): WhiteboardElement[] {
  const out: WhiteboardElement[] = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object' || el.isDeleted === true) continue;
    if (el.type === 'iframe') continue;
    const widget = guestWidget(el);
    const copy: WhiteboardElement = { ...el };
    delete copy.customData;
    if (widget) {
      copy.customData = { dc: widget };
      copy.link = `${WIDGET_LINK_PREFIX}${widget.kind}`;
    } else if (el.type === 'embeddable') {
      copy.link = null;
    } else if (typeof el.link === 'string') {
      copy.link = HTTP_LINK.test(el.link) ? el.link : null;
    }
    out.push(copy);
  }
  return out;
}

/** The picture ids the projected scene draws (live image elements), each once. */
export function guestPictureIds(elements: readonly WhiteboardElement[]): Set<string> {
  const ids = new Set<string>();
  for (const el of elements) {
    if (!el || el.isDeleted === true || el.type !== 'image') continue;
    if (typeof el.fileId === 'string' && el.fileId) ids.add(el.fileId);
  }
  return ids;
}
