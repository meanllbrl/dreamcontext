import { CustomFieldInput } from 'dreamcontext-dashboard';

// CustomFieldInput renders the right control per override-declared field type.
// One cell per type, with realistic dreamcontext task fields synced to
// ClickUp / GitHub. Parent owns state, so we pass a fixed value + `noop`.
const noop = () => {};

export const TextOwner = () => (
  <div style={{ width: 280 }}>
    <CustomFieldInput
      field={{ name: 'Owner', key: 'owner', type: 'text', sync: ['clickup'] }}
      value="Mehmet Nuraydin"
      onChange={noop}
      onCommit={noop}
    />
  </div>
);

export const NumberStoryPoints = () => (
  <div style={{ width: 280 }}>
    <CustomFieldInput
      field={{ name: 'Story Points', key: 'story_points', type: 'number', sync: ['clickup', 'github'] }}
      value={5}
      onChange={noop}
      onCommit={noop}
    />
  </div>
);

export const SelectEffort = () => (
  <div style={{ width: 280 }}>
    <CustomFieldInput
      field={{
        name: 'Effort',
        key: 'effort',
        type: 'select',
        options: ['XS', 'S', 'M', 'L', 'XL'],
        sync: ['clickup'],
      }}
      value="M"
      onChange={noop}
      onCommit={noop}
    />
  </div>
);

export const DateTarget = () => (
  <div style={{ width: 280 }}>
    <CustomFieldInput
      field={{ name: 'Target Date', key: 'target_date', type: 'date', required: true, sync: ['github'] }}
      value="2026-07-15"
      onChange={noop}
      onCommit={noop}
    />
  </div>
);
