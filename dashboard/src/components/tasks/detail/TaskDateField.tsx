import { useState } from 'react';
import { TaskField, EmptyField } from './TaskSection';

/**
 * A nullable date, under the shared field contract. Three DISTINCT states:
 *
 *  - **never set** → the dashed "＋ Add" affordance (clicking reveals the input; it never writes
 *    today's date by itself, which would be a worse lie than an empty field);
 *  - **set** → the input, with the same × clear every field uses;
 *  - **undated by rule** (a `backlog` tag) → says so, names the tag as the cause, and offers to
 *    remove it.
 */
export function TaskDateField(
  { label, value, backlog, onChange, onRemoveBacklog }:
  {
    label: string;
    value: string | null | undefined;
    backlog: boolean;
    onChange: (v: string) => void;
    onRemoveBacklog: () => void;
  },
) {
  const [revealed, setRevealed] = useState(false);
  const id = `tf-date-${label.toLowerCase()}`;

  if (backlog) {
    return (
      <TaskField label={label}>
        <span className="prop-backlog">
          <span className="prop-backlog-text">Undated — this task is <code>backlog</code></span>
          <button type="button" className="prop-backlog-clear" onClick={onRemoveBacklog}>
            Remove tag to schedule
          </button>
        </span>
      </TaskField>
    );
  }

  if (!value && !revealed) {
    return (
      <TaskField label={label}>
        <EmptyField label={`Add ${label.toLowerCase()} date`} onClick={() => setRevealed(true)} />
      </TaskField>
    );
  }

  return (
    <TaskField label={label} htmlFor={id}>
      <span className="prop-date-edit">
        <input
          id={id}
          type="date"
          className="field-select prop-select"
          autoFocus={revealed && !value}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
        {value && (
          <button
            type="button"
            className="prop-clear"
            aria-label={`Clear ${label.toLowerCase()} date`}
            title="Clear"
            onClick={() => { onChange(''); setRevealed(false); }}
          >
            ×
          </button>
        )}
      </span>
    </TaskField>
  );
}
