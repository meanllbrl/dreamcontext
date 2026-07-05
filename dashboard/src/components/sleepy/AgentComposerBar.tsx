import { useEffect, useRef, useState } from 'react';
import {
  SKILL_GROUPS, effortLabel, fmtTokens, fmtCost,
  type ModelOption, type SessionStats,
} from '../../lib/agentComposer';

/**
 * The thin strip pinned to the bottom of the expanded Agent overlay. It has NO text field of
 * its own — the terminal's OWN input line is the text field. The strip only:
 *   • 📎 Files            — native multi-select picker; the chosen paths drop into the
 *                           focused terminal's input line.
 *   • ✦ Dreamcontext Skills — a popover of our signature capabilities; picking one types its
 *                           trigger into the terminal's input line.
 *   • model ▾ / effort ▾  — the FOCUSED agent's live model + effort (from the Claude CLI);
 *                           changing either fires `/model` or `/effort` at that agent.
 *
 * Purely presentational + a self-contained popover; all injection/switching lives in
 * {@link AgentSurface}.
 */

// ── A tiny popover: a trigger button + a menu that closes on outside-click / Esc ──────
function Popover({
  trigger, align = 'right', children,
}: {
  trigger: (open: boolean, toggle: () => void) => React.ReactNode;
  align?: 'left' | 'right';
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div className="agent-composer-pop" ref={ref}>
      {trigger(open, () => setOpen((v) => !v))}
      {open && (
        <div className={`agent-composer-menu align-${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function AgentComposerBar({
  onInsert, onPickFiles, models, efforts, model, effort, onModelChange, onEffortChange, disabled, skillsDisabled = false, stats,
}: {
  /** Type a skill trigger into the focused terminal's input line. */
  onInsert: (snippet: string) => void;
  /** Open the native multi-file picker and drop the chosen paths into the terminal. */
  onPickFiles: () => void;
  /** Model options the CLI offers, and effort levels from `claude --help`. */
  models: ModelOption[];
  efforts: string[];
  /** The focused agent's current model alias + effort level. */
  model: string;
  effort: string;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  /** No live agent focused → the model/effort pickers can't target anything. */
  disabled: boolean;
  /** This pane is a plain SHELL, not a Claude agent → our skill triggers (slash commands)
   *  don't apply, so the Skills picker is disabled (Files still works for a shell). */
  skillsDisabled?: boolean;
  /** This agent's live context-window footprint + API-rate cost estimate (null until the
   *  first turn writes usage, or omitted entirely for a shell). */
  stats?: SessionStats | null;
}) {
  const modelLabel = models.find((m) => m.id === model)?.label ?? (model || '—');
  const ctx = stats?.contextTokens != null && stats.contextLimit
    ? { used: stats.contextTokens, limit: stats.contextLimit, pct: Math.min(100, Math.round((stats.contextTokens / stats.contextLimit) * 100)) }
    : null;
  const showStats = !!ctx || (stats?.costUsd != null && stats.costUsd > 0);

  return (
    <div className="agent-composer">
      {/* Files */}
      <button
        type="button"
        className="agent-composer-btn"
        title="Attach files (multi-select) — drops into the terminal input"
        aria-label="Attach files"
        onClick={onPickFiles}
      >
        <span aria-hidden>📎</span>
        <span className="agent-composer-btn-label">Files</span>
      </button>

      {/* Dreamcontext Skills */}
      <Popover
        align="left"
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-btn${open ? ' open' : ''}`}
            title={skillsDisabled ? 'Skills apply to Claude agents, not a plain terminal' : 'Insert one of our skills into the terminal input'}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={skillsDisabled}
            onClick={toggle}
          >
            <span aria-hidden>✦</span>
            <span className="agent-composer-btn-label">Dreamcontext Skills</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="agent-skill-list">
            {SKILL_GROUPS.map((group) => (
              <div className="agent-skill-group" key={group.id}>
                <span className="agent-skill-group-label">{group.label}</span>
                <div className="agent-skill-chips">
                  {group.triggers.map((t) => (
                    <button
                      key={t.insert}
                      type="button"
                      className="agent-skill-chip"
                      title={t.hint}
                      onClick={() => { onInsert(t.insert); close(); }}
                    >{t.label}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Popover>

      {/* Spacer pushes the live readout + model/effort pickers to the right edge */}
      <div className="agent-composer-spacer" />

      {/* Live context-window footprint + API-rate cost estimate (this agent's own). */}
      {showStats && (
        <div
          className="agent-composer-stats"
          title={
            `${ctx ? `Context window: ${fmtTokens(ctx.used)} of ${fmtTokens(ctx.limit)} used (${ctx.pct}%)\n` : ''}` +
            `${stats?.costUsd != null ? `Estimated cost at public API rates: ${fmtCost(stats.costUsd)} (a Max/Pro plan is flat-rate — this is a what-if)` : ''}`
          }
        >
          {ctx && (
            <span className="agent-composer-stat" data-hot={ctx.pct >= 85}>
              <span className="agent-composer-stat-glyph" aria-hidden>◔</span>
              <span className="agent-composer-stat-val">{fmtTokens(ctx.used)}<span className="agent-composer-stat-dim">/{fmtTokens(ctx.limit)}</span></span>
            </span>
          )}
          {stats?.costUsd != null && (
            <span className="agent-composer-stat">
              <span className="agent-composer-stat-val">{fmtCost(stats.costUsd)}</span>
            </span>
          )}
        </div>
      )}

      {/* Model — the focused agent's live model */}
      <Popover
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-select${open ? ' open' : ''}`}
            title={disabled ? 'Focus an agent to change its model' : 'Model of the focused agent'}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={toggle}
          >
            <span aria-hidden>◆</span>
            <span className="agent-composer-select-label">{modelLabel}</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="agent-model-list">
            {models.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`agent-model-row${m.id === model ? ' on' : ''}`}
                role="menuitemradio"
                aria-checked={m.id === model}
                onClick={() => { onModelChange(m.id); close(); }}
              >
                <span className="agent-model-row-label">{m.label}</span>
              </button>
            ))}
          </div>
        )}
      </Popover>

      {/* Effort — the focused agent's live reasoning effort */}
      <Popover
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-select${open ? ' open' : ''}`}
            title={disabled ? 'Focus an agent to change its effort' : 'Reasoning effort of the focused agent'}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={toggle}
          >
            <span aria-hidden>◈</span>
            <span className="agent-composer-select-label">{effort ? effortLabel(effort) : '—'}</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="agent-model-list">
            {efforts.map((lvl) => (
              <button
                key={lvl}
                type="button"
                className={`agent-model-row${lvl === effort ? ' on' : ''}`}
                role="menuitemradio"
                aria-checked={lvl === effort}
                onClick={() => { onEffortChange(lvl); close(); }}
              >
                <span className="agent-model-row-label">{effortLabel(lvl)}</span>
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}
