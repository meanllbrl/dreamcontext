import { useSuperUnreadCount } from '../../sleepy/super/superUnreadStore';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { VaultLogo } from '../VaultLogo';
import { ProjectChipBubbles } from '../ProjectTabs';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { DRAWER_WIDTH_MAX, DRAWER_WIDTH_MIN } from '../../../lib/launcherPrefs';
import type { DrawerIntent } from '../../../lib/drawerIntents';
import type { DrawerChild, DrawerProjectRow } from './drawerModel';
import './ChatDrawer.css';

/** Pixels a press must travel before it is a drag, not a click (`tabDrag.ts`'s threshold). */
const DRAG_START_PX = 4;

export interface ChatDrawerProps {
  rows: DrawerProjectRow[];
  width: number;
  /** Floats over the page with a scrim (≤900) or slides from the top (≤600). */
  floating: boolean;
  onClose(): void;
  onResize(width: number): void;
  onToggleExpanded(name: string): void;
  onIntent(vault: string, intent: DrawerIntent): void;
  onHistory(): void;
  onRelations(): void;
  onMove(name: string, delta: -1 | 1): void;
  onDrop(name: string, beforeIndex: number): void;
  onOpenInWindow(name: string): void;
  onCloseProject(name: string): void;
  /** "+" beside Projects: the app's Add Project flow. */
  onNewProject(): void;
  /** Bumped by ⌘N: open the New chat window picker at its row. */
  newWindowNonce: number;
}

interface Menu { kind: 'project' | 'new' | 'window'; name?: string; windowId?: string; x: number; y: number }

/** The stored name of a project's first window (agent-sessions.ts `DEFAULT_WINDOW`): drawn in the
 *  owner's language. */
const STORED_DEFAULT_NAME = 'Chat';

