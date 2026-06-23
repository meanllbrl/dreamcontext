import { useState } from 'react';
import { useAddCustomFieldDef, type AddCustomFieldInput, type CustomFieldDef } from '../../hooks/useTasks';
import './AddCustomFieldForm.css';

/** Snake_case ascii id from a name (mirrors the server's fieldKey). */
function toKey(name: string): string {
  return name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

type FieldType = 'text' | 'number' | 'select' | 'date';

interface AddCustomFieldFormProps {
  /** When set, the form opens pre-filled to EDIT this field (upsert by its id). */
  initial?: CustomFieldDef | null;
  /** Called after a successful add/save or a cancel — lets the parent dismiss edit mode. */
  onClose?: () => void;
}

/**
 * Defines a PROJECT-WIDE custom field (written to overrides/task.md): a field
 * id, data type, options (for select), the sync targets, and a SYSTEM PROMPT
 * telling Claude how to determine the value. Once added it appears on every
 * task and is surfaced to the main agent + sub-agents. With `initial` set it
 * edits that field instead (the server upserts by id). The raw task-template is
 * intentionally NOT editable here — only structured custom fields are.
 */
export function AddCustomFieldForm({ initial = null, onClose }: AddCustomFieldFormProps) {
  const isEdit = initial !== null;
  const addField = useAddCustomFieldDef();
  const [open, setOpen] = useState(isEdit);
  const [name, setName] = useState(initial?.name ?? '');
  // In edit mode the id is fixed (it keys the upsert), so treat it as user-set.
  const [keyEdited, setKeyEdited] = useState(isEdit);
  const [key, setKey] = useState(initial?.key ?? '');
  const [type, setType] = useState<FieldType>(initial?.type ?? 'text');
  const [optionsInput, setOptionsInput] = useState(initial?.options?.join(', ') ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [required, setRequired] = useState(initial?.required ?? false);
  const [ask, setAsk] = useState(initial?.ask ?? false);
  const [syncClickup, setSyncClickup] = useState(initial ? initial.sync.includes('clickup') : true);
  const [syncGithub, setSyncGithub] = useState(initial ? initial.sync.includes('github') : true);
  const [error, setError] = useState<string | null>(null);

  const effectiveKey = keyEdited ? key : toKey(name);

  const reset = () => {
    setName(''); setKey(''); setKeyEdited(false); setType('text');
    setOptionsInput(''); setPrompt(''); setRequired(false); setAsk(false); setSyncClickup(true); setSyncGithub(true); setError(null);
  };

  const close = () => {
    if (!isEdit) { reset(); setOpen(false); }
    onClose?.();
  };

  const submit = () => {
    if (!name.trim()) { setError('Name is required.'); return; }
    const options = optionsInput.split(',').map(o => o.trim()).filter(Boolean);
    if (type === 'select' && options.length === 0) { setError('A select field needs at least one option.'); return; }
    const sync: Array<'clickup' | 'github'> = [];
    if (syncClickup) sync.push('clickup');
    if (syncGithub) sync.push('github');

    const input: AddCustomFieldInput = {
      name: name.trim(),
      key: effectiveKey || undefined,
      type,
      options: type === 'select' ? options : undefined,
      sync: sync.length > 0 ? sync : undefined,
      prompt: prompt.trim() || undefined,
      required,
      ask,
    };
    addField.mutate(input, {
      onSuccess: () => { if (!isEdit) reset(); setOpen(false); onClose?.(); },
      onError: (e) => setError((e as Error).message),
    });
  };

  if (!open) {
    return (
      <button type="button" className="acf-add-btn" onClick={() => setOpen(true)}>
        + Add custom field
      </button>
    );
  }

  return (
    <div className="acf-form">
      <div className="acf-row">
        <span className="acf-label">Name</span>
        <input
          className="field-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Team"
          autoFocus
        />
      </div>
      <div className="acf-row">
        <span className="acf-label">Field ID</span>
        <input
          className="field-input"
          value={effectiveKey}
          onChange={e => { setKeyEdited(true); setKey(toKey(e.target.value)); }}
          placeholder="auto from name"
          disabled={isEdit}
          title={isEdit ? "A field's id can't change — remove and re-add to rename it." : undefined}
        />
      </div>
      <div className="acf-row">
        <span className="acf-label">Type</span>
        <select className="field-select" value={type} onChange={e => setType(e.target.value as FieldType)}>
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="select">select</option>
          <option value="date">date</option>
        </select>
      </div>
      <div className="acf-row">
        <span className="acf-label">Requirement</span>
        <label className="acf-check">
          <input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} />
          {' '}Required — Claude must set this on every task
        </label>
      </div>
      <div className="acf-row">
        <span className="acf-label">Source</span>
        <label className="acf-check">
          <input type="checkbox" checked={ask} onChange={e => setAsk(e.target.checked)} />
          {' '}Ask me — Claude asks you for this value when creating a task instead of guessing
        </label>
      </div>
      {type === 'select' && (
        <div className="acf-row">
          <span className="acf-label">Options</span>
          <input
            className="field-input"
            value={optionsInput}
            onChange={e => setOptionsInput(e.target.value)}
            placeholder="comma,separated,values"
          />
        </div>
      )}
      <div className="acf-row acf-row--top">
        <span className="acf-label">System prompt</span>
        <textarea
          className="field-textarea"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="How should Claude determine this field's value? e.g. 'Set to the owning squad based on the touched files.'"
          rows={3}
        />
      </div>
      <div className="acf-row">
        <span className="acf-label">Sync to</span>
        <div className="acf-sync">
          <label className="acf-check"><input type="checkbox" checked={syncClickup} onChange={e => setSyncClickup(e.target.checked)} /> ClickUp</label>
          <label className="acf-check"><input type="checkbox" checked={syncGithub} onChange={e => setSyncGithub(e.target.checked)} /> GitHub</label>
        </div>
      </div>
      {error && <div className="acf-error">{error}</div>}
      <div className="acf-actions">
        <button type="button" className="btn btn--ghost" onClick={close}>Cancel</button>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={addField.isPending || !name.trim()}>
          {addField.isPending ? '...' : isEdit ? 'Save changes' : 'Add field'}
        </button>
      </div>
    </div>
  );
}
