import { useEffect, useMemo, useState } from 'react';
import {
  useTaskOverrideDoc,
  useRemoveCustomFieldDef,
  useAddStatusDef,
  useRemoveStatusDef,
  type CustomFieldDef,
  type StatusDef,
} from '../../hooks/useTasks';
import { AddCustomFieldForm } from '../tasks/AddCustomFieldForm';
import { AddStatusForm } from '../tasks/AddStatusForm';
import { buildStatusModel, DEFAULT_STATUSES, SHIPPED_STATUS_KEYS, parentOf } from '../../lib/statusModel';
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
  const removeStatus = useRemoveStatusDef();
  const reorderStatus = useAddStatusDef();
  const [raw, setRaw] = useState('');
  const [editing, setEditing] = useState<CustomFieldDef | null>(null);
  const [editingStatus, setEditingStatus] = useState<StatusDef | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    setRaw(data?.raw ?? '');
  }, [data]);

  const warnings = data?.warnings ?? [];
  const fields = data?.customFields ?? [];
  const statuses = useMemo(() => buildStatusModel(data?.statuses ?? DEFAULT_STATUSES).defs, [data?.statuses]);
  const shippedKeys = data?.shippedStatusKeys ?? SHIPPED_STATUS_KEYS;
  const model = useMemo(() => buildStatusModel(statuses), [statuses]);

  /**
   * Move a status one slot up/down by swapping `order` with its neighbour. Both
   * rows are written (a shipped key only gets its order rewritten — kind stays).
   */
  /** Any status write in flight — every row action is gated on it (no double-fire). */
  const busy = reorderStatus.isPending || removeStatus.isPending;

  /**
   * Move a status one slot up/down by swapping `order` with its neighbour.
   *
   * The swap is TWO writes (the file holds one entry per status), so the second
   * runs in the first's `onSuccess` and MUST report its own failure: without an
   * `onError` there, a failed second write leaves a HALF-APPLIED swap — one
   * status moved, the other not — and the user sees a silent no-op. `busy` also
   * gates the buttons so a second click cannot race the in-flight pair against a
   * stale `statuses` snapshot.
   */
  const move = (idx: number, dir: -1 | 1) => {
    const a = statuses[idx];
    const b = statuses[idx + dir];
    if (!a || !b || busy) return;
    // Equal orders (declaration-order tie) need a real gap to swap: nudge by 1.
    const orderA = a.order === b.order ? b.order + (dir === 1 ? 1 : -1) : b.order;
    const orderB = a.order;
    const payload = (d: StatusDef, order: number) => ({
      name: d.label, key: d.key, order, color: d.color, remoteAliases: d.clickup,
      ...(shippedKeys.includes(d.key) ? {} : { kind: d.kind, parent: parentOf(d) }),
    });
    const failed = (e: unknown, which: string) =>
      setStatusError(`Reorder ${which}: ${(e as Error).message} — the order may be half-applied; reload Settings.`);
    setStatusError(null);
    reorderStatus.mutate(payload(a, orderA), {
      onSuccess: () => reorderStatus.mutate(payload(b, orderB), { onError: (e) => failed(e, 'second write failed') }),
      onError: (e) => failed(e, 'first write failed'),
    });
  };

  const onRemoveStatus = (key: string) => {
    setStatusError(null);
    if (editingStatus?.key === key) setEditingStatus(null);
    removeStatus.mutate(key, {
      // 409 while tasks still carry the status — the server names the count.
      onError: (e) => setStatusError((e as Error).message),
    });
  };

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
                  aria-label={`Edit field ${f.name}`}
                  onClick={() => setEditing(f)}
                >✎</button>
                <button
                  type="button"
                  className="tov-remove"
                  title="Remove field"
                  aria-label={`Remove field ${f.name}`}
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

      <h3 className="tov-subtitle">Statuses</h3>
      <p className="settings-field-hint">
        The four shipped statuses are locked (rename, reorder or recolour them, never remove or re-kind them).
        Add your own — <em>Planned</em>, <em>Cancelled</em>, anything — <strong>under one of the four</strong>,
        with a <strong>kind</strong> that tells every surface how to treat it: a <code>cancelled</code>-kind task
        leaves progress counts and is never overdue; an <code>active</code>-kind one stamps the start date.{' '}
        <strong>Cloud sync only ever sees the parent</strong>, so nothing has to be created on GitHub or ClickUp —
        the child rides beside it as its <code>dc:&lt;key&gt;</code> label/tag and round-trips.
      </p>

      <div className="tov-preview" aria-label="Board column preview" data-testid="status-preview">
        {model.order.map((k) => (
          <div key={k} className={`tov-col${model.isTerminal(k) ? ' tov-col--terminal' : ''}`}>
            <span className="tov-status-swatch" style={{ background: model.colorOf(k) }} />
            <span className="tov-col-label">{model.labelOf(k)}</span>
            <span className="tov-col-kind">{model.kindOf(k)}</span>
          </div>
        ))}
      </div>

      <div className="tov-fields" data-testid="status-list">
        {statuses.map((st, idx) => {
          const locked = shippedKeys.includes(st.key);
          return (
            <div className="tov-field" key={st.key}>
              <span className="tov-status-swatch" style={{ background: model.colorOf(st.key) }} />
              <span className="tov-field-name">{st.label}</span>
              <span className={`tov-field-req${locked ? ' tov-field-req--on' : ''}`}>{locked ? 'shipped · locked' : `under ${model.labelOf(parentOf(st))}`}</span>
              <span className="tov-field-meta">
                key <code>{st.key}</code> · kind {st.kind} · order {st.order}
                {st.color ? ` · #${st.color}` : ''}
                {st.clickup?.length ? ` · clickup: ${st.clickup.join(', ')}` : ''}
              </span>
              <div className="tov-field-actions">
                <button type="button" className="tov-edit" title="Move up" aria-label={`Move ${st.label} up`} disabled={busy || idx === 0} onClick={() => move(idx, -1)}>↑</button>
                <button type="button" className="tov-edit" title="Move down" aria-label={`Move ${st.label} down`} disabled={busy || idx === statuses.length - 1} onClick={() => move(idx, 1)}>↓</button>
                <button type="button" className="tov-edit" title="Edit status" aria-label={`Edit status ${st.label}`} disabled={busy} onClick={() => setEditingStatus(st)}>✎</button>
                <button
                  type="button"
                  className="tov-remove"
                  title={locked ? 'Shipped statuses cannot be removed' : 'Remove status'}
                  aria-label={`Remove status ${st.label}`}
                  disabled={busy || locked}
                  onClick={() => onRemoveStatus(st.key)}
                >×</button>
              </div>
            </div>
          );
        })}
      </div>

      {statusError && <div className="acf-error" role="alert">⚠ {statusError}</div>}

      {editingStatus
        ? <AddStatusForm key={editingStatus.key} initial={editingStatus} onClose={() => setEditingStatus(null)} />
        : <AddStatusForm key="add-status" />}

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
