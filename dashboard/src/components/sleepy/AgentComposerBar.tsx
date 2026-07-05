import { useEffect, useRef, useState } from 'react';
import {
  MODEL_OPTIONS, THINKING_EFFORTS, SKILL_GROUPS,
  modelById, type ComposerPrefs, type AgentProvider, type ThinkingEffortId,
} from '../../lib/agentComposer';

/**
 * The thin composer strip pinned to the bottom of the expanded Agent overlay. Three jobs,
 * one row:
 *   • 📎 Files  — native multi-select picker; the chosen absolute paths are appended to
 *                 the field (real OS paths in the desktop app).
 *   • ✦ Skills  — a popover of our signature capabilities (Multi-review · Goal · Excalidraw
 *                 · Council); picking one appends its trigger to the field.
 *   • model ▾ / effort ▾ / ➤ — pick the model + thinking effort for the NEXT session, then
 *                 send the composed field to the focused session (or a fresh one).
 *
 * Purely presentational + a self-contained popover: all state and the actual PTY
 * injection live in {@link AgentSurface}, handed in as callbacks.
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
  value, onChange, onInsert, onPickFiles, onSend, prefs, onPrefsChange, canSend,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Append a snippet (a skill trigger) to the field. */
  onInsert: (snippet: string) => void;
  /** Open the native multi-file picker and append the chosen paths. */
  onPickFiles: () => void;
  /** Submit the composed field to the focused/new session. */
  onSend: () => void;
  prefs: ComposerPrefs;
  onPrefsChange: (p: ComposerPrefs) => void;
  /** There's something to send (non-empty field) AND a session can receive it. */
  canSend: boolean;
}) {
  const model = modelById(prefs.modelId);
  const effort = THINKING_EFFORTS.find((e) => e.id === prefs.effort) ?? THINKING_EFFORTS[0];
  const providers: AgentProvider[] = ['claude', 'codex'];

  const setModel = (id: string, provider: AgentProvider) => onPrefsChange({ ...prefs, modelId: id, provider });
  const setEffort = (id: ThinkingEffortId) => onPrefsChange({ ...prefs, effort: id });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter sends; Shift+Enter is a no-op here (the field is one line — a real multi-line
    // prompt belongs in the terminal itself, so we keep the strip a single line).
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  };

  return (
    <div className="agent-composer">
      {/* Files */}
      <button
        type="button"
        className="agent-composer-btn"
        title="Attach files (multi-select)"
        aria-label="Attach files"
        onClick={onPickFiles}
      >
        <span aria-hidden>📎</span>
        <span className="agent-composer-btn-label">Files</span>
      </button>

      {/* Skills */}
      <Popover
        align="left"
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-btn${open ? ' open' : ''}`}
            title="Insert one of our skills"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <span aria-hidden>✦</span>
            <span className="agent-composer-btn-label">Skills</span>
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

      {/* The field — the "text field" our skills/files write into. */}
      <input
        className="agent-composer-input"
        type="text"
        value={value}
        placeholder="Message the agent — or add files / skills, then ↵"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Agent message"
      />

      {/* Model */}
      <Popover
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-select${open ? ' open' : ''}`}
            title="Model for the next session"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <span aria-hidden>◆</span>
            <span className="agent-composer-select-label">{model.label}</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="agent-model-list">
            {providers.map((provider) => {
              const rows = MODEL_OPTIONS.filter((m) => m.provider === provider);
              if (!rows.length) return null;
              return (
                <div className="agent-model-provider" key={provider}>
                  <span className="agent-model-provider-label">{provider === 'claude' ? 'Claude' : 'Codex'}</span>
                  {rows.map((m) => (
                    <button
                      key={m.provider + m.id}
                      type="button"
                      className={`agent-model-row${m.id === prefs.modelId && m.provider === prefs.provider ? ' on' : ''}`}
                      role="menuitemradio"
                      aria-checked={m.id === prefs.modelId && m.provider === prefs.provider}
                      disabled={!m.available}
                      onClick={() => { if (m.available) { setModel(m.id, m.provider); close(); } }}
                    >
                      <span className="agent-model-row-label">{m.label}</span>
                      {m.tag && <span className="agent-model-row-tag">{m.tag}</span>}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </Popover>

      {/* Thinking effort */}
      <Popover
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`agent-composer-select${open ? ' open' : ''}`}
            title="Thinking effort for the next prompt"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <span aria-hidden>◈</span>
            <span className="agent-composer-select-label">{effort.id === 'off' ? 'Effort' : effort.label}</span>
            <span className="agent-composer-caret" aria-hidden>▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="agent-model-list">
            {THINKING_EFFORTS.map((e) => (
              <button
                key={e.id}
                type="button"
                className={`agent-model-row${e.id === prefs.effort ? ' on' : ''}`}
                role="menuitemradio"
                aria-checked={e.id === prefs.effort}
                onClick={() => { setEffort(e.id); close(); }}
              >
                <span className="agent-model-row-label">{e.id === 'off' ? 'Off' : e.label}</span>
              </button>
            ))}
          </div>
        )}
      </Popover>

      {/* Send */}
      <button
        type="button"
        className="agent-composer-send"
        title="Send to the agent (↵)"
        aria-label="Send"
        disabled={!canSend}
        onClick={onSend}
      >➤</button>
    </div>
  );
}
