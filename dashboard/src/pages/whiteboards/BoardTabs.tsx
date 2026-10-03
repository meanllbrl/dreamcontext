import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useVault } from '../../context/VaultContext';
import { useDismissOnOutside } from '../../lib/useDismissOnOutside';
import { useWhiteboardList } from '../../hooks/useWhiteboards';
import { BoardGlyph, BoardsPanel, ChevronGlyph, CreatePanel, PlusGlyph } from './BoardSwitcher';
import { DEFAULT_BOARD_SLUG } from './boardSwitcherLogic';
import {
  GROUP_COLORS, addToGroup, addToNewGroup, closeGroup, closeOtherTabs, closeTab, moveTab, neighbourAfterClose,
  openTab, pruneTabs, removeFromGroup, sanitizeLayout, stripItems, ungroup, updateGroup,
  type StripItem, type TabGroup, type TabLayout,
} from './tabStripLogic';
import './BoardSwitcher.css';
import './BoardTabs.css';

/**
 * Which boards sit open as tabs, and how they are grouped, remembered per machine and per
 * project — like Chrome's tabs, a working arrangement rather than something the team shares.
 * Absent or unreadable → no tabs; the open board then takes the first one.
 */
const KEY_PREFIX = 'dreamcontext:whiteboard-tabs:';
const storageKey = (vault: string | null) => `${KEY_PREFIX}${vault ?? ''}`;

function readLayout(vault: string | null): TabLayout {
  try {
    const raw = localStorage.getItem(storageKey(vault));
    return sanitizeLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeLayout(null);
  }
}

function useTabLayout(): [TabLayout, (update: (l: TabLayout) => TabLayout) => void] {
  const { vault } = useVault();
  const [layout, setLayout] = useState(() => readLayout(vault));
  const latest = useRef(layout);
  // Written NOW, not inside a state updater: closing the open tab also switches boards, which
  // remounts this strip before an updater would run, and the new strip reads storage.
  const change = useCallback((update: (l: TabLayout) => TabLayout) => {
    const cur = latest.current;
    const next = update(cur);
    if (next === cur) return;
    latest.current = next;
    try { localStorage.setItem(storageKey(vault), JSON.stringify(next)); } catch { /* best-effort */ }
    setLayout(next);
  }, [vault]);
  return [layout, change];
}

type Panel = 'boards' | 'create' | null;
type Menu = { kind: 'tab'; slug: string; x: number; y: number } | { kind: 'group'; id: string; x: number; y: number } | null;
/** A close waiting for "are you sure": closing never deletes a board, but a board that drops
 *  off the strip feels lost, so every close asks first. In-app, not `confirm()`: a browser
 *  dialog is a silent no-op in the desktop webview. */
type Confirm = { ask: string; run: () => void; x: number; y: number } | null;
/** Where a dragged tab would land: before `before` (null = the end), in `group`. */
type DropAt = { before: string | null; group: string | null; mark: string; side: 'before' | 'after' | 'end' };

/** `.wbt-confirm`'s width, so the popover is kept inside the strip. */
const CONFIRM_WIDTH = 300;

const newGroupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface BoardTabsProps {
  /** The open board. */
  slug: string;
  /** Its display name once loaded; until then the list's name, then the slug, stand in. */
  name?: string;
  /** Open another board. The page re-keys the editor on the slug, so the old board's save
   *  loop flushes before its canvas goes away. */
  onOpen: (slug: string) => void;
}

/**
 * The boards as Chrome-style tabs at the top of the board: open boards side by side, dragged
 * into order, gathered in named, coloured groups that a click on the group's chip folds
 * away. Closing a tab only takes it off the strip; deleting a board is in "All boards" (⌄),
 * which also opens any board not on the strip. "+" names and creates a new one.
 */
