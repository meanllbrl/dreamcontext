import { MultiSelectFilter } from 'dreamcontext-dashboard';

// MultiSelectFilter takes an isOpen PROP — pass isOpen={true} to render the OPEN
// popover (the interesting state: All/None actions, colored option dots, checkboxes,
// and the search box when options > 5). options: { value, label, color? }[].
// Also include a closed cell (isOpen={false}) showing just the active/inactive chip.
// The dropdown is absolutely positioned below the trigger and may escape the card —
// if clipped, record a cardMode/viewport override in learnings.
const noop = () => {};

const statusOptions = [
  { value: 'todo', label: 'To Do', color: '#8b8b9e' },
  { value: 'in_progress', label: 'In Progress', color: '#7c5cff' },
  { value: 'in_review', label: 'In Review', color: '#f0a020' },
  { value: 'completed', label: 'Completed', color: '#22b07d' },
];

const tagOptions = [
  { value: 'backend', label: 'backend', color: '#7c5cff' },
  { value: 'cli', label: 'cli', color: '#3b82f6' },
  { value: 'agents', label: 'agents', color: '#ec4899' },
  { value: 'recall', label: 'recall', color: '#f0a020' },
  { value: 'sleep', label: 'sleep', color: '#22b07d' },
  { value: 'federation', label: 'federation', color: '#06b6d4' },
  { value: 'taxonomy', label: 'taxonomy', color: '#a855f7' },
];

// OPEN — status filter with a couple selected (no search: ≤ 5 options).
export const OpenStatus = () => (
  <div style={{ minHeight: 300, paddingBottom: 8 }}>
    <MultiSelectFilter
      id="status"
      label="Status"
      options={statusOptions}
      selected={['in_progress', 'in_review']}
      onChange={noop}
      isOpen={true}
      onToggle={noop}
      onClose={noop}
    />
  </div>
);

// OPEN — tag filter with > 5 options, so the search box renders.
export const OpenSearchable = () => (
  <div style={{ minHeight: 340, paddingBottom: 8 }}>
    <MultiSelectFilter
      id="tags"
      label="Tags"
      options={tagOptions}
      selected={['recall', 'sleep']}
      onChange={noop}
      isOpen={true}
      onToggle={noop}
      onClose={noop}
    />
  </div>
);

// CLOSED — active chip (selection summarized in the trigger label).
export const ClosedActive = () => (
  <div>
    <MultiSelectFilter
      id="status-closed"
      label="Status"
      options={statusOptions}
      selected={['in_progress', 'in_review', 'completed']}
      onChange={noop}
      isOpen={false}
      onToggle={noop}
      onClose={noop}
    />
  </div>
);

// CLOSED — inactive chip (no selection, shows just the label + chevron).
export const ClosedDefault = () => (
  <div>
    <MultiSelectFilter
      id="tags-closed"
      label="Tags"
      options={tagOptions}
      selected={[]}
      onChange={noop}
      isOpen={false}
      onToggle={noop}
      onClose={noop}
    />
  </div>
);
