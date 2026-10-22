import { useState } from 'react';
import type { Task } from '../../../hooks/useTasks';
import { useCreateTask, useStatusModel } from '../../../hooks/useTasks';
import { criteriaCount, subtaskProgress, taskName } from '../boardModel';

/**
 * The drawer's Subtasks section: a progress bar (done / not-cancelled), one row per child
 * (status, name, criteria count; click opens it) and "+ Add subtask" (Enter creates it under
 * this task: it inherits version and feature; Esc cancels; an empty name is ignored).
 */
export function SubtasksSection({ task, children, onOpen }: { task: Task; children: Task[]; onOpen: (slug: string) => void }) {
  const sm = useStatusModel();
  const create = useCreateTask();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const prog = subtaskProgress(children, sm);
  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;

  const submit = () => {
    const nm = name.trim();
    if (!nm || create.isPending) return;
    setError(null);
    create.mutate(
      { name: nm, description: '', priority: task.priority, parent_task: task.slug },
      { onSuccess: () => setName(''), onError: (err) => setError(err instanceof Error ? err.message : 'Could not add the subtask.') },
    );
  };

  return (
    <section className="dsec" data-section="subtasks">
      <div className="dsec-head">
        <h3 className="dsec-title">Subtasks</h3>
        <span className="dsec-count">{prog.done}/{prog.total}</span>
        <span className="dsub-bar" aria-hidden><span style={{ width: `${pct}%` }} /></span>
      </div>
      <div className="dsub-list">
        {children.map((c) => {
          const crit = criteriaCount(c);
          const done = sm.isDone(c.status);
          return (
            <button key={c.slug} type="button" className="dsub-row" data-done={done || undefined} onClick={() => onOpen(c.slug)}>
              <span className="dsub-dot" style={{ background: sm.colorOf(c.status) }} aria-hidden />
              <span className="dsub-name">{taskName(c)}</span>
              <span className="dsub-status">{sm.labelOf(c.status)}</span>
              <span className="dsub-crit">{crit.total ? `${crit.done}/${crit.total}` : ''}</span>
            </button>
          );
        })}
        {adding ? (
          <div className="dsub-input">
            <input
              autoFocus
              value={name}
              placeholder="Subtask name"
              aria-label="New subtask name"
              onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(false); setName(''); setError(null); }
              }}
            />
            <kbd>Enter</kbd>
          </div>
        ) : (
          <button type="button" className="dsub-add" data-testid="detail-add-subtask" onClick={() => setAdding(true)}>+ Add subtask</button>
        )}
        {error && <div className="prop-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
