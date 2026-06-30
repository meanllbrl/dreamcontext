import type { SessionStatusInfo } from './agentStatus';

/**
 * The expanded overlay's TOP-BAR tab strip — the agent surface's primary session
 * navigator (it replaced the old left rail). Every session is a tab; tabs are grouped
 * per PANE so a side-by-side split reads as two adjacent tab clusters in one strip. A
 * tab shows `[status dot] [title] [⚡?] [↻][✕]`; clicking focuses it, double-click
 * renames inline, and dragging it carries the session id under {@link AGENT_TAB_MIME}
 * for the pane drop-zones (split/combine) and tab-to-tab reorder. Purely presentational
 * — all state + actions arrive as props.
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

export interface TabVM {
  /** Session id. */
  id: string;
  title: string;
  info: SessionStatusInfo;
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
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
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
                      if (e.key === 'Enter') { e.preventDefault(); onCommitRename(tab.id, e.currentTarget.value); }
                      else if (e.key === 'Escape') { e.preventDefault(); onCancelRename(); }
                    }}
                  />
                ) : (
                  <span className="agent-tab-title">{tab.title}</span>
                )}
                {tab.bypass && <span className="agent-tab-bypass" title="Bypass permissions is ON for this session" aria-hidden>⚡</span>}
                {tab.attention && <span className="agent-tab-badge" aria-label="Waiting for you" />}
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
    </div>
  );
}
