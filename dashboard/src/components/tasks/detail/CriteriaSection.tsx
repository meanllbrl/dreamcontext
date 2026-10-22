import { useState } from 'react';
import { marked } from 'marked';
import { checkItems, findSection, sectionContent } from './sectionModel';
import { sanitizeTaskHtml } from './sanitize';

const SHOWN = 5;

/**
 * Acceptance Criteria as a checklist: each `- [ ]` line of the section is one checkbox; ticking
 * flips exactly that line (and its linked mermaid node) through the shell's serialized body
 * write. The first five show; "Show all" opens the rest. A section with no checkboxes renders
 * as its markdown.
 */
export function CriteriaSection({ body, onToggle }: { body: string; onToggle: (index: number, checked: boolean) => void }) {
  const [all, setAll] = useState(false);
  const items = checkItems(body, 'acceptance_criteria');
  const sec = findSection(body, 'acceptance_criteria');
  if (!sec) return null;
  const done = items.filter((i) => i.checked).length;
  if (items.length === 0) {
    const text = sectionContent(sec.text);
    if (!text) return null;
    return (
      <section className="dsec" data-section="acceptance_criteria">
        <div className="dsec-head"><h3 className="dsec-title">Acceptance Criteria</h3></div>
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: sanitizeTaskHtml(marked.parse(text) as string) }} />
      </section>
    );
  }
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <section className="dsec" data-section="acceptance_criteria">
      <div className="dsec-head">
        <h3 className="dsec-title">Acceptance Criteria</h3>
        <span className="dsec-count">{done}/{items.length}</span>
        {items.length > SHOWN && (
          <button type="button" className="dsec-action" onClick={() => setAll((v) => !v)}>{all ? 'Show less' : `Show all ${items.length}`}</button>
        )}
      </div>
      <ul className="dcrit-list">
        {shown.map((it) => (
          <li key={it.index} className="dcrit-row" data-done={it.checked || undefined}>
            <input
              type="checkbox"
              className="dcrit-box"
              checked={it.checked}
              aria-label={`Criterion ${it.index + 1}`}
              data-criterion-index={it.index}
              onChange={(e) => onToggle(it.index, e.target.checked)}
            />
            <span className="dcrit-text" dangerouslySetInnerHTML={{ __html: sanitizeTaskHtml(marked.parseInline(it.text.replace(/<!--[\s\S]*?-->/g, '').trim()) as string) }} />
          </li>
        ))}
      </ul>
    </section>
  );
}
