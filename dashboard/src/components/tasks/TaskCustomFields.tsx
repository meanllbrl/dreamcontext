import { useEffect, useState } from 'react';
import type { CustomFieldDef, Task } from '../../hooks/useTasks';
import { CustomFieldInput } from './CustomFieldInput';
import './TaskCustomFields.css';

interface TaskCustomFieldsProps {
  defs: CustomFieldDef[];
  values: Task['custom_fields'];
  /** Persist one field (the detail panel PATCHes `{ custom_fields: { key: value } }`). */
  onCommit: (key: string, value: string | number | null) => void;
}

/**
 * Inline editor for the override-declared custom fields on the task detail
 * panel. Holds a local draft (so text/number inputs update smoothly while
 * typing) seeded from the task and re-synced whenever the task changes;
 * commits one field on pick (select/date) or blur (text/number). Renders
 * nothing when the project declares no custom fields.
 */
export function TaskCustomFields({ defs, values, onCommit }: TaskCustomFieldsProps) {
  const [draft, setDraft] = useState<Record<string, string | number | null>>(values ?? {});
  useEffect(() => { setDraft(values ?? {}); }, [values]);

  if (defs.length === 0) return null;

  return (
    <div className="custom-fields">
      <div className="custom-fields-title">Custom Fields</div>
      <div className="custom-fields-grid">
        {defs.map((field) => (
          <label className="custom-field-row" key={field.key}>
            <span className="custom-field-label">
              {field.name}
              {field.required && (
                <span className="custom-field-req" title="Required — must be set on every task">*</span>
              )}
            </span>
            <CustomFieldInput
              field={field}
              value={draft[field.key]}
              onChange={(v) => setDraft((p) => ({ ...p, [field.key]: v }))}
              onCommit={(v) => onCommit(field.key, v)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
