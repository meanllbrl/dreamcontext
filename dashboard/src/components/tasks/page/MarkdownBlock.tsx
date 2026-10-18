import { useEffect, useMemo, useRef } from 'react';
import { useTheme } from '../../../context/ThemeContext';
import { hasMermaidFence, renderMarkdown } from './taskMarkdown';

/**
 * One task-authored markdown block on the task surfaces, rendered through
 * {@link renderMarkdown} (marked + DOMPurify). The only `dangerouslySetInnerHTML` on these
 * surfaces lives here and is fed by that function (`task-ui-sinks.test.ts`).
 *
 * Diagrams: the mermaid code is loaded only when the text holds a ```mermaid fence, and only
 * through `lib/mermaidRender` (`initMermaid`, `securityLevel: 'strict'`).
 */
export function MarkdownBlock({ text, idPrefix, className }: { text: string; idPrefix: string; className?: string }) {
  const { resolved: theme } = useTheme();
  const html = useMemo(() => renderMarkdown(text), [text]);
  // One object per html: React re-applies the prop whenever the object is new, which would
  // throw the rendered diagrams away on every unrelated re-render.
  const inner = useMemo(() => ({ __html: html }), [html]);
  const ref = useRef<HTMLDivElement>(null);
  const diagrams = hasMermaidFence(text);

  useEffect(() => {
    const root = ref.current;
    if (!root || !diagrams) return;
    let cancelled = false;
    void import('../../../lib/mermaidRender').then(({ initMermaid, renderMermaidIn }) => {
      if (cancelled) return;
      initMermaid(theme);
      return renderMermaidIn(root, idPrefix);
    }).catch((err: unknown) => {
      console.warn('[task-page] diagram render failed', err);
    });
    return () => { cancelled = true; };
  }, [html, diagrams, theme, idPrefix]);

  return <div ref={ref} className={`markdown-body${className ? ` ${className}` : ''}`} dangerouslySetInnerHTML={inner} />;
}
