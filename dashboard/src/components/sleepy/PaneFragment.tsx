import type { TermStatus } from './agentSession';

/**
 * A single session pane: its renameable header (status dot · title · per-session
 * controls) above the detached xterm slot, plus the divider that resizes it against
 * the next visible pane. Presentational — all state + actions come in as props.
 */
export function PaneFragment({
  sid, title, grow, multi, last, status, busy, bypassOn, focused, renaming,
  slotRefs, onFocusPane, onStartRename, onCommitRename, onCancelRename,
  onMinimize, onClose, onRestart, onResizeStart,
}: {
  sid: string;
  title: string;
  grow: number;
  multi: boolean;
  last: boolean;
  status: TermStatus;
  busy: boolean;
  bypassOn: boolean;
  focused: boolean;
  renaming: boolean;
  slotRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onFocusPane: () => void;
  onStartRename: () => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onMinimize: () => void;
  onClose: () => void;
  onRestart: () => void;
  onResizeStart: (e: React.PointerEvent) => void;
}) {
  const ended = status === 'closed';
  // Dot state: ended → red; live & streaming → pulsing green (working); live & idle →
  // steady green; otherwise connecting.
  const dotStatus = ended ? 'closed' : status === 'open' ? (busy ? 'working' : 'open') : 'connecting';
  // A stop-propagation mousedown keeps a control click from re-focusing/dragging the
  // pane, so the action fires on the FIRST click every time.
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <>
      <div
        className={'agent-pane' + (focused && multi ? ' focused' : '') + (ended ? ' ended' : '')}
        style={{ flexGrow: grow, flexBasis: 0 }}
        onMouseDown={onFocusPane}
      >
        {/* Each session's own "tab", directly above it — renameable, no boilerplate. */}
        <div className="agent-pane-head">
          <span className="agent-pane-status" data-status={dotStatus} aria-label={dotStatus}><span className="dot" /></span>
          {renaming ? (
            <input
              className="agent-pane-rename"
              autoFocus
              defaultValue={title}
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
              onClick={stop}
              onMouseDown={stop}
              onBlur={(e) => onCommitRename(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); onCommitRename(e.currentTarget.value); }
                else if (e.key === 'Escape') { e.preventDefault(); onCancelRename(); }
              }}
            />
          ) : (
            <span
              className="agent-pane-title"
              title={`${title} — double-click to rename`}
              onDoubleClick={(e) => { e.stopPropagation(); onStartRename(); }}
            >{title}</span>
          )}
          {bypassOn && <span className="agent-pane-bypass" title="Bypass permissions is ON for this session — it can edit files and run commands without asking">⚡</span>}
          <div style={{ flex: 1 }} />
          <button className="agent-pane-btn" title="Rename" aria-label="Rename session" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); onStartRename(); }}>✎</button>
          <button className="agent-pane-btn" title="Minimize to dock" aria-label="Minimize session" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); onMinimize(); }}>–</button>
          <button className="agent-pane-btn" title="Restart session" aria-label="Restart session" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); onRestart(); }}>↻</button>
          <button className="agent-pane-btn close" title="Close session (⌘W)" aria-label="Close session" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
        </div>
        <div
          className="agent-pane-slot"
          ref={(el) => { if (el) slotRefs.current.set(sid, el); else slotRefs.current.delete(sid); }}
        />
        {/* Ended session → an unmissable Reconnect target, not a 12px hover icon. */}
        {ended && (
          <div className="agent-pane-ended" onMouseDown={stop}>
            <div className="agent-pane-ended-card">
              <div className="agent-pane-ended-glyph" aria-hidden>&gt;_</div>
              <div className="agent-pane-ended-title">Session ended</div>
              <div className="agent-pane-ended-sub">Claude exited this session. Start a fresh one right here.</div>
              <div className="agent-pane-ended-actions">
                <button className="agent-pane-reconnect" onClick={(e) => { e.stopPropagation(); onRestart(); }}>↻ Reconnect</button>
                <button className="agent-pane-ended-close" onClick={(e) => { e.stopPropagation(); onClose(); }}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
      {!last && <div className="agent-pane-divider" onPointerDown={onResizeStart} />}
    </>
  );
}
