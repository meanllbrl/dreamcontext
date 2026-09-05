import type { ReactNode } from 'react';
import './SettingRow.css';

/**
 * One grammar for the inside of every settings section.
 *
 * The regroup fixed the MENU; the sections themselves were still three layouts
 * stacked in one list: a checkbox with its label on the right, a full-width
 * paragraph under it at a different indent, and a label-left/select-right field
 * row. Agents had ten of those paragraphs in a row — 3,200 characters where you
 * could not see, at a glance, where one setting ended and the next began.
 *
 * Every setting is now the same shape: what it is on the left (name + one line
 * of explanation on a readable measure), the control on the right, a hairline
 * between rows. Scanning the list means reading the left column; changing
 * something means reaching for the right one.
 */

export function SettingGroup({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  return (
    <div className="setting-group">
      {title && <h3 className="setting-group-title">{title}</h3>}
      {note && <p className="setting-group-note">{note}</p>}
      <div className="setting-rows">{children}</div>
    </div>
  );
}

interface SettingRowProps {
  title: string;
  /** ONE line — the sentence that decides the setting. */
  hint?: string;
  /**
   * The rest of the explanation, folded. These settings genuinely have deep
   * behaviour worth documenting (what a running session keeps, what a dirty tree
   * does), and deleting it to make the list short would be trading one failure
   * for another. Folded, not dropped: the list scans, the detail is one click in.
   */
  more?: string;
  /** Extra body under the row — a nested card, a status line, a preview panel. */
  children?: ReactNode;
  /** The control itself: a Toggle, a select, an input, a button. */
  control?: ReactNode;
  /** Reported beside the control (the save mark, a test result). */
  status?: ReactNode;
  /** Renders the whole row as a <label> so the text is part of the hit target. */
  labelled?: boolean;
  tone?: 'default' | 'warn';
}

export function SettingRow({ title, hint, more, children, control, status, labelled, tone = 'default' }: SettingRowProps) {
  // A <summary> inside a <label> would toggle the control on every expand, so a
  // row carrying folded detail is never the label itself.
  const Wrapper = labelled && !more ? 'label' : 'div';
  return (
    <Wrapper className={`setting-row${labelled && !more ? ' setting-row--labelled' : ''}${tone === 'warn' ? ' setting-row--warn' : ''}`}>
      <span className="setting-row-head">
        <span className="setting-row-text">
          <span className="setting-row-title">{title}</span>
          {hint && <span className="setting-row-hint">{hint}</span>}
          {more && (
            <details className="setting-row-more">
              <summary>{'Details'}</summary>
              <span className="setting-row-more-body">{more}</span>
            </details>
          )}
        </span>
        {(control || status) && (
          <span className="setting-row-control">
            {status}
            {control}
          </span>
        )}
      </span>
      {children && <span className="setting-row-body">{children}</span>}
    </Wrapper>
  );
}

/**
 * The boolean control. A pill switch rather than a checkbox: it sits in the
 * right-hand control column with the selects, and at a glance a row of switches
 * reads as on/off state instead of a column of ticks the eye has to parse.
 */
export function Toggle({ checked, disabled, onChange, label }: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name when the row's own title isn't the label (unlabelled rows). */
  label?: string;
}) {
  return (
    <input
      type="checkbox"
      className="setting-switch"
      role="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/**
 * A row in a mutually-exclusive choice list (recall mode, and anything else that
 * is one-of-N). The radio stays on the LEFT here on purpose — this is a list of
 * options being compared, not a list of independent settings being flipped.
 */
export function SettingChoice({ name, value, checked, disabled, onSelect, title, hint, badge, children }: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  hint?: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <label className={`setting-choice${checked ? ' setting-choice--on' : ''}`}>
      <input
        type="radio"
        className="setting-choice-radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="setting-choice-text">
        <span className="setting-choice-title">
          {title}
          {badge}
        </span>
        {hint && <span className="setting-choice-hint">{hint}</span>}
        {children}
      </span>
    </label>
  );
}
