/**
 * The board tab strip's two panels (A16): "All boards" (search, open, delete) and "New board".
 * The strip that opens them is BoardTabs.tsx.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  useCreateWhiteboard, useDeleteWhiteboard, useWhiteboardList, type WhiteboardSummary,
} from '../../hooks/useWhiteboards';
import {
  DEFAULT_BOARD_SLUG, canDeleteBoard, filterBoards, isDefaultBoard, moveActive, newBoardName, pickActive,
} from './boardSwitcherLogic';
import './BoardSwitcher.css';

// ── All boards ───────────────────────────────────────────────────────────────────────────────

export function BoardsPanel({ current, onOpen, onNew }: {
  current: string;
  onOpen: (slug: string) => void;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const { data: boards, isLoading, isError, error, refetch } = useWhiteboardList();
  // Opening the panel asks again: a board the CLI or an agent made a second ago must be in it,
  // whatever the list cache's age. The cached rows show meanwhile.
  useEffect(() => { void refetch(); }, [refetch]);
  const [query, setQuery] = useState('');
  const list = useMemo(() => filterBoards(boards ?? [], query), [boards, query]);
  const [active, setActive] = useState(0);
  // Two clicks, not `confirm()`: a browser dialog is a silent no-op in the desktop webview.
  const [confirming, setConfirming] = useState<string | null>(null);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  // A new query starts the highlight at the top; a list that shrank keeps it in range.
  useEffect(() => { setActive(0); }, [query]);
  const activeIndex = moveActive(active, '', list.length);

  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const board = pickActive(list, activeIndex);
      if (board) onOpen(board.slug);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setConfirming(null);
      setActive(moveActive(activeIndex, e.key, list.length));
    }
  };

  const optionId = (slug: string) => `${listId}-${slug}`;
  const activeBoard = pickActive(list, activeIndex);

  return (
    <div className="wbs-panel wbs-panel--boards" role="dialog" aria-label={t('whiteboard.switcher.boards')}>
      <div className="wbs-search">
        <SearchGlyph />
        <input
          className="wbs-search-input"
          autoFocus
          value={query}
          placeholder={t('whiteboard.switcher.search')}
          aria-label={t('whiteboard.switcher.search')}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeBoard ? optionId(activeBoard.slug) : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      {isLoading && <p className="wbs-note">{t('common.loading')}</p>}
      {isError && <p className="wbs-note wbs-note--bad">{t('whiteboard.page.loadFailed')} {error?.message}</p>}
      {!isLoading && !isError && list.length === 0 && (
        <p className="wbs-note">{t('whiteboard.switcher.noMatch')}</p>
      )}

      {list.length > 0 && (
        <ul className="wbs-list" id={listId} role="listbox" ref={listRef} aria-label={t('whiteboard.switcher.boards')}>
          {list.map((board, i) => (
            <BoardRow
              key={board.slug}
              id={optionId(board.slug)}
              board={board}
              current={board.slug === current}
              active={i === activeIndex}
              confirming={confirming === board.slug}
              onHover={() => setActive(i)}
              onOpen={() => onOpen(board.slug)}
              onAskDelete={() => setConfirming(board.slug)}
              onCancelDelete={() => setConfirming(null)}
              onDeleted={() => {
                setConfirming(null);
                // The open board is gone: land on the default one rather than a dead canvas.
                if (board.slug === current) onOpen(DEFAULT_BOARD_SLUG);
              }}
            />
          ))}
        </ul>
      )}

      <div className="wbs-foot">
        <button type="button" className="wbs-foot-btn" onClick={onNew}>
          <PlusGlyph /> {t('whiteboard.switcher.new')}
        </button>
        <span className="wbs-foot-hint" aria-hidden="true">↑↓ ↵ esc</span>
      </div>
    </div>
  );
}

function BoardRow({
  id, board, current, active, confirming, onHover, onOpen, onAskDelete, onCancelDelete, onDeleted,
}: {
  id: string;
  board: WhiteboardSummary;
  current: boolean;
  active: boolean;
  confirming: boolean;
  onHover: () => void;
  onOpen: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const del = useDeleteWhiteboard();
  const updated = board.updatedAt ? new Date(board.updatedAt) : null;
  const count = board.elements ?? 0;
  const label = board.name || board.slug;

  if (confirming) {
    return (
      <li className="wbs-row wbs-row--confirm" id={id} role="option" aria-selected={active} data-active={active ? '' : undefined}>
        <span className="wbs-confirm-text">{t('whiteboard.switcher.deleteAsk').replace('{name}', label)}</span>
        {del.isError && <span className="wbs-confirm-error">{del.error?.message}</span>}
        <span className="wbs-confirm-actions">
          <button type="button" className="wbs-btn" autoFocus onClick={onCancelDelete}>
            {t('whiteboard.widget.cancel')}
          </button>
          <button
            type="button"
            className="wbs-btn wbs-btn--danger"
            disabled={del.isPending}
            onClick={() => del.mutate(board.slug, { onSuccess: onDeleted })}
          >
            {t('whiteboard.page.delete')}
          </button>
        </span>
      </li>
    );
  }

  return (
    <li
      className="wbs-row"
      id={id}
      role="option"
      aria-selected={active}
      aria-current={current ? 'page' : undefined}
      data-active={active ? '' : undefined}
      onMouseEnter={onHover}
    >
      <button type="button" className="wbs-row-open" tabIndex={-1} onClick={onOpen} title={board.description || undefined}>
        <span className="wbs-row-check" aria-hidden="true">{current ? <CheckGlyph /> : null}</span>
        <span className="wbs-row-text">
          <span className="wbs-row-name">
            {label}
            {isDefaultBoard(board.slug) && <span className="wbs-badge">{t('whiteboard.switcher.default')}</span>}
          </span>
          <span className="wbs-row-meta">
            {board.corrupt
              ? <span className="wbs-row-corrupt">{t('whiteboard.page.corruptBadge')}</span>
              : count === 1
                ? t('whiteboard.switcher.elementsOne')
                : t('whiteboard.page.elements').replace('{n}', String(count))}
            {updated && !Number.isNaN(updated.getTime()) && <> · {updated.toLocaleDateString()}</>}
          </span>
        </span>
      </button>
      {canDeleteBoard(board.slug) && (
        <button
          type="button"
          className="wbs-row-delete"
          aria-label={`${t('whiteboard.page.delete')} ${label}`}
          title={t('whiteboard.page.delete')}
          onClick={onAskDelete}
        >
          <TrashGlyph />
        </button>
      )}
    </li>
  );
}

// ── New board ────────────────────────────────────────────────────────────────────────────────

export function CreatePanel({ onCreated }: { onCreated: (slug: string) => void }) {
  const { t } = useI18n();
  const create = useCreateWhiteboard();
  const [name, setName] = useState('');
  const valid = newBoardName(name);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || create.isPending) return;
    create.mutate({ name: valid, description: '' }, {
      onSuccess: (res) => { if (res?.slug) onCreated(res.slug); },
    });
  };

  return (
    <form className="wbs-panel wbs-panel--create" role="dialog" aria-label={t('whiteboard.switcher.new')} onSubmit={submit}>
      <label className="wbs-create-label" htmlFor="wbs-create-name">{t('whiteboard.switcher.new')}</label>
      <div className="wbs-create-row">
        <input
          id="wbs-create-name"
          className="wbs-create-input"
          autoFocus
          value={name}
          maxLength={200}
          placeholder={t('whiteboard.page.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="wbs-primary" disabled={!valid || create.isPending}>
          {create.isPending ? t('whiteboard.page.creating') : t('whiteboard.page.create')}
        </button>
      </div>
      {create.isError
        ? <p className="wbs-note wbs-note--bad">{create.error?.message}</p>
        : <p className="wbs-create-hint">{t('whiteboard.switcher.createHint')}</p>}
    </form>
  );
}

// ── glyphs (16px, the rail's stroke hand) ────────────────────────────────────────────────────

const glyph = {
  width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
};

export function BoardGlyph() {
  return (
    <svg {...glyph} className="wbs-glyph">
      <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
      <path d="M2 6h12M6.5 6v7.5" />
    </svg>
  );
}

export function ChevronGlyph() {
  return <svg {...glyph} className="wbs-glyph wbs-chevron"><path d="M4.5 6.5 8 10l3.5-3.5" /></svg>;
}

export function PlusGlyph() {
  return <svg {...glyph} className="wbs-glyph"><path d="M8 3.5v9M3.5 8h9" /></svg>;
}

export function SearchGlyph() {
  return <svg {...glyph} className="wbs-glyph"><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3 3" /></svg>;
}

export function CheckGlyph() {
  return <svg {...glyph} className="wbs-glyph"><path d="m3.5 8.5 3 3 6-6.5" /></svg>;
}

export function TrashGlyph() {
  return (
    <svg {...glyph} className="wbs-glyph">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" />
    </svg>
  );
}
