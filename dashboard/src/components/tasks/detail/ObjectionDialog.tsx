import { useEffect, useMemo, useRef, useState } from 'react';
import type { ObjectionKind, Task } from '../../../hooks/useTasks';
import { MIN_OBJECTION_NOTE_CHARS, OBJECTION_TARGETED, useObjectToTask, useStatusModel } from '../../../hooks/useTasks';
import { useI18n } from '../../../context/I18nContext';
import { OBJECTION_KINDS, fill, objectionConfirmLabel, objectionPreview, objectionTargets } from '../../../lib/taskObjection';
import '../TaskCreateModal.css';
import './ObjectionDialog.css';

/**
 * "Object to this task" (approved draft 2): what the task should have been, the task it belongs
 * to when the kind points at one, a required sentence sleep learns from, a preview of what
 * happens, and ONE confirm that applies it (`POST /api/tasks/:slug/objection`). No browser
 * `confirm()`: the dialog is the confirmation. A refusal is shown in place.
 *
 * The target list is open tasks only; for "sub-task of" only tasks that are not sub-tasks
 * themselves (two levels max). The server checks every rule again.
 */
export function ObjectionDialog({ task, allTasks, onClose }: { task: Task; allTasks: Task[]; onClose: () => void }) {
  const { t } = useI18n();
  const sm = useStatusModel();
  const object = useObjectToTask();
  const [as, setAs] = useState<ObjectionKind>('subtask-of');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  // Esc and Tab belong to the dialog wherever focus is. On `window` in the CAPTURE phase, so
  // this runs before the drawer's own Esc listener (which would close the drawer and lose the
  // typed reason), and Tab cycles inside the dialog instead of walking into the drawer behind.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && dialogRef.current.contains(active);
      if (e.shiftKey && (!inside || active === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || active === last)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const targets = useMemo(() => objectionTargets(task, allTasks, as, sm.isTerminal), [allTasks, task, sm, as]);

  const needsTarget = OBJECTION_TARGETED.has(as);
  // A target that is no longer offered (the kind changed) is dropped, never sent.
  const chosen = needsTarget ? targets.find((x) => x.slug === target) ?? null : null;
  const noteOk = note.trim().length >= MIN_OBJECTION_NOTE_CHARS;
  const ready = noteOk && (!needsTarget || chosen !== null);

  const preview = objectionPreview(t, as, chosen ? chosen.name || chosen.slug : null, needsTarget);
  const confirmLabel = objectionConfirmLabel(t, as);

  const submit = () => {
    if (!ready || object.isPending) return;
    setError(null);
    object.mutate(
      { slug: task.slug, as, target: chosen?.slug ?? null, note: note.trim() },
      { onSuccess: () => onClose(), onError: (err) => setError(err.message) },
    );
  };

  return (
    <div className="modal-overlay" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div
        ref={dialogRef}
        className="modal objection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="objection-title"
        data-testid="objection-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="objection-head">
            <h2 className="modal-title" id="objection-title">{t('tasks.objection.title')}</h2>
            <p className="objection-sub">{t('tasks.objection.subtitle')}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('tasks.objection.cancel')}>&times;</button>
        </div>
        <div className="modal-body objection-body">
          <div className="objection-options" role="radiogroup" aria-labelledby="objection-title">
            {OBJECTION_KINDS.map((k, i) => (
              <div key={k} className={`objection-option ${as === k ? 'objection-option--on' : ''}`}>
                <label className="objection-option-label">
                  <input
                    ref={i === 0 ? firstRef : undefined}
                    type="radio"
                    name="objection-kind"
                    value={k}
                    checked={as === k}
                    onChange={() => setAs(k)}
                  />
                  <span>{t(`tasks.objection.as.${k}`)}</span>
                </label>
                {as === k && OBJECTION_TARGETED.has(k) && (
                  targets.length === 0 ? (
                    <p className="objection-muted">{t('tasks.objection.noOpenTasks')}</p>
                  ) : (
                    <select
                      className="field-select objection-target"
                      aria-label={t('tasks.objection.pickTarget')}
                      data-testid="objection-target"
                      value={chosen?.slug ?? ''}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      <option value="" disabled>{t('tasks.objection.pickTarget')}</option>
                      {targets.map((x) => <option key={x.slug} value={x.slug}>{x.name || x.slug}</option>)}
                    </select>
                  )
                )}
              </div>
            ))}
          </div>

          <label className="field">
            <span className="field-label">
              {t('tasks.objection.noteLabel')} <span className="objection-muted">{t('tasks.objection.noteHint')}</span>
            </span>
            <textarea
              className="field-textarea objection-note"
              data-testid="objection-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={note.length > 0 && !noteOk}
            />
            {note.length > 0 && !noteOk && (
              <span className="objection-muted">{fill(t, 'tasks.objection.noteShort', { n: String(MIN_OBJECTION_NOTE_CHARS) })}</span>
            )}
          </label>

          <div className="objection-preview" aria-live="polite">
            <strong>{t('tasks.objection.previewLabel')}</strong> {preview}
          </div>

          {error && <div className="error-state objection-error" role="alert">{error}</div>}

          <div className="modal-actions objection-actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>{t('tasks.objection.cancel')}</button>
            <button type="button" className="btn btn--primary" data-testid="objection-confirm" disabled={!ready || object.isPending} onClick={submit}>
              {object.isPending ? t('tasks.objection.saving') : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
