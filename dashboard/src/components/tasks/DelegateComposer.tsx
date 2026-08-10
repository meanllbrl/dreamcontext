import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { useVault } from '../../context/VaultContext';
import { delegateTaskToAgent } from '../../lib/delegateAgent';
import {
  DELEGATE_MODES, DEFAULT_DELEGATE_MODE, delegateMode, delegateTitle,
  type DelegateMode, type DelegateModeId,
} from '../../lib/delegateModes';
import { SparkIcon } from '../sleepy/TypeIcons';
import { taskName } from './boardModel';
import './TaskCreateModal.css';

interface DelegateComposerProps {
  task: Task;
  onClose: () => void;
  /** Called after a successful delegate so the board can flash a confirmation toast. */
  onDelegated?: (title: string) => void;
  /** Open the Agents overlay on the new session instead of backgrounding it as a corner chip.
   *  See {@link DelegateAgentDetail.reveal} for when each is right. A mode can force this on
   *  (Discuss), but never off — a call site that asked to watch always gets to watch. */
  reveal?: boolean;
}

/** What a mode switch replaced, so an edited prompt is recoverable rather than gone. */
interface Replaced { mode: DelegateModeId; prompt: string; bypass: boolean; }

/**
 * The prompt-composer modal for "Delegate to Claude". Opens on a MODE — Autonomous / Discuss /
 * Is it done? / Summarize (lib/delegateModes.ts) — each of which drafts its own prompt from the
 * task (title/description/why/user-stories/acceptance-criteria + slug, all editable), sets the
 * bypass-permissions toggle to what that job needs, and titles the session so several chips for
 * one task stay tellable apart. A model picker rides alongside; leaving it on the CLI default
 * sends nothing, so the agent inherits whatever the user's own default is.
 *
 * Submit (⌘↵ / Send) dispatches the delegate event the always-mounted `AgentSurface` listens
 * for; the agent spawns MINIMIZED as a background corner chip, or revealed as a pane when the
 * call site or the mode asks for it. Esc / Cancel closes without spawning. Reuses the shared
 * modal + field CSS.
 */
