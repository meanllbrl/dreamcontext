import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState,
  type ComponentType, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../../context/I18nContext';
import { useApi, useVault } from '../../../context/VaultContext';
import { useDismissOnOutside } from '../../../lib/useDismissOnOutside';
import { isTopOverlay, popOverlay, pushOverlay } from '../../../lib/overlayStack';
import { revealPath } from '../../../lib/reveal';
import { useFocusTarget, type FocusTarget } from '../../../hooks/useFocusTarget';
import {
  useLabInsights, useLabSyncSlots, useStartLabSyncJob, type InsightCache, type InsightSummary, type SyncResult,
} from '../../../hooks/useLab';
import {
  useBlockLibrary, useBoard, useBoardCaches, useBoards, useBoardWriter, useCreateBoard, useDeleteBoard,
  useFetchBoard, useSaveBoard, type BoardSaveSignal,
} from '../../../hooks/useBoards';
import { findFreeSlot } from '../../../generated/grid';
import catalogJson from '../../../generated/block-catalog.json';
import { RequestError } from '../../../api/client';
import { isRoutedRender } from '../chartRegistry';
import { InsightDetailPanel } from '../InsightDetailPanel';
import { LabCredentialsBanner } from '../LabCredentialsBanner';
import { pushLabPath, useLabSearchParams } from '../funnel/labRoute';
import { BoardGrid } from './BoardGrid';
import { BoardCard } from './BoardCard';
import { BoardMenu } from './BoardMenu';
import { CardMenu } from './CardMenu';
import { BoardEmptyState } from './BoardEmptyState';
import { BlockInspector } from './BlockInspector';
import { AddCardMenu as EditorAddCardMenu } from './AddCardMenu';
import { createRevGuard, createUndoStack, settleMoveUndo, undoKey } from './boardUndo';
import { MoveBlockedError, duplicateCard, moveCardToBoard, removeCard, specOf } from './boardEdits';
import {
  RECHECK_MS, busySlugs, cardSyncState, freshReason, isExpired, planAutomaticSync,
} from './boardSync';
import { pruneViews, updateView, type CardView, type CardViews } from './cardViewState';
import { renderBlock as registryRenderBlock } from '../blocks/blockRegistry';
import type {
  AddCardMenuProps, Board, BlockCatalog, BlockRenderer, BoardSpec, Card, InspectorProps,
} from './boardTypes';
import './board.css';
import './lab-shell.css';

/**
 * THE INSIGHTS PAGE: one board at a time, a switcher over all of them.
 *
 * Tabs name every board; the ones that do not fit fold into a "+N" chip whose
 * menu lists them (the Automations filter row's recipe), and the active board
 * always keeps a visible tab. Beside them: the board's ⋯ menu (New, Rename,
 * Delete, Sync board) and the Edit toggle. Under them, one sentence on how
 * fresh the board is. Below, the grid; every card has its own ⋯ menu.
 *
 * SEAMS. The page draws blocks, the inspector and the add-card menu through
 * props: `renderBlock` defaults to the block registry, `Inspector` to
 * `BlockInspector`, `AddCardMenu` to the editors' `AddCardMenu`. Every change
 * they make arrives as a whole card through `onChange` / `onAdd`, so the save
 * queue and the undo stack cover them like any other edit.
 *
 * EDITING writes through `useSaveBoard`: every edit is the board's whole next
 * spec, queued (one PUT in flight, the rest coalesced). Each edit also records
 * the spec it replaced on an undo stack (⌘Z / ⇧⌘Z, and the Undo toast). A
 * conflict (409: someone else wrote the file) reloads the board, says so and
 * clears the stack, because every remembered spec is a rewrite of a file that
 * no longer exists. A failed save keeps the edits on screen with Retry.
 *
 * SYNC. Opening a board starts ONE automatic job over the insights whose data
 * expired, and none when all are fresh; while the page is visible a 60 s timer
 * and every return to the tab ask again, from the summaries already loaded
 * (`boardSync.ts`). Automatic requests carry no `force`; Sync board and a
 * card's Refresh send `'user'`, Force full refresh `'hard'`.
 *
 * AN ERROR BOARD (conflict markers, unparseable YAML) shows its name, the parse
 * error and "Open file", and cannot enter edit mode: the server refuses its PUT
 * (423) and the page never offers one.
 *
 * CARD VIEW STATE (filters, breakdown selection, lanes, open tab, open app page)
 * lives HERE, per card id (`cardViewState.ts`), so a card and its fullscreen
 * twin share it. A card's view dies when the card leaves the board; a board
 * switch starts every view empty. Nothing of it is saved.
 *
 * FULLSCREEN is the URL's `?card=<id>`: the card menu pushes a history entry
 * (Back closes), a link with the param reopens it, Esc and the exit button
 * close it and focus returns to the card's menu. The overlay draws the ONE live
 * copy of the card; its grid slot shows an empty lifted box, so an app card
 * never runs two iframes.
 */

