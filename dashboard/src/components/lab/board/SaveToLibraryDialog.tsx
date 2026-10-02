import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import type { Block, LibraryBlock, LibraryBlockInput } from './boardTypes';
import {
  libraryDraftFrom, libraryDraftProblems, libraryPutRequest, slugSuggestion, type LibraryDraft,
} from './editorModel';
import { librarySaveError, useSaveLibraryBlock, type LibrarySaveError } from './useSaveLibraryBlock';

/**
 * "Save HTML to library": an inline html block becomes a vault library entry
 * (`lab/blocks/<slug>.md`: title, description, declared inputs, body = the
 * markup), and the block on the card becomes a reference to it. The slug
 * follows the title until the author edits it; a slug that already exists
 * replaces that entry, guarded by the rev the page last read (409 = someone
 * changed it meanwhile).
 *
 * `onSaved` hands back the stored entry; the inspector turns the block into
 * `html: {ref, inputs}` and emits the card, so the switch is one undoable edit.
 *
 * It is a centred modal portalled to `document.body`, above the page's fixed
 * overlays (the agent button in the bottom-right corner would otherwise cover
 * the actions of a panel drawn in the inspector's column).
 */

const KINDS: ReadonlyArray<LibraryBlockInput['kind']> = [null, 'series', 'table', 'value', 'funnel'];

export interface SaveToLibraryDialogProps {
  block: Block;
  library: LibraryBlock[];
  onSaved: (entry: LibraryBlock) => void;
  onClose: () => void;
}

export function SaveToLibraryDialog({ block, library, onSaved, onClose }: SaveToLibraryDialogProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<LibraryDraft>(() => libraryDraftFrom(block));
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<LibrarySaveError | null>(null);
  const [tried, setTried] = useState(false);
  const save = useSaveLibraryBlock();
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);

  const html = typeof block.options.html === 'string' ? block.options.html : '';
  const problems = libraryDraftProblems(draft, html);
  const existing = library.find((b) => b.slug === draft.slug.trim()) ?? null;
  const show = (p: (typeof problems)[number]) => tried && problems.includes(p);

  const setInput = (i: number, patch: Partial<LibraryBlockInput>) =>
    setDraft((d) => ({ ...d, inputs: d.inputs.map((inp, j) => (j === i ? { ...inp, ...patch } : inp)) }));

  const submit = () => {
    setTried(true);
    setError(null);
    if (problems.length > 0 || save.isPending) return;
    save.mutate(libraryPutRequest(draft, html, existing), {
      onSuccess: (entry) => onSaved(entry),
      onError: (err) => setError(librarySaveError(err)),
    });
  };

  return createPortal(
    <div className="lab-editor-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section
        className="lab-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('lab.editor.library.title')}
        data-lab-save-to-library-dialog
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      >
        <header className="lab-editor-dialog-head">
          <span className="lab-editor-heading">{t('lab.editor.library.title')}</span>
        </header>
        <p className="lab-editor-hint">{t('lab.editor.library.hint')}</p>

        <label className="lab-editor-field">
          <span className="lab-editor-label">{t('lab.editor.library.name')}</span>
          <input
            ref={titleRef}
            className="lab-editor-input"
            data-lab-field="library-title"
            value={draft.title}
            onChange={(e) => {
              const title = e.target.value;
              setDraft((d) => ({ ...d, title, slug: slugTouched ? d.slug : slugSuggestion(title) }));
            }}
          />
          {show('title') && <span className="lab-editor-problem">{t('lab.editor.library.titleRequired')}</span>}
        </label>

        <label className="lab-editor-field">
          <span className="lab-editor-label">{t('lab.editor.library.slug')}</span>
          <input
            className="lab-editor-input lab-editor-input--mono"
            data-lab-field="library-slug"
            value={draft.slug}
            spellCheck={false}
            onChange={(e) => { setSlugTouched(true); setDraft((d) => ({ ...d, slug: e.target.value })); }}
          />
          {show('slug') && <span className="lab-editor-problem">{t('lab.editor.library.slugInvalid')}</span>}
          {existing && !show('slug') && (
            <span className="lab-editor-hint">{t('lab.editor.library.replaces').replace('{title}', existing.title)}</span>
          )}
        </label>

        <label className="lab-editor-field">
          <span className="lab-editor-label">{t('lab.editor.library.description')}</span>
          <textarea
            className="lab-editor-input lab-editor-textarea"
            data-lab-field="library-description"
            rows={2}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </label>

        <div className="lab-editor-field" data-lab-field="library-inputs">
          <span className="lab-editor-label">{t('lab.editor.library.inputs')}</span>
          {draft.inputs.length === 0 && <span className="lab-editor-hint">{t('lab.editor.library.noInputs')}</span>}
          {draft.inputs.map((inp, i) => (
            <div key={i} className="lab-editor-row">
              <input
                className="lab-editor-input lab-editor-input--mono"
                aria-label={t('lab.editor.inputs.name')}
                value={inp.name}
                spellCheck={false}
                onChange={(e) => setInput(i, { name: e.target.value })}
              />
              <select
                className="lab-editor-input"
                aria-label={t('lab.editor.library.kind')}
                value={inp.kind ?? ''}
                onChange={(e) => setInput(i, { kind: (e.target.value || null) as LibraryBlockInput['kind'] })}
              >
                {KINDS.map((k) => (
                  <option key={k ?? ''} value={k ?? ''}>{t(k ? `lab.editor.kind.${k}` : 'lab.editor.kind.any')}</option>
                ))}
              </select>
              <button
                type="button"
                className="lab-editor-icon"
                aria-label={t('lab.editor.remove')}
                onClick={() => setDraft((d) => ({ ...d, inputs: d.inputs.filter((_, j) => j !== i) }))}
              >×</button>
            </div>
          ))}
          <button
            type="button"
            className="lab-editor-link"
            onClick={() => setDraft((d) => ({ ...d, inputs: [...d.inputs, { name: '', kind: null }] }))}
          >{t('lab.editor.inputs.add')}</button>
          {show('input-name') && <span className="lab-editor-problem">{t('lab.editor.problem.input-name')}</span>}
          {show('input-duplicate') && <span className="lab-editor-problem">{t('lab.editor.library.inputDuplicate')}</span>}
        </div>

        {show('html') && <p className="lab-editor-problem">{t('lab.editor.library.htmlEmpty')}</p>}
        {error && (
          <p className="lab-editor-problem" role="alert">
            {t(error.kind === 'conflict' ? 'lab.editor.library.conflict' : error.kind === 'invalid' ? 'lab.editor.library.invalid' : 'lab.editor.library.failed')}
            {error.kind === 'invalid' && <span className="lab-editor-detail">{error.message}</span>}
          </p>
        )}

        <div className="lab-editor-actions">
          <button type="button" className="board-btn" onClick={onClose}>{t('lab.editor.cancel')}</button>
          <button
            type="button"
            className="board-btn board-btn--on"
            data-lab-save-to-library-submit
            disabled={save.isPending}
            onClick={submit}
          >{save.isPending ? t('lab.editor.library.saving') : t('lab.editor.library.save')}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
