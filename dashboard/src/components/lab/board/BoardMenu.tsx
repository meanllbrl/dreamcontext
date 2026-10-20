import { useRef, useState, type FormEvent } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { BoardPopover, MenuItem } from './BoardPopover';

/**
 * The board's ⋯ menu: New board, Rename, Delete, Sync board.
 *
 * New and Rename ask for a title and Delete asks to be confirmed INSIDE the
 * popover (a browser `prompt`/`confirm` does nothing in the desktop app). The
 * page does the work: it owns the board queries, the save queue and the undo
 * stack. Rename and Delete are off for an error board's missing parts: an
 * error board cannot be written (the server answers 423), only deleted.
 */

type Mode = 'menu' | 'new' | 'rename' | 'delete';

export interface BoardMenuProps {
  /** The open board's title, or null when there is no board. */
  title: string | null;
  canRename: boolean;
  canDelete: boolean;
  canSync: boolean;
  onNew: (title: string) => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onSync: () => void;
}

export function BoardMenu({ title, canRename, canDelete, canSync, onNew, onRename, onDelete, onSync }: BoardMenuProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode | null>(null);
  const [draft, setDraft] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setMode(null);
    triggerRef.current?.focus();
  };
  const ask = (next: Mode) => {
    setDraft(next === 'rename' ? title ?? '' : '');
    setMode(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    if (!value) return;
    if (mode === 'new') onNew(value);
    else if (mode === 'rename' && value !== title) onRename(value);
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="board-btn board-btn--icon"
        data-lab-board-menu
        aria-haspopup="menu"
        aria-expanded={mode !== null}
        aria-label={t('lab.board.menu.label')}
        title={t('lab.board.menu.label')}
        onClick={() => setMode((m) => (m === null ? 'menu' : null))}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {mode === 'menu' && (
        <BoardPopover key="menu" anchor={triggerRef} onClose={close} label={t('lab.board.menu.label')}>
          <MenuItem hook="new-board" onSelect={() => ask('new')}>{t('lab.board.menu.new')}</MenuItem>
          <MenuItem hook="rename-board" disabled={!canRename} onSelect={() => ask('rename')}>{t('lab.board.menu.rename')}</MenuItem>
          <MenuItem hook="sync-board" disabled={!canSync} onSelect={() => { setMode(null); onSync(); }}>{t('lab.board.menu.sync')}</MenuItem>
          <div className="board-menu-sep" role="separator" />
          <MenuItem hook="delete-board" danger disabled={!canDelete} onSelect={() => ask('delete')}>{t('lab.board.menu.delete')}</MenuItem>
        </BoardPopover>
      )}
      {(mode === 'new' || mode === 'rename') && (
        <BoardPopover key={mode} anchor={triggerRef} onClose={close} role="dialog" label={t(mode === 'new' ? 'lab.board.menu.new' : 'lab.board.menu.rename')}>
          <form className="board-form" onSubmit={submit} data-lab-board-form={mode}>
            <label className="board-form-label">
              <span>{t('lab.board.menu.titleLabel')}</span>
              <input
                className="board-input"
                value={draft}
                maxLength={80}
                placeholder={t('lab.board.menu.titlePlaceholder')}
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
            <div className="board-form-actions">
              <button type="button" className="board-btn" onClick={close}>{t('lab.board.cancel')}</button>
              <button type="submit" className="board-btn board-btn--primary" disabled={!draft.trim()}>
                {t(mode === 'new' ? 'lab.board.menu.create' : 'lab.board.menu.save')}
              </button>
            </div>
          </form>
        </BoardPopover>
      )}
      {mode === 'delete' && (
        <BoardPopover key="delete" anchor={triggerRef} onClose={close} role="dialog" label={t('lab.board.menu.delete')}>
          <div className="board-form" data-lab-board-form="delete">
            <p className="board-form-note">{t('lab.board.menu.deleteConfirm').replace('{title}', title ?? '')}</p>
            <div className="board-form-actions">
              <button type="button" className="board-btn" onClick={close}>{t('lab.board.cancel')}</button>
              <button type="button" className="board-btn board-btn--danger" onClick={() => { setMode(null); onDelete(); }}>
                {t('lab.board.menu.deleteYes')}
              </button>
            </div>
          </div>
        </BoardPopover>
      )}
    </>
  );
}
