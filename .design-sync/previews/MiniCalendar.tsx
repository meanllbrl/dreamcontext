import { MiniCalendar } from 'dreamcontext-dashboard';

// MiniCalendar is the task-filter date-range picker: a field toggle
// (Updated / Created), quick presets, a month grid, and a selection footer.
// Realistic ranges over the current sprint window. `noop` for callbacks.
const noop = () => {};

export const SprintRange = () => (
  <div style={{ width: 280 }}>
    <MiniCalendar
      dateField="updated_at"
      dateFrom="2026-06-01"
      dateTo="2026-06-26"
      onDateFieldChange={noop}
      onDateFromChange={noop}
      onDateToChange={noop}
    />
  </div>
);

export const CreatedSingleDay = () => (
  <div style={{ width: 280 }}>
    <MiniCalendar
      dateField="created_at"
      dateFrom="2026-06-12"
      dateTo="2026-06-12"
      onDateFieldChange={noop}
      onDateFromChange={noop}
      onDateToChange={noop}
    />
  </div>
);

export const NoRange = () => (
  <div style={{ width: 280 }}>
    <MiniCalendar
      dateField="updated_at"
      dateFrom=""
      dateTo=""
      onDateFieldChange={noop}
      onDateFromChange={noop}
      onDateToChange={noop}
    />
  </div>
);
