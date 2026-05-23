import { useMemo, useRef } from 'react';
import { marked } from 'marked';
import { useTheme } from '../../context/ThemeContext';
import { useMermaidRender } from '../../lib/mermaidRender';
import './MarkdownPreview.css';

marked.setOptions({ gfm: true, breaks: true });

interface Props {
  content: string;
  frontmatter?: Record<string, unknown>;
}

export function MarkdownPreview({ content, frontmatter }: Props) {
  const html = useMemo(() => marked.parse(content) as string, [content]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { resolved } = useTheme();
  useMermaidRender(bodyRef, html, resolved, 'md-mmd');

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
