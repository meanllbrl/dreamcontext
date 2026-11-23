/**
 * The board explorer (owner, 2026-10-28: "a page explorer with grouped pages, like a wiki"):
 * the left sidebar of the Whiteboard page listing EVERY board — Pinned, Recent, the groups
 * (a board's own frontmatter `group`), Ungrouped — with search, drag a board onto a group, and
 * a ⋯ menu that does everything a drag does, so the keyboard reaches it all. A right-click on a
 * board or group row (or Shift+F10 / the Menu key on it) opens the same menu at the pointer;
 * "Recently deleted" sits at the list's foot (both moved from the retired tab strip, 2026-11-11).
 *
 * Rendered above the slug-keyed editor (WhiteboardsPage.tsx), so a board switch keeps its
 * search, its fields and its scroll. The pure half is explorerLogic.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsMutating } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useDismissOnOutside } from '../../lib/useDismissOnOutside';
import {
  useCreateWhiteboard, useDeleteWhiteboard, useRenameWhiteboard, useRenameWhiteboardGroup, useSetWhiteboardGroup,
  useSetWhiteboardGroupOrder, useWhiteboardGroupOrder, useWhiteboardList, type GroupMoveNote, type WhiteboardSummary,
} from '../../hooks/useWhiteboards';
import { BoardGlyph, ChevronRightGlyph, ClockGlyph, DotsGlyph, FolderGlyph, PinGlyph, PlusGlyph, SearchGlyph, SidebarGlyph } from './boardGlyphs';
import { LoadingSkeleton } from '../../components/common/LoadingSkeleton';
import { TrashSection } from './BoardTrash';
import { DEFAULT_BOARD_SLUG, canDeleteBoard, fold, isDefaultBoard, newBoardName } from './boardSwitcherLogic';
import {
  addEmptyGroup, buildExplorer, composeOrder, expandFolder, keepGroupIfEmptied, moveGroup, movedFolderPath, pruneExplorerPrefs,
  realGroupNames, renameGroupInPrefs, stepGroup, toggleCollapsed, togglePin, validFolderName, FOLDER_SEP,
  GROUP_MAX, type ExplorerGroup, type ExplorerPrefs,
} from './explorerLogic';
import './BoardExplorer.css';

type Change = (update: (p: ExplorerPrefs) => ExplorerPrefs) => void;
/** Where a menu opens: below its button, or above it when the room below is short; a right-click
 *  also places it at the pointer (`left`). */
type MenuAt = ({ top: number } | { bottom: number }) & { left?: number };
type Menu = ({ kind: 'board'; slug: string } & MenuAt) | ({ kind: 'group'; key: string } & MenuAt) | null;
/** An inline name field: a new board (in a group, or none), a new group, a board or group rename. */
type Field =
  | { kind: 'new-board'; group: string | null }
  | { kind: 'new-group' }
  /** A new sub-folder inside the top folder `parent` (its key). */
  | { kind: 'new-sub'; parent: string }
  | { kind: 'rename-board'; slug: string }
  | { kind: 'rename-group'; key: string }
  | null;
type Note = { text: string; retry?: () => void } | null;

const UNGROUPED = '__ungrouped__';

export interface BoardExplorerProps {
  openSlug: string | null;
  onOpen: (slug: string) => void;
  prefs: ExplorerPrefs;
  change: Change;
  /** Hide it (desktop) or close the drawer (phone). */
  onHide: () => void;
  phone: boolean;
  /** The owner just asked for it: put focus in its search field. */
  focusOnMount?: boolean;
  /** `embedded`: drawn inside the local new shell's sidebar under the project's row (tek-kenar
   *  C4): no title, hide button or search field (the sidebar's "Search boards…" filters it), its
   *  New board / New folder portalled into `footSlot`, every other function kept. */
  variant?: 'embedded';
  /** The sidebar's board search (embedded). */
  query?: string;
  /** Where New board / New folder go (embedded): the sidebar's foot, above Settings. */
  footSlot?: HTMLElement | null;
  /** The project, for each board row's `data-row-key` (embedded; the sidebar's anchor layer). */
  vault?: string | null;
}

/** Focus went nowhere: to <body>, or with an element that has since left the page. */
const focusLost = () => {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected;
};

/** The room a menu needs below its button before it opens upward instead. */
const MENU_ROOM = 320;
/** `.wbx-menu[data-at-point]`'s width, so a pointer menu is kept inside the window. */
const POINT_MENU_WIDTH = 240;

/** A right-click on a text field keeps the native menu (copy, paste, spelling). */
const isTextField = (el: EventTarget | null) => el instanceof HTMLElement && !!el.closest('input, textarea, [contenteditable="true"]');
/** Shift+F10 or the Menu key: the keyboard's right-click. */
const isMenuKey = (e: KeyboardEvent<HTMLElement>) => e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);

