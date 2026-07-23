import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAgentCouncilLive } from '../../hooks/useAgentCapabilities';
import {
  councilElapsedMinutes,
  councilPhaseLabel,
  councilShift,
  councilStanceColor,
  councilTally,
  type CouncilLivePersona,
  type CouncilLiveState,
} from '../../lib/councilLive';
import './CouncilLivePanel.css';

/**
 * The in-app live surface of a council debate — the chamber's read-only renderer.
 * Two states, mirroring GoalLivePanel:
 *
 *  - COMPACT STRIP, rendered directly above the pane's composer while a debate is
 *    active (zero footprint otherwise). Council glyph, truncated topic, round dots,
 *    phase label, persona dots colored by stance, convergence meter + leading key.
 *  - CHAMBER VIEW (click the strip): portal popup with one row per persona — stance
 *    chip, 10-cell conviction bar, shift arrow vs the previous round, headline —
 *    plus an options tally footer. Portal on document.body (the agent surface's
 *    `contain: layout paint` would clip a fixed overlay; same trap as the AgentDock).
 *
 * Session-scoped by the SERVER: this component only ever receives an active state
 * for the pane whose conversation is running the council orchestrator.
 */
export function CouncilLivePanel({ claudeId, enabled }: { claudeId?: string; enabled: boolean }) {
  const { data } = useAgentCouncilLive(claudeId, enabled);
  const [open, setOpen] = useState(false);
  const active = !!data?.active && !!data.state;

  // A finished/vanished debate closes the popup so it never shows stale state.
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  if (!active || !data?.state) return null;
  const st = data.state;
  const rounds = Math.max(0, st.rounds ?? 0);
  const round = Math.max(0, st.round ?? 0);
  const personas = st.personas ?? [];

  return (
    <>
      <button
        type="button"
        className="council-live-bar"
        title="Council live — click for the chamber view"
        aria-label="Council debate live — open chamber view"
        onClick={() => setOpen(true)}
      >
        <span className="council-live-mark" aria-hidden>⚖</span>
        {st.topic && <span className="council-live-topic">{String(st.topic).slice(0, 32)}</span>}
        <span className="council-live-round">
          {rounds > 0 && (
            <span className="council-live-round-dots" aria-label={`Round ${round} of ${rounds}`}>
              {Array.from({ length: rounds }, (_, i) => {
                const n = i + 1;
                const state = st.phase === 'done' || n < round ? 'done' : n === round ? 'active' : 'todo';
                return <b key={n} data-state={state} />;
              })}
            </span>
          )}
          <span className="council-live-phase" data-phase={st.phase}>{councilPhaseLabel(st.phase)}</span>
        </span>
        {personas.length > 0 && (
          <span className="council-live-personas" aria-hidden>
            {personas.map((p) => (
              <b
                key={p.slug}
                data-s={p.state}
                title={p.slug}
                style={{ ['--stance-c' as string]: councilStanceColor(st.options, p.stance) }}
              />
            ))}
          </span>
        )}
        {st.convergence != null && (
          <span className="council-live-conv" title={`Convergence ${st.convergence}%${st.leading ? ` toward ${st.leading}` : ''}`}>
            <span className="council-live-conv-track" aria-hidden>
              <span
                className="council-live-conv-fill"
                style={{
                  width: `${Math.min(100, Math.max(0, st.convergence))}%`,
                  background: councilStanceColor(st.options, st.leading),
                }}
              />
            </span>
            <span className="council-live-conv-num">{st.convergence}%</span>
            {st.leading && (
              <span className="council-live-conv-lead" style={{ color: councilStanceColor(st.options, st.leading) }}>
                {st.leading}
              </span>
            )}
          </span>
        )}
        <span className="council-live-expand" aria-hidden>⤢</span>
      </button>
      {open && createPortal(<CouncilLiveOverlay state={st} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

// ─── Chamber view — the expanded popup ───────────────────────────────────────

const BAR_CELLS = 10;

function ConvictionBar({ conviction, color }: { conviction: number | undefined; color: string }) {
  const filled = conviction == null ? 0 : Math.max(0, Math.min(BAR_CELLS, Math.round(conviction / 10)));
  return (
    <span className="council-live-cbar" aria-label={conviction == null ? 'no verdict' : `conviction ${conviction}`}>
      {Array.from({ length: BAR_CELLS }, (_, i) => (
        <i key={i} data-on={i < filled || undefined} style={i < filled ? { background: color } : undefined} />
      ))}
      <em>{conviction ?? '–'}</em>
    </span>
  );
}

function ShiftMark({ p }: { p: CouncilLivePersona }) {
  const shift = councilShift(p);
  if (!shift) return <span className="council-live-shift" data-kind="none" aria-hidden>·</span>;
  if (shift.kind === 'stance') {
    return (
      <span className="council-live-shift" data-kind="stance" title={`Changed stance ${shift.from} → ${shift.to}`}>
        ↷ {shift.from}→{shift.to}
      </span>
    );
  }
  if (shift.kind === 'conviction') {
    return (
      <span className="council-live-shift" data-kind={shift.up ? 'up' : 'down'} title="Conviction shift vs previous round">
        {shift.up ? '↑' : '↓'} {shift.from}→{shift.to}
      </span>
    );
  }
  return <span className="council-live-shift" data-kind="stable" title="Position stable">=</span>;
}

function CouncilLiveOverlay({ state, onClose }: { state: CouncilLiveState; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mins = councilElapsedMinutes(state);
  const personas = state.personas ?? [];
  const tally = councilTally(state);

  return (
    <div className="council-live-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Council chamber view">
      <div className="council-live-popup" onClick={(e) => e.stopPropagation()}>
        <header>
          <span className="council-live-mark" aria-hidden>⚖</span>
          <h3>council</h3>
          {state.topic && <span className="council-live-popup-topic">{state.topic}</span>}
          <span className="council-live-popup-meta">
            {councilPhaseLabel(state.phase)}
            {state.rounds ? ` · R${state.round ?? 0}/${state.rounds}` : ''}
            {mins != null ? ` · ${mins}m` : ''}
          </span>
          <button type="button" className="council-live-close" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="council-live-chamber-scroll">
          <table className="council-live-chamber">
            <tbody>
              {personas.map((p) => {
                const color = councilStanceColor(state.options, p.stance);
                return (
                  <tr key={p.slug} data-s={p.state}>
                    <td className="council-live-cell-name">
                      <b data-s={p.state} style={{ ['--stance-c' as string]: color }} aria-hidden />
                      <span title={p.model ? `${p.slug} · ${p.model}` : p.slug}>{p.slug}</span>
                    </td>
                    <td className="council-live-cell-stance">
                      {p.stance ? (
                        <span className="council-live-stance-chip" style={{ ['--stance-c' as string]: color }}>
                          {p.stance}
                        </span>
                      ) : (
                        <span className="council-live-stance-none">{p.state === 'think' ? 'deliberating' : '—'}</span>
                      )}
                    </td>
                    <td className="council-live-cell-bar">
                      <ConvictionBar conviction={p.conviction} color={color} />
                    </td>
                    <td className="council-live-cell-shift">
                      <ShiftMark p={p} />
                    </td>
                    <td className="council-live-cell-headline">
                      {p.headline ? <span title={p.headline}>{p.headline}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {tally.length > 0 && (
          <footer className="council-live-tally">
            <span className="council-live-tally-label">OPTIONS</span>
            {tally.map((t) => (
              <span key={t.key} className="council-live-tally-item" data-leading={state.leading?.toLowerCase() === t.key.toLowerCase() || undefined}>
                <b style={{ background: councilStanceColor(state.options, t.key) }} aria-hidden />
                <strong>{t.key}</strong> {t.label !== t.key ? t.label : ''} ({t.votes} · {t.conviction})
              </span>
            ))}
            {state.convergence != null && (
              <span className="council-live-tally-conv">
                convergence {state.convergence}%{state.leading ? ` → ${state.leading}` : ''}
              </span>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

// ─── Dock badge — the minimized "sleepy team" line ───────────────────────────

/**
 * Mini live readout for a MINIMIZED session's dock chip: round, convergence and
 * leading option key. Shares the panel's query (same key → deduped poll). Renders
 * nothing when no debate is active for that conversation.
 */
export function CouncilDockBadge({ claudeId, enabled }: { claudeId?: string; enabled: boolean }) {
  const { data } = useAgentCouncilLive(claudeId, enabled);
  if (!data?.active || !data.state) return null;
  const st = data.state;
  const label = councilPhaseLabel(st.phase);
  return (
    <span className="council-live-dock-badge" title={`council · ${label}${st.topic ? ` · ${st.topic}` : ''}`}>
      <span aria-hidden>⚖</span>
      {st.rounds ? ` R${st.round ?? 0}/${st.rounds}` : ` ${label}`}
      {st.convergence != null ? ` ${st.convergence}%` : ''}
      {st.leading ? (
        <strong style={{ color: councilStanceColor(st.options, st.leading) }}> {st.leading}</strong>
      ) : null}
    </span>
  );
}
