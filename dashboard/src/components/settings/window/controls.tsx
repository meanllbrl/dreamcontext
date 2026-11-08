import type { ReactNode } from 'react';

/**
 * A segmented choice (the window's one-of-N control). A passive one keeps its value visible
 * and says why in its row (`SettingRow.why`), never silently.
 */
export function Seg<T extends string>({ options, value, onChange, label, disabled }: {
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className="sw-seg" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`sw-seg-btn${o.value === value ? ' on' : ''}`}
          disabled={disabled}
          onClick={() => { if (o.value !== value) onChange(o.value); }}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** One page's head: the name once, one sentence, and an optional action on the right. */
export function PageHead({ title, desc, action }: { title: string; desc: string; action?: ReactNode }) {
  return (
    <div className="sw-head">
      <div className="sw-head-row">
        <h2 className="sw-title">{title}</h2>
        {action}
      </div>
      <p className="sw-desc">{desc}</p>
    </div>
  );
}
