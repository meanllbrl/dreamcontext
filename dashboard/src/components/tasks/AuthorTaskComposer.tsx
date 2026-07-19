import { useEffect, useRef, useState } from 'react';
import { authorTaskWithAgent } from '../../lib/authorTaskAgent';
import { SparkIcon } from '../sleepy/TypeIcons';
import { PRIO_ORDER, STATUS_ORDER, STATUS_META, levelLabel } from './boardModel';
import './TaskCreateModal.css';

interface AuthorTaskComposerProps {
  onClose: () => void;
  /** Fired after a successful spawn so the board can flash a confirmation toast. */
  onStarted?: () => void;
  /** Pre-seed the target column the user authored from (e.g. clicked "+" under a status). */
  initialStatus?: string;
}

/**
 * "Author with agent" composer — the doorway from the New-task button to a task-authoring
 * agent. The user types the rough idea (and optionally the target column / priority); Submit
 * (⌘↵) hands it to a background Claude Code agent via the shared spawn-with-prompt rail (the
 * same `dreamcontext-delegate-agent` event the manual delegate flow uses), which spawns the
 * agent MINIMIZED. The agent interviews for gaps, then writes a properly-speced task via
 * `dreamcontext tasks create`. Esc / Cancel closes without spawning. Reuses the shared modal +
 * field CSS.
 *
 * This is desktop-only: it is rendered only when the board's agent readiness gate passes, so
 * the manual `TaskCreateModal` stays the fallback on web (A6).
 */
export function AuthorTaskComposer({ onClose, onStarted, initialStatus }: AuthorTaskComposerProps) {
  const [idea, setIdea] = useState('');
  const [status, setStatus] = useState(initialStatus && (STATUS_ORDER as readonly string[]).includes(initialStatus) ? initialStatus : '');
  const [priority, setPriority] = useState('');
  const [bypass, setBypass] = useState(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the idea field on open so the user can start typing immediately.
  useEffect(() => { textareaRef.current?.focus(); }, []);

  // Esc closes the modal (the standard modal-dismiss gesture; there's also a Cancel button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const canSend = idea.trim().length > 0 && !sending;

  const submit = () => {
    if (!canSend) return;
    setSending(true);
    void authorTaskWithAgent({ idea, hints: { status, priority }, bypass })
      .then((accepted) => {
        // Report what REALLY happened — the surface gates on its own capabilities snapshot,
        // which can disagree with the one that made this affordance visible. An optimistic
        // "started ✓" could leave the user believing an agent is authoring when none spawned.
        if (!accepted) {
          setError(
            "Couldn't start the agent — the in-app Claude agent isn't available right now. "
            + 'Check that the Agents surface is enabled in Settings → Agents and that the Claude CLI is installed.',
          );
          return;
        }
        onStarted?.();
        onClose();
      })
      .catch((e: unknown) => {
        setError(`Couldn't hand the idea to the agent: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => setSending(false));
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
            Author a task with Claude
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Cancel">&times;</button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
            Describe the idea in plain language. A Claude Code agent starts{' '}
            <strong style={{ color: 'var(--color-text-secondary)' }}>minimized</strong> in the corner, asks any
            follow-ups it needs, and writes a properly-speced task (Why, acceptance criteria, workflow, plan).
            Click its chip to answer questions; the new task appears on the board when it's done.
          </p>
          <label className="field">
            <span className="field-label">Your idea</span>
            <textarea
              ref={textareaRef}
              className="field-textarea"
              value={idea}
              onChange={(e) => { setIdea(e.target.value); if (error) setError(''); }}
              onKeyDown={onTextareaKeyDown}
              rows={7}
              placeholder="e.g. Let users pin a task to the top of its column so it doesn't scroll away…"
              style={{ minHeight: 140, lineHeight: 1.55 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">Column (optional)</span>
              <select className="field-select" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Let the agent decide</option>
                {STATUS_ORDER.map((st) => (
                  <option key={st} value={st}>{STATUS_META[st]?.label ?? st}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">Priority (optional)</span>
              <select className="field-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">Let the agent decide</option>
                {PRIO_ORDER.map((p) => (
                  <option key={p} value={p}>{levelLabel(p)}</option>
                ))}
              </select>
            </label>
          </div>
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
                Let the agent run <code>tasks create</code> / <code>tasks doctor</code> without an approval prompt per command. It still asks you about the task's content.
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
              {sending ? 'Starting…' : <>Author task <kbd style={{ marginLeft: 6, fontSize: 10.5, opacity: 0.8 }}>⌘↵</kbd></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
