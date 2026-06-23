import { useState, useRef, useEffect } from 'react';
import { FilterPopover } from './FilterPopover';
import './VersionFilter.css';

export type VersionStatus = 'planning' | 'released' | 'unregistered';

export interface VersionFilterItem {
  /** The version / sprint name (e.g. "S7", "BACKLOG", "v0.10.0"). */
  value: string;
  /** planning = active sprint, released = completed, unregistered = only a task `version:` string. */
  status: VersionStatus;
  /** Release date — present for completed (released) sprints only. */
  date?: string;
  /** True when this is the active planning version ("current sprint"). */
  isCurrent: boolean;
  /** Number of tasks carrying this version. */
  taskCount: number;
}

interface VersionFilterProps {
  /** Pre-sorted by the parent: current → planning → unregistered → backlog → released. */
  items: VersionFilterItem[];
  selected: string[];
  onChange: (values: string[]) => void;
  currentVersion: string | null;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSetCurrent: (version: string) => void;
  onComplete: (item: VersionFilterItem) => void;
  /** Version with an in-flight current/complete mutation (disables its actions). */
  busyVersion?: string | null;
}

const BACKLOG_RE = /^backlog$/i;

function ChevronIcon({ open }: { open?: boolean }) {
  return (
    <svg className={`filter-chip-chevron ${open ? 'filter-chip-chevron--open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StarIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill={filled ? 'currentColor' : 'none'} aria-hidden="true">
      <path d="M7 1.5l1.6 3.4 3.7.5-2.7 2.6.7 3.7L7 10.5 3.7 12.2l.7-3.7L1.7 5.9l3.7-.5L7 1.5z"
        stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="3" fill="currentColor" />
    </svg>
  );
}

function HollowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 7L6 10L11 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function statusIcon(item: VersionFilterItem) {
  if (item.status === 'released') return <CheckIcon />;
  if (item.isCurrent) return <StarIcon filled />;
  if (item.status === 'planning') return <DotIcon />;
  return <HollowIcon />;
}

function statusClass(item: VersionFilterItem): string {
  if (item.status === 'released') return 'vf-icon--released';
  if (item.isCurrent) return 'vf-icon--current';
  if (item.status === 'planning') return 'vf-icon--planning';
  return 'vf-icon--unregistered';
}

export function VersionFilter({
  items,
  selected,
  onChange,
  currentVersion,
  isOpen,
  onToggle,
  onClose,
  onSetCurrent,
  onComplete,
  busyVersion,
}: VersionFilterProps) {
  const isActive = selected.length > 0;
  const [search, setSearch] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => searchRef.current?.focus());
    } else {
      setSearch('');
    }
  }, [isOpen]);

  const q = search.trim().toLowerCase();
  const matches = (it: VersionFilterItem) => !q || it.value.toLowerCase().includes(q);
  const visible = items.filter(matches);
  const active = visible.filter(it => it.status !== 'released');
  const completed = visible.filter(it => it.status === 'released');

  const toggleValue = (value: string) => {
    if (selected.includes(value)) onChange(selected.filter(v => v !== value));
    else onChange([...selected, value]);
  };

  const selectAll = () => onChange(items.map(it => it.value));
  const selectNone = () => onChange([]);
  const selectCurrent = () => { if (currentVersion) onChange([currentVersion]); };

  const showSearch = items.length > 5;

  const labelFor = (v: string) => v;
  const displayLabel = isActive
    ? selected.length <= 2
      ? selected.map(labelFor).join(', ')
      : `${labelFor(selected[0])} +${selected.length - 1}`
    : 'Version';
  const showCurrentStar = isActive && selected.length === 1 && selected[0] === currentVersion;

  const renderRow = (it: VersionFilterItem, withActions: boolean) => {
    const isBacklog = BACKLOG_RE.test(it.value);
    const busy = busyVersion === it.value;
    return (
      <div key={it.value} className={`vf-row ${it.isCurrent ? 'vf-row--current' : ''}`}>
        <label className="vf-check">
          <input
            type="checkbox"
            checked={selected.includes(it.value)}
            onChange={() => toggleValue(it.value)}
          />
          <span className={`vf-icon ${statusClass(it)}`}>{statusIcon(it)}</span>
          <span className="vf-name">{it.value}</span>
          {it.isCurrent && <span className="vf-badge">current</span>}
          {it.status === 'released' && it.date && <span className="vf-date">{it.date}</span>}
          <span className="vf-count">{it.taskCount}</span>
        </label>
        {withActions && !isBacklog && (
          <div className="vf-actions">
            {!it.isCurrent && (
              <button
                type="button"
                className="vf-action vf-action--current"
                title="Set as current sprint"
                aria-label={`Set ${it.value} as current sprint`}
                disabled={busy}
                onClick={(e) => { e.stopPropagation(); onSetCurrent(it.value); }}
              >
                <StarIcon />
              </button>
            )}
            <button
              type="button"
              className="vf-action vf-action--complete"
              title="Mark sprint completed"
              aria-label={`Mark ${it.value} completed`}
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); onComplete(it); }}
            >
              <CheckIcon />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <FilterPopover
      isOpen={isOpen}
      onClose={onClose}
      width={280}
      trigger={
        <button
          className={`filter-chip ${isActive ? 'filter-chip--active' : ''}`}
          onClick={onToggle}
        >
          {showCurrentStar && <span className="vf-chip-star"><StarIcon filled /></span>}
          <span className="filter-chip-label">{displayLabel}</span>
          <ChevronIcon open={isOpen} />
        </button>
      }
      content={
        <div className="vf-list">
          {showSearch && (
            <div className="vf-search-wrap">
              <input
                ref={searchRef}
                className="vf-search"
                placeholder="Search sprints..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          )}
          <div className="vf-quick">
            <button className="vf-quick-btn" onClick={selectAll}>All</button>
            <button className="vf-quick-btn" onClick={selectNone}>None</button>
            <button
              className="vf-quick-btn vf-quick-btn--current"
              onClick={selectCurrent}
              disabled={!currentVersion}
              title={currentVersion ? `Show current sprint (${currentVersion})` : 'No current sprint set'}
            >
              <StarIcon filled /> Current
            </button>
          </div>

          <div className="vf-options">
            {active.map(it => renderRow(it, true))}
            {active.length === 0 && completed.length === 0 && (
              <div className="vf-empty">No matches</div>
            )}

            {completed.length > 0 && (
              <>
                <button
                  type="button"
                  className="vf-section-toggle"
                  onClick={() => setShowCompleted(s => !s)}
                  aria-expanded={showCompleted}
                >
                  <ChevronIcon open={showCompleted} />
                  <span>Completed</span>
                  <span className="vf-section-count">{completed.length}</span>
                </button>
                {showCompleted && completed.map(it => renderRow(it, false))}
              </>
            )}
          </div>
        </div>
      }
    />
  );
}
