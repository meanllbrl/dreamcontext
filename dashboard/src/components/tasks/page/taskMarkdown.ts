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
 * `javascript:` URLs before any of it reaches the document.
 *
 * `tests/unit/task-ui-sinks.test.ts` pins this: the only `dangerouslySetInnerHTML` on the task
 * surfaces is fed by this function, and this function sanitizes what `marked.parse` returns.
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html);
}

const MERMAID_FENCE_RE = /^\s*(```|~~~)\s*mermaid\b/im;

/** Whether `text` holds a ```mermaid fence: only then is the diagram code loaded at all. */
export function hasMermaidFence(text: string): boolean {
  return MERMAID_FENCE_RE.test(text);
}
