import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pushOverlay, popOverlay, isTopOverlay } from '../../lib/overlayStack';
import type { SessionStatusInfo } from './agentStatus';
import type { SessionKind } from './agentSession';

/**
 * The expanded overlay's TOP-BAR tab strip — the agent surface's primary session
 * navigator (it replaced the old left rail). Every session is a tab; tabs are grouped
 * per PANE so a side-by-side split reads as two adjacent tab clusters in one strip. A
 * tab shows `[status dot] [title] [⚡?] [↻][✕]`; clicking focuses it, double-click (or
 * right-click → Rename) renames inline, and dragging it carries the session id under
 * {@link AGENT_TAB_MIME} for the pane drop-zones (split/combine) and tab-to-tab reorder.
 * Presentational apart from its own right-click menu — every action arrives as a prop.
 *
 * The groups render INSIDE the overlay header (`.agent-overlay-tabs`), not above their
 * pane: the header IS the tab bar, so the surface spends one 44px row on chrome instead
 * of two. Every glyph here is monochrome/mono — no emoji in the strip.
 */

/** The DnD payload type for an internal agent-tab drag (NOT `text/plain`, so it never
 *  collides with the Kanban/Eisenhower board DnD, and carries no files so the image-drop
 *  handler ignores it). The session id is stored under this key. */
export const AGENT_TAB_MIME = 'application/x-agent-tab';

/** Crisp icons for the per-tab actions (clearer than Unicode glyphs at small sizes). */
function MinimizeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 2.5v6.5" />
      <path d="M5 6 8 9 11 6" />
      <path d="M4.25 13h7.5" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M4 4 12 12M12 4 4 12" />
    </svg>
  );
}
/** "Open in Chat" — a line-art bubble, not the 💬 emoji: the strip stays monochrome and
 *  this action reads as a sibling of minimize/close rather than a sticker. */
function ChatIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.5 9.5a1.5 1.5 0 0 1-1.5 1.5H6l-3 2.5V4a1.5 1.5 0 0 1 1.5-1.5h7.5A1.5 1.5 0 0 1 13.5 4z" />
    </svg>
  );
}

export interface TabVM {
  /** Session id. */
  id: string;
  title: string;
  info: SessionStatusInfo;
  /** Claude agent (◇), Claude chat (◆) or a plain login shell (>_) — a mono glyph
   *  before the title. */
  sessionKind: SessionKind;
  /** Bypass-permissions armed for this session (shows a ⚡). */
  bypass: boolean;
  /** A backgrounded session finished / rang the bell since you last looked at it. */
  attention: boolean;
}

export interface PaneVM {
  /** Pane id (layout). */
  id: string;
  /** The session id currently shown in this pane. */
  active: string;
  tabs: TabVM[];
}

/** An open right-click menu: the tab it acts on, and where to draw it. The coordinates
 *  are the raw pointer position; the layout effect below clamps them to the viewport. */
interface TabMenuState {
  sid: string;
  title: string;
  x: number;
  y: number;
  /** Raised from the keyboard (Menu key / Shift+F10) rather than by a pointer — the menu
   *  then takes focus, because there is otherwise no way to reach its items. A pointer-raised
   *  menu deliberately does NOT, so dismissing it leaves the pane still typing-ready. */
  kbd: boolean;
}

/** Viewport breathing room for the clamped context menu. */
const MENU_PAD = 8;

/**
 * The tab bar for ONE pane — rendered at the TOP of that pane (not in a shared header),
 * so the tabs sit directly above the terminal they control and it's unambiguous which tab
 * belongs to which pane. The active pane's bar carries a faint accent.
 */
