import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ComponentType, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { useApi } from '../../../context/VaultContext';
import { useDismissOnOutside } from '../../../lib/useDismissOnOutside';
import { revealPath } from '../../../lib/reveal';
import { useLabInsights, type InsightCache } from '../../../hooks/useLab';
import {
  useBlockLibrary, useBoard, useBoardCaches, useBoards, useSaveBoard, type BoardSaveSignal,
} from '../../../hooks/useBoards';
import { findFreeSlot } from '../../../generated/grid';
import catalogJson from '../../../generated/block-catalog.json';
import { BoardGrid } from './BoardGrid';
import { BoardCard } from './BoardCard';
import { renderBlock as registryRenderBlock } from '../blocks/blockRegistry';
import type {
  AddCardMenuProps, Board, BlockCatalog, BlockRenderer, BoardSpec, Card, InspectorProps,
} from './boardTypes';
import './board.css';

/**
 * THE INSIGHTS PAGE: one board at a time, a switcher over all of them.
 *
 * Tabs name every board; the ones that do not fit fold into a "+N" chip whose
 * menu lists them (the Automations filter row's recipe), and the active board
 * always keeps a visible tab. Below them, the board's grid.
 *
 * SEAMS. The page draws blocks, the inspector and the add-card menu through
 * props: `renderBlock` defaults to the block registry (wired by the Wave 1
 * integration), `Inspector` and `AddCardMenu` to small stand-in panels until
 * the Wave 2 integration wires `BlockInspector` and `AddCardMenu`.
 *
 * EDITING writes through `useSaveBoard`: a layout change is the board's whole
 * next spec, queued (one PUT in flight, the rest coalesced). A conflict reloads
 * the board and says so; a failed save keeps the edits on screen with Retry.
 *
 * AN ERROR BOARD (conflict markers, unparseable YAML) shows its name, the parse
 * error and "Open file", and cannot enter edit mode: the server refuses its PUT
 * (423) and the page never offers one.
 */

const CATALOG = catalogJson as unknown as BlockCatalog;
/** The "+N" chip's key in the width cache. */
const MORE_ID = '__more';
/** Keeps the menu off the window's edge, in px. */
const EDGE_PAD = 8;

/** A board's spec as the PUT wants it: the stored fields, none of the server's bookkeeping. */
export function specOf(board: Board, cards: Card[] = board.cards): BoardSpec {
  return {
    title: board.title,
    ...(board.titleKey ? { titleKey: board.titleKey } : {}),
    order: board.order,
    cards,
    body: board.body,
  };
}

/** The tabs a row holding `k` of them shows: the first `k`, with the active one taking the last slot. */
export function visibleTabs<T extends { slug: string }>(boards: readonly T[], k: number, active: string | null): T[] {
  const head = boards.slice(0, k);
  if (!active || head.some((b) => b.slug === active)) return head;
  const hit = boards.find((b) => b.slug === active);
  if (!hit) return head;
  return k === 0 ? [hit] : [...head.slice(0, k - 1), hit];
}

function InspectorPlaceholder({ card, onClose }: InspectorProps) {
  const { t } = useI18n();
  return (
    <aside className="board-slot" aria-label={t('lab.board.slot.inspector')}>
      <header className="board-slot-head">
        <span className="board-slot-title">{card.title ?? card.insight ?? card.id}</span>
        <button type="button" className="board-btn" onClick={onClose}>{t('lab.board.close')}</button>
      </header>
      <p className="board-slot-note">{t('lab.board.slot.inspectorSoon')}</p>
    </aside>
  );
}

function AddCardMenuPlaceholder({ onClose }: AddCardMenuProps) {
  const { t } = useI18n();
  return (
    <aside className="board-slot" aria-label={t('lab.board.addCard')}>
      <header className="board-slot-head">
        <span className="board-slot-title">{t('lab.board.addCard')}</span>
        <button type="button" className="board-btn" onClick={onClose}>{t('lab.board.close')}</button>
      </header>
      <p className="board-slot-note">{t('lab.board.slot.addCardSoon')}</p>
    </aside>
  );
}

