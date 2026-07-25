import {
  effortLabel, fmtTokens, fmtCost, modelLabelFor, CONTEXT_TIGHT_PCT,
  type ModelOption, type SessionStats,
} from '../../lib/agentComposer';
import { Popover, SkillBrowser } from './SkillPickerPopover';

/**
 * The strip pinned to the bottom of each pane, styled as the terminal's OWN status line
 * (see AgentTerminal.css — same canvas, same mono grid, `·`-separated hint-row segments).
 * It has NO text field of its own — the terminal's OWN input line is the text field. It only:
 *   • @ Files             — native multi-select picker; the chosen paths drop into the
 *                           focused terminal's input line.
 *   • ✦ Dreamcontext Skills — a two-pane popover of our signature capabilities: chips on the
 *                           left, a live "what it is / how it works" detail card on the right
 *                           that follows hover/focus. Picking one types its trigger into the
 *                           terminal's input line.
 *   • model ▾ / effort ▾  — the FOCUSED agent's live model + effort (from the Claude CLI);
 *                           changing either fires `/model` or `/effort` at that agent.
 *
 * Purely presentational + a self-contained popover; all injection/switching lives in
 * {@link AgentSurface}. `Popover`/`SkillBrowser` live in `SkillPickerPopover.tsx` — shared
 * verbatim with the Agent Chat (beta) composer so both surfaces use the SAME skill picker.
 */

export function AgentComposerBar({
  onInsert, onPickFiles, onPickFolders, models, efforts, model, effort, onModelChange, onEffortChange, disabled, skillsDisabled = false, stats,
}: {
  /** Type a skill trigger into the focused terminal's input line. */
  onInsert: (snippet: string) => void;
  /** Open the native multi-file picker and drop the chosen paths into the terminal. */
  onPickFiles: () => void;
  /** Same, but the native multi-FOLDER picker (one Tauri dialog can't offer both mixed). */
  onPickFolders: () => void;
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
  // Shared with the chat composer so both surfaces name the model the same way: a picker
  // alias, a full CLI id resolved by family, and never a bare "—".
  // `|| '—'` only for a genuinely EMPTY model (no agent focused yet). A full CLI id like
  // `claude-opus-4-5-20251101` now resolves to "Opus" instead of falling through to the dash.
  const modelLabel = modelLabelFor({ models, efforts, defaultModel: '', defaultEffort: '' }, model) || '—';
  // `contextTokens` must be non-ZERO, not merely non-null: a transcript whose only turn was
  // a synthetic notice ("Please run /login") reports 0, and "0% 0/200k" is noise, not a
  // reading. Same rule as the chat composer's.
  const ctx = stats?.contextTokens
    ? {
      used: stats.contextTokens,
      limit: stats.contextLimit ?? 200_000,
      pct: Math.min(100, Math.round((stats.contextTokens / (stats.contextLimit ?? 200_000)) * 100)),
    }
    : null;
  const showStats = !!ctx || (stats?.costUsd != null && stats.costUsd > 0);

  return (
    <div className="agent-composer">
      {/* Files / Folders — two menu entries because one native dialog can't offer both mixed. */}
      <Popover
        align="left"
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-btn${open ? ' open' : ''}`}
            title="Attach files or folders (multi-select) — drops into the terminal input"
            aria-label="Attach files or folders"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            {/* `＋ Attach`, the same word the chat composer uses for the same menu — the two
                surfaces sit one keystroke apart, so a control that opens identical entries
                should not be called two different things. */}
            <span className="agent-composer-glyph" aria-hidden>＋</span>
            <span className="agent-composer-btn-label">Attach</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="agent-model-list">
            <button
              type="button"
              className="agent-model-row"
              role="menuitem"
              onClick={() => { onPickFiles(); close(); }}
            >
              <span className="agent-model-row-label">Attach files…</span>
            </button>
            <button
              type="button"
              className="agent-model-row"
              role="menuitem"
              onClick={() => { onPickFolders(); close(); }}
            >
              <span className="agent-model-row-label">Attach folders…</span>
            </button>
          </div>
        )}
      </Popover>

      <span className="agent-composer-sep" aria-hidden>·</span>

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
            <span className="agent-composer-glyph" aria-hidden>✦</span>
            <span className="agent-composer-btn-label">Dreamcontext Skills</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => <SkillBrowser onInsert={onInsert} close={close} />}
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
            // Percentage FIRST, then the raw counts — "how much room is left" is the
            // question the readout exists to answer, and `44k/200k` alone made you do the
            // division yourself. The bar is the same gauge the chat composer draws.
            <span className="agent-composer-stat" data-hot={ctx.pct >= CONTEXT_TIGHT_PCT}>
              <span className="agent-composer-gauge" aria-hidden>
                <span className="agent-composer-gauge-fill" style={{ width: `${ctx.pct}%` }} />
              </span>
              <span className="agent-composer-stat-pct">{ctx.pct}%</span>
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
      {/* The `·` after the readout is its DOM sibling so the ≤420px container query can
          hide both together (an orphan dot otherwise). */}
      {showStats && <span className="agent-composer-sep" aria-hidden>·</span>}

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
            <span className="agent-composer-glyph" aria-hidden>⬡</span>
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

      <span className="agent-composer-sep" aria-hidden>·</span>

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
            <span className="agent-composer-glyph" aria-hidden>▚</span>
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
