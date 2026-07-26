import { memo, useCallback, useState } from 'react';
import { AGENT_TAB_MIME } from './AgentTabs';

/**
 * One PANE of the expanded overlay — the terminal slot for that pane's ACTIVE session,
 * plus the dormant "Session saved → Resume" card. The session's identity + per-session
 * controls live on its TAB, and every pane's tab group now sits in the overlay HEADER
 * ({@link AgentTabs} inside `.agent-overlay-tabs`) — a pane is just the terminal surface
 * plus its composer.
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
 *
 * MEMOIZED, and that is why the actions arrive as ONE stable {@link PaneActions} object
 * keyed by pane/session id rather than as four pre-bound arrows: AgentSurface re-renders on
 * every session's status edge anywhere in the roster, and four fresh closures per render
 * would make the memo a no-op. A chat pane passes `composer={false}` (its composer lives
 * inside the portaled ChatPane), so its whole subtree genuinely stops re-rendering; a
 * terminal pane still rebuilds its `<PaneComposer>` element and re-renders, which is the
 * cheap half of the tree and out of this change's scope.
 */

type Zone = 'left' | 'center' | 'right';

/** Surface-owned pane actions, taking their target as an argument so the object itself can
 *  be a single unchanging identity shared by every pane. */
export interface PaneActions {
  /** Report the drop zone the cursor is over (or null on leave). */
  setZoneTarget: (paneId: string, zone: Zone | null) => void;
  /** Pointer-down anywhere in the pane → make it the action-focused pane. */
  activate: (paneId: string) => void;
  /** Resume this pane's dormant active session. */
  resume: (sessionId: string) => void;
  /** Close this pane's active session. */
  close: (sessionId: string) => void;
}

function PaneFragmentInner({
  paneId, activeSessionId, actions, active, dormant, dragging, composer,
}: {
  paneId: string;
  /** The session this pane is currently showing — what `resume`/`close` act on. */
  activeSessionId: string;
  actions: PaneActions;
  /** This pane's OWN composer strip (files + skills + this agent's live model/effort),
   *  pinned to the bottom of the pane so every agent gets its own bar. Built by
   *  AgentSurface and passed in; omitted for a dormant pane. */
  composer?: React.ReactNode;
  /** This is the action-focused pane (drives a subtle accent rail). */
  active: boolean;
  /** The pane's active session is a restored roster entry with NO live session yet. */
  dormant?: boolean;
  /** A tab drag is in progress anywhere — show the split/combine drop overlay. */
  dragging: boolean;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  // Which drop zone the dragged tab is currently over (for the highlight), or ''.
  const [over, setOver] = useState<Zone | ''>('');

  // The four surface actions, re-bound to THIS pane/session. Derived inside the memo so the
  // identities survive an AgentSurface render (see this file's header).
  const onZoneTarget = useCallback(
    (zone: Zone | null) => actions.setZoneTarget(paneId, zone), [actions, paneId],
  );
  const onActivate = useCallback(() => actions.activate(paneId), [actions, paneId]);
  const onResume = useCallback(() => actions.resume(activeSessionId), [actions, activeSessionId]);
  const onClose = useCallback(() => actions.close(activeSessionId), [actions, activeSessionId]);

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
      onMouseDownCapture={onActivate}
    >
      <div className="agent-pane-slot" data-pane={paneId} />
      {/* This pane's own bottom strip — files/skills + THIS agent's live model & effort. */}
      {composer}

      {/* Dormant restored tab → its name is remembered; resume spawns a real session
          here. (A LIVE ended session shows NO overlay — its output stays frozen.) */}
      {dormant && (
        <div className="agent-pane-ended" onMouseDown={stop}>
          <div className="agent-pane-ended-card">
            <div className="agent-pane-ended-glyph" aria-hidden>&gt;_</div>
            <div className="agent-pane-ended-title">Session saved</div>
            <div className="agent-pane-ended-sub">This tab’s name is remembered. Resume to start a fresh Claude Code session right here.</div>
            <div className="agent-pane-ended-actions">
              <button className="agent-pane-reconnect" onClick={(e) => { e.stopPropagation(); onResume(); }}>▸ Resume session</button>
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

export const PaneFragment = memo(PaneFragmentInner);
