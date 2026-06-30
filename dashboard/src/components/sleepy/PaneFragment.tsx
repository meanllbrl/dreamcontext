import { useState } from 'react';
import { AGENT_TAB_MIME } from './AgentTabs';

/**
 * One PANE of the expanded overlay — the terminal slot for that pane's ACTIVE session,
 * plus the dormant "Session saved → Resume" card. The session's identity + per-session
 * controls now live on its TAB in the top bar ({@link AgentTabs}); a pane is just the
 * terminal surface.
 *
 * The detached xterm container is appended into `.agent-pane-slot[data-pane=<id>]`
 * imperatively by AgentSurface's layout effect (never React-rendered), so switching the
 * pane's active session — or moving a session between panes — never remounts the
 * terminal. When a LIVE session ends its final output stays frozen in the slot.
 *
 * While a tab is being dragged, a three-zone drop overlay appears: dropping on the
 * LEFT/RIGHT edge splits the dragged session into a new pane beside this one; dropping
 * in the CENTER combines it into this pane as another tab. Presentational — all state +
 * actions come in as props.
 */

type Zone = 'left' | 'center' | 'right';

export function PaneFragment({
  paneId, active, dormant, dragging, tabbar, onZoneTarget, onResume, onClose, onActivate,
}: {
  paneId: string;
  /** This pane's own tab bar (rendered at the top of the pane so tabs sit directly above
   *  the terminal they drive). Built by AgentSurface and passed in. */
  tabbar?: React.ReactNode;
  /** This is the action-focused pane (drives a subtle accent rail). */
  active: boolean;
  /** The pane's active session is a restored roster entry with NO live session yet. */
  dormant?: boolean;
  /** A tab drag is in progress anywhere — show the split/combine drop overlay. */
  dragging: boolean;
  /** Report the zone the cursor is over (or null on leave) so the surface can act on the
   *  dragged tab's `dragend`. The HTML5 `drop` event is unreliable here in WKWebView. */
  onZoneTarget: (zone: Zone | null) => void;
  onResume?: () => void;
  onClose: () => void;
  /** Pointer-down anywhere in the pane (incl. its terminal) → make it the action-focused
   *  pane, so clicking into a split's other terminal moves the accent/⌘-target there. */
  onActivate?: () => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  // Which drop zone the dragged tab is currently over (for the highlight), or ''.
  const [over, setOver] = useState<Zone | ''>('');

  // Set on every dragover (not just dragenter) so the highlight reliably tracks the
  // cursor between zones even if a dragenter is missed at the seams / in WKWebView. This
  // ALSO records the live drop target on the surface (via onZoneTarget) for the dragend
  // executor — `dragover` is the reliable signal; the `drop` event is not in WKWebView.
  const over_ = (zone: Zone) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(AGENT_TAB_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOver((cur) => (cur === zone ? cur : zone));
    onZoneTarget(zone);
  };
  // Keep a `drop` handler too (harmless if it fires): it just preventDefaults so the OS
  // doesn't treat the release as a failed drag, and re-pins the exact release zone. The
  // actual split/combine runs on the dragged tab's `dragend` in AgentSurface.
  const drop = (zone: Zone) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver('');
    onZoneTarget(zone);
  };
  const leave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setOver('');
    onZoneTarget(null);
  };

  return (
    <div
      className={'agent-pane' + (active ? ' active' : '')}
      onMouseDownCapture={() => onActivate?.()}
    >
      {tabbar}
      <div className="agent-pane-slot" data-pane={paneId} />

      {/* Dormant restored tab → its name is remembered; resume spawns a real session
          here. (A LIVE ended session shows NO overlay — its output stays frozen.) */}
      {dormant && (
        <div className="agent-pane-ended" onMouseDown={stop}>
          <div className="agent-pane-ended-card">
            <div className="agent-pane-ended-glyph" aria-hidden>&gt;_</div>
            <div className="agent-pane-ended-title">Session saved</div>
            <div className="agent-pane-ended-sub">This tab’s name is remembered. Resume to start a fresh Claude Code session right here.</div>
            <div className="agent-pane-ended-actions">
              <button className="agent-pane-reconnect" onClick={(e) => { e.stopPropagation(); onResume?.(); }}>▸ Resume session</button>
              <button className="agent-pane-ended-close" onClick={(e) => { e.stopPropagation(); onClose(); }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Split/combine drop overlay — only present while a tab is being dragged, so it
          never blocks the terminal during normal use. */}
      {dragging && (
        <div
          className="agent-pane-droplayer"
          onDragLeave={leave}
        >
          <div className="agent-pane-zone left" data-over={over === 'left'} onDragOver={over_('left')} onDrop={drop('left')}>
            <span className="agent-pane-zone-label">⊟ Split left</span>
          </div>
          <div className="agent-pane-zone center" data-over={over === 'center'} onDragOver={over_('center')} onDrop={drop('center')}>
            <span className="agent-pane-zone-label">⊞ Add as tab</span>
          </div>
          <div className="agent-pane-zone right" data-over={over === 'right'} onDragOver={over_('right')} onDrop={drop('right')}>
            <span className="agent-pane-zone-label">⊟ Split right</span>
          </div>
        </div>
      )}
    </div>
  );
}