export function ChatDrawer(p: ChatDrawerProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [guide, setGuide] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ name: string; over: number } | null>(null);
  /** A window row being renamed in place (the desktop WebView has no `prompt`). */
  const [renaming, setRenaming] = useState<{ vault: string; id: string; value: string } | null>(null);
  const renameDone = useRef(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const newRowRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const justDragged = useRef(false);
  /** Where focus was when a menu opened: it goes back there when the menu closes. */
  const opener = useRef<HTMLElement | null>(null);
  const openMenu = (m: Menu) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu(m);
  };
  const closeMenu = () => {
    setMenu(null);
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) requestAnimationFrame(() => back.focus());
  };
  // A menu takes focus on its first item, so the keyboard can use it (⌘N is often pressed from
  // the composer); ↑ ↓ Home End move between items.
  const menuOpen = !!menu;
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menuOpen]);
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  };
  // A menu opens at the click point, then is pulled back inside the window (a right-click near
  // the edge of a 390px window would otherwise hang off it).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const x = Math.max(pad, Math.min(menu.x, window.innerWidth - r.width - pad));
    const y = Math.max(pad, Math.min(menu.y, window.innerHeight - r.height - pad));
    if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y });
  }, [menu]);

  // ⌘N: the picker opens where New chat window sits.
  const seenNonce = useRef(p.newWindowNonce);
  useEffect(() => {
    if (p.newWindowNonce === seenNonce.current) return;
    seenNonce.current = p.newWindowNonce;
    const r = newRowRef.current?.getBoundingClientRect();
    openMenu({ kind: 'new', x: r ? r.left + 12 : 80, y: r ? r.bottom + 4 : 80 });
  }, [p.newWindowNonce]);

  // A menu closes on Esc or a press outside it, and owns that Esc (the chat must not see it).
  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeMenu();
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.ns-drawer-menu')) { opener.current = null; setMenu(null); }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [menu]);

  /* ── Resize: a guide line follows the pointer; the width is committed on release (D4). ── */
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const left = rootRef.current?.getBoundingClientRect().left ?? 0;
    const clamp = (x: number) => Math.round(Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, x - left)));
    setGuide(p.width);
    const move = (ev: PointerEvent) => setGuide(clamp(ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGuide(null);
      p.onResize(clamp(ev.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ── Reorder: pointer events, never HTML5 drag-and-drop (WKWebView). ── */
  const startDrag = (e: ReactPointerEvent<HTMLElement>, name: string) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest('.ns-dr-act'))) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    let over = -1;
    const rowsEls = () => Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-drawer-project]') ?? []);
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
      dragging = true;
      const els = rowsEls();
      over = els.findIndex((el) => ev.clientY < el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
      if (over < 0) over = els.length;
      setDrag({ name, over });
    };
    const end = (drop: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setDrag(null);
      if (!dragging) return;
      if (drop) p.onDrop(name, over);
      // The click that ends a drag is not a toggle; nothing outside this row is ever held back.
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const onRowKey = (e: ReactKeyboardEvent, name: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    p.onMove(name, e.key === 'ArrowUp' ? -1 : 1);
  };

  const pick = (vault: string, intent: DrawerIntent) => {
    p.onIntent(vault, intent);
    if (p.floating) p.onClose();
  };

  const child = (row: DrawerProjectRow, c: DrawerChild) => {
    if (c.kind === 'super') {
      return (
        <SuperRow key="super" vault={row.name} selected={c.selected} on={c.on} working={c.working} asking={c.asking} label={t('shell.drawer.superAgent')}
          workingLabel={(n) => t('shell.drawer.superWorking').replace('{n}', String(n))} askingLabel={t('shell.drawer.superAsking')}
          unreadLabel={(n) => t('super.unread.count').replace('{n}', String(n))} onPick={() => pick(row.name, { kind: 'super' })} />
      );
    }
    if (c.kind === 'member') {
      return (
        <button key={`m-${c.slug}`} type="button" className={`ns-dr-row ns-dr-child ns-dr-member${c.selected ? ' is-sel' : ''}`} data-status={c.status}
          data-testid="drawer-member-row" onClick={() => pick(row.name, { kind: 'member', slug: c.slug, title: c.title })}>
          <AgentAvatar of="agent" slug={c.slug} title={c.title} hasPhoto={c.hasPhoto} size={16} />
          <span className="ns-dr-t">{c.title}</span>
          <span className="ns-dr-status" data-status={c.status} aria-hidden="true" />
        </button>
      );
    }
    if (c.kind === 'new-chat') {
      return (
        <button key="new-chat" type="button" className="ns-dr-row ns-dr-child ns-dr-newchat" data-testid="drawer-new-chat"
          onClick={() => pick(row.name, { kind: 'new-window' })}>
          <svg className="ns-dr-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
          <span className="ns-dr-t">{t('shell.drawer.newChat')}</span>
        </button>
      );
    }
    const live = c.working + c.asking + c.other;
    const label = c.name === STORED_DEFAULT_NAME ? t('shell.windows.defaultName') : c.name;
    if (renaming && renaming.vault === row.name && renaming.id === c.id) {
      // Enter or a click away keeps the name; Esc, or a blank name, leaves it as it was.
      const finish = (keep: boolean) => {
        if (renameDone.current) return;
        renameDone.current = true;
        const value = renaming.value.trim();
        setRenaming(null);
        if (keep && value && value !== c.name) p.onIntent(row.name, { kind: 'rename-window', windowId: c.id, name: value });
      };
      return (
        <div key={`w-${c.id}`} className="ns-dr-row ns-dr-child ns-dr-win is-renaming">
          <input className="ns-dr-rename" autoFocus value={renaming.value} maxLength={60}
            aria-label={t('shell.windows.rename')} data-testid="drawer-window-rename"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); finish(true); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
            }}
            onBlur={() => finish(true)} />
        </div>
      );
    }
    const openWindowMenu = (x: number, y: number) => openMenu({ kind: 'window', name: row.name, windowId: c.id, x, y });
    return (
      <button key={`w-${c.id}`} type="button" className={`ns-dr-row ns-dr-child ns-dr-win${c.selected ? ' is-sel' : ''}`}
        data-testid="drawer-window-row" data-window-id={c.id} aria-haspopup="menu"
        onClick={() => pick(row.name, { kind: 'open-window', windowId: c.id })}
        onContextMenu={(e) => { e.preventDefault(); openWindowMenu(e.clientX, e.clientY); }}
        onKeyDown={(e) => {
          // The keyboard's way to the same menu, and F2 to rename (the desktop convention).
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            openWindowMenu(r.left + 24, r.bottom);
          } else if (e.key === 'F2') {
            e.preventDefault();
            renameDone.current = false;
            setRenaming({ vault: row.name, id: c.id, value: c.name === STORED_DEFAULT_NAME ? label : c.name });
          }
        }}>
        <span className="ns-dr-t">{label}</span>
        <ProjectChipBubbles chip={{ live, asking: c.asking, working: c.working, idle: c.other, flagged: c.flagged }} />
      </button>
    );
  };

  return (
    <aside className="ns-drawer" data-floating={p.floating ? 'true' : undefined} style={{ width: p.floating ? undefined : p.width }}
      ref={rootRef} aria-label={t('shell.drawer.projects')} data-testid="chat-drawer">
      <div className="ns-dr-scroll">
        <button ref={newRowRef} type="button" className="ns-dr-row ns-dr-entry" data-testid="drawer-new-window"
          onClick={(e) => openMenu({ kind: 'new', x: e.clientX, y: e.clientY })}>
          <svg className="ns-dr-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h3l7-7-3-3-7 7v3zM9 4l3 3" /></svg>
          <span className="ns-dr-t">{t('shell.drawer.newWindow')}</span>
          <kbd className="ns-dr-kbd">⌘N</kbd>
        </button>
        <button type="button" className="ns-dr-row ns-dr-entry" data-testid="drawer-new-project-row" onClick={p.onNewProject}>
          <svg className="ns-dr-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11zM8 7.8v3M6.5 9.3h3" /></svg>
          <span className="ns-dr-t">{t('shell.drawer.newProject')}</span>
        </button>
        <button type="button" className="ns-dr-row ns-dr-entry" data-testid="drawer-history" onClick={p.onHistory}>
          <svg className="ns-dr-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5" /></svg>
          <span className="ns-dr-t">{t('shell.drawer.history')}</span>
        </button>
        <button type="button" className="ns-dr-row ns-dr-entry" data-testid="drawer-relations" onClick={p.onRelations}>
          <svg className="ns-dr-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="1.8" /><circle cx="12" cy="4" r="1.8" /><circle cx="8" cy="12" r="1.8" /><path d="M5.6 4h4.8M5 5.4l2.2 5M11 5.4l-2.2 5" /></svg>
          <span className="ns-dr-t">{t('shell.drawer.relations')}</span>
        </button>

        <div className="ns-dr-sec">
          <span>{t('shell.drawer.projects')}</span>
          <button type="button" className="ns-dr-sec-add" aria-label={t('shell.drawer.newProject')} title={t('shell.drawer.newProject')}
            data-testid="drawer-new-project" onClick={p.onNewProject}>+</button>
        </div>
        {p.rows.map((row, i) => (
          <div key={row.name} className="ns-dr-project" data-drawer-project={row.name}
            data-drop-before={drag && drag.over === i && drag.name !== row.name ? 'true' : undefined}
            data-dragging={drag?.name === row.name ? 'true' : undefined}>
            {/* Two sibling buttons, never one inside the other: the row's own toggle (name, notes)
                and "+". The rest of the row (the chevron, the gaps) toggles on a pointer click. */}
            <div className={`ns-dr-row ns-dr-proj${row.active ? ' is-cur' : ''}`}
              onPointerDown={(e) => startDrag(e, row.name)}
              onClick={(e) => {
                if (justDragged.current || (e.target instanceof Element && e.target.closest('button'))) return;
                p.onToggleExpanded(row.name);
              }}
              onContextMenu={(e) => { e.preventDefault(); openMenu({ kind: 'project', name: row.name, x: e.clientX, y: e.clientY }); }}>
              <button type="button" className="ns-dr-toggle" aria-expanded={row.expanded} data-testid="drawer-project-row"
                onClick={() => { if (!justDragged.current) p.onToggleExpanded(row.name); }}
                onKeyDown={(e) => onRowKey(e, row.name)}>
                <span className="ns-dr-pic">
                  {row.logo
                    ? <VaultLogo name={row.name} hasLogo={row.logo} stamp={row.logoStamp} size={18} />
                    : <span className="ns-dr-initial" aria-hidden="true">{row.name.slice(0, 1).toUpperCase()}</span>}
                </span>
                <span className="ns-dr-t">{row.name}</span>
                {row.otherWindow && <span className="ns-dr-note">{t('shell.drawer.otherWindow')}</span>}
                {row.asleep && <span className="ns-dr-note">{t('shell.drawer.asleep')}</span>}
                {row.sum && <ProjectChipBubbles chip={row.sum} />}
                {row.superAsking && <span className="ns-dr-ask" data-testid="drawer-project-asking" aria-label={t('shell.drawer.superAsking')} />}
              </button>
              <button type="button" className="ns-dr-act ns-dr-add" aria-label={`${t('shell.drawer.newWindow')}: ${row.name}`}
                data-testid="drawer-project-add"
                onClick={(e) => { e.stopPropagation(); pick(row.name, { kind: 'new-window' }); }}>+</button>
              <svg className={`ns-dr-chev${row.expanded ? ' is-open' : ''}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
            </div>
            {row.expanded && <div className="ns-dr-children">{row.children.map((c) => child(row, c))}</div>}
          </div>
        ))}
        {drag && drag.over >= p.rows.length && <div className="ns-dr-drop-end" aria-hidden="true" />}
      </div>

      {!p.floating && <div className="ns-dr-handle" onPointerDown={startResize} aria-hidden="true" />}
      {guide !== null && <div className="ns-dr-guide" style={{ left: guide }} aria-hidden="true" />}

      {menu && (
        <div ref={menuRef} className="ns-menu ns-drawer-menu" role="menu" onKeyDown={onMenuKey} style={{ left: menu.x, top: menu.y }}
          data-testid={menu.kind === 'new' ? 'drawer-new-menu' : menu.kind === 'window' ? 'drawer-window-menu' : 'drawer-project-menu'}>
          {menu.kind === 'new' ? (
            <>
              <div className="ns-drawer-menu-head">{t('shell.drawer.pickProject')}</div>
              {p.rows.map((row) => (
                <button key={row.name} type="button" role="menuitem" className="ns-drawer-menu-item"
                  onClick={() => { closeMenu(); pick(row.name, { kind: 'new-window' }); }}>
                  {row.name}
                </button>
              ))}
            </>
          ) : menu.kind === 'window' && menu.name && menu.windowId ? (
            <>
              <button type="button" role="menuitem" className="ns-drawer-menu-item" data-testid="drawer-window-rename-item"
                onClick={() => {
                  const win = p.rows.find((r) => r.name === menu.name)?.children.find((c) => c.kind === 'window' && c.id === menu.windowId);
                  const name = win && win.kind === 'window' ? win.name : '';
                  // Focus goes to the rename field, not back to the row.
                  opener.current = null;
                  setMenu(null);
                  renameDone.current = false;
                  setRenaming({ vault: menu.name!, id: menu.windowId!, value: name === STORED_DEFAULT_NAME ? t('shell.windows.defaultName') : name });
                }}>
                {t('shell.windows.rename')}<kbd>F2</kbd>
              </button>
              {/* Menu-only, with no shortcut: ⌘W stays "close tab". */}
              <button type="button" role="menuitem" className="ns-drawer-menu-item is-danger" data-testid="drawer-window-close-item"
                onClick={() => { closeMenu(); p.onIntent(menu.name!, { kind: 'close-window', windowId: menu.windowId! }); }}>
                {t('shell.windows.close')}
              </button>
            </>
          ) : menu.name && (
            <>
              <button type="button" role="menuitem" className="ns-drawer-menu-item" onClick={() => { closeMenu(); p.onMove(menu.name!, -1); }}>
                {t('shell.drawer.moveUp')}<kbd>⌥↑</kbd>
              </button>
              <button type="button" role="menuitem" className="ns-drawer-menu-item" onClick={() => { closeMenu(); p.onMove(menu.name!, 1); }}>
                {t('shell.drawer.moveDown')}<kbd>⌥↓</kbd>
              </button>
              <button type="button" role="menuitem" className="ns-drawer-menu-item" onClick={() => { closeMenu(); p.onOpenInWindow(menu.name!); }}>
                {t('shell.drawer.openInWindow')}
              </button>
              <button type="button" role="menuitem" className="ns-drawer-menu-item"
                disabled={!p.rows.find((r) => r.name === menu.name)?.held}
                onClick={() => { closeMenu(); p.onCloseProject(menu.name!); }}>
                {t('shell.drawer.closeProject')}
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/** The Super Agent row: its project's unread count rides beside the title (the pane publishes it). */
function SuperRow({ vault, selected, on, working, asking, label, workingLabel, askingLabel, unreadLabel, onPick }: {
  vault: string; selected: boolean; on: boolean; working: number; asking: boolean; label: string;
  workingLabel: (n: number) => string; askingLabel: string; unreadLabel: (n: number) => string; onPick: () => void;
}) {
  const unread = useSuperUnreadCount(vault);
  // One mark at the row's end, in order of what the owner must do: the row itself goes red for a
  // question; the ring counts the children at work; the unread count shows only when no ring does.
  const named = [asking ? askingLabel : '', working > 0 ? workingLabel(working) : '', unread > 0 ? unreadLabel(unread) : ''].filter(Boolean).join(', ');
  return (
    <button type="button" className={`ns-dr-row ns-dr-child ns-dr-super${selected ? ' is-sel' : ''}`} data-asking={asking ? 'true' : undefined}
      data-testid="drawer-super-row" aria-label={named ? `${label} (${named})` : undefined} onClick={onPick}>
      <span className="ns-dr-t">{label}</span>
      {working > 0
        ? <span data-testid="super-working-ring"><ProjectChipBubbles chip={{ live: working, asking: 0, working, idle: 0, flagged: 0 }} /></span>
        : unread > 0 && <span className="ns-menu-count" data-testid="super-unread-badge">{unread}</span>}
      {working === 0 && unread === 0 && !asking && <span className={`ns-dr-dot${on ? ' is-on' : ''}`} aria-hidden="true" />}
    </button>
  );
}
