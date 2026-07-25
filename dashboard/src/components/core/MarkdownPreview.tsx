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
  // The OBJECT has to be stable, not just the string inside it. React compares the
  // `dangerouslySetInnerHTML` prop by identity — a fresh `{ __html }` literal every render
  // is always "different", so it re-writes `innerHTML` on EVERY re-render of this component,
  // even when the markdown has not changed by one character.
  //
  // That rewrite is destructive, and it is what made inline media in Chat look like it never
  // shipped: the chat-local effects turn a media reference into a `<video>`, a path into a
  // clickable chip, a code block into one with a Copy bar — and the next unrelated re-render
  // (another message streaming, a panel opening) threw all of it away and restored the raw
  // markdown, without changing any effect's deps, so nothing re-ran to put it back. What was
  // left was a live `<a href="_dream_context/…mp4">`, and in a window with no back button,
  // following one of those IS the app closing (owner report 07-25).
  //
  // With a stable object React skips the write, so a playing clip also keeps playing instead
  // of restarting on every frame of someone else's answer.
  const dangerousHtml = useMemo(() => ({ __html: html }), [html]);
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
        dangerouslySetInnerHTML={dangerousHtml}
      />
    </div>
  );
}
