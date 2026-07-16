import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import {
  buildDelegatePrompt, requestDelegateAgent, fitPromptForTransport,
  encodedPromptLen, MAX_PROMPT_ENCODED,
} from '../../lib/delegateAgent';
import { SparkIcon } from '../sleepy/TypeIcons';
import { taskName } from './boardModel';
import './TaskCreateModal.css';

interface DelegateComposerProps {
  task: Task;
  onClose: () => void;
  /** Called after a successful delegate so the board can flash a confirmation toast. */
  onDelegated?: (title: string) => void;
}

/**
 * The prompt-composer modal for "Delegate to Claude". Opens prefilled with the task's
 * title/description/why/user-stories/acceptance-criteria + slug (all editable), plus a
 * bypass-permissions toggle (ON by default — a delegated agent is meant to run
 * autonomously). Submit (⌘↵ / Send) dispatches the delegate event the always-mounted
 * `AgentSurface` listens for; the agent then spawns MINIMIZED as a background corner chip.
 * Esc / Cancel closes without spawning. Reuses the shared modal + field CSS.
 */
export function DelegateComposer({ task, onClose, onDelegated }: DelegateComposerProps) {
  // ONE source for the title: the prompt's "Task:" line and the delegated tab's title both
  // come from this call, so they can't drift.
  const title = taskName(task);
  const [prompt, setPrompt] = useState(() => buildDelegatePrompt(task, title));
  const [bypass, setBypass] = useState(true);
  const [error, setError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the prompt on open, cursor at the START (so the reviewer reads top-down and
  // isn't scrolled to the bottom of a long acceptance-criteria block).
  useEffect(() => {
    const el = textareaRef.current;
    if (el) { el.focus(); el.setSelectionRange(0, 0); el.scrollTop = 0; }
  }, []);

  // Esc closes the whole modal (the field doesn't own Esc here — there's a Cancel button
  // for intent, and Esc-to-dismiss is the expected modal gesture).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const canSend = prompt.trim().length > 0;
  // The prefill is already transport-fitted, but the user can paste past the budget — warn
  // before they send rather than trimming behind their back.
  const willTruncate = encodedPromptLen(prompt.trim()) > MAX_PROMPT_ENCODED;

  const submit = () => {
    if (!canSend) return;
    // Final guard: an over-budget prompt would overflow the WS upgrade request line and the
    // session would die silently with no agent and no output. Never send an unfitted prompt.
    const fitted = fitPromptForTransport(prompt.trim(), task.slug);
    // Report what REALLY happened. The surface gates on its own capabilities snapshot, which
    // can disagree with the one that made this menu item visible — an optimistic "Delegated ✓"
    // could leave the user believing an agent is working overnight when none ever spawned.
    if (!requestDelegateAgent({ title, prompt: fitted, bypass })) {
      setError(
        "Couldn't start the agent — the in-app Claude agent isn't available right now. "
        + 'Check that the Agents surface is enabled in Settings → Agents and that the Claude CLI is installed.',
      );
      return;
    }
    onDelegated?.(title);
    onClose();
  };

  // ⌘↵ / Ctrl+↵ submits from inside the textarea.
  const onTextareaKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ color: 'var(--color-accent)', display: 'inline-flex' }}><SparkIcon size={18} /></span>
            Delegate to Claude
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Cancel">&times;</button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
            Hands <strong style={{ color: 'var(--color-text-secondary)' }}>{title}</strong> to an in-app Claude Code
            agent. It starts <strong style={{ color: 'var(--color-text-secondary)' }}>minimized</strong> in the corner
            and works in the background — click its chip to watch it as a pane.
          </p>
          <label className="field">
            <span className="field-label">Prompt</span>
            <textarea
              ref={textareaRef}
              className="field-textarea"
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); if (error) setError(''); }}
              onKeyDown={onTextareaKeyDown}
              rows={12}
              style={{ minHeight: 240, fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.55 }}
            />
            {willTruncate && (
              <span style={{ fontSize: 11.5, color: 'var(--color-warning)', lineHeight: 1.45, marginTop: 2 }}>
                This prompt is longer than the agent's launch channel allows — the tail will be
                trimmed on send. The agent still reads the full task from its slug, so nothing is lost.
              </span>
            )}
          </label>
          <label
            className="field"
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={bypass}
              onChange={(e) => setBypass(e.target.checked)}
              style={{ marginTop: 2, accentColor: 'var(--color-accent)', cursor: 'pointer' }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="field-label" style={{ color: 'var(--color-text)' }}>Bypass permissions (autonomous)</span>
              <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', lineHeight: 1.45 }}>
                Let the agent act without approval prompts, so it can finish while you're away. Turn off to approve each step.
              </span>
            </span>
          </label>
          {error && (
            <div
              role="alert"
              style={{
                fontSize: 12, lineHeight: 1.5, color: 'var(--color-error)',
                background: 'var(--color-bg-secondary)', border: '1px solid var(--color-error)',
                borderRadius: 'var(--radius-md)', padding: '8px 10px',
              }}
            >
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn--primary" onClick={submit} disabled={!canSend}>
              Delegate <kbd style={{ marginLeft: 6, fontSize: 10.5, opacity: 0.8 }}>⌘↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
