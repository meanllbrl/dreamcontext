import { useEffect, useState } from 'react';
import {
  useTaskOverrideDoc,
  useRemoveCustomFieldDef,
  type CustomFieldDef,
} from '../../hooks/useTasks';
import { AddCustomFieldForm } from '../tasks/AddCustomFieldForm';
import './TaskOverrideEditor.css';

/**
 * Settings editor for the project-wide task-format override
 * (`_dream_context/overrides/task.md`). Custom fields are managed through a
 * structured add/edit form (each field can be marked required); the raw
 * markdown — which can also carry a body template — is shown READ-ONLY, since
 * template editing is intentionally not exposed in the dashboard. The override
 * is honored by the CLI, the dashboard, the main agent, and every sub-agent.
 */
export function TaskOverrideEditor() {
  const { data, isLoading } = useTaskOverrideDoc();
  const removeField = useRemoveCustomFieldDef();
  const [raw, setRaw] = useState('');
  const [editing, setEditing] = useState<CustomFieldDef | null>(null);

  useEffect(() => {
    setRaw(data?.raw ?? '');
  }, [data]);

  const warnings = data?.warnings ?? [];
  const fields = data?.customFields ?? [];

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">
        Task Format & Custom Fields
        <span className="settings-beta-badge">BETA</span>
      </h2>
      <p className="settings-field-hint">
        Declare custom fields for this project — they’re written to <code>overrides/task.md</code> (committed
        to git) and apply to everyone: the CLI, the dashboard, the main agent, and sleep agents. Required
        fields must be set on every task. Custom fields sync to ClickUp / GitHub.
      </p>

      <details className="tov-doc">
        <summary>How the format works</summary>
        <div className="tov-doc-body">
          <p>
            <code>_dream_context/overrides/task.md</code> has two parts — YAML frontmatter plus a body.
            With no file, tasks use the shipped defaults (nothing changes).
          </p>
          <p><strong>1. Frontmatter <code>custom_fields:</code></strong> — a list; each field accepts:</p>
          <ul>
            <li><code>name</code> — display name (required).</li>
            <li><code>key</code> — stable id used by the CLI and backend (optional; defaults to the snake_cased name).</li>
            <li><code>type</code> — <code>text</code>, <code>number</code>, <code>select</code>, or <code>date</code>.</li>
            <li><code>required</code> — <code>true</code> to force the agent to set it on every task (default: optional).</li>
            <li><code>options</code> — the allowed values, for a <code>select</code>.</li>
            <li><code>sync</code> — <code>[clickup, github]</code> (both by default): which backend(s) the field syncs to.</li>
            <li><code>prompt</code> — tells the agent how to fill the field; shown in every agent’s briefing.</li>
          </ul>
          <p>
            <strong>2. Body</strong> — your task template (the sections a new task scaffolds with;{' '}
            <code>{'{{WHY}}'}</code> is a placeholder), plus an optional <code>## Agent Instructions</code>{' '}
            section the agents follow when creating a task (it is stripped from the created task). The body is
            edited via git/CLI — the box below is a read-only preview.
          </p>
          <p className="tov-doc-note">
            Values are set with <code>{'tasks field <slug> <key> <value>'}</code> or{' '}
            <code>{'tasks create --field key=value'}</code>, and show up wherever a task is read or listed. A
            malformed field is skipped with a warning — never fatal.
          </p>
        </div>
      </details>

      {fields.length > 0 && (
        <div className="tov-fields">
          {fields.map((f) => (
            <div className="tov-field" key={f.key}>
              <span className="tov-field-name">{f.name}</span>
              <span className={`tov-field-req${f.required ? ' tov-field-req--on' : ''}`}>
                {f.required ? 'required' : 'optional'}
              </span>
              <span className="tov-field-meta">
                id <code>{f.key}</code> · {f.type}
                {f.type === 'select' && f.options?.length ? ` (${f.options.join(', ')})` : ''}
                {` · ${f.sync.join('+') || 'none'}`}
              </span>
              {f.prompt && <span className="tov-field-prompt">“{f.prompt}”</span>}
              <div className="tov-field-actions">
                <button
                  type="button"
                  className="tov-edit"
                  title="Edit field"
                  onClick={() => setEditing(f)}
                >✎</button>
                <button
                  type="button"
                  className="tov-remove"
                  title="Remove field"
                  onClick={() => { if (editing?.key === f.key) setEditing(null); removeField.mutate(f.key); }}
                >×</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing
        ? <AddCustomFieldForm key={editing.key} initial={editing} onClose={() => setEditing(null)} />
        : <AddCustomFieldForm key="add" />}

      {warnings.length > 0 && (
        <ul className="tov-warnings">
          {warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
        </ul>
      )}

      <label className="tov-preview-label">
        Generated <code>overrides/task.md</code> — read-only
      </label>
      <textarea
        className="tov-editor"
        spellCheck={false}
        value={raw}
        readOnly
        placeholder={isLoading ? 'Loading…' : 'No override yet — add a custom field above to create it.'}
        rows={14}
      />
    </section>
  );
}