export function BoardTabs({ slug, name, onOpen }: BoardTabsProps) {
  const { t } = useI18n();
  const { data: boards } = useWhiteboardList();
  const [layout, change] = useTabLayout();
  const [panel, setPanel] = useState<Panel>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropAt | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const closePanel = useCallback(() => setPanel(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  useDismissOnOutside(panel !== null, closePanel, [rootRef]);
  useDismissOnOutside(menu !== null, closeMenu, [menuRef]);
  useDismissOnOutside(confirm !== null, closeConfirm, [confirmRef]);

  // The open board always has a tab: a deep link, a chat link or "All boards" may open one
  // that is not on the strip.
  useEffect(() => { change((l) => openTab(l, slug)); }, [change, slug]);

  // A board deleted here, by the CLI or by an agent loses its tab once the list says so.
  const existing = useMemo(() => (boards ? new Set(boards.map((b) => b.slug)) : null), [boards]);
  useEffect(() => {
    if (existing) change((l) => pruneTabs(l, new Set([...existing, slug])));
  }, [change, existing, slug]);

  // The open tab scrolls into view when it changes or its group unfolds.
  useEffect(() => {
    stripRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [slug, layout.groups]);

  const nameOf = (s: string) => (s === slug && name) || boards?.find((b) => b.slug === s)?.name || s;
  const items = stripItems(layout, slug);
  const single = layout.tabs.length <= 1;

  const open = (target: string) => {
    setPanel(null);
    if (target !== slug) onOpen(target);
  };

  const close = (target: string) => {
    if (single) return;
    const next = target === slug ? neighbourAfterClose(layout, target) ?? DEFAULT_BOARD_SLUG : null;
    change((l) => closeTab(l, target));
    if (next) onOpen(next);
  };

  const closeTabs = (keep: (l: TabLayout) => TabLayout) => {
    const next = keep(layout);
    if (next.tabs.length === 0) return;
    change(keep);
    if (!next.tabs.some((x) => x.slug === slug)) onOpen(next.tabs[0].slug);
  };

  /** Where a popover opens: under the element the click came from, in the strip's frame. */
  const below = (el: Element) => {
    const host = rootRef.current?.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { x: box.left - (host?.left ?? 0), y: box.bottom - (host?.top ?? 0) + 4 };
  };

  const askClose = (target: string, at: { x: number; y: number }) => {
    if (single) return;
    setMenu(null);
    setPanel(null);
    setConfirm({
      ask: t('whiteboard.tabs.closeAsk').replace('{name}', nameOf(target)),
      run: () => close(target),
      ...at,
    });
  };

  const askCloseMany = (ask: string, keep: (l: TabLayout) => TabLayout, at: { x: number; y: number }) => {
    setMenu(null);
    setConfirm({ ask, run: () => closeTabs(keep), ...at });
  };

  const openMenu = (e: MouseEvent, next: Exclude<Menu, null>) => {
    e.preventDefault();
    setPanel(null);
    setMenu(next);
  };

  const menuAt = (e: MouseEvent, kind: 'tab' | 'group', id: string) => {
    const host = rootRef.current?.getBoundingClientRect();
    const x = e.clientX - (host?.left ?? 0);
    const y = e.clientY - (host?.top ?? 0);
    openMenu(e, kind === 'tab' ? { kind, slug: id, x, y } : { kind, id, x, y });
  };

  // ── drag ──

  const onTabDragOver = (e: DragEvent<HTMLElement>, target: string, group: string | null) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const box = e.currentTarget.getBoundingClientRect();
    const after = e.clientX > box.left + box.width / 2;
    const i = layout.tabs.findIndex((x) => x.slug === target);
    const before = after ? layout.tabs[i + 1]?.slug ?? null : target;
    setDrop({ before: before === drag ? layout.tabs[i + 2]?.slug ?? null : before, group, mark: target, side: after ? 'after' : 'before' });
  };

  const onChipDragOver = (e: DragEvent<HTMLElement>, group: TabGroup) => {
    if (!drag) return;
    e.preventDefault();
    const first = layout.tabs.find((x) => x.group === group.id)?.slug ?? null;
    setDrop({ before: first, group: group.id, mark: `group:${group.id}`, side: 'after' });
  };

  const onEndDragOver = (e: DragEvent<HTMLElement>) => {
    if (!drag || e.target !== e.currentTarget) return;
    e.preventDefault();
    setDrop({ before: null, group: null, mark: 'end', side: 'end' });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (drag && drop) change((l) => moveTab(l, drag, drop.before, drop.group));
    setDrag(null);
    setDrop(null);
  };

  const menuTab = menu?.kind === 'tab' ? layout.tabs.find((x) => x.slug === menu.slug) : undefined;
  const menuGroup = menu?.kind === 'group' ? layout.groups.find((g) => g.id === menu.id) : undefined;

  const renderItem = (item: StripItem) => {
    if (item.kind === 'group') {
      const { group, count } = item;
      return (
        <button
          key={`group:${group.id}`}
          type="button"
          className="wbt-chip"
          data-color={group.color}
          data-named={group.name ? '' : undefined}
          data-drop={drop?.mark === `group:${group.id}` ? 'after' : undefined}
          aria-expanded={!group.collapsed}
          title={group.collapsed ? t('whiteboard.tabs.expand') : t('whiteboard.tabs.collapse')}
          onClick={() => change((l) => updateGroup(l, group.id, { collapsed: !group.collapsed }))}
          onContextMenu={(e) => menuAt(e, 'group', group.id)}
          onDragOver={(e) => onChipDragOver(e, group)}
          onDrop={onDrop}
        >
          <span className="wbt-chip-name">{group.name}</span>
          {group.collapsed && <span className="wbt-chip-count">{count}</span>}
        </button>
      );
    }
    const current = item.slug === slug;
    const label = nameOf(item.slug);
    return (
      <div
        key={item.slug}
        className="wbt-tab"
        role="tab"
        aria-selected={current}
        tabIndex={current ? 0 : -1}
        data-color={item.group?.color}
        data-grouped={item.group ? '' : undefined}
        data-dragging={drag === item.slug ? '' : undefined}
        data-drop={drop?.mark === item.slug ? drop.side : undefined}
        title={label}
        draggable
        onClick={() => open(item.slug)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(item.slug); } }}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); askClose(item.slug, below(e.currentTarget)); } }}
        onContextMenu={(e) => menuAt(e, 'tab', item.slug)}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', label);
          setMenu(null);
          setDrag(item.slug);
        }}
        onDragEnd={() => { setDrag(null); setDrop(null); }}
        onDragOver={(e) => onTabDragOver(e, item.slug, item.group?.id ?? null)}
        onDrop={onDrop}
      >
        <BoardGlyph />
        <span className={current ? 'wbt-tab-name wbs-current-name' : 'wbt-tab-name'}>{label}</span>
        {!single && (
          <button
            type="button"
            className="wbt-tab-close"
            tabIndex={-1}
            draggable={false}
            aria-label={`${t('whiteboard.tabs.close')} ${label}`}
            title={t('whiteboard.tabs.close')}
            onClick={(e) => { e.stopPropagation(); askClose(item.slug, below(e.currentTarget.closest('.wbt-tab') ?? e.currentTarget)); }}
          >
            <CloseGlyph />
          </button>
        )}
      </div>
    );
  };

  // A group's chip and its tabs share one box, so the group's colour runs under them as one
  // line, as Chrome draws it.
  const segments: { group?: TabGroup; items: StripItem[] }[] = [];
  for (const item of items) {
    const group = item.kind === 'group' ? item.group : item.group;
    const last = segments[segments.length - 1];
    if (group && last?.group?.id === group.id) last.items.push(item);
    else segments.push(group ? { group, items: [item] } : { items: [item] });
  }

  return (
    <div className="wbs wbt" ref={rootRef}>
      <div
        className="wbt-strip"
        role="tablist"
        aria-label={t('whiteboard.switcher.boards')}
        ref={stripRef}
        onDragOver={onEndDragOver}
        onDrop={onDrop}
        onDragLeave={(e) => { if (e.target === e.currentTarget) setDrop(null); }}
      >
        {segments.map((seg) => (seg.group
          ? (
            <div key={`seg:${seg.group.id}`} className="wbt-group" data-color={seg.group.color} data-collapsed={seg.group.collapsed ? '' : undefined}>
              {seg.items.map(renderItem)}
            </div>
          )
          : seg.items.map(renderItem)))}
        <button
          type="button"
          className="wbs-icon-btn"
          aria-haspopup="dialog"
          aria-expanded={panel === 'create'}
          aria-label={t('whiteboard.switcher.new')}
          title={t('whiteboard.switcher.new')}
          onClick={() => setPanel((cur) => (cur === 'create' ? null : 'create'))}
        >
          <PlusGlyph />
        </button>
      </div>
      <button
        type="button"
        className="wbs-current wbt-all"
        aria-haspopup="dialog"
        aria-expanded={panel === 'boards'}
        aria-label={t('whiteboard.switcher.boards')}
        title={t('whiteboard.switcher.boards')}
        onClick={() => setPanel((cur) => (cur === 'boards' ? null : 'boards'))}
      >
        <ChevronGlyph />
      </button>

      {panel === 'boards' && (
        <div className="wbt-anchor wbt-anchor--end">
          <BoardsPanel current={slug} onOpen={open} onNew={() => setPanel('create')} />
        </div>
      )}
      {panel === 'create' && (
        <div className="wbt-anchor wbt-anchor--end">
          <CreatePanel onCreated={open} />
        </div>
      )}

      {menu && (
        <div className="wbt-menu" role="menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          {menuTab && (
            <>
              <MenuItem label={t('whiteboard.tabs.addToNewGroup')} onClick={() => {
                const id = newGroupId();
                change((l) => addToNewGroup(l, menuTab.slug, id));
                setMenu({ kind: 'group', id, x: menu.x, y: menu.y });
              }} />
              {layout.groups.filter((g) => g.id !== menuTab.group).map((g) => (
                <MenuItem
                  key={g.id}
                  label={t('whiteboard.tabs.addToGroup').replace('{name}', g.name || t('whiteboard.tabs.unnamed'))}
                  swatch={g.color}
                  onClick={() => { change((l) => addToGroup(l, menuTab.slug, g.id)); setMenu(null); }}
                />
              ))}
              {menuTab.group && (
                <MenuItem label={t('whiteboard.tabs.removeFromGroup')} onClick={() => {
                  change((l) => removeFromGroup(l, menuTab.slug));
                  setMenu(null);
                }} />
              )}
              <div className="wbt-menu-sep" role="separator" />
              <MenuItem label={t('whiteboard.tabs.close')} disabled={single} onClick={() => askClose(menuTab.slug, menu)} />
              <MenuItem label={t('whiteboard.tabs.closeOthers')} disabled={single} onClick={() => askCloseMany(
                t('whiteboard.tabs.closeOthersAsk').replace('{n}', String(layout.tabs.length - 1)),
                (l) => closeOtherTabs(l, menuTab.slug),
                menu,
              )} />
            </>
          )}
          {menuGroup && (
            <GroupEditor
              group={menuGroup}
              onChange={(patch) => change((l) => updateGroup(l, menuGroup.id, patch))}
              onUngroup={() => { change((l) => ungroup(l, menuGroup.id)); setMenu(null); }}
              onClose={() => askCloseMany(
                t('whiteboard.tabs.closeGroupAsk')
                  .replace('{name}', menuGroup.name || t('whiteboard.tabs.unnamed'))
                  .replace('{n}', String(layout.tabs.filter((x) => x.group === menuGroup.id).length)),
                (l) => closeGroup(l, menuGroup.id),
                menu,
              )}
              canClose={layout.tabs.some((x) => x.group !== menuGroup.id)}
              onDone={() => setMenu(null)}
            />
          )}
        </div>
      )}

      {confirm && (
        <div
          className="wbt-confirm"
          role="alertdialog"
          aria-label={confirm.ask}
          ref={confirmRef}
          style={{ left: Math.max(0, Math.min(confirm.x, (rootRef.current?.clientWidth ?? 0) - CONFIRM_WIDTH)), top: confirm.y }}
          onKeyDown={(e) => { if (e.key === 'Escape') setConfirm(null); }}
        >
          <p className="wbt-confirm-ask">{confirm.ask}</p>
          <p className="wbt-confirm-note">{t('whiteboard.tabs.closeNote')}</p>
          <div className="wbt-confirm-actions">
            <button type="button" className="wbt-confirm-cancel" autoFocus onClick={() => setConfirm(null)}>
              {t('whiteboard.widget.cancel')}
            </button>
            <button type="button" className="wbs-primary" onClick={() => { const { run } = confirm; setConfirm(null); run(); }}>
              {t('whiteboard.tabs.confirmClose')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onClick, disabled, swatch }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  swatch?: string;
}) {
  return (
    <button type="button" role="menuitem" className="wbt-menu-item" disabled={disabled} onClick={onClick}>
      {swatch && <span className="wbt-swatch wbt-swatch--sm" data-color={swatch} aria-hidden="true" />}
      {label}
    </button>
  );
}

