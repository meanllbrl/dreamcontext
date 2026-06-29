import { FilterPopover } from 'dreamcontext-dashboard';

// FilterPopover is the generic anchored-dropdown primitive: it renders an arbitrary
// `trigger` and, when isOpen, an absolutely-positioned `content` panel below it
// (align left/right, optional fixed width). We supply DS-styled trigger + content
// (the filter-chip + filter-option classes ship in the bundle CSS). isOpen is a PROP:
// author an OPEN cell (the panel + options) and a CLOSED cell (just the trigger).
// The open panel is absolutely positioned and may escape the card — if clipped,
// record a cardMode/viewport override in learnings.
const noop = () => {};

// The .filter-chip pill styles live in TaskFilters.css, which is NOT in this
// component's CSS bundle graph — so we inline the chip styling (same DS tokens)
// to keep the FilterPopover preview self-contained and fully styled.
function Chip({ label, active, open }: { label: string; active?: boolean; open?: boolean }) {
  return (
    <button
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '5px 10px',
        border: '1px solid',
        borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--color-accent-soft)' : 'var(--color-bg-elevated)',
        color: active ? 'var(--color-text)' : 'var(--color-text-secondary)',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 'var(--font-weight-medium)' as unknown as number,
        fontFamily: 'var(--font-family)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ lineHeight: 1 }}>{label}</span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        style={{ opacity: 0.5, flexShrink: 0, transform: open ? 'rotate(180deg)' : undefined }}
      >
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

const priorities = [
  { value: 'critical', label: 'Critical', color: '#ef4444' },
  { value: 'high', label: 'High', color: '#f0a020' },
  { value: 'medium', label: 'Medium', color: '#7c5cff' },
  { value: 'low', label: 'Low', color: '#8b8b9e' },
];

function PriorityList({ selected }: { selected: string[] }) {
  return (
    <div className="filter-option-list">
      <div className="filter-popover-section">Priority</div>
      {priorities.map(p => (
        <button key={p.value} className={`filter-option ${selected.includes(p.value) ? 'filter-option--selected' : ''}`}>
          <span className="filter-option-dot" style={{ background: p.color }} />
          <span className="filter-option-label">{p.label}</span>
          {selected.includes(p.value) && (
            <svg className="filter-option-check" width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M3 7L6 10L11 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      ))}
    </div>
  );
}

// OPEN — left-aligned priority filter panel with two selected.
export const Open = () => (
  <div style={{ minHeight: 240, paddingBottom: 8 }}>
    <FilterPopover
      isOpen={true}
      onClose={noop}
      trigger={<Chip label="Priority" active open />}
      content={<PriorityList selected={['critical', 'high']} />}
    />
  </div>
);

// OPEN — right-aligned, fixed width.
export const OpenRight = () => (
  <div style={{ minHeight: 240, paddingBottom: 8, display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-start' }}>
    <FilterPopover
      isOpen={true}
      onClose={noop}
      align="right"
      width={200}
      trigger={<Chip label="Priority" active open />}
      content={<PriorityList selected={['medium']} />}
    />
  </div>
);

// CLOSED — just the trigger chip, no panel.
export const Closed = () => (
  <div>
    <FilterPopover
      isOpen={false}
      onClose={noop}
      trigger={<Chip label="Priority" />}
      content={<PriorityList selected={[]} />}
    />
  </div>
);
