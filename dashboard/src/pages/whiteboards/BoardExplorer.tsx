/**
 * The board explorer (owner, 2026-10-28: "a page explorer with grouped pages, like a wiki"):
 * the left sidebar of the Whiteboard page listing EVERY board — Pinned, Recent, the groups
 * (a board's own frontmatter `group`), Ungrouped — with search, drag a board onto a group, and
 * a ⋯ menu that does everything a drag does, so the keyboard reaches it all.
 *
 * Rendered above the slug-keyed editor (WhiteboardsPage.tsx), so a board switch keeps its
 * search, its fields and its scroll. The pure half is explorerLogic.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useDismissOnOutside } from '../../lib/useDismissOnOutside';
import {
  useCreateWhiteboard, useDeleteWhiteboard, useRenameWhiteboard, useRenameWhiteboardGroup, useSetWhiteboardGroup,
  useWhiteboardList, type GroupMoveNote, type WhiteboardSummary,
} from '../../hooks/useWhiteboards';
import { BoardGlyph, PlusGlyph, SearchGlyph } from './BoardSwitcher';
import { DEFAULT_BOARD_SLUG, canDeleteBoard, fold, isDefaultBoard, newBoardName } from './boardSwitcherLogic';
import {
  addEmptyGroup, buildExplorer, keepGroupIfEmptied, pruneExplorerPrefs, realGroupNames, removeEmptyGroup,
  renameGroupInPrefs, toggleCollapsed, togglePin, validGroupName, GROUP_MAX, type ExplorerGroup, type ExplorerPrefs,
} from './explorerLogic';
import './BoardExplorer.css';

type Change = (update: (p: ExplorerPrefs) => ExplorerPrefs) => void;
/** Where a menu opens: below its button, or above it when the room below is short. */
type MenuAt = { top: number } | { bottom: number };
type Menu = ({ kind: 'board'; slug: string } & MenuAt) | ({ kind: 'group'; key: string } & MenuAt) | null;
/** An inline name field: a new board (in a group, or none), a new group, a board or group rename. */
type Field =
  | { kind: 'new-board'; group: string | null }
  | { kind: 'new-group' }
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
}

/** Focus went nowhere: to <body>, or with an element that has since left the page. */
const focusLost = () => {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected;
};

/** The room a menu needs below its button before it opens upward instead. */
const MENU_ROOM = 320;

