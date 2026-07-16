import type { ReactNode } from 'react';

interface TaskSectionProps {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Shown beside the title while collapsed — so a closed section still says how much it holds
   *  (the design's `{{ s.count }}`). Omit for sections where a count means nothing. */
  count?: number;
  children: ReactNode;
}

/**
 * One collapsible group in the properties rail.
 *
 * The 18+ flat rows this replaces had exactly one collapsible member (RICE) and no hierarchy,
 * so every property read as equally important — which meant none did. Grouping is the fix, and
 * the group has to be able to close or it is just a heading.
 */
export function TaskSection({ id, title, open, onToggle, count, children }: TaskSectionProps) {
  const bodyId = `task-section-${id}`;
  return (
    <div className="task-section">
      <button
        type="button"
        className="task-section-head"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="task-section-caret" aria-hidden data-open={open || undefined}>▶</span>
        <span className="task-section-title">{title}</span>
        {!open && count !== undefined && <span className="task-section-count">{count}</span>}
      </button>
      {/* Unmounted, not hidden, while closed: these bodies hold live selects and pickers, and a
          closed section's controls should be out of the tab order entirely. */}
      {open && <div className="task-section-body" id={bodyId}>{children}</div>}
    </div>
  );
}

interface TaskFieldProps {
  label: string;
  /** Marks the field's value as the accessible name target. */
  htmlFor?: string;
  children: ReactNode;
}

/** One labelled row inside a section. Replaces the rigid `140px 1fr` grid: the rail is 320px,
 *  so a fixed 140px label column left the value column too narrow for a date input or a chip
 *  set to breathe. */
export function TaskField({ label, htmlFor, children }: TaskFieldProps) {
  return (
    <div className="task-field">
      <label className="task-field-label" htmlFor={htmlFor}>{label}</label>
      <div className="task-field-value">{children}</div>
    </div>
  );
}

interface EmptyFieldProps {
  /** What clicking this starts, e.g. "Add priority" / "Assign someone". */
  label: string;
  onClick?: () => void;
}

/**
 * The one honest empty state — "never set".
 *
 * The complaint this answers: today "never set" and "deliberately cleared" render identically
 * (both just blank), and every field invented its own clear gesture — RICE had a Clear button,
 * Feature had a "No feature" option, chips had an ×, dates just went blank. A reader could not
 * tell whether a field was untouched or emptied on purpose, and a writer had to learn a new
 * gesture per field. A dashed affordance says "nothing here, and you may put something here",
 * in one shape, everywhere.
 */
export function EmptyField({ label, onClick }: EmptyFieldProps) {
  return (
    <button type="button" className="task-field-empty" onClick={onClick} disabled={!onClick}>
      <span aria-hidden>＋</span>{label}
    </button>
  );
}

/** Required, and missing. Distinct from empty: it blocks nothing else, but it is not OK. */
export function RequiredField({ label }: { label: string }) {
  return (
    <span className="task-field-required" role="status">
      <span aria-hidden>!</span>{label}
    </span>
  );
}
