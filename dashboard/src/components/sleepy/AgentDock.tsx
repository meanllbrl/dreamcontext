import { useState, useEffect } from 'react';
import { SleepyMascot } from './SleepyMascot';
import { GoalDockBadge } from './GoalLivePanel';
import { orderRows, rollupKind, type SessionRow } from './agentStatus';

/**
 * The bottom-right session dock — shown when the full overlay is closed and ≥1 session
 * exists (a lone "Agent" FAB stands in at zero sessions). It is NOT a panel/popover: it's
 * a bare vertical stack of chip TILES anchored in the corner, growing upward. Each tile —
 * `[figure] [title / state] [✕]` — is its OWN solid, shadowed pill, so the names stay
 * legible over WHATEVER page/terminal content sits behind the fixed dock. The FIGURE is
 * the status: Sleepy's face wears a distinct per-state look on Claude-agent tiles (green
 * scanning = working, magenta wide-eyed = asking, violet waving = ready, amber pondering
 * = starting, asleep = saved/ended); a plain terminal (shell) has no agent behind it, so
 * it shows a mini prompt glyph with a blinking cursor instead. No status dots.
 *
 * A session that ASKS A QUESTION jumps to the top of the stack, shakes, grows a "?"
 * bubble, and rings a chime (the chime fires at the session layer, on the asking edge) —
 * everything else keeps its roster order so tiles don't churn. A single anchor chip sits
 * at the very corner: it collapses the stack into one COMBINED chip (figure · count) and
 * re-expands it. Default is expanded; the choice is remembered across reloads. Clicking
 * a tile opens the overlay AND focuses that session; the tile's own ✕ closes it one-click.
 */

const COLLAPSE_KEY = 'dreamcontext.agentDock.collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

/** The status figure: Sleepy's per-state face for agents, a mini prompt glyph with a
 *  blinking cursor for shells, plus the "?" bubble when the session is asking. */
function ChipFigure({ row, size = 26 }: { row: SessionRow; size?: number }) {
  return (
    <span className="agent-dock-chip-figure" aria-hidden>
      {row.kind === 'agent' ? (
        <span className="agent-dock-chip-figure-clip">
          <SleepyMascot mood={row.info.mood} size={size} compact />
        </span>
      ) : (
        <span className="agent-dock-chip-glyph" data-kind={row.info.kind}>❯<i /></span>
      )}
      {row.info.kind === 'asking' && <span className="agent-dock-chip-q">?</span>}
    </span>
  );
}

export function AgentDock({ rows, focusedId, onOpen, onClose, className }: {
  rows: SessionRow[];
  focusedId: string;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  /** Extra class on the dock root (e.g. to float it ABOVE the expanded overlay). */
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* non-fatal */ }
  }, [collapsed]);

  const ordered = orderRows(rows);
  const attention = rows.some(r => r.attention);
  const anyAsking = rows.some(r => r.info.kind === 'asking');
  const rollup = rollupKind(rows);
  const plural = rows.length === 1 ? '' : 's';
  // The anchor chip's figure surfaces the most urgent row: a question outranks the
  // focused session, which outranks the worst-of fallback.
  const anchorRow = rows.find(r => r.info.kind === 'asking')
    ?? rows.find(r => r.id === focusedId)
    ?? rows.find(r => r.info.kind === rollup)
    ?? rows[0];

  return (
    <div className={'agent-dock' + (className ? ' ' + className : '')} data-collapsed={collapsed} role="group" aria-label="Agent sessions">
      {!collapsed && (
        <div className="agent-dock-tiles">
          {ordered.map((row) => {
            const focused = row.id === focusedId;
            const busyish = row.info.kind === 'working' || row.info.kind === 'starting';
            return (
              <div
                key={row.id}
                className={'agent-dock-chip' + (focused ? ' focused' : '')}
                data-kind={row.info.kind}
                role="button"
                tabIndex={0}
                aria-current={focused ? 'true' : undefined}
                aria-label={`${row.title} — ${row.info.label} · open`}
                title={`${row.title} — ${row.info.label} · click to open`}
                onClick={() => onOpen(row.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row.id); } }}
              >
                <ChipFigure row={row} />
                <span className="agent-dock-chip-text">
                  <span className="agent-dock-chip-title" title={row.title}>{row.title}</span>
                  <span className="agent-dock-chip-state" data-kind={row.info.kind}>
                    {row.info.label}
                    {busyish && <span className="agent-dock-chip-dots" aria-hidden><i /><i /><i /></span>}
                  </span>
                  {/* Sleepy-team line: a minimized agent running a goal-skill cycle
                      shows its live phase + implementer dots right on the chip. */}
                  {row.kind === 'agent' && (
                    <GoalDockBadge claudeId={row.claudeId} enabled={!!row.claudeId} />
                  )}
                </span>
                {row.attention && row.info.kind !== 'asking' && <span className="agent-dock-chip-badge" aria-label="Waiting for you" />}
                <button
                  type="button"
                  className="agent-dock-chip-close"
                  aria-label={`Close ${row.title}`}
                  title="Close session"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onClose(row.id); }}
                >✕</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Anchor chip — the corner-most element. Collapses the stack into one combined
          chip and re-expands it. Same footprint in both states for spatial continuity.
          While ANY session is asking, the anchor itself shakes so a collapsed dock
          still makes the question unmissable. */}
      <button
        type="button"
        className="agent-dock-anchor"
        data-kind={rollup}
        data-asking={anyAsking || undefined}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `${rows.length} agent${plural} — expand` : 'Collapse agents'}
        title={collapsed ? `${rows.length} agent${plural} · click to expand` : 'Collapse'}
        onClick={() => setCollapsed(c => !c)}
      >
        {anchorRow && <ChipFigure row={anchorRow} size={24} />}
        <span className="agent-dock-anchor-count">{rows.length}</span>
        {attention && !anyAsking && <span className="agent-dock-anchor-badge" aria-label="Waiting for you" />}
        <svg className="agent-dock-anchor-chevron" data-open={!collapsed || undefined} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 6.2 L5 3.2 L8 6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