export function BoardExplorer({ openSlug, onOpen, prefs, change, onHide, phone, focusOnMount }: BoardExplorerProps) {
  const { t } = useI18n();
  const list = useWhiteboardList();
  const boards = useMemo(() => list.data ?? [], [list.data]);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<Menu>(null);
  const [field, setField] = useState<Field>(null);
  const [note, setNote] = useState<Note>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
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
  const renameGroup = useRenameWhiteboardGroup(fold);
  const create = useCreateWhiteboard();
  const renameBoard = useRenameWhiteboard();
  const del = useDeleteWhiteboard();
  const groupMutations = useIsMutating({ mutationKey: ['whiteboard-group'] });

  // The explorer re-asks on open: a board the CLI or an agent made a second ago must be in it.
  useEffect(() => { void list.refetch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pins, recents and empty groups are pruned only against a list that LOADED and is not an
  // optimistic patch: a loading or failed list would wipe the pins, a rolled-back drop the group.
  useEffect(() => {
    if (!list.isSuccess || list.isFetching || groupMutations > 0) return;
    change((p) => pruneExplorerPrefs(p, boards));
  }, [list.isSuccess, list.isFetching, groupMutations, boards, change]);

  const view = useMemo(() => buildExplorer(boards, prefs, query, openSlug), [boards, prefs, query, openSlug]);
  const groupNames = useMemo(() => realGroupNames(boards), [boards]);
  const bySlug = useMemo(() => new Map(boards.map((b) => [b.slug, b])), [boards]);

  // The open board's group opens when that board is opened (once: a click may fold it again).
  const openGroupKey = openSlug && bySlug.get(openSlug)?.group ? fold(bySlug.get(openSlug)!.group!) : null;
  useEffect(() => {
    if (openGroupKey) change((p) => (p.collapsed.includes(openGroupKey) ? { ...p, collapsed: p.collapsed.filter((k) => k !== openGroupKey) } : p));
  }, [openSlug, openGroupKey, change]);

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
    const grp = g ? view.groups.find((x) => x.key === fold(g)) : undefined;
    if (grp?.collapsed) change((p) => toggleCollapsed(p, grp.name));
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
    const name = validGroupName(raw);
    if (raw.trim() && !name) { setNote({ text: t('whiteboard.explorer.badGroupName').replace('{max}', String(GROUP_MAX)) }); return; }
    if (!name) return;
    if (f.kind === 'new-group') {
      change((p) => addEmptyGroup(p, name, groupNames));
      return;
    }
    const group = view.groups.find((g) => g.key === f.key);
    if (!group || group.name === name) return;
    runGroupRename(group, name);
  };

  /** Rename (or ungroup all, `to: null`) a group. An empty group lives in prefs only. */
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

  // ── drag ──
  const onDragOver = (e: DragEvent, target: string) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropAt !== target) setDropAt(target);
  };
  const onDrop = (e: DragEvent, target: string) => {
    e.preventDefault();
    if (drag) moveTo(drag, target === UNGROUPED ? null : target);
    setDrag(null);
    setDropAt(null);
  };
  // WKWebView reports `relatedTarget = null` mid-drag: a leave with no target is not a leave.
  const onDragLeave = (e: DragEvent, target: string) => {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to) && dropAt === target) setDropAt(null);
  };

  const menuAt = (el: HTMLElement, slug: string | null): MenuAt => {
    trigger.current = { el, slug };
    const host = rootRef.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!host) return { top: r.bottom + 4 };
    return host.bottom - r.bottom < MENU_ROOM ? { bottom: host.bottom - r.top + 4 } : { top: r.bottom - host.top + 4 };
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
        data-current={current ? 'true' : undefined}
        data-dragging={drag === b.slug ? '' : undefined}
        draggable={!b.corrupt}
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.name); setMenu(null); setDrag(b.slug); }}
        onDragEnd={() => { setDrag(null); setDropAt(null); }}
      >
        <button
          type="button"
          className="wbx-row-open"
          aria-current={current ? 'page' : undefined}
          title={b.description || b.name}
          onClick={() => open(b.slug)}
          onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); startRename(b.slug); } }}
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

  const groupBlock = (g: ExplorerGroup<WhiteboardSummary>) => {
    const renaming = field?.kind === 'rename-group' && field.key === g.key;
    const adding = field?.kind === 'new-board' && field.group !== null && fold(field.group) === g.key;
    return (
      <div
        key={`g:${g.key}`}
        className="wbx-group"
        data-drop={dropAt === g.key ? '' : undefined}
        onDragOver={(e) => onDragOver(e, g.key)}
        onDragLeave={(e) => onDragLeave(e, g.key)}
        onDrop={(e) => onDrop(e, g.name)}
      >
        {renaming ? (
          <InlineField initial={g.name} label={t('whiteboard.explorer.groupName')} maxLength={GROUP_MAX} onDone={commitField} onCancel={cancelField} />
        ) : (
          <div className="wbx-row wbx-row--group">
            <button
              type="button"
              className="wbx-row-open"
              aria-expanded={!g.collapsed}
              onClick={() => change((p) => toggleCollapsed(p, g.name))}
            >
              <span className="wbx-twisty" data-open={g.collapsed ? undefined : ''}><ChevronRightGlyph /></span>
              <FolderGlyph />
              <span className="wbx-name">{g.name}</span>
              <span className="wbx-count">{g.empty ? t('whiteboard.explorer.emptyCount') : g.boards.length}</span>
            </button>
            <button
              type="button"
              className="wbx-more"
              aria-label={t('whiteboard.explorer.newBoardIn').replace('{name}', g.name)}
              title={t('whiteboard.explorer.newBoardIn').replace('{name}', g.name)}
              onClick={() => { setMenu(null); setField({ kind: 'new-board', group: g.name }); if (g.collapsed) change((p) => toggleCollapsed(p, g.name)); }}
            >
              <PlusGlyph />
            </button>
            <button
              type="button"
              className="wbx-more"
              aria-label={t('whiteboard.explorer.moreFor').replace('{name}', g.name)}
              aria-haspopup="menu"
              onClick={(e) => { setConfirm(null); setMenu({ kind: 'group', key: g.key, ...menuAt(e.currentTarget, null) }); }}
            >
              <DotsGlyph />
            </button>
          </div>
        )}
        {!g.collapsed && (
          <div className="wbx-kids">
            {g.boards.map((b) => row(b, `g:${g.key}`))}
            {g.empty && !adding && <p className="wbx-hint">{t('whiteboard.explorer.emptyHint')}</p>}
            {adding && <InlineField initial="" label={t('whiteboard.switcher.new')} placeholder={t('whiteboard.page.namePlaceholder')} onDone={commitField} onCancel={cancelField} />}
          </div>
        )}
      </div>
    );
  };

  const menuBoard = menu?.kind === 'board' ? bySlug.get(menu.slug) : undefined;
  const menuGroup = menu?.kind === 'group' ? view.groups.find((g) => g.key === menu.key) : undefined;

  return (
    <aside className="wbx" ref={rootRef} aria-label={t('whiteboard.explorer.title')} data-phone={phone ? '' : undefined}>
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
      {note && (
        <div className="wbx-note" role="alert">
          <span>{note.text}</span>
          {note.retry && <button type="button" className="wbx-link" onClick={() => { const r = note.retry!; setNote(null); r(); }}>{t('whiteboard.page.retry')}</button>}
          <button type="button" className="wbx-link" aria-label={t('whiteboard.explorer.dismiss')} onClick={() => setNote(null)}>×</button>
        </div>
      )}

      <div className="wbx-scroll" ref={scrollRef} onDragEnd={() => { setDrag(null); setDropAt(null); }}>
        {list.isLoading && <p className="wbx-hint">{t('common.loading')}</p>}
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
      </div>

      <div className="wbx-foot">
        <button type="button" className="wbx-foot-btn wbx-foot-btn--primary" onClick={() => setField({ kind: 'new-board', group: null })}>
          <PlusGlyph /> {t('whiteboard.switcher.new')}
        </button>
        <button type="button" className="wbx-foot-btn" onClick={() => setField({ kind: 'new-group' })}>
          <FolderGlyph /> {t('whiteboard.explorer.newGroup')}
        </button>
      </div>

      {menu && (
        <div className="wbx-menu" role="menu" ref={menuRef} style={'top' in menu ? { top: menu.top } : { bottom: menu.bottom }}>
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
              <MenuButton label={t('whiteboard.tabs.rename')} onClick={() => startRename(menuBoard.slug)} />
              <MenuButton
                label={prefs.pinned.includes(menuBoard.slug) ? t('whiteboard.explorer.unpin') : t('whiteboard.explorer.pin')}
                onClick={() => { change((p) => togglePin(p, menuBoard.slug)); closeMenu(); }}
              />
              <div className="wbx-menu-sep" role="separator" />
              <p className="wbx-menu-label">{t('whiteboard.explorer.moveTo')}</p>
              {menuBoard.corrupt && <p className="wbx-menu-label">{t('whiteboard.explorer.corruptNoMove')}</p>}
              {[...groupNames, ...prefs.emptyGroups.filter((e) => !groupNames.some((g) => fold(g) === fold(e)))]
                .filter((g) => !menuBoard.group || fold(g) !== fold(menuBoard.group))
                .map((g) => (
                  <MenuButton key={g} label={g} icon={<FolderGlyph />} disabled={!!menuBoard.corrupt} onClick={() => { moveTo(menuBoard.slug, g); closeMenu(); }} />
                ))}
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
              <p>{t('whiteboard.explorer.ungroupAsk').replace('{name}', menuGroup.name)}</p>
              <div className="wbx-confirm-actions">
                <button type="button" className="wbx-menu-item" autoFocus onClick={() => setConfirm(null)}>{t('whiteboard.widget.cancel')}</button>
                <button type="button" className="wbx-menu-item" onClick={() => { closeMenu(); if (menuGroup.empty) change((p) => removeEmptyGroup(p, menuGroup.name)); else runGroupRename(menuGroup, null); }}>
                  {menuGroup.empty ? t('whiteboard.explorer.deleteEmptyGroup') : t('whiteboard.explorer.ungroupAll')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <MenuButton label={t('whiteboard.explorer.renameGroup')} autoFocus onClick={() => { setMenu(null); setField({ kind: 'rename-group', key: menuGroup.key }); }} />
              <MenuButton label={t('whiteboard.explorer.newBoardIn').replace('{name}', menuGroup.name)} onClick={() => { setMenu(null); setField({ kind: 'new-board', group: menuGroup.name }); }} />
              <div className="wbx-menu-sep" role="separator" />
              <MenuButton
                label={menuGroup.empty ? t('whiteboard.explorer.deleteEmptyGroup') : t('whiteboard.explorer.ungroupAll')}
                onClick={() => setConfirm(`g:${menuGroup.key}`)}
              />
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

function MenuButton({ label, onClick, disabled, danger, icon, autoFocus }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; icon?: ReactNode; autoFocus?: boolean;
}) {
  return (
    <button type="button" role="menuitem" className={danger ? 'wbx-menu-item wbx-menu-item--danger' : 'wbx-menu-item'} disabled={disabled} autoFocus={autoFocus} onClick={onClick}>
      {icon}{label}
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

// ── glyphs (16px, the rail's stroke hand, as BoardSwitcher's) ──────────────────────────────────

const glyph = {
  width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
};

export function SidebarGlyph() {
  return <svg {...glyph} className="wbs-glyph"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M6 2.5v11" /></svg>;
}
function FolderGlyph() {
  return <svg {...glyph} className="wbs-glyph"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></svg>;
}
function ChevronRightGlyph() {
  return <svg {...glyph} className="wbs-glyph"><path d="M6 4l4 4-4 4" /></svg>;
}
function PinGlyph() {
  return <svg {...glyph} className="wbs-glyph"><path d="M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2zM8 9.5V14" /></svg>;
}
function ClockGlyph() {
  return <svg {...glyph} className="wbs-glyph"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>;
}
function DotsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="wbs-glyph">
      <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}
