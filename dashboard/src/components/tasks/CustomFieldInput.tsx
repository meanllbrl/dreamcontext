import type { CustomFieldDef } from '../../hooks/useTasks';

interface CustomFieldInputProps {
  field: CustomFieldDef;
  value: string | number | null | undefined;
  /** Live change (updates the parent's draft as the user types/picks). */
  onChange: (value: string | number | null) => void;
  /**
   * Commit the value for persistence. Fires immediately for select/date (on
   * pick) and on blur for text/number. Receives the value to commit, so the
   * parent never has to read stale draft state.
   */
  onCommit?: (value: string | number | null) => void;
  className?: string;
}

/**
 * A single override-declared custom field rendered as the right input for its
 * type: select → native dropdown of its options; number → number input; date →
 * date picker; text → text input. Pure presentational — the parent owns state
 * and persistence. Shared by the create modal and the task detail panel.
 */
export function CustomFieldInput({ field, value, onChange, onCommit, className }: CustomFieldInputProps) {
  const cls = className ?? 'field-input';
  const str = value === null || value === undefined ? '' : String(value);

  if (field.type === 'select') {
    return (
      <select
        className="field-select"
        value={str}
        onChange={(e) => { const v = e.target.value || null; onChange(v); onCommit?.(v); }}
      >
        <option value="">—</option>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }

  if (field.type === 'number') {
    return (
      <input
        className={cls}
        type="number"
        value={str}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        onBlur={() => onCommit?.(value ?? null)}
      />
    );
  }

  if (field.type === 'date') {
    return (
      <input
        className={cls}
        type="date"
        value={str}
        onChange={(e) => { const v = e.target.value || null; onChange(v); onCommit?.(v); }}
      />
    );
  }

  return (
    <input
      className={cls}
      type="text"
      value={str}
      onChange={(e) => onChange(e.target.value || null)}
      onBlur={() => onCommit?.(value ?? null)}
    />
  );
}