/** Chrome's group editor: a name, a colour, Ungroup, Close group. A new group opens it. */
function GroupEditor({ group, onChange, onUngroup, onClose, canClose, onDone }: {
  group: TabGroup;
  onChange: (patch: Partial<Pick<TabGroup, 'name' | 'color'>>) => void;
  onUngroup: () => void;
  onClose: () => void;
  canClose: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="wbt-editor">
      <input
        className="wbt-editor-name"
        autoFocus
        value={group.name}
        maxLength={80}
        placeholder={t('whiteboard.tabs.groupName')}
        aria-label={t('whiteboard.tabs.groupName')}
        onChange={(e) => onChange({ name: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') onDone(); }}
      />
      <div className="wbt-colors" role="radiogroup" aria-label={t('whiteboard.tabs.color')}>
        {GROUP_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={group.color === c}
            className="wbt-swatch"
            data-color={c}
            aria-label={t(`whiteboard.tabs.color.${c}`)}
            title={t(`whiteboard.tabs.color.${c}`)}
            onClick={() => onChange({ color: c })}
          />
        ))}
      </div>
      <div className="wbt-menu-sep" role="separator" />
      <MenuItem label={t('whiteboard.tabs.ungroup')} onClick={onUngroup} />
      <MenuItem label={t('whiteboard.tabs.closeGroup')} disabled={!canClose} onClick={onClose} />
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <path d="M3 3l6 6M9 3 3 9" />
    </svg>
  );
}
