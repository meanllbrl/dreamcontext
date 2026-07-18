import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAgentGoalLive } from '../../hooks/useAgentCapabilities';
import {
  GOAL_PHASES,
  GOAL_PHASE_LABELS,
  goalElapsedMinutes,
  goalHeatTier,
  goalPhaseIndex,
  type GoalLiveState,
} from '../../lib/goalLive';
import './GoalLivePanel.css';

/**
 * The in-app live surface of a goal-skill run — the user-chosen replacement for the
 * terminal statusline strip. Two states:
 *
 *  - COMPACT BAR, rendered directly above the pane's composer while a run is active
 *    (zero footprint otherwise). Phase chips with loop-heat, implementer fork dots,
 *    wave counter, elapsed time.
 *  - EXPANDED POPUP (click the bar): the rich Excalidraw-viewer-style graph — phase
 *    nodes with arrows, loop-back heat arcs, fork satellites around IMPL — rendered
 *    in a portal on document.body (the agent surface's `contain: layout paint` would
 *    otherwise clip a fixed overlay; same trap as the AgentDock).
 *
 * Session-scoped by the SERVER: this component only ever receives an active state for
 * the pane whose conversation is running the orchestrator.
 */
export function GoalLivePanel({ claudeId, enabled }: { claudeId?: string; enabled: boolean }) {
  const { data } = useAgentGoalLive(claudeId, enabled);
  const [open, setOpen] = useState(false);
  const active = !!data?.active && !!data.state;

  // A finished/vanished run closes the popup so it never shows stale state.
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  if (!active || !data?.state) return null;
  const st = data.state;
  const cur = goalPhaseIndex(st.phase);
  const mins = goalElapsedMinutes(st);

  return (
    <>
      <button
        type="button"
        className="goal-live-bar"
        title="Goal-skill live — click for the expanded view"
        aria-label="Goal-skill live run — open expanded view"
        onClick={() => setOpen(true)}
      >
        <span className="goal-live-mark" aria-hidden>⛬</span>
        {st.goal && <span className="goal-live-goal">{String(st.goal).slice(0, 28)}</span>}
        <span className="goal-live-phases">
          {GOAL_PHASES.map((p, i) => {
            const state = st.phase === 'done' || i < cur ? 'done' : i === cur ? 'active' : 'todo';
            const heat = goalHeatTier(st.iters, p);
            return (
              <span key={p} className="goal-live-chip" data-state={state} data-heat={heat || undefined}>
                <i aria-hidden>{state === 'done' ? '✓' : state === 'active' ? '▶' : '·'}</i>
                {GOAL_PHASE_LABELS[p]}
                {heat > 0 && <em>×{st.iters?.[p]}</em>}
                {p === 'impl' && st.impl && (i <= cur || st.phase === 'done') && (
                  <span className="goal-live-forks" aria-hidden>
                    {(st.impl.forks ?? []).map((f, k) => (
                      <b key={k} data-s={f.s} />
                    ))}
                    {st.impl.waves ? <u>W{st.impl.wave ?? 1}/{st.impl.waves}</u> : null}
                  </span>
                )}
              </span>
            );
          })}
        </span>
        <span className="goal-live-tail">
          {st.phase === 'done' ? <span className="goal-live-done">DONE</span> : null}
          {mins != null && <span className="goal-live-mins">{mins}m</span>}
          <span className="goal-live-expand" aria-hidden>⤢</span>
        </span>
      </button>
      {open && createPortal(<GoalLiveOverlay state={st} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

// ─── Expanded popup — the viewer graph, in-app ────────────────────────────────

const NODE_W = 118;
const NODE_H = 54;
const NODE_GAP = 26;
const GRAPH_PAD = 28;
const GRAPH_W = GRAPH_PAD * 2 + GOAL_PHASES.length * NODE_W + (GOAL_PHASES.length - 1) * NODE_GAP;
const NODE_Y = 96;
const HEAT_COLORS = ['', '#e6b31780', '#e6b317', '#fa5252'];
const FORK_COLORS: Record<string, string> = {
  done: '#40c057',
  run: '#fab005',
  wait: '#5c5f66',
  fail: '#fa5252',
};

function GoalLiveOverlay({ state, onClose }: { state: GoalLiveState; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cur = goalPhaseIndex(state.phase);
  const mins = goalElapsedMinutes(state);
  const forks = state.impl?.forks ?? [];
  const nodeX = (i: number) => GRAPH_PAD + i * (NODE_W + NODE_GAP);

  return (
    <div className="goal-live-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Goal-skill live run">
      <div className="goal-live-popup" onClick={(e) => e.stopPropagation()}>
        <header>
          <span className="goal-live-mark" aria-hidden>⛬</span>
          <h3>goal-skill</h3>
          {state.goal && <span className="goal-live-popup-goal">{state.goal}</span>}
          <span className="goal-live-popup-meta">
            {state.phase === 'done' ? 'DONE' : GOAL_PHASE_LABELS[state.phase] ?? state.phase}
            {mins != null ? ` · ${mins}m` : ''}
          </span>
          <button type="button" className="goal-live-close" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="goal-live-graph-scroll">
          <svg viewBox={`0 0 ${GRAPH_W} 250`} width={GRAPH_W} height={250} role="img" aria-label="Phase graph">
            {/* forward arrows */}
            {GOAL_PHASES.map((_, i) =>
              i === 0 ? null : (
                <line
                  key={`a${i}`}
                  x1={nodeX(i - 1) + NODE_W}
                  y1={NODE_Y + NODE_H / 2}
                  x2={nodeX(i) - 6}
                  y2={NODE_Y + NODE_H / 2}
                  className="goal-live-edge"
                  markerEnd="url(#goal-live-arrow)"
                />
              ),
            )}
            {/* loop-back heat arcs: review→plan, codereview→impl, validate→impl */}
            {([['review', 'plan'], ['codereview', 'impl'], ['validate', 'impl']] as const).map(([from, to]) => {
              const n = state.iters?.[from] ?? 0;
              if (n < 2) return null;
              const fi = GOAL_PHASES.indexOf(from);
              const ti = GOAL_PHASES.indexOf(to);
              const x1 = nodeX(fi) + NODE_W / 2;
              const x2 = nodeX(ti) + NODE_W / 2;
              const heat = HEAT_COLORS[goalHeatTier(state.iters, from)];
              return (
                <g key={`${from}-${to}`}>
                  <path
                    d={`M ${x1} ${NODE_Y - 6} Q ${(x1 + x2) / 2} ${NODE_Y - 64} ${x2} ${NODE_Y - 6}`}
                    className="goal-live-arc"
                    style={{ stroke: heat }}
                    markerEnd="url(#goal-live-arrow-hot)"
                  />
                  <text x={(x1 + x2) / 2} y={NODE_Y - 66} className="goal-live-arc-label" style={{ fill: heat }}>
                    ×{n}
                  </text>
                </g>
              );
            })}
            {/* phase nodes */}
            {GOAL_PHASES.map((p, i) => {
              const s = state.phase === 'done' || i < cur ? 'done' : i === cur ? 'active' : 'todo';
              return (
                <g key={p} className="goal-live-node" data-state={s}>
                  <rect x={nodeX(i)} y={NODE_Y} rx={12} width={NODE_W} height={NODE_H} />
                  <text x={nodeX(i) + NODE_W / 2} y={NODE_Y + NODE_H / 2 + 5}>
                    {GOAL_PHASE_LABELS[p]}
                  </text>
                </g>
              );
            })}
            {/* implementer fork satellites under IMPL */}
            {forks.map((f, k) => {
              const ix = nodeX(GOAL_PHASES.indexOf('impl')) + NODE_W / 2;
              const spread = (k - (forks.length - 1) / 2) * 26;
              return (
                <g key={k}>
                  <line x1={ix} y1={NODE_Y + NODE_H} x2={ix + spread} y2={NODE_Y + NODE_H + 34} className="goal-live-sat-line" />
                  <circle cx={ix + spread} cy={NODE_Y + NODE_H + 42} r={8} fill={FORK_COLORS[f.s] ?? FORK_COLORS.wait}>
                    {f.s === 'run' && (
                      <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
                    )}
                  </circle>
                </g>
              );
            })}
            {state.impl?.waves ? (
              <text x={nodeX(GOAL_PHASES.indexOf('impl')) + NODE_W / 2} y={NODE_Y + NODE_H + 72} className="goal-live-wave">
                wave {state.impl.wave ?? 1}/{state.impl.waves}
              </text>
            ) : null}
            <defs>
              <marker id="goal-live-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="goal-live-arrowhead" />
              </marker>
              <marker id="goal-live-arrow-hot" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
          </svg>
        </div>
      </div>
    </div>
  );
}

// ─── Dock badge — the minimized "sleepy team" line ───────────────────────────

/**
 * Mini live readout for a MINIMIZED session's dock chip: active phase + wave + one dot
 * per implementer fork. Shares the panel's query (same key → deduped poll). Renders
 * nothing when no run is active for that conversation.
 */
export function GoalDockBadge({ claudeId, enabled }: { claudeId?: string; enabled: boolean }) {
  const { data } = useAgentGoalLive(claudeId, enabled);
  if (!data?.active || !data.state) return null;
  const st = data.state;
  const label = st.phase === 'done' ? 'DONE' : GOAL_PHASE_LABELS[st.phase] ?? st.phase;
  return (
    <span className="goal-live-dock-badge" title={`goal-skill · ${label}`}>
      <span aria-hidden>⛬</span> {label}
      {st.impl?.waves ? ` W${st.impl.wave ?? 1}/${st.impl.waves}` : ''}
      <span className="goal-live-dock-forks" aria-hidden>
        {(st.impl?.forks ?? []).slice(0, 6).map((f, k) => (
          <b key={k} data-s={f.s} />
        ))}
      </span>
    </span>
  );
}
