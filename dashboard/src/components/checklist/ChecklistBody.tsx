import { useState } from 'react';
import { pickFiles } from '../../lib/desktop';
import { doneCount, MAX_NOTE_CHARS, type ChecklistAction, type ChecklistState } from '../../lib/checklistState';
import type { ChecklistItemSpec, ChecklistViewSpec } from '../../lib/chatViewSpec';
import { MarkdownPreview } from '../core/MarkdownPreview';
import './ChecklistWindow.css';

interface Props {
  spec: ChecklistViewSpec;
  state: ChecklistState;
  dispatch: (a: ChecklistAction) => void;
  secrets: Record<string, string>;
  setSecret: (id: string, value: string) => void;
}

/**
 * Per-item rows for the pinned checklist window (plan §1.9/§1.13): a real checkbox + label,
 * the item text through `MarkdownPreview`, an ALWAYS-present note field — the manual-test
 * scenario is "tick each, write the bug underneath the failing ones", so notes are never
 * gated behind `wants` — and the `wants`-driven extra affordance (`file` attach, `secret`
 * masked input). Every control here is a real, natively-focusable form element, so Tab/Space
 * keyboard operability (criterion 30) comes from the browser, not from custom key handling.
 */
export function ChecklistBody({ spec, state, dispatch, secrets, setSecret }: Props) {
  const total = spec.items.length;
  const done = doneCount(spec, state);

  return (
    <div className="checklist-body">
      <p className="checklist-progress">{done} / {total} done</p>
      <p className="checklist-notes-hint">
        Notes are saved locally until you submit — for a key or password, use the field marked secret.
      </p>
      <ul className="checklist-items">
        {spec.items.map((item) => (
          <ChecklistItemRow
            key={item.id}
            item={item}
            checked={!!state.checked[item.id]}
            note={state.notes[item.id] ?? ''}
            files={state.files[item.id] ?? []}
            secret={secrets[item.id] ?? ''}
            dispatch={dispatch}
            setSecret={setSecret}
          />
        ))}
      </ul>
    </div>
  );
}

function ChecklistItemRow({
  item, checked, note, files, secret, dispatch, setSecret,
}: {
  item: ChecklistItemSpec;
  checked: boolean;
  note: string;
  files: string[];
  secret: string;
  dispatch: (a: ChecklistAction) => void;
  setSecret: (id: string, value: string) => void;
}) {
  const inputId = `checklist-item-${item.id}`;

  const attach = async () => {
    const paths = await pickFiles();
    if (paths.length) dispatch({ t: 'addFile', id: item.id, paths });
  };

  return (
    <li className={`checklist-item${checked ? ' is-done' : ''}`}>
      <div className="checklist-item-row">
        <input
          type="checkbox"
          id={inputId}
          checked={checked}
          onChange={() => dispatch({ t: 'toggle', id: item.id })}
        />
        <label htmlFor={inputId} className="checklist-item-text">
          <MarkdownPreview content={item.text} />
        </label>
      </div>
      {item.hint && <p className="checklist-item-hint">{item.hint}</p>}

      <textarea
        className="checklist-item-note"
        placeholder="Notes…"
        aria-label={`Notes for "${item.text}"`}
        value={note}
        maxLength={MAX_NOTE_CHARS}
        onChange={(e) => dispatch({ t: 'setNote', id: item.id, text: e.target.value })}
      />

      {item.wants === 'file' && (
        <div className="checklist-item-files">
          <button type="button" className="checklist-attach-btn" onClick={() => void attach()}>
            Attach…
          </button>
          {files.length > 0 && (
            <ul className="checklist-file-list">
              {files.map((path) => (
                <li key={path} className="checklist-file-chip">
                  <span className="checklist-file-path" title={path}>{path}</span>
                  <button
                    type="button"
                    className="checklist-file-remove"
                    onClick={() => dispatch({ t: 'removeFile', id: item.id, path })}
                    aria-label={`Remove attached file ${path}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {item.wants === 'secret' && (
        <SecretField itemId={item.id} value={secret} onChange={(v) => setSecret(item.id, v)} />
      )}
    </li>
  );
}

/**
 * The masked field for `wants:'secret'` (plan §1.13.5). Deliberately `type="text"`, NEVER
 * `type="password"` — a real password field is exactly what tells WebKit/the OS credential
 * manager to offer to save it, which is the one thing this field must never trigger. Masking
 * is done purely visually via `-webkit-text-security` (ChecklistWindow.css) plus a reveal
 * toggle, so the browser never learns this holds a secret at all.
 */
function SecretField({ itemId, value, onChange }: { itemId: string; value: string; onChange: (v: string) => void }) {
  const [revealed, setRevealed] = useState(false);
  const inputId = `checklist-secret-${itemId}`;

  return (
    <div className="checklist-secret">
      <div className="checklist-secret-row">
        <input
          id={inputId}
          type="text"
          className={`checklist-secret-input${revealed ? ' is-revealed' : ''}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste here…"
          autoComplete="off"
          spellCheck={false}
          autoCorrect="off"
          data-1p-ignore
          data-lpignore="true"
          aria-label="Secret value"
        />
        <button
          type="button"
          className="checklist-secret-toggle"
          onClick={() => setRevealed((r) => !r)}
          aria-pressed={revealed}
          aria-label={revealed ? 'Hide value' : 'Reveal value'}
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      </div>
      <p className="checklist-secret-note">
        Sent to the agent and stored in this conversation's transcript.
      </p>
    </div>
  );
}
