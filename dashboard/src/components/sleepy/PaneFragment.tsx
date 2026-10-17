import { memo, useCallback } from 'react';
import { useTabDragActive, useTabDragZone, type TabDragStore } from './tabDrag';

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
 * in the CENTER combines it into this pane as another tab. Presentational — the drag is a
 * pointer gesture owned by the tab (tabDrag.ts), which hit-tests these thirds from rects it
 * measured once; this pane only READS the surface's drag store, and re-renders only when
 * the pointer enters or leaves one of its own zones.
 *
 * MEMOIZED, and that is why the actions arrive as ONE stable {@link PaneActions} object
 * keyed by pane/session id rather than as four pre-bound arrows: AgentSurface re-renders on
 * every session's status edge anywhere in the roster, and four fresh closures per render
 * would make the memo a no-op. A chat pane passes `composer={false}` (its composer lives
 * inside the portaled ChatPane), so its whole subtree genuinely stops re-rendering; a
 * terminal pane still rebuilds its `<PaneComposer>` element and re-renders, which is the
 * cheap half of the tree and out of this change's scope.
 */

/** Surface-owned pane actions, taking their target as an argument so the object itself can
 *  be a single unchanging identity shared by every pane. */
export interface PaneActions {
  /** Pointer-down anywhere in the pane → make it the action-focused pane. */
  activate: (paneId: string) => void;
  /** Resume this pane's dormant active session. */
  resume: (sessionId: string) => void;
  /** Close this pane's active session. */
  close: (sessionId: string) => void;
}

function PaneFragmentInner({
  paneId, activeSessionId, actions, active, dormant, drag, composer,
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
  /** The surface's tab-drag store (one stable identity) — mounts the drop overlay while a
   *  tab is dragged and highlights the zone under the pointer. */
  drag: TabDragStore;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const dragging = useTabDragActive(drag);
  // Which of this pane's zones the dragged tab is over (for the highlight), or ''.
  const over = useTabDragZone(drag, paneId);

  // The three surface actions, re-bound to THIS pane/session. Derived inside the memo so the
  // identities survive an AgentSurface render (see this file's header).
  const onActivate = useCallback(() => actions.activate(paneId), [actions, paneId]);
  const onResume = useCallback(() => actions.resume(activeSessionId), [actions, activeSessionId]);
  const onClose = useCallback(() => actions.close(activeSessionId), [actions, activeSessionId]);

  return (
    <div
      className={'agent-pane' + (active ? ' active' : '')}
      data-pane-id={paneId}
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
        <div className="agent-pane-droplayer">
          <div className="agent-pane-zone left" data-over={over === 'left'}>
            <span className="agent-pane-zone-label">⊟ Split left</span>
          </div>
          <div className="agent-pane-zone center" data-over={over === 'center'}>
            <span className="agent-pane-zone-label">⊞ Add as tab</span>
          </div>
          <div className="agent-pane-zone right" data-over={over === 'right'}>
            <span className="agent-pane-zone-label">⊟ Split right</span>
          </div>
        </div>
      )}
    </div>
  );
}

export const PaneFragment = memo(PaneFragmentInner);