export interface BoardPageProps {
  /** The block renderer. Default: the block registry (W1 integration). */
  renderBlock?: BlockRenderer;
  /** The block inspector slot. Default: a stand-in panel. */
  Inspector?: ComponentType<InspectorProps>;
  /** The add-card menu slot. Default: a stand-in panel. */
  AddCardMenu?: ComponentType<AddCardMenuProps>;
  /** The board to open (route / saved prefs); falls back to the first board. */
  board?: string | null;
  onBoardChange?: (slug: string) => void;
  /** Told about save conflicts and failures (undo stacks clear on a conflict). */
  onSaveSignal?: (signal: BoardSaveSignal) => void;
}

export function BoardPage({
  renderBlock = registryRenderBlock,
  Inspector = InspectorPlaceholder,
  AddCardMenu = AddCardMenuPlaceholder,
  board: requested = null,
  onBoardChange,
  onSaveSignal,
}: BoardPageProps) {
  const { t } = useI18n();
  const api = useApi();
  const list = useBoards();
  const boards = useMemo(() => list.data?.boards ?? [], [list.data]);
  const [picked, setPicked] = useState<string | null>(requested);
  useEffect(() => { if (requested) setPicked(requested); }, [requested]);
  const active = boards.some((b) => b.slug === picked) ? picked : boards[0]?.slug ?? null;

  const shown = useBoard(active);
  const board = shown.data?.board ?? null;
  const caches = useBoardCaches(board?.cards);
  const insights = useLabInsights();
  const library = useBlockLibrary();

  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<{ card: string; block: number[] | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<BoardSaveSignal | null>(null);
  const [openError, setOpenError] = useState(false);

  const signal = useCallback((s: BoardSaveSignal) => {
    setNotice(s);
    onSaveSignal?.(s);
  }, [onSaveSignal]);
  const { save, retry, status: saveStatus } = useSaveBoard(active, signal);

  // A board switch leaves edit state behind.
  useEffect(() => {
    setEditing(false);
    setSelected(null);
    setAdding(false);
    setNotice(null);
    setOpenError(false);
  }, [active]);

  const choose = useCallback((slug: string) => {
    setPicked(slug);
    onBoardChange?.(slug);
  }, [onBoardChange]);

  const boardTitle = useCallback((b: Pick<Board, 'title' | 'titleKey'>) => (b.titleKey ? t(b.titleKey) : b.title), [t]);

  const writeCards = useCallback((cards: Card[]) => {
    if (!board || board.error) return;
    save(specOf(board, cards), board.rev);
  }, [board, save]);

  const cacheMap = useMemo<Record<string, InsightCache | null>>(() => {
    const out: Record<string, InsightCache | null> = {};
    for (const [slug, entry] of Object.entries(caches.data ?? {})) out[slug] = entry.cache;
    return out;
  }, [caches.data]);

  const summaries = useMemo(() => shown.data?.summaries ?? {}, [shown.data]);
  const frames = useMemo(() => shown.data?.frames ?? {}, [shown.data]);

  const renderCard = useCallback((card: Card) => {
    const missing = !!card.insight && !!shown.data && !summaries[card.insight];
    return (
      <BoardCard
        card={card}
        frames={frames}
        summaries={summaries}
        caches={cacheMap}
        renderBlock={renderBlock}
        missing={missing}
        onRemove={missing && board && !board.error ? () => writeCards(board.cards.filter((c) => c.id !== card.id)) : undefined}
      />
    );
  }, [board, cacheMap, frames, renderBlock, shown.data, summaries, writeCards]);

  const selectedCard = board && selected ? board.cards.find((c) => c.id === selected.card) ?? null : null;

  let body;
  if (list.isLoading || (active && shown.isLoading)) {
    body = <p className="board-note">{t('lab.board.loading')}</p>;
  } else if (list.isError || shown.isError) {
    body = <p className="board-note board-note--error">{t('lab.board.loadFailed')}</p>;
  } else if (!board) {
    body = <p className="board-note">{t('lab.board.empty')}</p>;
  } else if (board.error) {
    body = (
      <section className="board-error" role="alert">
        <h2 className="board-error-title">{boardTitle(board)}</h2>
        <p className="board-error-kind">
          {t(board.error.kind === 'conflict' ? 'lab.board.error.conflict' : 'lab.board.error.parse')}
        </p>
        <pre className="board-error-message">{board.error.message}</pre>
        <div className="board-error-actions">
          <button
            type="button"
            className="board-btn"
            onClick={() => {
              setOpenError(false);
              void revealPath(api, `_dream_context/lab/boards/${board.slug}.md`).then((err) => setOpenError(err !== null));
            }}
          >
            {t('lab.board.error.openFile')}
          </button>
          {openError && <span className="board-note board-note--error">{t('lab.board.error.openFailed')}</span>}
        </div>
      </section>
    );
  } else if (board.cards.length === 0) {
    body = <p className="board-note">{t('lab.board.noCards')}</p>;
  } else {
    body = (
      <BoardGrid
        cards={board.cards}
        editing={editing}
        renderCard={renderCard}
        onLayout={writeCards}
        onSelectCard={(id) => { setAdding(false); setSelected({ card: id, block: null }); }}
      />
    );
  }

  const canEdit = !!board && !board.error;
  return (
    <div className="board-page">
      <div className="board-bar">
        <BoardTabs boards={boards} active={active} onSelect={choose} title={boardTitle} />
        <div className="board-bar-actions">
          {saveStatus === 'saving' && <span className="board-status">{t('lab.board.saving')}</span>}
          {notice?.kind === 'conflict' && <span className="board-status" role="status">{t('lab.board.conflict')}</span>}
          {saveStatus === 'failed' && (
            <span className="board-status board-status--error" role="status">
              {t('lab.board.saveFailed')}
              <button type="button" className="board-btn board-btn--quiet" onClick={retry}>{t('lab.board.retry')}</button>
            </span>
          )}
          {editing && canEdit && (
            <button type="button" className="board-btn" onClick={() => { setSelected(null); setAdding(true); }}>
              {t('lab.board.addCard')}
            </button>
          )}
          <button
            type="button"
            className={`board-btn${editing ? ' board-btn--on' : ''}`}
            aria-pressed={editing}
            disabled={!canEdit}
            onClick={() => { setEditing((v) => !v); setSelected(null); setAdding(false); }}
          >
            {editing ? t('lab.board.done') : t('lab.board.edit')}
          </button>
        </div>
      </div>
      {board && !board.error && (shown.data?.unplaced.length ?? 0) > 0 && (
        <p className="board-note">
          {t('lab.board.unplaced').replace('{n}', String(shown.data?.unplaced.length ?? 0))}
        </p>
      )}
      <div className="board-main">
        <div className="board-canvas">{body}</div>
        {editing && board && !board.error && selectedCard && (
          <Inspector
            board={board}
            card={selectedCard}
            blockPath={selected?.block ?? null}
            catalog={CATALOG}
            library={library.data ?? []}
            insights={insights.data ?? []}
            onChange={(card) => writeCards(board.cards.map((c) => (c.id === card.id ? card : c)))}
            onSelectBlock={(path) => setSelected((s) => (s ? { ...s, block: path } : s))}
            onClose={() => setSelected(null)}
          />
        )}
        {editing && board && !board.error && adding && (
          <AddCardMenu
            board={board}
            unplaced={shown.data?.unplaced ?? []}
            insights={insights.data ?? []}
            catalog={CATALOG}
            library={library.data ?? []}
            onAdd={(card) => {
              const at = card.at ?? findFreeSlot(board.cards, 4, 3);
              writeCards([...board.cards, { ...card, at }]);
              setAdding(false);
            }}
            onClose={() => setAdding(false)}
          />
        )}
      </div>
    </div>
  );
}

// ─── The board switcher ─────────────────────────────────────────────────────

function BoardTabs({
  boards, active, onSelect, title,
}: {
  boards: Board[];
  active: string | null;
  onSelect: (slug: string) => void;
  title: (b: Board) => string;
}) {
  const { t } = useI18n();

  // Natural widths, cached by slug and measured with every tab on the row (before paint) when
  // the set of boards changes; a resize re-fits from the cache. Tabs are `flex: none`.
  const rowRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const signature = boards.map((b) => `${b.slug}:${title(b)}`).join('|');
  const [measuredSig, setMeasuredSig] = useState<string | null>(null);
  const measuring = measuredSig !== signature;
  const [fit, setFit] = useState(boards.length);

  const refit = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const cs = getComputedStyle(row);
    const avail = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    const w = (id: string) => widths.current.get(id) ?? 0;
    const total = (visible: Board[], folded: boolean) => {
      const items = [...visible.map((b) => w(b.slug)), ...(folded ? [w(MORE_ID)] : [])];
      return items.reduce((a, b) => a + b, 0) + gap * Math.max(0, items.length - 1);
    };
    let k = boards.length;
    while (k > 1 && total(visibleTabs(boards, k, active), k < boards.length) > avail) k--;
    setFit(k);
  }, [boards, active]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (measuring) {
      for (const el of row.querySelectorAll<HTMLElement>('[data-tab-id]')) {
        widths.current.set(el.dataset.tabId as string, el.offsetWidth);
      }
      setMeasuredSig(signature);
    }
    refit();
  }, [measuring, signature, refit]);

  const refitRef = useRef(refit);
  refitRef.current = refit;
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const ro = new ResizeObserver(() => refitRef.current());
    ro.observe(row);
    return () => ro.disconnect();
  }, []);

  const fitted = visibleTabs(boards, fit, active);
  const hidden = boards.filter((b) => !fitted.includes(b));
  const visible = measuring ? boards : fitted;
  const moreLabel = (n: number) => t('lab.board.more').replace('{n}', String(n));

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    const inside = !!menuRef.current?.contains(document.activeElement);
    setOpen(false);
    if (inside) triggerRef.current?.focus();
  }, []);
  useDismissOnOutside(open, close, [triggerRef, menuRef]);
  useEffect(() => { if (open && hidden.length === 0) setOpen(false); }, [open, hidden.length]);

  // Below the trigger, right-aligned to it, clamped inside the window. Hidden until placed.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = triggerRef.current?.getBoundingClientRect();
      const m = menuRef.current;
      if (!a || !m) return;
      const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-1')) || 0;
      const top = a.bottom + gap;
      const left = Math.max(EDGE_PAD, Math.min(a.right - m.offsetWidth, window.innerWidth - m.offsetWidth - EDGE_PAD));
      m.style.top = `${Math.round(top)}px`;
      m.style.left = `${Math.round(left)}px`;
      m.style.maxHeight = `${Math.max(0, Math.round(window.innerHeight - top - EDGE_PAD))}px`;
      m.style.visibility = 'visible';
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, hidden.length]);

  useEffect(() => {
    if (!open) return;
    const rows = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    if (!rows?.length) return;
    ([...rows].find((r) => r.getAttribute('aria-checked') === 'true') ?? rows[0]).focus();
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => { e.preventDefault(); rows[(i + rows.length) % rows.length]?.focus(); };
    switch (e.key) {
      case 'ArrowDown': go(at + 1); break;
      case 'ArrowUp': go(at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(rows.length - 1); break;
      case 'Tab': setOpen(false); break;
    }
  };

  return (
    <div className="board-tabs" ref={rowRef}>
      <div className="board-tabs-list" role="tablist" aria-label={t('lab.board.switcher')}>
        {visible.map((b) => {
          const on = b.slug === active;
          return (
            <button
              key={b.slug}
              type="button"
              role="tab"
              aria-selected={on}
              data-tab-id={b.slug}
              className={`board-tab${on ? ' board-tab--on' : ''}${b.error ? ' board-tab--error' : ''}`}
              onClick={() => onSelect(b.slug)}
              title={title(b)}
            >
              <span className="board-tab-label">{title(b)}</span>
            </button>
          );
        })}
      </div>
      {measuring && (
        <span data-tab-id={MORE_ID} className="board-tab" style={{ position: 'absolute', visibility: 'hidden' }} aria-hidden="true">
          {moreLabel(boards.length)}
        </span>
      )}
      {hidden.length > 0 && (
        <button
          ref={triggerRef}
          type="button"
          className="board-tab board-tab--more"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${t('lab.board.moreAria')}: ${moreLabel(hidden.length)}`}
          onClick={() => setOpen((v) => !v)}
        >
          {moreLabel(hidden.length)}
        </button>
      )}
      {open && hidden.length > 0 && createPortal(
        <div
          ref={menuRef}
          className="board-tabs-menu"
          role="menu"
          aria-label={t('lab.board.moreAria')}
          style={{ visibility: 'hidden' }}
          onKeyDown={onMenuKey}
        >
          {hidden.map((b) => (
            <button
              key={b.slug}
              type="button"
              role="menuitemradio"
              aria-checked={b.slug === active}
              tabIndex={-1}
              title={title(b)}
              onClick={() => { onSelect(b.slug); setOpen(false); triggerRef.current?.focus(); }}
            >
              <span className="board-tabs-menu-label">{title(b)}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
