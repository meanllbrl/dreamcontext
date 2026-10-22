import { useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useCreateTask, useStatusModel } from '../../hooks/useTasks';
import { taskName } from './boardModel';

/**
 * The thin subtask list that opens under a parent card's `n/m` chip: one line per child (status
 * dot + name, click opens the child) and "+ Add subtask". Enter creates the child under this
 * parent (it inherits the parent's version and feature server-side), Esc closes the input, an
 * empty name is ignored, a refusal is shown in place.
 */
export function BoardSubtasks({ parent, children, onOpen }: {
  parent: Task;
  children: Task[];
  onOpen: (t: Task) => void;
}) {
  const sm = useStatusModel();
  const create = useCreateTask();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const nm = name.trim();
    if (!nm || create.isPending) return;
    setError(null);
    create.mutate(
      { name: nm, description: '', priority: parent.priority, parent_task: parent.slug },
      {
        onSuccess: () => { setName(''); },
        onError: (err) => setError(err instanceof Error ? err.message : 'Could not add the subtask.'),
      },
    );
  };

  // Clicks inside the list must not reach the card (which opens the parent's detail).
  return (
    <div className="bd-subs" onClick={(e) => e.stopPropagation()} data-testid="board-subtasks">
      {children.map((c) => (
        <button
          key={c.slug}
          type="button"
          className="bd-btnreset bd-sub-row"
          data-done={sm.isDone(c.status) || undefined}
          onClick={() => onOpen(c)}
          title={`${taskName(c)} · ${sm.labelOf(c.status)}`}
        >
          <span className="bd-sub-dot" style={{ background: sm.colorOf(c.status) }} aria-hidden />
          <span className="bd-sub-name">{taskName(c)}</span>
        </button>
      ))}
      {adding ? (
        <div className="bd-sub-input">
          <span className="bd-sub-dot" style={{ background: sm.colorOf(sm.order[0] ?? 'todo') }} aria-hidden />
          <input
            autoFocus
            value={name}
            placeholder="Subtask name"
            aria-label={`New subtask of ${taskName(parent)}`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAdding(false); setName(''); setError(null); }
            }}
          />
          <kbd>Enter</kbd>
        </div>
      ) : (
        <button type="button" className="bd-btnreset bd-sub-add" onClick={() => setAdding(true)}>+ Add subtask</button>
      )}
      {error && <div className="bd-sub-error" role="alert">{error}</div>}
    </div>
  );
}
