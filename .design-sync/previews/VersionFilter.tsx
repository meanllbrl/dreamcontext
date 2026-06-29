import { VersionFilter } from 'dreamcontext-dashboard';

// VersionFilter takes an isOpen PROP — pass isOpen={true} for the OPEN popover
// (the interesting state: search, All/None/Current quick actions, rows with a
// status icon — star=current, dot=planning, hollow=unregistered, check=released —
// task counts, a current badge, and a collapsible Completed section). items are
// PRE-SORTED by the parent: current → planning → unregistered → backlog → released.
// Include a closed cell (isOpen={false}) showing the active chip with its star.
// The dropdown is absolutely positioned below the trigger and may escape the card —
// if clipped, record a cardMode/viewport override in learnings.
const noop = () => {};
const noopItem = (_: unknown) => {};

const items = [
  { value: 'S7', status: 'planning' as const, isCurrent: true, taskCount: 12 },
  { value: 'S8', status: 'planning' as const, isCurrent: false, taskCount: 5 },
  { value: 'BACKLOG', status: 'unregistered' as const, isCurrent: false, taskCount: 23 },
  { value: 'v0.11.0', status: 'unregistered' as const, isCurrent: false, taskCount: 3 },
  { value: 'S6', status: 'released' as const, date: '2026-06-12', isCurrent: false, taskCount: 9 },
  { value: 'S5', status: 'released' as const, date: '2026-05-29', isCurrent: false, taskCount: 11 },
];

// OPEN — full picker, current sprint selected. > 5 items so the search box renders.
export const Open = () => (
  <div style={{ minHeight: 360, paddingBottom: 8 }}>
    <VersionFilter
      items={items}
      selected={['S7']}
      onChange={noop}
      currentVersion="S7"
      isOpen={true}
      onToggle={noop}
      onClose={noop}
      onSetCurrent={noop}
      onComplete={noopItem}
    />
  </div>
);

// OPEN — a set-current mutation in flight on S8 (its row actions are disabled).
export const OpenBusy = () => (
  <div style={{ minHeight: 360, paddingBottom: 8 }}>
    <VersionFilter
      items={items}
      selected={['S7', 'S8']}
      onChange={noop}
      currentVersion="S7"
      isOpen={true}
      onToggle={noop}
      onClose={noop}
      onSetCurrent={noop}
      onComplete={noopItem}
      busyVersion="S8"
    />
  </div>
);

// CLOSED — active chip showing the current sprint (with its filled star).
export const ClosedCurrent = () => (
  <div>
    <VersionFilter
      items={items}
      selected={['S7']}
      onChange={noop}
      currentVersion="S7"
      isOpen={false}
      onToggle={noop}
      onClose={noop}
      onSetCurrent={noop}
      onComplete={noopItem}
    />
  </div>
);

// CLOSED — inactive chip (no selection → just the "Version" label + chevron).
export const ClosedDefault = () => (
  <div>
    <VersionFilter
      items={items}
      selected={[]}
      onChange={noop}
      currentVersion="S7"
      isOpen={false}
      onToggle={noop}
      onClose={noop}
      onSetCurrent={noop}
      onComplete={noopItem}
    />
  </div>
);
