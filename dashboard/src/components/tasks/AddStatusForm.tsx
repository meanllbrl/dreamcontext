import { useState } from 'react';
import { useAddStatusDef, type AddStatusInput, type StatusDef, type StatusKind } from '../../hooks/useTasks';
import { DEFAULT_STATUSES, PARENT_BY_KIND, SHIPPED_STATUS_KEYS, parentOf, statusCssColor } from '../../lib/statusModel';
import './AddCustomFieldForm.css';

/** Snake_case ascii id from a name (mirrors the server's fieldKey). */
function toKey(name: string): string {
  return name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const KINDS: Array<{ value: StatusKind; label: string; hint: string }> = [
  { value: 'open', label: 'open', hint: 'queued, not started (like To Do)' },
  { value: 'active', label: 'active', hint: 'being worked on — stamps the start date' },
  { value: 'review', label: 'review', hint: 'done pending a human — required fields must be set' },
  { value: 'cancelled', label: 'cancelled', hint: 'abandoned / superseded — leaves every progress count, closes the GitHub issue' },
];

interface AddStatusFormProps {
  /** When set, the form opens pre-filled to EDIT this status (upsert by its key). */
  initial?: StatusDef | null;
  /** Called after a successful add/save or a cancel — lets the parent dismiss edit mode. */
  onClose?: () => void;
}

/**
 * Defines a PROJECT-WIDE task status (written to overrides/task.md `statuses:`):
 * a label, a stable key, a semantic kind (which drives every derived behaviour —
 * terminal? active? closes the issue?), a pipeline position, a colour (also the
 * GitHub label colour) and optional ClickUp aliases. A SHIPPED status opens in
 * edit mode with its key and kind locked — relabel / reorder / recolour only.
 */
export function AddStatusForm({ initial = null, onClose }: AddStatusFormProps) {
  const isEdit = initial !== null;
  const isShipped = isEdit && SHIPPED_STATUS_KEYS.includes(initial.key);
  const addStatus = useAddStatusDef();
  const [open, setOpen] = useState(isEdit);
  const [name, setName] = useState(initial?.label ?? '');
  const [keyEdited, setKeyEdited] = useState(isEdit);
  const [key, setKey] = useState(initial?.key ?? '');
  const [kind, setKind] = useState<StatusKind>(initial?.kind && initial.kind !== 'done' ? initial.kind : 'open');
  const [parent, setParent] = useState<string>(initial ? parentOf(initial) : PARENT_BY_KIND.open);
  const [parentEdited, setParentEdited] = useState(Boolean(initial?.parent));
  const [order, setOrder] = useState(initial?.order !== undefined ? String(initial.order) : '');
  const [color, setColor] = useState(initial?.color ? `#${initial.color}` : '');
  const [clickupInput, setClickupInput] = useState(initial?.clickup?.join(', ') ?? '');
  const [error, setError] = useState<string | null>(null);

  const effectiveKey = keyEdited ? key : toKey(name);
  // The parent follows the kind until the user overrides it explicitly.
  const effectiveParent = parentEdited ? parent : PARENT_BY_KIND[kind];
  const previewColor = color && /^#[0-9a-f]{6}$/i.test(color)
    ? color
    : statusCssColor({ key: effectiveKey || 'x', label: name, kind: isShipped && initial ? initial.kind : kind, order: 0 });

  const reset = () => {
    setName(''); setKey(''); setKeyEdited(false); setKind('open'); setOrder(''); setColor(''); setClickupInput(''); setError(null);
  };
  const close = () => {
    if (!isEdit) { reset(); setOpen(false); }
    onClose?.();
  };

  const submit = () => {
    if (!name.trim()) { setError('Label is required.'); return; }
    if (!effectiveKey) { setError('A key could not be derived from the label.'); return; }
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) { setError('Colour must be a 6-digit hex like #c5def5.'); return; }
    const orderNum = order.trim() === '' ? undefined : Number(order);
    if (orderNum !== undefined && !Number.isFinite(orderNum)) { setError('Order must be a number.'); return; }
    const input: AddStatusInput = {
      name: name.trim(),
      key: effectiveKey,
      ...(isShipped ? {} : { kind, parent: effectiveParent }),
      order: orderNum,
      color: color ? color.slice(1).toLowerCase() : undefined,
      remoteAliases: clickupInput.split(',').map((a) => a.trim()).filter(Boolean),
    };
    addStatus.mutate(input, {
      onSuccess: () => { if (!isEdit) reset(); setOpen(false); onClose?.(); },
      onError: (e) => setError((e as Error).message),
    });
  };

  if (!open) {
    return (
      <button type="button" className="acf-add-btn" onClick={() => setOpen(true)}>
        + Add status
      </button>
    );
  }

  return (
    <div className="acf-form" data-testid="add-status-form">
      <div className="acf-row">
        <span className="acf-label">Label</span>
        <input
          className="field-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Planned"
          autoFocus
        />
        <span className="tov-status-swatch" style={{ background: previewColor }} aria-hidden="true" />
      </div>
      <div className="acf-row">
        <span className="acf-label">Key</span>
        <input
          className="field-input"
          value={effectiveKey}
          onChange={(e) => { setKeyEdited(true); setKey(toKey(e.target.value)); }}
          placeholder="auto from label"
          disabled={isEdit}
          title={isEdit ? "A status key can't change — it is what tasks and synced labels carry." : undefined}
        />
      </div>
      <div className="acf-row">
        <span className="acf-label">Kind</span>
        {isShipped && initial ? (
          <span className="tov-field-meta">
            <code>{initial.kind}</code> — shipped statuses keep their kind
          </span>
        ) : (
          <select className="field-select" value={kind} onChange={(e) => setKind(e.target.value as StatusKind)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label} — {k.hint}</option>)}
          </select>
        )}
      </div>
      {!isShipped && (
        <div className="acf-row">
          <span className="acf-label">Lives under</span>
          <select className="field-select" value={effectiveParent} onChange={(e) => { setParentEdited(true); setParent(e.target.value); }}>
            {DEFAULT_STATUSES.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </div>
      )}
      {!isShipped && (
        <p className="tov-parent-hint">
          Cloud sync only ever sees the parent: GitHub gets its open/closed state, ClickUp gets a list status
          every list already has — and this status rides beside it as the <code>dc:{effectiveKey || '<key>'}</code>{' '}
          label/tag. Nothing has to be created on the provider.
        </p>
      )}
      <div className="acf-row">
        <span className="acf-label">Order</span>
        <input
          className="field-input"
          value={order}
          onChange={(e) => setOrder(e.target.value)}
          placeholder="pipeline position — shipped: todo 0 · in_progress 10 · in_review 20 · completed 30"
          inputMode="numeric"
        />
      </div>
      <div className="acf-row">
        <span className="acf-label">Colour</span>
        <input
          className="field-input"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          placeholder="#c5def5 — also the GitHub label colour (blank = the kind's default)"
        />
      </div>
      <div className="acf-row">
        <span className="acf-label">ClickUp names</span>
        <input
          className="field-input"
          value={clickupInput}
          onChange={(e) => setClickupInput(e.target.value)}
          placeholder="comma,separated list-status names this maps to (ClickUp cannot create statuses via API)"
        />
      </div>
      {error && <div className="acf-error">{error}</div>}
      <div className="acf-actions">
        <button type="button" className="btn btn--ghost" onClick={close}>Cancel</button>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={addStatus.isPending || !name.trim()}>
          {addStatus.isPending ? '...' : isEdit ? 'Save changes' : 'Add status'}
        </button>
      </div>
    </div>
  );
}
