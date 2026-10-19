import { useState, useRef, useEffect } from 'react';
import { FilterPopover } from './FilterPopover';
import './MultiSelectFilter.css';

interface Option {
  value: string;
  label: string;
  color?: string;
}

interface MultiSelectFilterProps {
  id: string;
  label: string;
  options: Option[];
  selected: string[];
  onChange: (values: string[]) => void;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}

function ChevronIcon({ open }: { open?: boolean }) {
  return (
    <svg className={`filter-chip-chevron ${open ? 'filter-chip-chevron--open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  isOpen,
  onToggle,
  onClose,
}: MultiSelectFilterProps) {
  const isActive = selected.length > 0;
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Auto-focus search and clear on close
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      setSearch('');
    }
  }, [isOpen]);

  const filteredOptions = search.trim()
    ? options.filter(o => o.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  const toggleValue = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const selectAll = () => onChange(options.map(o => o.value));
  const selectNone = () => onChange([]);

  const displayLabel = isActive
    ? selected.length <= 2
      ? selected.map(v => options.find(o => o.value === v)?.label ?? v).join(', ')
      : `${options.find(o => o.value === selected[0])?.label ?? selected[0]} +${selected.length - 1}`
    : label;

  const showSearch = options.length > 5;

  return (
    <FilterPopover
      isOpen={isOpen}
      onClose={onClose}
      trigger={
        <button
          className={`filter-chip ${isActive ? 'filter-chip--active' : ''}`}
          onClick={onToggle}
        >
          {isActive && selected.length === 1 && (
            <span
              className="filter-chip-dot"
              style={{ background: options.find(o => o.value === selected[0])?.color }}
            />
          )}
          <span className="filter-chip-label">{displayLabel}</span>
          <ChevronIcon open={isOpen} />
        </button>
      }
      content={
        <div className="multi-select-list">
          {showSearch && (
            <div className="multi-select-search-wrap">
              <input
                ref={searchRef}
                className="multi-select-search"
                placeholder="Search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          )}
          <div className="multi-select-actions">
            <button className="multi-select-action" onClick={selectAll}>All</button>
            <button className="multi-select-action" onClick={selectNone}>None</button>
          </div>
          <div className="multi-select-options">
            {filteredOptions.map(opt => (
              <label key={opt.value} className="multi-select-option">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggleValue(opt.value)}
                />
                {opt.color && (
                  <span className="filter-option-dot" style={{ background: opt.color }} />
                )}
                <span className="filter-option-label">{opt.label}</span>
              </label>
            ))}
            {filteredOptions.length === 0 && (
              <div className="multi-select-no-results">No matches</div>
            )}
          </div>
        </div>
      }
    />
  );
}
