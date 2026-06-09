import { useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useTheme } from '../../context/ThemeContext';
import { useMermaidRender } from '../../lib/mermaidRender';
import { useCodeHighlight } from '../../lib/codeHighlight';
import './MarkdownPreview.css';

marked.setOptions({ gfm: true, breaks: true });

interface Props {
  content: string;
  frontmatter?: Record<string, unknown>;
}

export function MarkdownPreview({ content, frontmatter }: Props) {
  // Sanitize the rendered markdown before injecting via dangerouslySetInnerHTML.
  // marked output for normal markdown (headings, lists, code, tables, links) is
  // preserved; scripts, event handlers, and javascript:/data: URLs are stripped.
  // Mermaid is unaffected — it replaces its code blocks with SVG in the live DOM
  // afterwards (see useMermaidRender), not through this HTML string.
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content) as string),
    [content],
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { resolved } = useTheme();
  useMermaidRender(bodyRef, html, resolved, 'md-mmd');
  useCodeHighlight(bodyRef, html);

  const fmEntries = frontmatter
    ? Object.entries(frontmatter).filter(([, v]) => v !== undefined && v !== null && v !== '')
    : [];

  return (
    <div className="md-preview">
      {fmEntries.length > 0 && (
        <div className="md-frontmatter">
          {fmEntries.map(([key, value]) => (
            <div key={key} className="md-fm-row">
              <span className="md-fm-key">{key}</span>
              <span className="md-fm-value">{String(value)}</span>
            </div>
          ))}
        </div>
      )}
      <div
        ref={bodyRef}
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