const CATALOG = catalogJson as unknown as BlockCatalog;
/** The "+N" chip's key in the width cache. */
const MORE_ID = '__more';
/** Keeps the menu off the window's edge, in px. */
const EDGE_PAD = 8;
/** How long a transient toast stays up, in ms (the clock stops while the pointer or focus is on it). */
export const TOAST_MS = 6000;

export { specOf };

/** How long until a toast goes away on its own: never while held (pointer or focus on it), else TOAST_MS. */
export function toastDelay(toast: { id: number } | null, held: boolean): number | null {
  return toast && !held ? TOAST_MS : null;
}

/** The tabs a row holding `k` of them shows: the first `k`, with the active one taking the last slot. */
export function visibleTabs<T extends { slug: string }>(boards: readonly T[], k: number, active: string | null): T[] {
  const head = boards.slice(0, k);
  if (!active || head.some((b) => b.slug === active)) return head;
  const hit = boards.find((b) => b.slug === active);
  if (!hit) return head;
  return k === 0 ? [hit] : [...head.slice(0, k - 1), hit];
}

/** The board-level freshness sentence's parts, from the board's summaries. */
export function boardFreshness(summaries: Readonly<Record<string, InsightSummary>>, now: number): {
  total: number; stale: number; failed: number; newest: string | null;
} {
  let stale = 0;
  let failed = 0;
  let newest: string | null = null;
  const list = Object.values(summaries);
  for (const s of list) {
    if (s.error) failed++;
    else if (isExpired(s, now)) stale++;
    if (s.fetchedAt && (!newest || Date.parse(s.fetchedAt) > Date.parse(newest))) newest = s.fetchedAt;
  }
  return { total: list.length, stale, failed, newest };
}

