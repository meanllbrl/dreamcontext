import { SearchableSelect } from 'dreamcontext-dashboard';

// SearchableSelect manages its OPEN state INTERNALLY (no isOpen prop), so a static
// preview can only render the CLOSED trigger — the selected value (or placeholder)
// plus the chevron. We author several closed-trigger cells with different
// values/placeholders. options: { value, label, hint? }[] — hint is the dim
// secondary text (the slug actually stored). NOTE in learnings: the open search
// dropdown cannot render statically.
const noop = () => {};

const assignees = [
  { value: 'mehmet', label: 'Mehmet Nuraydın', hint: '@mehmet' },
  { value: 'remsleep-bot', label: 'RemSleep (sleep agent)', hint: '@remsleep' },
  { value: 'curator-bot', label: 'Curator (refactor agent)', hint: '@curator' },
  { value: 'unassigned', label: 'Unassigned', hint: '' },
];

const features = [
  { value: 'context-snapshot', label: 'Context Snapshot', hint: 'context-snapshot' },
  { value: 'brain-curator', label: 'Brain Curator', hint: 'brain-curator' },
  { value: 'agent-feedback', label: 'Agent Feedback Loop', hint: 'agent-feedback' },
  { value: 'recall-engine', label: 'Recall Engine (BM25)', hint: 'recall-engine' },
];

export const AssigneeSelected = () => (
  <div style={{ width: 240 }}>
    <SearchableSelect
      value="mehmet"
      options={assignees}
      placeholder="Assign to…"
      searchPlaceholder="Search people…"
      onChange={noop}
      clearLabel="Unassign"
    />
  </div>
);

export const Placeholder = () => (
  <div style={{ width: 240 }}>
    <SearchableSelect
      value={null}
      options={features}
      placeholder="Link a feature…"
      searchPlaceholder="Search features…"
      onChange={noop}
      clearLabel="No feature"
    />
  </div>
);

export const FeatureSelected = () => (
  <div style={{ width: 240 }}>
    <SearchableSelect
      value="brain-curator"
      options={features}
      placeholder="Link a feature…"
      onChange={noop}
      clearLabel="No feature"
    />
  </div>
);

export const CustomValue = () => (
  <div style={{ width: 240 }}>
    <SearchableSelect
      value="S7-hotfix"
      options={[
        { value: 'S5', label: 'Sprint S5' },
        { value: 'S6', label: 'Sprint S6' },
        { value: 'S7', label: 'Sprint S7 (current)' },
      ]}
      placeholder="Version…"
      onChange={noop}
      allowCustom
      clearLabel="No version"
    />
  </div>
);
