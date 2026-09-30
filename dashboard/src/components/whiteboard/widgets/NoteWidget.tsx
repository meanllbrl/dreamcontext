import { useMemo, useState } from 'react';
import { useWbText, useWhiteboardHost } from '../whiteboardHost';
import { WidgetButton, WidgetFrame, WidgetNotice, useOpenEditorWhenEmpty } from './WidgetFrame';
import { renderBoardNote } from './noteSanitize';
import type { WidgetProps } from './types';
// The app's markdown styles, so a note reads like every other rendered document.
import '../../core/MarkdownPreview.css';

/** A markdown note, rendered through the board-note sanitize profile (`noteSanitize.ts`). */
export function NoteWidget({ elementId, payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const host = useWhiteboardHost();
  const markdown = payload.markdown ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const html = useMemo(() => renderBoardNote(markdown), [markdown]);
  const title = payload.title || tx('whiteboard.kind.note', 'Note');
  const editing = active && draft !== null;
  useOpenEditorWhenEmpty(active, !markdown.trim(), draft, setDraft);

  const save = () => {
    if (draft === null) return;
    const next = draft;
    host.commitWidget(elementId, (cur) => ({ ...cur, markdown: next }));
    setDraft(null);
  };

  return (
    <WidgetFrame
      kind="note"
      title={title}
      active={active}
      size={size}
      actions={!editing && (
        <WidgetButton onClick={() => setDraft(markdown)}>{tx('whiteboard.widget.edit', 'Edit')}</WidgetButton>
      )}
    >
      {editing ? (
        <div className="wb-editor">
          <textarea
            className="wb-textarea"
            value={draft ?? ''}
            autoFocus
            placeholder={tx('whiteboard.note.placeholder', 'Write markdown…')}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="wb-editor-actions">
            <WidgetButton onClick={() => setDraft(null)}>{tx('whiteboard.widget.cancel', 'Cancel')}</WidgetButton>
            <WidgetButton onClick={save}>{tx('whiteboard.widget.save', 'Save')}</WidgetButton>
          </div>
        </div>
      ) : markdown.trim() ? (
        // Sanitized by renderBoardNote (DOMPurify, board-note profile) on the line above.
        <div className="md-preview"><div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} /></div>
      ) : (
        <WidgetNotice tone="empty" onClick={() => setDraft('')}>{tx('whiteboard.note.emptyAction', 'Empty note. Click to write.')}</WidgetNotice>
      )}
    </WidgetFrame>
  );
}
