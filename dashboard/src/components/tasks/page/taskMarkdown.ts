import { marked } from 'marked';
// Arms `==highlight==` on the shared `marked` singleton (lib/markdownMark.ts) — every parse path
// imports it for itself, because which modules a route loads is not fixed.
import '../../../lib/markdownMark';
import DOMPurify from 'dompurify';

/**
 * THE RENDERING RULE (plan r3 S4): every task-authored string on the task surfaces renders as
 * React text or through this function. A card section, a criterion, a journal body, a proposal
 * and a learned quote are all written by an agent or pulled from a remote, so they are data:
 * `marked` turns them into HTML and DOMPurify takes out scripts, event handlers, iframes and
 * `javascript:` URLs (and, below, form controls, `style` and every remote load) before any of
 * it reaches the document.
 *
 * `tests/unit/task-ui-sinks.test.ts` pins this: the only `dangerouslySetInnerHTML` on the task
 * surfaces is fed by this function, and this function sanitizes what `marked.parse` returns.
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return purify.sanitize(html, SANITIZE_CONFIG);
}

/**
 * The task surfaces' own sanitizer: a private instance, so its hook never reaches the other
 * DOMPurify callers (core preview, whiteboard notes, agent profiles). On top of the defaults it
 * takes out form controls (a card can't draw a fake "Approve" button or a login form), every
 * `style` attribute (a `background-image: url(…)` loads too) and `srcset`, and any attribute
 * that would load from another origin the moment the owner opens the card: an `<img src>`, a
 * `<video poster>`, an `<audio src>`, an SVG `<image href>` are all tracking beacons. A `data:`
 * source or one this app serves stays; a link's `href` stays (it loads nothing until clicked).
 */
export const SANITIZE_CONFIG = {
  FORBID_TAGS: ['form', 'input', 'button', 'iframe'],
  FORBID_ATTR: ['style', 'srcset'],
};
const purify = DOMPurify();

/** Whether a source may load: inline `data:`, or this app's own origin. */
export function imageSourceAllowed(src: string, base: string): boolean {
  const trimmed = src.trim();
  if (/^data:/i.test(trimmed)) return true;
  try {
    return new URL(trimmed, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** The attributes a browser fetches as soon as the element is drawn, on any element. */
const LOADING_ATTRS = new Set(['src', 'poster', 'href', 'xlink:href', 'background']);

/**
 * Whether the sanitizer drops `attr` from a `tag` element: it loads a URL from another origin.
 * A link (`<a>`, HTML or SVG) only navigates when clicked, so its `href` is not a load.
 */
export function dropsRemoteLoad(tag: string, attr: string, value: string, base: string): boolean {
  const name = attr.toLowerCase();
  if (!LOADING_ATTRS.has(name)) return false;
  if (tag.toLowerCase() === 'a' && (name === 'href' || name === 'xlink:href')) return false;
  return !imageSourceAllowed(value, base);
}

// `isSupported` is false only without a DOM (the root test suite importing the pure helpers).
if (purify.isSupported) purify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;
  if (typeof el.getAttributeNames !== 'function') return;
  for (const name of el.getAttributeNames()) {
    const value = el.getAttribute(name);
    if (value !== null && dropsRemoteLoad(el.nodeName, name, value, window.location.href)) el.removeAttribute(name);
  }
});

const MERMAID_FENCE_RE = /^\s*(```|~~~)\s*mermaid\b/im;

/** Whether `text` holds a ```mermaid fence: only then is the diagram code loaded at all. */
export function hasMermaidFence(text: string): boolean {
  return MERMAID_FENCE_RE.test(text);
}
