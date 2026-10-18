import { marked } from 'marked';
// Arms `==highlight==` on the shared `marked` singleton (lib/markdownMark.ts) — every parse path
// imports it for itself, because which modules a route loads is not fixed.
import { PEN_CLASSES } from '../../../lib/markdownMark';
import DOMPurify from 'dompurify';

/**
 * THE RENDERING RULE (plan r3 S4): every task-authored string on the task surfaces renders as
 * React text or through this function. A card section, a criterion, a journal body, a proposal
 * and a learned quote are all written by an agent or pulled from a remote, so they are data:
 * `marked` turns them into HTML and DOMPurify keeps only an allow-list of tags and attributes
 * (below) before any of it reaches the document.
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
 * The task surfaces' own sanitizer: an ALLOW-list on a private DOMPurify instance (its hook never
 * reaches the other DOMPurify callers: core preview, whiteboard notes, agent profiles). Only what
 * `marked` emits plus the few tags real task bodies use (synced GitHub and Firebase images,
 * `<video>`, `<details>`, `<span>`/`<div>`) is kept; everything else goes, with no exceptions to
 * remember: no `style` (element or attribute: `@import`, `url()` and page-wide rules), no SVG or
 * MathML (`<image href>`, `mask="url(…)"`), no frames, forms, buttons, objects, embeds, links,
 * metas, bases, pictures, tracks; no `on*`, `srcset`, `target`, `data-*` or `aria-*` attributes.
 *
 * Media: an `https:` image or video from another host DOES load, by the owner's choice (2026-10-19,
 * "tasklerde görseller videolar vs. de olabilir"): a synced GitHub attachment or a Firebase
 * Storage picture must show. That tells the image's host the viewer's IP when the card opens;
 * accepted. `http:` from elsewhere and every other scheme are removed (see {@link sourceAllowed}).
 */
export const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    // what marked emits (GFM, task lists, tables, ==mark==)
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'del', 's',
    'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr',
    'th', 'td', 'input',
    // what task bodies write by hand
    'details', 'summary', 'kbd', 'sub', 'sup', 'mark', 'span', 'div', 'figure', 'figcaption',
    'video', 'audio', 'source',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'alt', 'src', 'poster', 'width', 'height', 'controls', 'loop', 'muted',
    'playsinline', 'preload', 'type', 'checked', 'disabled', 'open', 'start', 'align', 'colspan',
    'rowspan', 'lang', 'dir', 'class',
  ],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};
const purify = DOMPurify();

/**
 * A URL's own scheme (`https`, `mailto`, …), or null for a relative one (`a.png`, `/x`, `#y`).
 * Control characters and spaces are dropped first, as a browser does: `java\tscript:` is a scheme.
 */
function schemeOf(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(/[\u0000-\u0020\u007f]/g, ''));
  return m ? m[1].toLowerCase() : null;
}

/** A link may go to: `http(s):`, `mailto:`, or a relative path / `#anchor` (a relative URL has no scheme). */
export function hrefAllowed(href: string): boolean {
  const scheme = schemeOf(href);
  return scheme === null || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

/**
 * Whether a media source (`src`, `poster`) may load: `https:` from anywhere (the owner's choice
 * above), this app's own origin, a relative path, and `data:image/*` on an `<img>` only. `http:`
 * from another host, `javascript:`, `blob:`, `file:` and every other scheme are removed.
 */
export function sourceAllowed(tag: string, value: string, base: string): boolean {
  const trimmed = value.trim();
  const scheme = schemeOf(trimmed);
  if (scheme !== null && scheme !== 'https' && scheme !== 'http' && scheme !== 'data') return false;
  if (scheme === 'data') return tag.toLowerCase() === 'img' && /^data:image\/[a-z0-9.+-]+[;,]/i.test(trimmed);
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.origin === new URL(base).origin;
}

/**
 * The classes a tag keeps, by tag: a `<code>` keeps `language-*` (a fenced block's language, for
 * highlighting and mermaid), a `<mark>` keeps exactly the pen classes `==!…==` / `==+…==` emit
 * (lib/markdownMark.ts), and every other tag keeps none.
 */
export function keptClasses(tag: string, value: string): string {
  const name = tag.toLowerCase();
  const keep = name === 'code' ? (c: string) => /^language-[\w#+.-]+$/.test(c)
    : name === 'mark' ? (c: string) => PEN_CLASSES.includes(c)
    : () => false;
  return value.split(/\s+/).filter(keep).join(' ');
}

/** `type` on a `<source>` is a media type and nothing else. */
export function mediaTypeAllowed(value: string): boolean {
  return /^(video|audio)\/[a-z0-9.+-]+$/i.test(value.trim());
}

// `isSupported` is false only without a DOM (the root test suite importing the pure helpers).
if (purify.isSupported) purify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;
  if (typeof el.getAttributeNames !== 'function') return;
  const tag = el.nodeName.toLowerCase();
  // An input survives only as a GFM task-list box: a disabled checkbox.
  if (tag === 'input' && !(el.getAttribute('type') === 'checkbox' && el.hasAttribute('disabled'))) {
    el.remove();
    return;
  }
  for (const name of el.getAttributeNames()) {
    const value = el.getAttribute(name) ?? '';
    if (name === 'href' && !(tag === 'a' && hrefAllowed(value))) el.removeAttribute(name);
    else if ((name === 'src' || name === 'poster') && !sourceAllowed(tag, value, window.location.href)) el.removeAttribute(name);
    else if (name === 'type' && !(tag === 'input' || (tag === 'source' && mediaTypeAllowed(value)))) el.removeAttribute(name);
    else if (name === 'class') {
      const kept = keptClasses(tag, value);
      if (kept) el.setAttribute('class', kept);
      else el.removeAttribute('class');
    }
  }
});

const MERMAID_FENCE_RE = /^\s*(```|~~~)\s*mermaid\b/im;

/** Whether `text` holds a ```mermaid fence: only then is the diagram code loaded at all. */
export function hasMermaidFence(text: string): boolean {
  return MERMAID_FENCE_RE.test(text);
}
