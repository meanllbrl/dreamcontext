import { useState, useEffect } from 'react';
import type { SessionRow, SessionStatusKind } from './agentStatus';

/**
 * The bottom-right session dock — shown when the full overlay is closed and ≥1 session
 * exists (a lone "Agent" FAB stands in at zero sessions). It is NOT a panel/popover: it's
 * a bare vertical stack of chip TILES anchored in the corner, growing upward. Each tile —
 * `[dot] [mascot] [name] [state] [✕]` — is its OWN solid, shadowed pill, so the names stay
 * legible over WHATEVER page/terminal content sits behind the fixed dock (the original
 * floating-label readability problem). A single anchor chip sits at the very corner: it
 * collapses the stack into one COMBINED chip (mascot · count) and re-expands it. Default
 * is expanded; the choice is remembered across reloads. Clicking a tile opens the overlay
 * AND focuses that session; the tile's own ✕ closes it one-click.
 */

const COLLAPSE_KEY = 'dreamcontext.agentDock.collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

/** Worst-of rollup so the collapsed/anchor chip's dot still surfaces the most "alive"
 *  state (working ▸ starting ▸ ready ▸ saved ▸ ended) at a glance. */
const KIND_RANK: Record<SessionStatusKind, number> = {
  working: 5, starting: 4, ready: 3, saved: 2, ended: 1,
};
function rollupKind(rows: SessionRow[]): SessionStatusKind {
  return rows.reduce<SessionStatusKind>(
    (worst, r) => (KIND_RANK[r.info.kind] > KIND_RANK[worst] ? r.info.kind : worst),
    'ended',
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

  const attention = rows.some(r => r.attention);
  const rollup = rollupKind(rows);
  const plural = rows.length === 1 ? '' : 's';

  return (
    <div className={'agent-dock' + (className ? ' ' + className : '')} data-collapsed={collapsed} role="group" aria-label="Agent sessions">
      {!collapsed && (
        <div className="agent-dock-tiles">
          {rows.map((row) => {
            const focused = row.id === focusedId;
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
                <span className="agent-dock-chip-dot" data-kind={row.info.kind} aria-hidden />
                <span className="agent-dock-chip-title" title={row.title}>{row.title}</span>
                <span className="agent-dock-chip-state" data-kind={row.info.kind}>{row.info.label}</span>
                {row.attention && <span className="agent-dock-chip-badge" aria-label="Waiting for you" />}
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
          chip and re-expands it. Same footprint in both states for spatial continuity. */}
      <button
        type="button"
        className="agent-dock-anchor"
        data-kind={rollup}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `${rows.length} agent${plural} — expand` : 'Collapse agents'}
        title={collapsed ? `${rows.length} agent${plural} · click to expand` : 'Collapse'}
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="agent-dock-anchor-dot" data-kind={rollup} aria-hidden />
        <span className="agent-dock-anchor-count">{rows.length}</span>
        {attention && <span className="agent-dock-anchor-badge" aria-label="Waiting for you" />}
        <span className="agent-dock-anchor-chevron" aria-hidden>{collapsed ? '⌃' : '⌄'}</span>
      </button>
    </div>
  );
}
