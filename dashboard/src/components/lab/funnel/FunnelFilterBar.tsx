import { useEffect, useRef, useState } from 'react';
import {
  dimensionValues,
  hasActiveFilters,
  type FilterState,
  type FunnelDimension,
  type FunnelSet,
} from './funnelModel';
import './FunnelFilterBar.css';

/**
 * Dimension filter chips (A9) — one chip per payload-declared dimension.
 * `client` dims are multi-select (instant — segments carry the data);
 * `refetch` dims are single-select ("All" clears) — the chosen value is written
 * into the dimension's tweak and the insight re-syncs. Active values render as
 * removable chips with a clear-all. State lives in the URL (the parent owns it).
 */
export function FunnelFilterBar({ set, filters, refetchValues, onChange, onApplyRefetch, syncing }: {
  set: FunnelSet;
  filters: FilterState;
  /** Current tweak-backed value per refetch dim key ('' = unset). */
  refetchValues: Record<string, string>;
  onChange: (filters: FilterState) => void;
  onApplyRefetch: (dim: FunnelDimension, value: string | null) => void;
  syncing: boolean;
}) {
  const [openDim, setOpenDim] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const popRef = useRef<HTMLDivElement | null>(null);

  // Click-outside closes the value popover.
  useEffect(() => {
    if (!openDim) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpenDim(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [openDim]);

  if (set.dimensions.length === 0) return null;

  const toggleValue = (dim: FunnelDimension, value: string) => {
    const current = filters[dim.key] ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    onChange({ ...filters, [dim.key]: next });
  };

  const activeChips: { dim: FunnelDimension; value: string; refetch: boolean }[] = [];
  for (const dim of set.dimensions) {
    if (dim.mode === 'client') {
      for (const value of filters[dim.key] ?? []) activeChips.push({ dim, value, refetch: false });
    } else if (refetchValues[dim.key]) {
      activeChips.push({ dim, value: refetchValues[dim.key], refetch: true });
    }
  }

  return (
    <div className="funnel-filters" role="group" aria-label="Funnel filters">
      {set.dimensions.map((dim) => {
        const open = openDim === dim.key;
        const selected = dim.mode === 'client' ? (filters[dim.key] ?? []) : (refetchValues[dim.key] ? [refetchValues[dim.key]] : []);
        const values = dimensionValues(set, dim).filter((v) =>
          !search.trim() || v.value.toLowerCase().includes(search.trim().toLowerCase()));
        return (
          <div key={dim.key} className="funnel-filter" ref={open ? popRef : undefined}>
            <button
              className={`funnel-filter-chip${selected.length > 0 ? ' funnel-filter-chip--active' : ''}`}
              onClick={() => { setOpenDim(open ? null : dim.key); setSearch(''); }}
              aria-expanded={open}
              aria-haspopup="listbox"
            >
              {dim.label}
              {selected.length > 0 && <span className="funnel-filter-count">{selected.length}</span>}
              {dim.mode === 'refetch' && <span className="funnel-filter-mode" title="Applying this filter re-fetches the data">↻</span>}
            </button>
            {open && (
              <div className="funnel-filter-pop" role="listbox" aria-label={`${dim.label} values`}>
                <input
                  className="funnel-filter-search"
                  placeholder="Search values…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                />
                {dim.mode === 'refetch' && (
                  <button
                    className={`funnel-filter-option${!refetchValues[dim.key] ? ' funnel-filter-option--on' : ''}`}
                    disabled={syncing}
                    onClick={() => { onApplyRefetch(dim, null); setOpenDim(null); }}
                  >All</button>
                )}
                {values.length === 0 && <div className="funnel-filter-empty">No values{dim.mode === 'client' ? ' (payload has no segments for this dimension)' : ' declared'}.</div>}
                {values.map(({ value, count }) => {
                  const on = selected.includes(value);
                  return (
                    <button
                      key={value}
                      className={`funnel-filter-option${on ? ' funnel-filter-option--on' : ''}`}
                      role="option"
                      aria-selected={on}
                      disabled={syncing && dim.mode === 'refetch'}
                      onClick={() => {
                        if (dim.mode === 'client') toggleValue(dim, value);
                        else { onApplyRefetch(dim, on ? null : value); setOpenDim(null); }
                      }}
                    >
                      <span className={`funnel-filter-check${on ? ' funnel-filter-check--on' : ''}`} aria-hidden>{on ? '✓' : ''}</span>
                      <span className="funnel-filter-value">{value}</span>
                      {count !== null && <span className="funnel-filter-vcount">{count.toLocaleString('en-US')}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {activeChips.length > 0 && (
        <>
          <span className="funnel-filters-sep" aria-hidden>·</span>
          {activeChips.map(({ dim, value, refetch }) => (
            <button
              key={`${dim.key}:${value}`}
              className="funnel-filter-active"
              title={`Remove ${dim.label}: ${value}`}
              disabled={syncing && refetch}
              onClick={() => {
                if (refetch) onApplyRefetch(dim, null);
                else onChange({ ...filters, [dim.key]: (filters[dim.key] ?? []).filter((v) => v !== value) });
              }}
            >
              {dim.label}: {value} <span aria-hidden>✕</span>
            </button>
          ))}
          {(hasActiveFilters(filters) || activeChips.some((c) => c.refetch)) && (
            <button
              className="funnel-filter-clear"
              onClick={() => {
                onChange({});
                for (const dim of set.dimensions) {
                  if (dim.mode === 'refetch' && refetchValues[dim.key]) onApplyRefetch(dim, null);
                }
              }}
            >Clear all</button>
          )}
        </>
      )}
    </div>
  );
}
