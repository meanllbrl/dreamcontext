import { useState } from 'react';
import './MaskedSecretInput.css';

/**
 * The one input in this app that a credential is typed into — shared by the pinned
 * checklist's `wants:'secret'` field and the Chat transcript's secret card, so the
 * masking discipline below has ONE home instead of two that drift.
 *
 * Deliberately `type="text"`, NEVER `type="password"`. A real password field is exactly
 * what tells WebKit and the OS credential manager to offer to save the value — the one
 * thing this input must never trigger, because the user is handing us a key to write to a
 * file, not a login they want remembered. Masking is purely visual
 * (`-webkit-text-security`, see the CSS) plus a reveal toggle, so the browser never learns
 * this field holds a secret at all. `data-1p-ignore` / `data-lpignore` say the same thing
 * to the password managers that look for it.
 *
 * Nothing here persists, autocompletes, or spellchecks. The value's only exit is the
 * `onChange` the caller owns.
 */
export function MaskedSecretInput({
  id, value, onChange, placeholder = 'Paste here…', ariaLabel = 'Secret value', onSubmit, disabled,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** Fires on ⏎ — a one-field card should submit from the keyboard. */
  onSubmit?: () => void;
  disabled?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="masked-secret-row">
      <input
        id={id}
        type="text"
        className={`masked-secret-input${revealed ? ' is-revealed' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit) { e.preventDefault(); onSubmit(); }
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        autoCorrect="off"
        data-1p-ignore
        data-lpignore="true"
        aria-label={ariaLabel}
        disabled={disabled}
      />
      <button
        type="button"
        className="masked-secret-toggle"
        onClick={() => setRevealed((r) => !r)}
        aria-pressed={revealed}
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
        disabled={disabled}
      >
        {revealed ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