/** "3 minutes ago" in the reader's language. */
function agoText(iso: string, locale: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const s = Math.round((ms - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

/** The page's card views, tagged with the board they belong to (a board switch empties them). */
interface ViewState { board: string | null; views: CardViews }
type ViewAction =
  | { type: 'update'; board: string; card: string; fn: (view: CardView) => CardView }
  | { type: 'prune'; board: string | null; cards: string[] };

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  if (action.type === 'prune') {
    if (state.board !== action.board) return { board: action.board, views: {} };
    const views = pruneViews(state.views, action.cards);
    return views === state.views ? state : { ...state, views };
  }
  // An update from a board that is no longer the one on screen is dropped.
  if (state.board !== action.board) return state;
  const views = updateView(state.views, action.card, action.fn);
  return views === state.views ? state : { ...state, views };
}

/** The fullscreen card: `?card=<id>` naming a card on this (readable) board, else null. */
export function fullscreenCard(board: Pick<Board, 'cards' | 'error'> | null, param: string | null): Card | null {
  if (!board || board.error || !param) return null;
  return board.cards.find((c) => c.id === param) ?? null;
}

type ToastKind = 'undo' | 'conflict' | 'queued' | 'info';
interface Toast { id: number; kind: ToastKind; text: string }

export interface BoardPageProps {
  /** The block renderer. Default: the block registry. */
  renderBlock?: BlockRenderer;
  /** The block inspector slot. Default: `BlockInspector`. */
  Inspector?: ComponentType<InspectorProps>;
  /** The add-card menu slot. Default: `AddCardMenu`. */
  AddCardMenu?: ComponentType<AddCardMenuProps>;
  /** The board to open (route / saved prefs); falls back to the first board. */
  board?: string | null;
  /** A board the user picked (a tab, a new board): the page's route and prefs follow. */
  onBoardChange?: (slug: string) => void;
  /** Told about save conflicts and failures (the page's own undo stack already clears on a conflict). */
  onSaveSignal?: (signal: BoardSaveSignal) => void;
  /** Shell navigation focus: opens that insight's detail (⌘K recall hit). */
  focus?: FocusTarget;
}

export function BoardPage({
  renderBlock = registryRenderBlock,
  Inspector = BlockInspector,
  AddCardMenu = EditorAddCardMenu,
  board: requested = null,
  onBoardChange,
  onSaveSignal,
  focus,
}: BoardPageProps) {
  const { t, locale } = useI18n();
  const api = useApi();
  const { isActive } = useVault();
  const queryClient = useQueryClient();
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
  const slots = useLabSyncSlots();
  const startSync = useStartLabSyncJob();
  const createBoard = useCreateBoard();
  const deleteBoard = useDeleteBoard();
  const fetchBoard = useFetchBoard();
  const writer = useBoardWriter();
  const pageRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<{ card: string; block: number[] | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const [openError, setOpenError] = useState(false);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // Pointer or keyboard focus on the toast holds it; leaving starts a fresh TOAST_MS.
  const [toastHeld, setToastHeld] = useState(false);
  const toastSeq = useRef(0);
  const undo = useRef(createUndoStack());
  const [, setUndoTick] = useState(0);

  const say = useCallback((kind: ToastKind, text: string) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, kind, text });
  }, []);
  useEffect(() => {
    const delay = toastDelay(toast, toastHeld);
    if (!toast || delay === null) return;
    const timer = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), delay);
    return () => clearTimeout(timer);
  }, [toast, toastHeld]);
  useEffect(() => { if (!toast) setToastHeld(false); }, [toast]);

  const signal = useCallback((s: BoardSaveSignal) => {
    if (s.kind === 'conflict') {
      // Every remembered spec now rewrites a file that no longer exists.
      if (s.slug === active) undo.current.clear();
      setUndoTick((n) => n + 1);
      say('conflict', t('lab.board.conflict'));
    }
    onSaveSignal?.(s);
  }, [active, onSaveSignal, say, t]);
  const { save, retry, status: saveStatus, savedRev } = useSaveBoard(active, signal);
  const activeRef = useRef(active);
  activeRef.current = active;

  // A rev this page did not write (an agent, the CLI, a brain-sync pull, seen through any refetch)
  // voids the undo stack: undoing would PUT an old spec with THEIR rev and silently overwrite them.
  const revGuard = useRef(createRevGuard());
  const serverRev = shown.data?.board.rev ?? null;
  useEffect(() => {
    const slug = shown.data?.board.slug ?? null;
    if (revGuard.current.observe(serverRev, { slug, ownRev: savedRev, saving: saveStatus === 'saving' }) === 'clear') {
      undo.current.clear();
      setUndoTick((n) => n + 1);
    }
  }, [serverRev, shown.data?.board.slug, savedRev, saveStatus]);

  // A board switch leaves edit state and its undo history behind.
  useEffect(() => {
    setEditing(false);
    setSelected(null);
    setAdding(false);
    setOpenError(false);
    undo.current.clear();
    setUndoTick((n) => n + 1);
  }, [active]);

  const choose = useCallback((slug: string) => {
    setPicked(slug);
    onBoardChange?.(slug);
  }, [onBoardChange]);

  const boardTitle = useCallback((b: Pick<Board, 'title' | 'titleKey'>) => (b.titleKey ? t(b.titleKey) : b.title), [t]);
  const writable = !!board && !board.error;

  /** Every board edit goes through here: record what it replaces, then queue the whole next spec. */
  const writeSpec = useCallback((next: BoardSpec) => {
    if (!board || board.error) return;
    undo.current.record(specOf(board));
    setUndoTick((n) => n + 1);
    save(next, board.rev);
    say('undo', t('lab.board.toast.edited'));
  }, [board, save, say, t]);

  const writeCards = useCallback((cards: Card[]) => {
    if (!board) return;
    writeSpec(specOf(board, cards));
  }, [board, writeSpec]);

  const step = useCallback((dir: 'undo' | 'redo') => {
    if (!board || board.error) return;
    const current = specOf(board);
    const next = dir === 'undo' ? undo.current.undo(current) : undo.current.redo(current);
    if (!next) return;
    setUndoTick((n) => n + 1);
    save(next, board.rev);
    say('info', t(dir === 'undo' ? 'lab.board.toast.undone' : 'lab.board.toast.redone'));
  }, [board, save, say, t]);

  // ⌘Z / ⇧⌘Z while this page is the one on screen (a background project's page stays mounted).
  const stepRef = useRef(step);
  stepRef.current = step;
  const keysLive = isActive && !openSlug;
  useEffect(() => {
    if (!keysLive) return;
    const onKey = (e: KeyboardEvent) => {
      const dir = undoKey(e);
      if (!dir) return;
      e.preventDefault();
      stepRef.current(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keysLive]);

  // ─── Sync ──────────────────────────────────────────────────────────────────

  const summaries = useMemo(() => shown.data?.summaries ?? {}, [shown.data]);
  const frames = useMemo(() => shown.data?.frames ?? {}, [shown.data]);
  const running = slots.data?.running ?? null;
  const pending = slots.data?.pending ?? null;

  const cacheMap = useMemo<Record<string, InsightCache | null>>(() => {
    const out: Record<string, InsightCache | null> = {};
    for (const [slug, entry] of Object.entries(caches.data ?? {})) out[slug] = entry.cache;
    return out;
  }, [caches.data]);

  /** Slugs this page asked for automatically, and when: not asked again inside their backoff window. */
  const askedAt = useRef(new Map<string, number>());

  const autoSync = useCallback(() => {
    if (!isActive || document.visibilityState !== 'visible') return;
    const now = Date.now();
    const req = planAutomaticSync(summaries, now, { recent: askedAt.current, busy: busySlugs(running, pending) });
    if (!req) return;
    for (const slug of req.slugs) askedAt.current.set(slug, now);
    startSync.mutate(req, {
      onSuccess: (d) => { if (d.queued) say('queued', t('lab.board.toast.queued')); },
    });
  }, [isActive, summaries, running, pending, startSync, say, t]);
  const autoSyncRef = useRef(autoSync);
  autoSyncRef.current = autoSync;

  // Board open: ONE evaluation once the board's summaries are loaded and settled.
  const evaluatedFor = useRef<string | null>(null);
  const settled = !!shown.data && !shown.isFetching && slots.isFetched;
  useEffect(() => {
    if (!active || !settled || evaluatedFor.current === active) return;
    evaluatedFor.current = active;
    autoSyncRef.current();
  }, [active, settled]);

  // While visible: every 60 s, and on every return to the tab.
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => autoSyncRef.current(), RECHECK_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') autoSyncRef.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isActive]);

  // Cards light up as the job settles them: refetch on every settled count, not every poll tick.
  const jobDone = running?.done ?? 0;
  const jobId = running?.id ?? null;
  useEffect(() => {
    if (!jobId || jobDone === 0) return;
    void queryClient.invalidateQueries({ queryKey: ['lab'] });
  }, [jobDone, jobId, queryClient]);

  // A job this page watched run: refetch once it settles, and report a user-started one's outcome.
  const watched = useRef<string | null>(null);
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!running) return;
    if (running.status === 'running') {
      watched.current = running.id;
      return;
    }
    if (watched.current !== running.id || reported.current === running.id) return;
    reported.current = running.id;
    void queryClient.invalidateQueries({ queryKey: ['lab'] });
    if (running.force === null) return;
    if (running.status === 'error') say('info', t('lab.board.toast.syncFailed').replace('{error}', running.error ?? ''));
    else if (running.failed.length > 0) {
      say('info', t('lab.board.toast.syncSomeFailed')
        .replace('{n}', String(running.failed.length)).replace('{total}', String(running.results.length)));
    } else say('info', t('lab.board.toast.synced').replace('{n}', String(running.results.length)));
  }, [running, queryClient, say, t]);

  /** The most recent job result per slug (the skip reason a card shows). */
  const lastResults = useMemo(() => {
    const out = new Map<string, SyncResult>();
    for (const r of running?.results ?? []) out.set(r.slug, r);
    return out;
  }, [running]);

  const syncBoard = useCallback(() => {
    const slugs = Object.keys(summaries).sort();
    if (slugs.length === 0) return;
    startSync.mutate({ force: 'user', slugs }, {
      onSuccess: (d) => { if (d.queued) say('queued', t('lab.board.toast.queued')); },
      onError: (err) => say('info', t('lab.board.toast.syncFailed').replace('{error}', (err as Error).message)),
    });
  }, [summaries, startSync, say, t]);

  // ─── Board + card actions ──────────────────────────────────────────────────

  const newBoard = useCallback((title: string) => {
    createBoard.mutate(title, {
      onSuccess: (r) => { choose(r.board.slug); say('info', t('lab.board.toast.created').replace('{title}', r.board.title)); },
      onError: (err) => say('info', t('lab.board.toast.createFailed').replace('{error}', (err as Error).message)),
    });
  }, [createBoard, choose, say, t]);

  const renameBoard = useCallback((title: string) => {
    if (!board) return;
    // A derived board's localized title is replaced by the name the user typed.
    writeSpec({ title, order: board.order, cards: board.cards, body: board.body });
  }, [board, writeSpec]);

  const removeBoard = useCallback(() => {
    if (!board) return;
    const next = boards.find((b) => b.slug !== board.slug);
    deleteBoard.mutate({ slug: board.slug, rev: board.rev }, {
      onSuccess: () => {
        if (next) choose(next.slug);
        else setPicked(null);
        say('info', t('lab.board.toast.deleted').replace('{title}', boardTitle(board)));
      },
      onError: (err) => say(
        err instanceof RequestError && err.status === 409 ? 'conflict' : 'info',
        err instanceof RequestError && err.status === 409
          ? t('lab.board.conflict')
          : t('lab.board.toast.deleteFailed').replace('{error}', (err as Error).message),
      ),
    });
  }, [board, boards, deleteBoard, choose, say, t, boardTitle]);

  // Multi-page insights (funnel, app) open their routed page; the rest open the detail panel.
  const openInsight = useCallback((slug: string) => {
    const summary = summaries[slug] ?? insights.data?.find((s) => s.slug === slug);
    if (summary && isRoutedRender(summary.render)) pushLabPath(slug, null);
    else setOpenSlug(slug);
  }, [summaries, insights.data]);
  useFocusTarget(focus, setOpenSlug);
  const openSummary = openSlug
    ? insights.data?.find((s) => s.slug === openSlug) ?? summaries[openSlug] ?? null
    : null;

  // Target written and AWAITED first, then the source re-read for its rev (the first write on a
  // derived vault materializes every board), then the source saved. A move spans two boards, so it
  // is NOT on the (one-board) undo stack and gets no Undo toast; it clears the source's stack, but
  // only if the source is still the board on screen when the move finishes (`settleMoveUndo`).
  const moveTo = useCallback(async (cardId: string, target: string) => {
    if (!board || board.error) return;
    const from = board.slug;
    try {
      const moved = await moveCardToBoard({
        fetchBoard: (slug) => fetchBoard(slug).then((r) => r.board),
        saveAndWait: writer.saveAndWait,
        idle: writer.idle,
        unsaved: writer.unsaved,
      }, from, target, cardId);
      if (!moved) return;
      if (settleMoveUndo(undo.current, from, activeRef.current)) setUndoTick((n) => n + 1);
      writer.saveAndWait(from, moved.sourceSpec, moved.sourceRev).catch(() => {
        // Conflict and failure already reach the page through the save signals (toast + Retry).
      });
      say('info', t('lab.board.toast.moved').replace('{title}', boardTitle(moved.target)));
    } catch (err) {
      if (err instanceof MoveBlockedError) {
        const blocked = boards.find((b) => b.slug === err.slug);
        say('info', err.slug === from || !blocked
          ? t('lab.board.toast.moveBlocked')
          : t('lab.board.toast.moveBlockedTarget').replace('{title}', boardTitle(blocked)));
        return;
      }
      if (err instanceof RequestError && err.status === 409) return; // the conflict toast already said it
      say('info', t('lab.board.toast.moveFailed').replace('{error}', (err as Error).message));
    }
  }, [board, boards, fetchBoard, writer, say, t, boardTitle]);

  // ─── Card views + fullscreen ───────────────────────────────────────────────

  const [viewState, dispatchView] = useReducer(viewReducer, { board: null, views: {} });
  const boardSlug = board?.slug ?? null;
  const cardIds = board?.cards.map((c) => c.id).join('\n') ?? '';
  useEffect(() => {
    dispatchView({ type: 'prune', board: boardSlug, cards: cardIds ? cardIds.split('\n') : [] });
  }, [boardSlug, cardIds]);

  const [search, updateSearch] = useLabSearchParams();
  const fsCard = fullscreenCard(board, search.get('card'));
  const fsId = fsCard?.id ?? null;
  /** The open fullscreen pushed its own history entry: closing goes Back over it. */
  const pushedFs = useRef(false);
  /** The card whose menu gets focus back once the overlay is gone. */
  const returnFocus = useRef<string | null>(null);

  const openFullscreen = useCallback((id: string) => {
    // labRoute's search writer only replaces; a duplicate entry first makes the param its own
    // history step, so Back closes the overlay. A click is the foreground instance's (a
    // background project is inert), which is the one that owns the address bar.
    window.history.pushState(window.history.state, '', window.location.href);
    pushedFs.current = true;
    updateSearch((p) => p.set('card', id));
  }, [updateSearch]);

  const closeFullscreen = useCallback(() => {
    if (!fsId) return;
    returnFocus.current = fsId;
    if (pushedFs.current) {
      pushedFs.current = false;
      window.history.back();
    } else {
      updateSearch((p) => p.delete('card'));
    }
  }, [fsId, updateSearch]);

  // Closed by any route (Back, a link): the next close must not go Back again.
  useEffect(() => { if (!fsId) pushedFs.current = false; }, [fsId]);

  // Esc closes, queued LIFO with menus and panels on the app's overlay stack.
  const overlayId = useId();
  const closeRef = useRef(closeFullscreen);
  closeRef.current = closeFullscreen;
  useEffect(() => {
    if (!fsId || !isActive) return;
    pushOverlay(overlayId);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(overlayId)) return;
      e.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      popOverlay(overlayId);
      document.removeEventListener('keydown', onKey);
    };
  }, [fsId, isActive, overlayId]);

  // Focus moves into the overlay on open and back to the card's menu on close.
  useEffect(() => {
    if (fsId) {
      overlayRef.current?.querySelector<HTMLElement>('[data-lab-card-exit]')?.focus();
      return;
    }
    const id = returnFocus.current;
    returnFocus.current = null;
    if (!id) return;
    const cardEl = [...(pageRef.current?.querySelectorAll<HTMLElement>('.board-canvas [data-card-id]') ?? [])]
      .find((el) => el.dataset.cardId === id);
    cardEl?.querySelector<HTMLElement>('[data-lab-card-menu]')?.focus();
  }, [fsId]);

  const targets = useMemo(
    () => boards.filter((b) => b.slug !== active && !b.error).map((b) => ({ slug: b.slug, title: boardTitle(b) })),
    [boards, active, boardTitle],
  );

  const views = viewState.views;
  const cardNode = useCallback((card: Card, fullscreen: boolean) => {
    const missing = !!card.insight && !!shown.data && !summaries[card.insight];
    const primary = card.insight ? summaries[card.insight] : undefined;
    return (
      <BoardCard
        card={card}
        view={views[card.id]}
        onView={boardSlug ? (fn) => dispatchView({ type: 'update', board: boardSlug, card: card.id, fn }) : undefined}
        fullscreen={fullscreen}
        onExitFullscreen={fullscreen ? closeFullscreen : undefined}
        frames={frames}
        summaries={summaries}
        caches={cacheMap}
        renderBlock={renderBlock}
        missing={missing}
        onRemove={missing && writable && board ? () => writeCards(removeCard(board.cards, card.id)) : undefined}
        // A plain-surface click opens what the menu's Open detail opens (edit mode: the grid's handle takes it).
        onOpen={card.insight && primary && !missing ? () => openInsight(card.insight as string) : undefined}
        syncState={cardSyncState(card.insight, running, pending)}
        freshReason={freshReason(primary, card.insight ? lastResults.get(card.insight) : null)}
        menu={(
          <CardMenu
            summary={primary}
            editable={writable}
            targets={targets}
            onEditBlocks={() => { setEditing(true); setAdding(false); setSelected({ card: card.id, block: null }); }}
            onOpenDetail={() => { if (card.insight) openInsight(card.insight); }}
            onDuplicate={() => { if (board) writeCards(duplicateCard(board.cards, card.id)); }}
            onMoveTo={(slug) => { void moveTo(card.id, slug); }}
            onRemove={() => { if (board) writeCards(removeCard(board.cards, card.id)); }}
            onToast={(text) => say('info', text)}
            fullscreen={fullscreen}
            onFullscreen={fullscreen ? closeFullscreen : () => openFullscreen(card.id)}
          />
        )}
      />
    );
  }, [board, cacheMap, frames, renderBlock, shown.data, summaries, writeCards, writable, running, pending,
    lastResults, targets, openInsight, moveTo, say, views, boardSlug, closeFullscreen, openFullscreen]);

  // The fullscreen card's grid slot keeps its place as an empty lifted box: ONE live copy of the card.
  const renderCard = useCallback((card: Card) => (card.id === fsId
    ? <div className="board-card board-card--lifted" data-lab-card-lifted={card.id} aria-hidden="true" />
    : cardNode(card, false)), [fsId, cardNode]);

  const selectedCard = board && selected ? board.cards.find((c) => c.id === selected.card) ?? null : null;
  const unplaced = shown.data?.unplaced ?? [];

  // ─── Render ────────────────────────────────────────────────────────────────

  const banner = <LabCredentialsBanner onToast={(text) => say('info', text)} />;

  if (list.isSuccess && boards.length === 0) {
    return (
      <div className="board-page board-page--empty">
        {banner}
        <div className="board-canvas">
          <BoardEmptyState
            creating={createBoard.isPending}
            failed={createBoard.isError}
            onCreate={() => newBoard(t('lab.board.emptyState.firstTitle'))}
          />
        </div>
        <BoardToasts toast={toast} onDismiss={() => setToast(null)} onUndo={() => step('undo')} onHold={setToastHeld} saveFailed={false} onRetry={retry} />
      </div>
    );
  }

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
            data-lab-open-file
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
    body = (
      <div className="board-blank">
        <p className="board-note">{t('lab.board.noCards')}</p>
        <button
          type="button"
          className="board-btn"
          data-lab-add-first-card
          onClick={() => { setEditing(true); setSelected(null); setAdding(true); }}
        >
          {t('lab.board.addCard')}
        </button>
      </div>
    );
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

  const fresh = board && !board.error ? boardFreshness(summaries, Date.now()) : null;
  const boardJob = running?.status === 'running' && Object.keys(summaries).some((s) => cardSyncState(s, running, null) === 'syncing');
  let sentence: string | null = null;
  if (boardJob && running) {
    sentence = t('lab.board.freshness.syncing').replace('{done}', String(running.done)).replace('{total}', String(running.total || running.done));
  } else if (fresh && fresh.total > 0) {
    if (fresh.failed > 0) {
      sentence = t('lab.board.freshness.failed').replace('{n}', String(fresh.failed)).replace('{total}', String(fresh.total));
    } else if (fresh.stale > 0) {
      sentence = t('lab.board.freshness.stale').replace('{n}', String(fresh.stale)).replace('{total}', String(fresh.total));
    } else if (fresh.newest) {
      sentence = t('lab.board.freshness.fresh').replace('{total}', String(fresh.total)).replace('{ago}', agoText(fresh.newest, locale));
    }
  }

  return (
    <div
      ref={pageRef}
      className="board-page"
      data-lab-board={active ?? ''}
      data-lab-board-derived={board?.derived ? 'true' : undefined}
      data-lab-board-error={board?.error ? 'true' : undefined}
    >
      {banner}
      <div className="board-bar">
        <BoardTabs boards={boards} active={active} onSelect={choose} title={boardTitle} />
        <div className="board-bar-actions">
          {saveStatus === 'saving' && <span className="board-status" data-lab-saving>{t('lab.board.saving')}</span>}
          {editing && writable && (
            <button type="button" className="board-btn" data-lab-add-card-open onClick={() => { setSelected(null); setAdding(true); }}>
              {t('lab.board.addCard')}
            </button>
          )}
          <button
            type="button"
            className={`board-btn${editing ? ' board-btn--on' : ''}`}
            data-lab-edit-toggle
            aria-pressed={editing}
            disabled={!writable}
            onClick={() => { setEditing((v) => !v); setSelected(null); setAdding(false); }}
          >
            {editing ? t('lab.board.done') : t('lab.board.edit')}
          </button>
          <BoardMenu
            title={board ? boardTitle(board) : null}
            canRename={writable}
            canDelete={!!board}
            canSync={writable && Object.keys(summaries).length > 0}
            onNew={newBoard}
            onRename={renameBoard}
            onDelete={removeBoard}
            onSync={syncBoard}
          />
        </div>
      </div>
      {sentence && <p className="board-freshness" data-lab-board-freshness>{sentence}</p>}
      {writable && unplaced.length > 0 && (
        <p className="board-notice" data-lab-unplaced={unplaced.length}>
          <span>{t('lab.board.unplaced').replace('{n}', String(unplaced.length))}</span>
          <button
            type="button"
            className="board-btn board-btn--quiet"
            onClick={() => { setEditing(true); setSelected(null); setAdding(true); }}
          >
            {t('lab.board.addCard')}
          </button>
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
            frames={frames}
            caches={cacheMap}
            onChange={(card) => writeCards(board.cards.map((c) => (c.id === card.id ? card : c)))}
            onSelectBlock={(path) => setSelected((s) => (s ? { ...s, block: path } : s))}
            onClose={() => setSelected(null)}
          />
        )}
        {editing && board && !board.error && adding && (
          <AddCardMenu
            board={board}
            unplaced={unplaced}
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
      {fsCard && (
        <div
          ref={overlayRef}
          className="board-fullscreen"
          role="dialog"
          aria-modal="true"
          aria-label={fsCard.title ?? (fsCard.insight ? summaries[fsCard.insight]?.title : undefined) ?? t('lab.board.card.fullscreen')}
          data-lab-fullscreen={fsCard.id}
        >
          {cardNode(fsCard, true)}
        </div>
      )}
      {openSummary && (
        <InsightDetailPanel summary={openSummary} onClose={() => setOpenSlug(null)} onToast={(text) => say('info', text)} />
      )}
      <BoardToasts
        toast={toast}
        onDismiss={() => setToast(null)}
        onUndo={() => step('undo')}
        onHold={setToastHeld}
        saveFailed={saveStatus === 'failed'}
        onRetry={retry}
      />
    </div>
  );
}

// ─── Toasts ─────────────────────────────────────────────────────────────────

function BoardToasts({ toast, onDismiss, onUndo, saveFailed, onRetry, onHold }: {
  toast: Toast | null;
  onDismiss: () => void;
  onUndo: () => void;
  saveFailed: boolean;
  onRetry: () => void;
  /** The pointer or focus entered (true) or left (false) the toast: its clock pauses meanwhile. */
  onHold?: (held: boolean) => void;
}) {
  const { t } = useI18n();
  if (!toast && !saveFailed) return null;
  return (
    <div className="board-toasts" role="status" aria-live="polite">
      {saveFailed && (
        <div className="board-toast board-toast--error" data-lab-toast="save-failed">
          <span>{t('lab.board.saveFailed')}</span>
          <button type="button" className="board-btn board-btn--quiet" data-lab-toast-retry onClick={onRetry}>
            {t('lab.board.retry')}
          </button>
        </div>
      )}
      {toast && (
        <div
          key={toast.id}
          className="board-toast"
          data-lab-toast={toast.kind}
          data-lab-toast-ttl={TOAST_MS}
          onPointerEnter={() => onHold?.(true)}
          onPointerLeave={() => onHold?.(false)}
          onFocus={() => onHold?.(true)}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHold?.(false); }}
        >
          <span>{toast.text}</span>
          {toast.kind === 'undo' && (
            <button type="button" className="board-btn board-btn--quiet" data-lab-toast-undo onClick={() => { onDismiss(); onUndo(); }}>
              {t('lab.board.undo')}
            </button>
          )}
          <button type="button" className="board-toast-close" aria-label={t('lab.board.close')} onClick={onDismiss}>×</button>
        </div>
      )}
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
  // The active tab is drawn wider (board.css): a new active tab is a new measurement.
  const signature = `${active}|${boards.map((b) => `${b.slug}:${title(b)}`).join('|')}`;
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
              data-lab-board-tab={b.slug}
              className={`board-tab${on ? ' board-tab--on' : ''}${b.error ? ' board-tab--error' : ''}`}
              onClick={() => onSelect(b.slug)}
              title={title(b)}
              aria-label={title(b)}
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
              data-lab-board-tab={b.slug}
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
