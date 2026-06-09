import { useEffect, type RefObject } from 'react';
import hljs from 'highlight.js/lib/common';

/**
 * React hook: syntax-highlight every non-mermaid code block inside `rootRef`
 * whenever `html` changes. highlight.js decorates the already-sanitized,
 * in-DOM `<code>` elements with `<span class="hljs-*">` tokens — so this runs
 * AFTER DOMPurify (no untrusted markup re-enters the DOM) and after the mermaid
 * pass (mermaid blocks are excluded; they're replaced with SVG separately).
 *
 * Token colors live in theme-aware CSS (MarkdownPreview.css), so highlighting
 * is class-based and does NOT need to re-run on theme change.
 */
export function useCodeHighlight(rootRef: RefObject<HTMLElement | null>, html: string): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('pre > code:not(.language-mermaid)').forEach((el) => {
      if (el.dataset.highlighted === 'yes') return;
      try {
        hljs.highlightElement(el);
      } catch {
        // Leave the block as plain (already-sanitized) text on any hljs error.
      }
    });
  }, [rootRef, html]);
}
