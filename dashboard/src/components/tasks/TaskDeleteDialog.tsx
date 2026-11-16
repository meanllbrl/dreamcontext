import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TaskListItem } from '../../hooks/useTasks';
import { useDeleteTask, useTask } from '../../hooks/useTasks';
import { useI18n } from '../../context/I18nContext';
import { fill } from '../../lib/taskObjection';
import { DELETE_REASON_MAX, afterDeleteTarget, deleteReason, deleteScope } from '../../lib/taskDelete';
import './TaskCreateModal.css';
import './TaskDeleteDialog.css';

/** A remote backend's name as the owner knows it. */
export function remoteLabel(backend: string): string {
  if (backend === 'clickup') return 'ClickUp';
  if (backend === 'github') return 'GitHub';
  return backend;
}

export interface TaskDeleteViewProps {
  name: string;
  isSubtask: boolean;
  subtasks: ReadonlyArray<{ slug: string; name?: string }>;
  /** The remote backend the delete reaches ('clickup'), or null when nothing remote holds the task. */
  remote: string | null;
  reason: string;
  onReason: (v: string) => void;
  pending: boolean;
  /** False until the task's own read has landed (its remote warning depends on it). */
  ready?: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  dialogRef?: React.Ref<HTMLDivElement>;
  reasonRef?: React.Ref<HTMLTextAreaElement>;
}

/**
 * The delete confirmation itself, no hooks: the task's name, every subtask it takes with it
 * ("This task and its 3 subtasks will be deleted"), the remote warning only when the task is on
 * one, an optional "Why?", and Cancel beside a red Delete. The dialog IS the confirmation; no
 * browser `confirm()` (a silent "no" in the desktop app).
 */
export function TaskDeleteView({
  name, isSubtask, subtasks, remote, reason, onReason, pending, ready = true, error, onCancel, onConfirm, dialogRef, reasonRef,
}: TaskDeleteViewProps) {
  const { t } = useI18n();
  const n = subtasks.length;
  const scope = n === 0
    ? t(isSubtask ? 'tasks.delete.scopeSubtask' : 'tasks.delete.scopeOne')
    : fill(t, n === 1 ? 'tasks.delete.scopeWithOne' : 'tasks.delete.scopeWithMany', { n: String(n) });
  return (
    <div className="modal-overlay" onClick={(e) => { e.stopPropagation(); if (!pending) onCancel(); }}>
      <div
        ref={dialogRef}
        className="modal task-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="task-delete-title"
        aria-describedby="task-delete-scope"
        data-testid="task-delete-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title" id="task-delete-title">{fill(t, 'tasks.delete.title', { name })}</h2>
          <button type="button" className="modal-close" onClick={onCancel} disabled={pending} aria-label={t('tasks.delete.cancel')}>&times;</button>
        </div>
        <div className="modal-body task-delete-body">
          <p className="task-delete-scope" id="task-delete-scope" data-testid="task-delete-scope">{scope}</p>
          {n > 0 && (
            <ul className="task-delete-subtasks" data-testid="task-delete-subtasks">
              {subtasks.map((c) => <li key={c.slug}>{c.name || c.slug}</li>)}
            </ul>
          )}
          {remote && (
            <p className="task-delete-remote" data-testid="task-delete-remote">
              {fill(t, remote === 'clickup' ? 'tasks.delete.remoteClickup' : remote === 'github' ? 'tasks.delete.remoteGithub' : 'tasks.delete.remote', { remote: remoteLabel(remote) })}
            </p>
          )}
          <p className="task-delete-undo">{t('tasks.delete.noUndo')}</p>
          <label className="field">
            <span className="field-label">{t('tasks.delete.reasonLabel')} <span className="task-delete-muted">{t('tasks.delete.reasonHint')}</span></span>
            <textarea
              ref={reasonRef}
              className="field-textarea"
              data-testid="task-delete-reason"
              rows={2}
              maxLength={DELETE_REASON_MAX}
              value={reason}
              disabled={pending}
              onChange={(e) => onReason(e.target.value)}
            />
          </label>
          {error && <div className="error-state task-delete-error" role="alert" data-testid="task-delete-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={pending}>{t('tasks.delete.cancel')}</button>
            <button type="button" className="btn task-delete-confirm" data-testid="task-delete-confirm" disabled={pending || !ready} onClick={onConfirm}>
              {pending ? t('tasks.delete.deleting') : t('tasks.delete.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Delete `task` after the owner confirms: `DELETE /api/tasks/:slug`, the CLI's `tasks delete`
 * path (tombstone + the remote deletion on the next sync), subtasks included. On success it calls
 * `onDeleted` with where to go next (the parent, or null for the list); on failure the error
 * stays in the dialog and the task stays where it was.
 */
export function TaskDeleteDialog({ task, allTasks, onClose, onDeleted }: {
  task: Pick<TaskListItem, 'slug' | 'name' | 'parent_task'>;
  allTasks: readonly TaskListItem[];
  onClose: () => void;
  onDeleted: (next: string | null, deleted: string[]) => void;
}) {
  const { t } = useI18n();
  const del = useDeleteTask();
  // The task's own read says whether it is on a remote yet (the list view carries no such field).
  const { data: detail, isError: detailFailed } = useTask(task.slug);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const subtasks = deleteScope(task, allTasks);
  const remote = detail?.remote?.linked ? detail.remote.backend : null;
  const pending = del.isPending;

  useEffect(() => { reasonRef.current?.focus(); }, []);

  // Esc and Tab belong to the dialog (capture phase, before the drawer's own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!pending) onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled])'));
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
  }, [onClose, pending]);

  const confirm = () => {
    if (pending) return;
    setError(null);
    del.mutate(
      { slug: task.slug, reason: deleteReason(reason), children: subtasks.map((c) => c.slug) },
      {
        onSuccess: (res) => onDeleted(afterDeleteTarget(task), res?.deleted ?? [...subtasks.map((c) => c.slug), task.slug]),
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  // To the page body: inside the drawer the overlay would be clipped to the drawer's box.
  return createPortal(
    <TaskDeleteView
      name={task.name || task.slug}
      isSubtask={!!task.parent_task}
      subtasks={subtasks}
      remote={remote}
      reason={reason}
      onReason={setReason}
      pending={pending}
      ready={!!detail || detailFailed}
      error={error ?? (detailFailed ? t('tasks.delete.remoteUnknown') : null)}
      onCancel={onClose}
      onConfirm={confirm}
      dialogRef={dialogRef}
      reasonRef={reasonRef}
    />,
    document.body,
  );
}
