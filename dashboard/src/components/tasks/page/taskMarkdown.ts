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
 * `javascript:` URLs (and, below, form controls and remote images) before any of it reaches
 * the document.
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
 * takes out form controls (a card can't draw a fake "Approve" button or a login form) and any
 * image that would load from another origin (a remote `<img>` is a tracking beacon the moment
 * the owner opens the card). A `data:` image or one this app serves stays.
 */
const SANITIZE_CONFIG = { FORBID_TAGS: ['form', 'input', 'button', 'iframe'] };
const purify = DOMPurify();

/** Whether an image source may load: inline `data:`, or this app's own origin. */
export function imageSourceAllowed(src: string, base: string): boolean {
  const trimmed = src.trim();
  if (/^data:/i.test(trimmed)) return true;
  try {
    return new URL(trimmed, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

// `isSupported` is false only without a DOM (the root test suite importing the pure helpers).
if (purify.isSupported) purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'IMG') return;
  const el = node as Element;
  el.removeAttribute('srcset');
  const src = el.getAttribute('src');
  if (src !== null && !imageSourceAllowed(src, window.location.href)) el.removeAttribute('src');
});

const MERMAID_FENCE_RE = /^\s*(```|~~~)\s*mermaid\b/im;

/** Whether `text` holds a ```mermaid fence: only then is the diagram code loaded at all. */
export function hasMermaidFence(text: string): boolean {
  return MERMAID_FENCE_RE.test(text);
}