export function BoardExplorer({ openSlug, onOpen, prefs, change, onHide, phone, focusOnMount, variant, query: outerQuery, footSlot, vault }: BoardExplorerProps) {
  const { t } = useI18n();
  const list = useWhiteboardList();
  const boards = useMemo(() => list.data ?? [], [list.data]);
  const embedded = variant === 'embedded';
  const [ownQuery, setQuery] = useState('');
  const query = embedded ? (outerQuery ?? '') : ownQuery;
  /** Menus are placed against the explorer, or against the window when it sits in the sidebar's
   *  scroll (a menu there is `position: fixed`, so the narrow column never clips it). */
  const hostRect = () => (embedded ? new DOMRect(0, 0, window.innerWidth, window.innerHeight) : rootRef.current?.getBoundingClientRect());
  const [menu, setMenu] = useState<Menu>(null);
  const [field, setField] = useState<Field>(null);
  const [note, setNote] = useState<Note>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  /** A GROUP being dragged (its key), and where it would land: before or after another group. */
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [groupDropAt, setGroupDropAt] = useState<{ key: string; after: boolean } | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The button that opened the menu: focus goes back to it (or to its row, if the row moved)
   *  when the menu closes, so a keyboard user never lands on <body>. */
  const trigger = useRef<{ el: HTMLElement | null; slug: string | null }>({ el: null, slug: null });
  const closeMenu = useCallback((restoreFocus = true) => {
    setMenu(null);
    setConfirm(null);
    if (!restoreFocus) return;
    const { el, slug } = trigger.current;
    // A move re-renders the row a moment later (the list patch waits on cancelQueries), so the
    // check runs again; it only ever moves focus that was LOST, never focus the owner put
    // somewhere else (the canvas keeps its shortcuts).
    const place = () => {
      if (!focusLost()) return;
      const back = el?.isConnected ? el
        : slug ? rootRef.current?.querySelector<HTMLElement>(`[data-slug="${CSS.escape(slug)}"] .wbx-row-open`) : null;
      (back ?? rootRef.current?.querySelector<HTMLElement>('.wbx-search-input'))?.focus();
    };
    for (const ms of [0, 120, 400]) setTimeout(place, ms);
  }, []);
  // Esc puts focus back on the menu's trigger; a click elsewhere leaves it where it landed.
  useDismissOnOutside(menu !== null, (reason) => closeMenu(reason === 'escape'), [menuRef]);
  // Shown again by the owner: the search field takes focus, so a keyboard user carries on.
  // Not on a plain page load: the canvas keeps its keys there.
  useEffect(() => { if (focusOnMount) rootRef.current?.querySelector<HTMLElement>('.wbx-search-input')?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** After an inline field closes, focus its row (a rename) or the search field. */
  const refocus = (slug: string | null) => requestAnimationFrame(() => {
    if (!focusLost()) return;
    const row = slug ? rootRef.current?.querySelector<HTMLElement>(`[data-slug="${CSS.escape(slug)}"] .wbx-row-open`) : null;
    (row ?? rootRef.current?.querySelector<HTMLElement>('.wbx-search-input'))?.focus();
  });
  const cancelField = () => {
    const f = field;
    setField(null);
    refocus(f?.kind === 'rename-board' ? f.slug : null);
  };

  const refused = (n: GroupMoveNote) => setNote({
    text: t(n.code === 'owner_grouped' ? 'whiteboard.explorer.refusedOwner' : n.code === 'stale_group' ? 'whiteboard.explorer.refusedStale' : 'whiteboard.explorer.refused')
      .replace(/\{(board|reason)\}/g, (_m, k: string) => (k === 'board' ? n.board : n.reason)),
  });
  const setGroup = useSetWhiteboardGroup(refused);
  const renameGroup = useRenameWhiteboardGroup(movedFolderPath);
  const create = useCreateWhiteboard();
  const renameBoard = useRenameWhiteboard();
  const del = useDeleteWhiteboard();
  const groupOrder = useWhiteboardGroupOrder();
  const setGroupOrder = useSetWhiteboardGroupOrder();
  const groupMutations = useIsMutating({ mutationKey: ['whiteboard-group'] });

  // The explorer re-asks on open: a board the CLI or an agent made a second ago must be in it.
  useEffect(() => { void list.refetch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pins, recents and empty groups are pruned only against a list that LOADED and is not an
  // optimistic patch: a loading or failed list would wipe the pins, a rolled-back drop the group.
  useEffect(() => {
    if (!list.isSuccess || list.isFetching || groupMutations > 0) return;
    change((p) => pruneExplorerPrefs(p, boards));
  }, [list.isSuccess, list.isFetching, groupMutations, boards, change]);

  const order = groupOrder.data;
  const view = useMemo(() => buildExplorer(boards, prefs, query, openSlug, order ?? []), [boards, prefs, query, openSlug, order]);
  const groupNames = useMemo(() => realGroupNames(boards), [boards]);
  /** Every folder, a sub-folder right after its folder: the lookup for menus and fields. The
   *  menu's "Move to" list is the whole tree, never only the search hits. */
  const allFolders = useMemo(() => buildExplorer(boards, prefs, '', null, order ?? []).groups, [boards, prefs, order]);
  const flatFolders = useMemo(() => allFolders.flatMap((g) => [g, ...g.subs]), [allFolders]);
  const findFolder = (key: string) => flatFolders.find((g) => g.key === key) ?? view.groups.flatMap((g) => [g, ...g.subs]).find((g) => g.key === key);
  const bySlug = useMemo(() => new Map(boards.map((b) => [b.slug, b])), [boards]);

  // The open board's folder (and its parent) opens when that board is opened (once: a click may fold it again).
  const openGroup = openSlug ? bySlug.get(openSlug)?.group ?? null : null;
  useEffect(() => {
    if (openGroup) change((p) => expandFolder(p, openGroup));
  }, [openSlug, openGroup, change]);

  // The open board's row scrolls into view when it changes.
  useEffect(() => {
    scrollRef.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [openSlug, view]);

  const open = (slug: string) => {
    if (menu) closeMenu();
    onOpen(slug);
    if (phone) onHide();
  };

  /** Rename a board in place: the field is drawn on its group (or Ungrouped) row, so a
   *  collapsed group is opened first, whichever copy of the row asked. */
  const startRename = (slug: string) => {
    const g = bySlug.get(slug)?.group;
    if (g) change((p) => expandFolder(p, g));
    setMenu(null);
    setConfirm(null);
    setField({ kind: 'rename-board', slug });
  };

  const moveTo = (slug: string, group: string | null) => {
    const board = bySlug.get(slug);
    if (!board || board.corrupt) return;
    const target = group === null ? null : group;
    if ((board.group ?? null) === target) return;
    setNote(null);
    // The last board out of a group keeps the group, as an empty one.
    change((p) => keepGroupIfEmptied(p, boards, slug));
    setGroup.mutate({ slug, group: target, expectGroup: board.group ?? null });
  };

  const commitField = (raw: string) => {
    const f = field;
    setField(null);
    if (!f) return;
    refocus(f.kind === 'rename-board' ? f.slug : null);
    if (f.kind === 'new-board') {
      const name = newBoardName(raw);
      if (!name) return;
      create.mutate({ name, description: '', ...(f.group ? { group: f.group } : {}) }, {
        onSuccess: (res) => { if (res?.slug) open(res.slug); },
        onError: (e: Error) => setNote({ text: e.message }),
      });
      return;
    }
    if (f.kind === 'rename-board') {
      const name = raw.trim();
      const was = bySlug.get(f.slug)?.name;
      if (!name || name === was) return;
      renameBoard.mutate({ slug: f.slug, name: name.slice(0, 200) }, { onError: (e: Error) => setNote({ text: e.message }) });
      return;
    }
    // Every field names ONE folder; its place in the tree comes from where the field is.
    const name = validFolderName(raw);
    if (raw.trim() && !name) { setNote({ text: t('whiteboard.explorer.badGroupName').replace('{max}', String(GROUP_MAX)) }); return; }
    if (!name) return;
    if (f.kind === 'new-group') {
      change((p) => addEmptyGroup(p, name, groupNames));
      return;
    }
    if (f.kind === 'new-sub') {
      const parent = findFolder(f.parent);
      if (!parent) return;
      change((p) => expandFolder(addEmptyGroup(p, `${parent.name}${FOLDER_SEP}${name}`, groupNames), parent.name));
      return;
    }
    const group = findFolder(f.key);
    if (!group || group.label === name) return;
    const parent = group.parent ? findFolder(group.parent) : undefined;
    runGroupRename(group, parent ? `${parent.name}${FOLDER_SEP}${name}` : name);
  };

  /** Rename or move a folder, or delete it (`to: null`: its boards come out one level). An empty
   *  folder lives in prefs only. */
  const runGroupRename = (group: ExplorerGroup<WhiteboardSummary>, to: string | null) => {
    setNote(null);
    change((p) => renameGroupInPrefs(p, group.name, to));
    if (group.empty) return;
    const go = () => renameGroup.mutate({ from: group.name, to }, {
      onSuccess: (res) => {
        if (res.failed.length > 0) {
          setNote({ text: t('whiteboard.explorer.renamePartial').replace('{n}', String(res.failed.length)), retry: go });
        }
      },
      onError: (e: Error) => setNote({ text: e.message, retry: go }),
    });
    go();
  };

  const deleteBoard = (slug: string) => {
    setMenu(null);
    setConfirm(null);
    change((p) => keepGroupIfEmptied(p, boards, slug));
    del.mutate(slug, {
      onSuccess: () => { if (slug === openSlug) onOpen(DEFAULT_BOARD_SLUG); },
      onError: (e: Error) => setNote({ text: e.message }),
    });
  };

  /** Store a new group order (every group, top first). Never while searching: only some show. */
  const reorder = (next: string[] | null) => {
    if (!next || view.searching) return;
    setNote(null);
    setGroupOrder.mutate(next, { onError: (e: Error) => setNote({ text: e.message }) });
  };

  // ── drag ──
  /** A folder reorders only among its siblings: the dragover line and the drop both ask this. */
  const sameLevel = (a: string, b: string) => findFolder(a)?.parent === findFolder(b)?.parent;
  const endDrag = () => { setDrag(null); setDropAt(null); setDragGroup(null); setGroupDropAt(null); };
  /** A group dragged over another group's block: the line goes above it or below it, by half. */
  const onGroupDragOver = (e: DragEvent<HTMLDivElement>, target: string) => {
    if (!dragGroup) return false;
    // A folder reorders only among its siblings: over a folder of another level the event goes
    // on to the enclosing folder block, which is the dragged folder's sibling.
    if (!sameLevel(dragGroup, target)) return true;
    e.stopPropagation();
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const head = e.currentTarget.querySelector('.wbx-row--group') ?? e.currentTarget;
    const r = head.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (groupDropAt?.key !== target || groupDropAt.after !== after) setGroupDropAt({ key: target, after });
    return true;
  };
  const onDragOver = (e: DragEvent, target: string) => {
    if (!drag) return;
    // The innermost folder under the pointer takes the drop, never its parent too.
    e.stopPropagation();
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropAt !== target) setDropAt(target);
  };
  const onDrop = (e: DragEvent, target: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (drag) moveTo(drag, target === UNGROUPED ? null : target);
    endDrag();
  };
  const onGroupDrop = (e: DragEvent, target: string) => {
    // Not a sibling: the enclosing folder block drew the line, so it takes the drop.
    if (dragGroup && !sameLevel(dragGroup, target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragGroup && groupDropAt?.key === target) reorderAmong(dragGroup, (sibs) => moveGroup(sibs, dragGroup, target, groupDropAt.after));
    endDrag();
  };
  /** Rearrange a folder among its siblings (top folders, or one folder's sub-folders) and store
   *  the whole order: every top folder followed by its sub-folders. */
  const reorderAmong = (key: string, step: (siblings: ExplorerGroup<WhiteboardSummary>[]) => string[] | null) => {
    const parentKey = findFolder(key)?.parent ?? null;
    const siblings = parentKey === null ? view.groups : view.groups.find((g) => g.key === parentKey)?.subs ?? [];
    reorder(composeOrder(view.groups, parentKey, step(siblings)));
  };
  // WKWebView reports `relatedTarget = null` mid-drag: a leave with no target is not a leave.
  const onDragLeave = (e: DragEvent, target: string) => {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to) && dropAt === target) setDropAt(null);
  };

  const menuAt = (el: HTMLElement, slug: string | null): MenuAt => {
    trigger.current = { el, slug };
    const host = hostRect();
    const r = el.getBoundingClientRect();
    if (!host) return { top: r.bottom + 4 };
    if (embedded) {
      // In the sidebar: under (or over) its button, kept inside the window.
      const left = Math.max(4, Math.min(r.left, window.innerWidth - POINT_MENU_WIDTH - 8));
      return host.bottom - r.bottom < MENU_ROOM ? { bottom: host.bottom - r.top + 4, left } : { top: r.bottom + 4, left };
    }
    return host.bottom - r.bottom < MENU_ROOM ? { bottom: host.bottom - r.top + 4 } : { top: r.bottom - host.top + 4 };
  };

  /** A right-click's menu: at the pointer, kept inside the window; focus goes back to `el`. */
  const menuAtPoint = (e: ReactMouseEvent, el: HTMLElement | null, slug: string | null): MenuAt => {
    trigger.current = { el, slug };
    const host = hostRect();
    if (!host) return { top: e.clientY, left: e.clientX };
    const left = Math.max(4, Math.min(e.clientX - host.left, window.innerWidth - host.left - POINT_MENU_WIDTH - 8));
    return window.innerHeight - e.clientY < MENU_ROOM
      ? { bottom: Math.max(4, host.bottom - e.clientY), left }
      : { top: Math.max(4, e.clientY - host.top), left };
  };
  const onRowContextMenu = (e: ReactMouseEvent<HTMLElement>, next: { kind: 'board'; slug: string } | { kind: 'group'; key: string }) => {
    if (isTextField(e.target)) return;
    e.preventDefault();
    setConfirm(null);
    const open = e.currentTarget.querySelector<HTMLElement>('.wbx-row-open');
    setMenu({ ...next, ...menuAtPoint(e, open, next.kind === 'board' ? next.slug : null) });
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); setQuery(''); }
    if (e.key === 'Enter' && view.searching && view.hits[0]) { e.preventDefault(); open(view.hits[0].slug); }
  };

  const row = (b: WhiteboardSummary, where: string) => {
    const current = b.slug === openSlug;
    if (field?.kind === 'rename-board' && field.slug === b.slug && where !== 'pinned' && where !== 'recent') {
      return <InlineField key={`${where}:${b.slug}`} initial={b.name} label={t('whiteboard.tabs.renameLabel')} onDone={commitField} onCancel={cancelField} />;
    }
    return (
      <div
        key={`${where}:${b.slug}`}
        className="wbx-row"
        data-slug={b.slug}
        data-row-key={embedded && vault ? `board:${vault}/${b.slug}` : undefined}
        data-current={current ? 'true' : undefined}
        data-dragging={drag === b.slug ? '' : undefined}
        draggable={!b.corrupt}
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.name); setMenu(null); setDrag(b.slug); }}
        onDragEnd={() => { setDrag(null); setDropAt(null); }}
        onContextMenu={(e) => onRowContextMenu(e, { kind: 'board', slug: b.slug })}
      >
        <button
          type="button"
          className="wbx-row-open"
          aria-current={current ? 'page' : undefined}
          title={b.description || b.name}
          onClick={() => open(b.slug)}
          onKeyDown={(e) => {
            if (e.key === 'F2') { e.preventDefault(); startRename(b.slug); return; }
            if (isMenuKey(e)) { e.preventDefault(); setConfirm(null); setMenu({ kind: 'board', slug: b.slug, ...menuAt(e.currentTarget, b.slug) }); }
          }}
        >
          <BoardGlyph />
          <span className="wbx-name">{b.name || b.slug}</span>
          {isDefaultBoard(b.slug) && where !== 'recent' && <span className="wbx-badge">{t('whiteboard.switcher.default')}</span>}
          {b.corrupt && <span className="wbx-badge wbx-badge--bad">{t('whiteboard.page.corruptBadge')}</span>}
        </button>
        <button
          type="button"
          className="wbx-more"
          aria-label={t('whiteboard.explorer.moreFor').replace('{name}', b.name)}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'board' && menu.slug === b.slug}
          onClick={(e) => { setConfirm(null); setMenu({ kind: 'board', slug: b.slug, ...menuAt(e.currentTarget, b.slug) }); }}
        >
          <DotsGlyph />
        </button>
      </div>
    );
  };

  const groupBlock = (g: ExplorerGroup<WhiteboardSummary>): ReactNode => {
    const renaming = field?.kind === 'rename-group' && field.key === g.key;
    const adding = field?.kind === 'new-board' && field.group !== null && fold(field.group) === g.key;
    const addingSub = field?.kind === 'new-sub' && field.parent === g.key;
    return (
      <div
        key={`g:${g.key}`}
        className="wbx-group"
        data-drop={dropAt === g.key ? '' : undefined}
        data-drop-line={groupDropAt?.key === g.key && dragGroup !== g.key ? (groupDropAt.after ? 'after' : 'before') : undefined}
        data-dragging={dragGroup === g.key ? '' : undefined}
        onDragOver={(e) => { if (!onGroupDragOver(e, g.key)) onDragOver(e, g.key); }}
        onDragLeave={(e) => {
          if (dragGroup) {
            const to = e.relatedTarget as Node | null;
            if (to && !e.currentTarget.contains(to) && groupDropAt?.key === g.key) setGroupDropAt(null);
            return;
          }
          onDragLeave(e, g.key);
        }}
        onDrop={(e) => (dragGroup ? onGroupDrop(e, g.key) : onDrop(e, g.name))}
      >
        {renaming ? (
          <InlineField initial={g.label} label={t('whiteboard.explorer.groupName')} maxLength={GROUP_MAX} onDone={commitField} onCancel={cancelField} />
        ) : (
          <div
            className="wbx-row wbx-row--group"
            data-sub={g.parent ? '' : undefined}
            draggable={!view.searching}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', g.name);
              setMenu(null);
              setDrag(null);
              setDragGroup(g.key);
            }}
            onDragEnd={endDrag}
            onContextMenu={(e) => onRowContextMenu(e, { kind: 'group', key: g.key })}
          >
            <button
              type="button"
              className="wbx-row-open"
              aria-expanded={!g.collapsed}
              onClick={() => change((p) => toggleCollapsed(p, g.name))}
              onKeyDown={(e) => {
                if (isMenuKey(e)) { e.preventDefault(); setConfirm(null); setMenu({ kind: 'group', key: g.key, ...menuAt(e.currentTarget, null) }); }
              }}
            >
              <span className="wbx-twisty" data-open={g.collapsed ? undefined : ''}><ChevronRightGlyph /></span>
              <FolderGlyph />
              <span className="wbx-name">{g.label}</span>
              <span className="wbx-count">{g.empty ? t('whiteboard.explorer.emptyCount') : g.total}</span>
            </button>
            <button
              type="button"
              className="wbx-more"
              aria-label={t('whiteboard.explorer.newBoardIn').replace('{name}', g.label)}
              title={t('whiteboard.explorer.newBoardIn').replace('{name}', g.label)}
              onClick={() => { setMenu(null); setField({ kind: 'new-board', group: g.name }); if (g.collapsed) change((p) => toggleCollapsed(p, g.name)); }}
            >
              <PlusGlyph />
            </button>
            <button
              type="button"
              className="wbx-more"
              aria-label={t('whiteboard.explorer.moreFor').replace('{name}', g.label)}
              aria-haspopup="menu"
              onClick={(e) => { setConfirm(null); setMenu({ kind: 'group', key: g.key, ...menuAt(e.currentTarget, null) }); }}
            >
              <DotsGlyph />
            </button>
          </div>
        )}
        {!g.collapsed && (
          <div className="wbx-kids">
            {addingSub && <InlineField initial="" label={t('whiteboard.explorer.subFolderName')} placeholder={t('whiteboard.explorer.subFolderName')} maxLength={GROUP_MAX} onDone={commitField} onCancel={cancelField} />}
            {g.subs.map(groupBlock)}
            {g.boards.map((b) => row(b, `g:${g.key}`))}
            {g.empty && g.subs.length === 0 && !adding && !addingSub && <p className="wbx-hint">{t('whiteboard.explorer.emptyHint')}</p>}
            {adding && <InlineField initial="" label={t('whiteboard.switcher.new')} placeholder={t('whiteboard.page.namePlaceholder')} onDone={commitField} onCancel={cancelField} />}
          </div>
        )}
      </div>
    );
  };

  const menuBoard = menu?.kind === 'board' ? bySlug.get(menu.slug) : undefined;
  const menuGroup = menu?.kind === 'group' ? findFolder(menu.key) : undefined;
  const menuParent = menuGroup?.parent ? findFolder(menuGroup.parent) : undefined;
  /** The folders a board's "Move to" lists: the whole tree, a sub-folder indented under its folder. */
  const moveTargets = flatFolders.map((g) => ({ name: g.name, label: g.label, depth: g.parent ? 1 : 0, key: g.key }));
  const menuSiblings = menuGroup ? (menuGroup.parent ? view.groups.find((g) => g.key === menuGroup.parent)?.subs ?? [] : view.groups) : [];

  return (
    <aside className="wbx" ref={rootRef} aria-label={t('whiteboard.explorer.title')} data-phone={phone ? '' : undefined} data-embedded={embedded ? '' : undefined}>
      {!embedded && (<>
      <div className="wbx-head">
        <h2 className="wbx-title">{t('whiteboard.explorer.title')}</h2>
        <button type="button" className="wbx-icon" aria-label={t('whiteboard.switcher.new')} title={t('whiteboard.switcher.new')} onClick={() => setField({ kind: 'new-board', group: null })}>
          <PlusGlyph />
        </button>
        <button type="button" className="wbx-icon" aria-label={t('whiteboard.explorer.hide')} title={t('whiteboard.explorer.hide')} onClick={onHide}>
          <SidebarGlyph />
        </button>
      </div>
      <label className="wbx-search">
        <SearchGlyph />
        <input
          className="wbx-search-input"
          value={query}
          placeholder={t('whiteboard.switcher.search')}
          aria-label={t('whiteboard.switcher.search')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
        />
      </label>
      </>)}
      {note && (
        <div className="wbx-note" role="alert">
          <span>{note.text}</span>
          {note.retry && <button type="button" className="wbx-link" onClick={() => { const r = note.retry!; setNote(null); r(); }}>{t('whiteboard.page.retry')}</button>}
          <button type="button" className="wbx-link" aria-label={t('whiteboard.explorer.dismiss')} onClick={() => setNote(null)}>×</button>
        </div>
      )}

      <div className="wbx-scroll" ref={scrollRef} onDragEnd={endDrag}>
        {list.isLoading && <LoadingSkeleton shape="list" label={t('common.loading')} />}
        {list.isError && <p className="wbx-hint wbx-hint--bad">{t('whiteboard.page.loadFailed')} {list.error?.message}</p>}

        {view.pinned.length > 0 && (
          <Section label={t('whiteboard.explorer.pinned')} icon={<PinGlyph />}>{view.pinned.map((b) => row(b, 'pinned'))}</Section>
        )}
        {view.recent.length > 0 && (
          <Section label={t('whiteboard.explorer.recent')} icon={<ClockGlyph />}>{view.recent.map((b) => row(b, 'recent'))}</Section>
        )}
        {(view.groups.length > 0 || field?.kind === 'new-group' || !view.searching) && (
          <Section
            label={t('whiteboard.explorer.groups')}
            action={(
              <button type="button" className="wbx-icon wbx-icon--sm" aria-label={t('whiteboard.explorer.newGroup')} title={t('whiteboard.explorer.newGroup')} onClick={() => setField({ kind: 'new-group' })}>
                <PlusGlyph />
              </button>
            )}
          >
            {view.groups.map(groupBlock)}
            {field?.kind === 'new-group' && (
              <InlineField initial="" label={t('whiteboard.explorer.groupName')} placeholder={t('whiteboard.explorer.groupName')} maxLength={GROUP_MAX} onDone={commitField} onCancel={cancelField} />
            )}
            {view.groups.length === 0 && field?.kind !== 'new-group' && !view.searching && boards.length > 0 && (
              <p className="wbx-hint">{t('whiteboard.explorer.noGroups')}</p>
            )}
          </Section>
        )}
        <div
          className="wbx-ungrouped"
          data-drop={dropAt === UNGROUPED ? '' : undefined}
          onDragOver={(e) => onDragOver(e, UNGROUPED)}
          onDragLeave={(e) => onDragLeave(e, UNGROUPED)}
          onDrop={(e) => onDrop(e, UNGROUPED)}
        >
          {(view.ungrouped.length > 0 || (drag && bySlug.get(drag)?.group)) && (
            <Section label={t('whiteboard.explorer.ungrouped')}>{view.ungrouped.map((b) => row(b, 'ungrouped'))}</Section>
          )}
          {field?.kind === 'new-board' && field.group === null && (
            <InlineField initial="" label={t('whiteboard.switcher.new')} placeholder={t('whiteboard.page.namePlaceholder')} onDone={commitField} onCancel={cancelField} />
          )}
        </div>
        {view.searching && view.hits.length === 0 && <p className="wbx-hint">{t('whiteboard.switcher.noMatch')}</p>}
        {!view.searching && <TrashSection onRestored={open} />}
      </div>

      {(() => {
        const foot = (
          <div className="wbx-foot" data-testid={embedded ? 'sidebar-boards-foot' : undefined}>
            <button type="button" className="wbx-foot-btn wbx-foot-btn--primary" onClick={() => setField({ kind: 'new-board', group: null })}>
              <PlusGlyph /> {t('whiteboard.switcher.new')}
            </button>
            <button type="button" className="wbx-foot-btn" onClick={() => setField({ kind: 'new-group' })}>
              <FolderGlyph /> {t('whiteboard.explorer.newGroup')}
            </button>
          </div>
        );
        if (!embedded) return foot;
        return footSlot ? createPortal(foot, footSlot) : null;
      })()}

      {menu && (
        <div
          className="wbx-menu"
          role="menu"
          ref={menuRef}
          data-at-point={menu.left !== undefined ? '' : undefined}
          style={{ ...('top' in menu ? { top: menu.top } : { bottom: menu.bottom }), ...(menu.left !== undefined ? { left: menu.left } : {}) }}
        >
          {menuBoard && (confirm === menuBoard.slug ? (
            <div className="wbx-confirm">
              <p>{t('whiteboard.switcher.deleteAsk').replace('{name}', menuBoard.name)}</p>
              <div className="wbx-confirm-actions">
                <button type="button" className="wbx-menu-item" autoFocus onClick={() => setConfirm(null)}>{t('whiteboard.widget.cancel')}</button>
                <button type="button" className="wbx-menu-item wbx-menu-item--danger" onClick={() => deleteBoard(menuBoard.slug)}>{t('whiteboard.page.delete')}</button>
              </div>
            </div>
          ) : (
            <>
              <MenuButton label={t('whiteboard.explorer.open')} onClick={() => open(menuBoard.slug)} autoFocus />
              <MenuButton label={t('whiteboard.tabs.rename')} hint="F2" onClick={() => startRename(menuBoard.slug)} />
              <MenuButton
                label={prefs.pinned.includes(menuBoard.slug) ? t('whiteboard.explorer.unpin') : t('whiteboard.explorer.pin')}
                onClick={() => { change((p) => togglePin(p, menuBoard.slug)); closeMenu(); }}
              />
              <div className="wbx-menu-sep" role="separator" />
              <p className="wbx-menu-label">{t('whiteboard.explorer.moveTo')}</p>
              {menuBoard.corrupt && <p className="wbx-menu-label">{t('whiteboard.explorer.corruptNoMove')}</p>}
              {moveTargets.map((g) => {
                const here = !!menuBoard.group && fold(menuBoard.group) === g.key;
                return (
                  <MenuButton
                    key={g.key}
                    label={g.label}
                    icon={<FolderGlyph />}
                    indent={g.depth}
                    tag={here ? t('whiteboard.explorer.here') : undefined}
                    disabled={!!menuBoard.corrupt || here}
                    onClick={() => { moveTo(menuBoard.slug, g.name); closeMenu(); }}
                  />
                );
              })}
              {menuBoard.group && (
                <MenuButton label={t('whiteboard.explorer.removeFromGroup')} disabled={!!menuBoard.corrupt} onClick={() => { moveTo(menuBoard.slug, null); closeMenu(); }} />
              )}
              {canDeleteBoard(menuBoard.slug) && (
                <>
                  <div className="wbx-menu-sep" role="separator" />
                  <MenuButton label={t('whiteboard.page.delete')} danger onClick={() => setConfirm(menuBoard.slug)} />
                </>
              )}
            </>
          ))}
          {menuGroup && (confirm === `g:${menuGroup.key}` ? (
            <div className="wbx-confirm">
              <p>{(menuParent
                ? t(menuGroup.empty ? 'whiteboard.explorer.deleteEmptyAsk' : 'whiteboard.explorer.deleteSubFolderAsk').replace('{parent}', menuParent.label)
                : t(menuGroup.subs.length > 0 ? 'whiteboard.explorer.deleteFolderAsk' : menuGroup.empty ? 'whiteboard.explorer.deleteEmptyAsk' : 'whiteboard.explorer.deleteFlatFolderAsk')
              ).replace('{name}', menuGroup.label)}</p>
              <div className="wbx-confirm-actions">
                <button type="button" className="wbx-menu-item" autoFocus onClick={() => setConfirm(null)}>{t('whiteboard.widget.cancel')}</button>
                <button type="button" className="wbx-menu-item" onClick={() => { closeMenu(); runGroupRename(menuGroup, null); }}>
                  {t('whiteboard.explorer.deleteFolder')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <MenuButton label={t('whiteboard.explorer.newBoardIn').replace('{name}', menuGroup.label)} autoFocus onClick={() => { setMenu(null); setField({ kind: 'new-board', group: menuGroup.name }); change((p) => expandFolder(p, menuGroup.name)); }} />
              {!menuGroup.parent && (
                <MenuButton label={t('whiteboard.explorer.newSubFolder')} onClick={() => { setMenu(null); setField({ kind: 'new-sub', parent: menuGroup.key }); change((p) => expandFolder(p, menuGroup.name)); }} />
              )}
              <MenuButton label={t('whiteboard.explorer.renameGroup')} onClick={() => { setMenu(null); setField({ kind: 'rename-group', key: menuGroup.key }); }} />
              {menuGroup.parent && (
                <>
                  <div className="wbx-menu-sep" role="separator" />
                  <p className="wbx-menu-label">{t('whiteboard.explorer.moveTo')}</p>
                  {allFolders.filter((g) => g.key !== menuGroup.parent).map((g) => (
                    <MenuButton key={g.key} label={g.label} icon={<FolderGlyph />} onClick={() => { closeMenu(); runGroupRename(menuGroup, `${g.name}${FOLDER_SEP}${menuGroup.label}`); }} />
                  ))}
                  <MenuButton label={t('whiteboard.explorer.moveToTop')} onClick={() => { closeMenu(); runGroupRename(menuGroup, menuGroup.label); }} />
                </>
              )}
              {!view.searching && menuSiblings.length > 1 && (
                <>
                  <div className="wbx-menu-sep" role="separator" />
                  <MenuButton
                    label={t('whiteboard.explorer.moveGroupUp')}
                    disabled={menuSiblings[0]?.key === menuGroup.key}
                    onClick={() => { reorderAmong(menuGroup.key, (sibs) => stepGroup(sibs, menuGroup.key, -1)); closeMenu(); }}
                  />
                  <MenuButton
                    label={t('whiteboard.explorer.moveGroupDown')}
                    disabled={menuSiblings[menuSiblings.length - 1]?.key === menuGroup.key}
                    onClick={() => { reorderAmong(menuGroup.key, (sibs) => stepGroup(sibs, menuGroup.key, 1)); closeMenu(); }}
                  />
                </>
              )}
              <div className="wbx-menu-sep" role="separator" />
              <MenuButton label={t('whiteboard.explorer.deleteFolder')} onClick={() => setConfirm(`g:${menuGroup.key}`)} />
            </>
          ))}
        </div>
      )}
    </aside>
  );
}

function Section({ label, icon, action, children }: { label: string; icon?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="wbx-sec">
      <div className="wbx-label">{icon}<span>{label}</span>{action}</div>
      {children}
    </section>
  );
}

function MenuButton({ label, onClick, disabled, danger, icon, autoFocus, hint, indent, tag }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; icon?: ReactNode; autoFocus?: boolean;
  /** Its keyboard shortcut, drawn quiet at the right. */
  hint?: string;
  /** A sub-folder in a folder list: one step in. */
  indent?: number;
  /** A quiet pill at the right ("here" on the folder a board is in). */
  tag?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'wbx-menu-item wbx-menu-item--danger' : 'wbx-menu-item'}
      data-indent={indent ? String(indent) : undefined}
      disabled={disabled}
      autoFocus={autoFocus}
      onClick={onClick}
    >
      {icon}{label}{hint && <kbd className="wbx-menu-hint">{hint}</kbd>}{tag && <span className="wbx-menu-tag">{tag}</span>}
    </button>
  );
}

/** One name field: Enter or blur commits, Escape cancels (once: unmounting blurs it too). */
function InlineField({ initial, label, placeholder, maxLength = 200, onDone, onCancel }: {
  initial: string; label: string; placeholder?: string; maxLength?: number;
  onDone: (value: string) => void; onCancel: () => void;
}) {
  const settled = useRef(false);
  return (
    <input
      className="wbx-field"
      defaultValue={initial}
      autoFocus
      maxLength={maxLength * 2}
      aria-label={label}
      placeholder={placeholder}
      onFocus={(e) => { settled.current = false; e.currentTarget.select(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        if (settled.current) return;
        settled.current = true;
        if (e.key === 'Enter') onDone(e.currentTarget.value);
        else onCancel();
      }}
      onBlur={(e) => {
        if (settled.current) return;
        settled.current = true;
        if (e.currentTarget.value.trim()) onDone(e.currentTarget.value);
        else onCancel();
      }}
    />
  );
}