export function AgentTabs({
  pane, isActivePane, renamingId,
  onSelect, onClose, onMinimize,
  onStartRename, onCommitRename, onCancelRename,
  onTabDragStart, onTabDragEnd, onReorderHover, onGroupHover,
  chatConvertEnabled = false, onOpenInChat = () => {},
  autoTitle = false, onToggleAutoTitle = () => {},
}: {
  pane: PaneVM;
  isActivePane: boolean;
  renamingId: string;
  onSelect: (paneId: string, sid: string) => void;
  onClose: (sid: string) => void;
  /** Minimize this session out of the panes → a corner progress chip (kept alive). */
  onMinimize: (sid: string) => void;
  onStartRename: (sid: string) => void;
  onCommitRename: (sid: string, value: string) => void;
  onCancelRename: () => void;
  onTabDragStart: (sid: string) => void;
  onTabDragEnd: () => void;
  /** Hovering a tab during a drag → record "move the dragged session into that tab's pane,
   *  before this tab" as the pending drop target (executed on dragend, not drop —
   *  WKWebView's `drop` event is unreliable for these elements). */
  onReorderHover: (targetPaneId: string, beforeSid: string) => void;
  /** Hovering a pane's tab-group padding → record "combine the dragged session into it". */
  onGroupHover: (targetPaneId: string) => void;
  /** Gate for the per-tab "Open in Chat" action (Settings → Agents on the Chat screen
   *  and the Claude CLI present) — optional/defaulted so a caller written before this
   *  prop existed keeps compiling and simply never shows the action. */
  chatConvertEnabled?: boolean;
  /** Convert this AGENT tab's conversation into a Chat pane (terminal→chat, AC7's second
   *  direction) — only ever called for an `agent`-kind tab (the button only renders then). */
  onOpenInChat?: (sid: string) => void;
  /** Live value of Settings → Agents' "auto-name tabs" preference, mirrored into the
   *  right-click menu so the setting is editable where its effect is visible. Optional so
   *  a caller written before it existed keeps compiling (the row then reads "off"). */
  autoTitle?: boolean;
  /** Flip that preference. The surface writes it through `patchAgentSettings`, so the new
   *  value comes back down as a prop — this component never holds its own copy. */
  onToggleAutoTitle?: (next: boolean) => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  /*
   * The per-tab right-click menu. It PORTALS to <body> for two independent reasons, either
   * of which alone would be fatal in place: `.agent-pane-tabbar` is an `overflow-x: auto`
   * scroller (an in-strip menu would be clipped to the row and scroll with the tabs), and
   * `.agent-surface` sets `contain: layout paint`, which makes it the containing block even
   * for `position: fixed` — the same trap that keeps `AgentDock` a sibling of the surface.
   */
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Stable per-instance id on the app's overlay stack, so Esc arbitrates LIFO with the ⌘K
  // palette / composer popovers instead of the earliest-registered listener winning.
  const overlayId = useId();

  const openMenu = (e: React.MouseEvent, tab: TabVM) => {
    e.preventDefault();
    e.stopPropagation();
    // A keyboard-raised menu (Menu key / Shift+F10 on the focused tab) reports 0,0 — anchor
    // it under the tab instead of pinning it to the top-left corner of the screen.
    const kbd = e.clientX === 0 && e.clientY === 0;
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({
      sid: tab.id,
      title: tab.title,
      x: kbd ? r.left : e.clientX,
      y: kbd ? r.bottom + 4 : e.clientY,
      kbd,
    });
  };

  /* Dismissed by anything that moves the page under it — a transient popover, not a modal.
     `pointerdown` (capture) is what closes it on an outside click, INCLUDING the right-click
     that opens a sibling tab's menu; the listener is attached after this render, so the very
     press that opened this one can never close it. */
  useEffect(() => {
    if (!menu) return;
    pushOverlay(overlayId);
    const close = () => setMenu(null);
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(overlayId)) return;
      // Swallow it: with a menu open, Esc means "close this", never "collapse the overlay"
      // (AgentSurface's handler yields to `.agent-tab-menu` for the same reason) and never
      // "interrupt the turn" when the pane underneath still holds focus.
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      popOverlay(overlayId);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [menu, overlayId]);

  // Place it at the pointer, clamped inside the viewport (flipping ABOVE the cursor when a
  // tab near the bottom of a tall window would push it off screen). Measured after mount and
  // revealed only then, so there is no first frame at 0,0.
  useLayoutEffect(() => {
    const m = menuRef.current;
    if (!menu || !m) return;
    const { offsetWidth: w, offsetHeight: h } = m;
    const left = Math.max(MENU_PAD, Math.min(menu.x, window.innerWidth - w - MENU_PAD));
    const top = menu.y + h + MENU_PAD > window.innerHeight
      ? Math.max(MENU_PAD, menu.y - h)
      : menu.y;
    m.style.left = `${Math.round(left)}px`;
    m.style.top = `${Math.round(top)}px`;
    m.style.visibility = 'visible';
    if (menu.kbd) m.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [menu]);
  const allowTabDrop = (e: React.DragEvent): boolean => {
    if (!e.dataTransfer.types.includes(AGENT_TAB_MIME)) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return true;
  };

  return (
    <div
      className={'agent-pane-tabbar' + (isActivePane ? ' active' : '')}
      role="tablist"
      aria-label="Agent sessions"
      onDragOver={(e) => { if (allowTabDrop(e)) onGroupHover(pane.id); }}
      onDrop={(e) => {
        // Reliability lives in dragend; this just pins the exact release target and
        // preventDefaults. WKWebView may not deliver this `drop` at all — that's fine.
        if (!e.dataTransfer.types.includes(AGENT_TAB_MIME)) return;
        e.preventDefault(); e.stopPropagation(); onGroupHover(pane.id);
      }}
    >
      {pane.tabs.map((tab) => {
            const active = tab.id === pane.active;
            const renaming = renamingId === tab.id;
            return (
              <div
                key={tab.id}
                className={'agent-tab' + (active ? ' active' : '')}
                data-kind={tab.info.kind}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                draggable={!renaming}
                title={`${tab.title} — ${tab.info.label}`}
                onClick={() => onSelect(pane.id, tab.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(pane.id, tab.id); } }}
                onDoubleClick={(e) => { e.stopPropagation(); onStartRename(tab.id); }}
                /* Right-click acts on THIS tab without focusing it (same as every other tab
                   strip): the menu names the tab it was raised on, so switching panes to
                   rename one would be a side effect nobody asked for. */
                onContextMenu={(e) => openMenu(e, tab)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(AGENT_TAB_MIME, tab.id);
                  e.dataTransfer.effectAllowed = 'move';
                  onTabDragStart(tab.id);
                }}
                onDragEnd={onTabDragEnd}
                onDragOver={(e) => {
                  // stopPropagation so the parent tabgroup's dragover doesn't overwrite
                  // this more-specific reorder target with a plain "combine".
                  if (allowTabDrop(e)) { e.stopPropagation(); onReorderHover(pane.id, tab.id); }
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes(AGENT_TAB_MIME)) return;
                  e.preventDefault(); e.stopPropagation(); onReorderHover(pane.id, tab.id);
                }}
              >
                <span className="agent-tab-dot" data-kind={tab.info.kind} aria-hidden />
                <span
                  className="agent-tab-kind"
                  data-session-kind={tab.sessionKind}
                  title={
                    tab.sessionKind === 'shell' ? 'Terminal (login shell)'
                      : tab.sessionKind === 'chat' ? 'Claude Code chat'
                        : tab.sessionKind === 'automation' ? 'Automation run — a scheduled job\'s own conversation'
                          : 'Claude Code agent'
                  }
                  aria-hidden
                >{
                  tab.sessionKind === 'shell' ? '>_'
                    : tab.sessionKind === 'chat' ? '◆'
                      // An automation run is the one tab you did not open yourself — it ran
                      // unattended, with bypassPermissions, while nobody was watching. The
                      // glyph is deliberately unlike the other three so a strip of tabs
                      // makes that legible at a glance.
                      : tab.sessionKind === 'automation' ? '⬡'
                        : '◇'
                }</span>
                {renaming ? (
                  <input
                    className="agent-tab-rename"
                    autoFocus
                    defaultValue={tab.title}
                    spellCheck={false}
                    onClick={stop}
                    onMouseDown={stop}
                    onDragStart={(e) => e.preventDefault()}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => onCommitRename(tab.id, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // Keep every key inside the input — otherwise it bubbles to the
                      // parent tab's onKeyDown, whose Space/Enter handler preventDefaults
                      // (so you couldn't type a space) and re-selects the tab. Commit is
                      // Enter-only; Space just types a space like any normal input.
                      e.stopPropagation();
                      if (e.key === 'Enter') { e.preventDefault(); onCommitRename(tab.id, e.currentTarget.value); }
                      else if (e.key === 'Escape') { e.preventDefault(); onCancelRename(); }
                    }}
                  />
                ) : (
                  <span className="agent-tab-title">{tab.title}</span>
                )}
                {tab.bypass && <span className="agent-tab-bypass" title="Bypass permissions is ON for this session" aria-hidden>⚡</span>}
                {tab.attention && <span className="agent-tab-badge" aria-label="Waiting for you" />}
                {tab.sessionKind === 'agent' && chatConvertEnabled && (
                  <button
                    type="button"
                    className="agent-tab-btn open-in-chat"
                    tabIndex={-1}
                    title="Open in Chat — reopens this conversation as a native chat pane"
                    aria-label={`Open ${tab.title} in Chat`}
                    onMouseDown={stop}
                    onClick={(e) => { e.stopPropagation(); onOpenInChat(tab.id); }}
                  ><ChatIcon /></button>
                )}
                <button
                  type="button"
                  className="agent-tab-btn minimize"
                  tabIndex={-1}
                  title="Minimize to corner (keeps running)"
                  aria-label={`Minimize ${tab.title}`}
                  onMouseDown={stop}
                  onClick={(e) => { e.stopPropagation(); onMinimize(tab.id); }}
                ><MinimizeIcon /></button>
                <button
                  type="button"
                  className="agent-tab-btn close"
                  tabIndex={-1}
                  title="Close session (⌘W)"
                  aria-label={`Close ${tab.title}`}
                  onMouseDown={stop}
                  onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                ><CloseIcon /></button>
              </div>
            );
      })}

      {menu && createPortal(
        // Hidden until the layout effect measures + places it — no first frame at 0,0.
        <div className="agent-tab-menu" role="menu" ref={menuRef} style={{ visibility: 'hidden' }}>
          <div className="agent-tab-menu-head" title={menu.title}>{menu.title}</div>
          <button
            type="button"
            role="menuitem"
            className="agent-tab-menu-item"
            onClick={() => { const { sid } = menu; setMenu(null); onStartRename(sid); }}
          >
            <span className="agent-tab-menu-label">Rename</span>
            <span className="agent-tab-menu-kbd">double-click</span>
          </button>
          <div className="agent-tab-menu-rule" />
          {/*
            Settings → Agents' auto-title preference, edited where you can see what it does.
            It is APP-GLOBAL, not per tab — the sub-label says so, because a control that
            lives inside one tab's menu otherwise reads as being about that tab.

            The menu deliberately stays OPEN on toggle: the switch moving IS the confirmation
            that the click landed, and closing on the same click would hide it.
          */}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={autoTitle}
            className="agent-tab-menu-item"
            onClick={() => onToggleAutoTitle(!autoTitle)}
          >
            <span className="agent-tab-menu-label">
              Auto-rename tabs
              <span className="agent-tab-menu-sub">
                Every tab — named from your first message
              </span>
            </span>
            <span className="agent-tab-menu-switch" data-on={autoTitle ? 'true' : undefined} aria-hidden />
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