export function DelegateComposer({ task, onClose, onDelegated, reveal }: DelegateComposerProps) {
  // The board this composer was opened from names the project the task belongs to — the prompt
  // token has to be minted against THAT project, not against whichever chip is active.
  const { vault, bus } = useVault();
  // ONE source for the title: the prompt's "Task:" line and the delegated tab's title both
  // come from this call, so they can't drift.
  const title = taskName(task);
  const [modeId, setModeId] = useState<DelegateModeId>(DEFAULT_DELEGATE_MODE);
  const mode = delegateMode(modeId);
  const [prompt, setPrompt] = useState(() => delegateMode(DEFAULT_DELEGATE_MODE).build(task, title));
  const [bypass, setBypass] = useState(mode.bypass);
  const [replaced, setReplaced] = useState<Replaced | null>(null);
  const [error, setError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The models the CLI actually offers + the user's live default (same query the agent
  // composer strip uses). `placeholderData` means this is never undefined — which is exactly
  // why an untouched picker sends NOTHING (see `model` below): the placeholder's "default" is
  // a guess, and pinning a delegated agent to a guess is worse than inheriting the real one.
  const modelConfig = useAgentModelConfig().data;
  const [model, setModel] = useState('');
  const shownModel = model || modelConfig?.defaultModel || '';

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

  const [sending, setSending] = useState(false);
  const canSend = prompt.trim().length > 0 && !sending;

  /**
   * Switch mode: redraft the prompt and re-arm the toggle for the new job.
   *
   * Switching is the primary gesture here, so it stays instant — no confirm dialog standing
   * between the user and the mode they wanted. But a prompt they had already edited is real
   * work, so when the outgoing draft is no longer the pristine one we stash it and offer a
   * one-click Restore (which brings the mode and the toggle back with it — restoring the text
   * alone would leave an Autonomous brief sitting under the Discuss chip).
   */
  const pickMode = (next: DelegateMode) => {
    if (next.id === modeId) return;
    const pristine = delegateMode(modeId).build(task, title);
    setReplaced(prompt !== pristine ? { mode: modeId, prompt, bypass } : null);
    setModeId(next.id);
    setPrompt(next.build(task, title));
    setBypass(next.bypass);
    if (error) setError('');
  };

  const restoreReplaced = () => {
    if (!replaced) return;
    setModeId(replaced.mode);
    setPrompt(replaced.prompt);
    setBypass(replaced.bypass);
    setReplaced(null);
  };

  const submit = () => {
    if (!canSend) return;
    setSending(true);
    // Hand the prompt over WHOLE — `delegateTaskToAgent` picks a transport that can carry it
    // (inline for a short prompt, a POSTed token for a long one), so what is shown above is
    // exactly what the agent receives. Nothing is trimmed behind the user's back.
    void delegateTaskToAgent(bus, vault, {
      title: delegateTitle(mode, title),
      prompt,
      bypass,
      model,
      // The mode can only ever ADD reveal: Discuss is a conversation and a conversation in a
      // corner chip is one nobody has. A call site that already asked to watch (the full-page
      // task view) keeps watching in every mode.
      reveal: reveal || mode.reveal === true,
    })
      .then((accepted) => {
        // Report what REALLY happened. The surface gates on its own capabilities snapshot,
        // which can disagree with the one that made this menu item visible — an optimistic
        // "Delegated ✓" could leave the user believing an agent is working overnight when
        // none ever spawned.
        if (!accepted) {
          setError(
            "Couldn't start the agent — the in-app Claude agent isn't available right now. "
            + 'Check that the Agents surface is enabled in Settings → Agents and that the Claude CLI is installed.',
          );
          return;
        }
        onDelegated?.(delegateTitle(mode, title));
        onClose();
      })
      .catch((e: unknown) => {
        // The prompt hand-off itself failed (server refused the token). Say so and keep the
        // modal open with the text intact, rather than sending a silently shortened brief.
        setError(`Couldn't hand the prompt to the agent: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => setSending(false));
  };

  // ⌘↵ / Ctrl+↵ submits from inside the textarea.
  const onTextareaKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  const watching = reveal || mode.reveal === true;

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
            agent.{' '}
            {watching
              ? <>It opens in <strong style={{ color: 'var(--color-text-secondary)' }}>Agents</strong> so you can watch it work.</>
              : <>It starts <strong style={{ color: 'var(--color-text-secondary)' }}>minimized</strong> in the corner
                 and works in the background — click its chip to watch it as a pane.</>}
          </p>

          {/* Mode picker — what you want FROM the task, which decides the draft below, the
              permission default, and where the session lands. */}
          <div className="field">
            <span className="field-label">What should it do?</span>
            <div role="radiogroup" aria-label="Delegation mode" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {DELEGATE_MODES.map((m) => {
                const active = m.id === modeId;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => pickMode(m)}
                    style={{
                      appearance: 'none', cursor: 'pointer', borderRadius: 999,
                      padding: '5px 11px', fontSize: 12.5, lineHeight: 1.3,
                      fontWeight: active ? 600 : 500,
                      border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                      background: active ? 'color-mix(in srgb, var(--color-accent) 16%, transparent)' : 'transparent',
                      color: active ? 'var(--color-text)' : 'var(--color-text-tertiary)',
                      transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
                    }}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', lineHeight: 1.45, marginTop: 6 }}>
              {mode.hint}
            </span>
          </div>

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
          </label>

          {/* An edited prompt was just swapped out by a mode switch — say so, and offer it back.
              Silently discarding someone's typing is the one thing the switch must never do. */}
          {replaced && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: -4 }}>
              <span>Your edited prompt was replaced.</span>
              <button
                type="button"
                onClick={restoreReplaced}
                style={{
                  appearance: 'none', border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  color: 'var(--color-accent)', fontSize: 11.5, fontWeight: 600, textDecoration: 'underline',
                }}
              >
                Restore it
              </button>
            </div>
          )}

          {/* Model — the pick travels only if the user makes one; otherwise the agent inherits
              the CLI default (shown here so the row is never blank about what will run). */}
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <span className="field-label" style={{ margin: 0, flex: '0 0 auto' }}>Model</span>
            <select
              className="field-select"
              value={shownModel}
              onChange={(e) => setModel(e.target.value)}
              style={{ flex: 1, cursor: 'pointer' }}
            >
              {(modelConfig?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.id === modelConfig?.defaultModel ? ' (default)' : ''}
                </option>
              ))}
              {/* The user's default isn't always in the offered list (a CLI id we don't know) —
                  keep it selectable rather than silently snapping the picker to another model. */}
              {shownModel && !(modelConfig?.models ?? []).some((m) => m.id === shownModel) && (
                <option value={shownModel}>{shownModel}</option>
              )}
            </select>
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
              {sending ? 'Delegating…' : <>Delegate <kbd style={{ marginLeft: 6, fontSize: 10.5, opacity: 0.8 }}>⌘↵</kbd></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
