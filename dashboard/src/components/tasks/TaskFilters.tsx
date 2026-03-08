import { useState, useMemo } from 'react';
import { useI18n } from '../../context/I18nContext';
import { FilterPopover } from './FilterPopover';
import { MultiSelectFilter } from './MultiSelectFilter';
import { MiniCalendar } from './MiniCalendar';
import './TaskFilters.css';

export type SortField = 'updated_at' | 'created_at' | 'priority' | 'urgency' | 'name';
export type GroupBy = 'status' | 'priority' | 'urgency' | 'tags' | 'version' | 'none';
export type ViewMode = 'kanban' | 'eisenhower';
export type DateField = 'created_at' | 'updated_at';

export interface FilterState {
  priorityFilter: string[];
  statusFilter: string[];
  urgencyFilter: string[];
  tagFilter: string[];
  versionFilter: string[];
  searchQuery: string;
  dateField: DateField;
  dateFrom: string;
  dateTo: string;
  sortField: SortField;
  groupBy: GroupBy;
  subGroupBy: GroupBy;
  viewMode: ViewMode;
}

export const DEFAULT_FILTERS: FilterState = {
  priorityFilter: [],
  statusFilter: [],
  urgencyFilter: [],
  tagFilter: [],
  versionFilter: [],
  searchQuery: '',
  dateField: 'updated_at',
  dateFrom: '',
  dateTo: '',
  sortField: 'updated_at',
  groupBy: 'status',
  subGroupBy: 'none',
  viewMode: 'kanban',
};

export interface FilterPreset {
  id: string;
  name: string;
  filters: FilterState;
}

interface TaskFiltersProps {
  filters: FilterState;
  onFilterChange: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void;
  onClearFilters: () => void;
  onCreateClick: () => void;
  presets: FilterPreset[];
  onSavePreset: (name: string) => void;
  onLoadPreset: (preset: FilterPreset) => void;
  onDeletePreset: (id: string) => void;
  allTags: string[];
  allVersions: string[];
  onVersionManagerClick: () => void;
}

// ─── Icons ───

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="5.8" cy="5.8" r="4.3" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M9 9L12.5 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}

function ChevronIcon({ open }: { open?: boolean }) {
  return (
    <svg className={`filter-chip-chevron ${open ? 'filter-chip-chevron--open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="filter-option-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M3 7L6 10L11 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2.5" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M1.5 5.5H12.5" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M4.5 1V3.5M9.5 1V3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
      <path d="M4 1.5V5H10V1.5" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="4" y="7.5" width="6" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  );
}

function KanbanIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="1" width="3.5" height="12" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="5.25" y="1" width="3.5" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="9.5" y="1" width="3.5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  );
}

function MatrixIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="1" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="7.5" y="1" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="1" y="7.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="7.5" y="7.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  );
}

function MilestoneIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <path d="M2 2V12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <path d="M2 3H9L7 5.5L9 8H2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
    </svg>
  );
}

// ─── Data ───

const STATUS_OPTIONS = [
  { value: 'todo', label: 'To Do', color: 'var(--color-status-todo)' },
  { value: 'in_progress', label: 'In Progress', color: 'var(--color-status-in-progress)' },
  { value: 'in_review', label: 'In Review', color: 'var(--color-status-in-review)' },
  { value: 'completed', label: 'Completed', color: 'var(--color-status-completed)' },
];

const PRIORITY_OPTIONS = [
  { value: 'critical', label: 'Critical', color: 'var(--color-priority-critical)' },
  { value: 'high', label: 'High', color: 'var(--color-priority-high)' },
  { value: 'medium', label: 'Medium', color: 'var(--color-priority-medium)' },
  { value: 'low', label: 'Low', color: 'var(--color-priority-low)' },
];

const URGENCY_OPTIONS = [
  { value: 'critical', label: 'Critical', color: 'var(--color-urgency-critical)' },
  { value: 'high', label: 'High', color: 'var(--color-urgency-high)' },
  { value: 'medium', label: 'Medium', color: 'var(--color-urgency-medium)' },
  { value: 'low', label: 'Low', color: 'var(--color-urgency-low)' },
];

const SORT_OPTIONS = [
  { value: 'updated_at', label: 'Last updated' },
  { value: 'created_at', label: 'Date created' },
  { value: 'priority', label: 'Priority' },
  { value: 'urgency', label: 'Urgency' },
  { value: 'name', label: 'Name' },
];

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'urgency', label: 'Urgency' },
  { value: 'tags', label: 'Tags' },
  { value: 'version', label: 'Version' },
  { value: 'none', label: 'No grouping' },
];

function countActiveFilters(f: FilterState): number {
  let n = 0;
  if (f.priorityFilter.length > 0) n++;
  if (f.statusFilter.length > 0) n++;
  if (f.urgencyFilter.length > 0) n++;
  if (f.tagFilter.length > 0) n++;
  if (f.versionFilter.length > 0) n++;
  if (f.searchQuery.trim()) n++;
  if (f.dateFrom || f.dateTo) n++;
  return n;
}

function getDateChipLabel(f: FilterState): string | null {
  if (!f.dateFrom && !f.dateTo) return null;
  const t = new Date().toISOString().slice(0, 10);
  if (f.dateFrom === t && f.dateTo === t) return 'Today';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  if (f.dateFrom === yStr && f.dateTo === yStr) return 'Yesterday';
  if (f.dateTo === t) {
    const d7 = new Date(); d7.setDate(d7.getDate() - 6);
    if (f.dateFrom === d7.toISOString().slice(0, 10)) return 'Last 7 days';
    const d30 = new Date(); d30.setDate(d30.getDate() - 29);
    if (f.dateFrom === d30.toISOString().slice(0, 10)) return 'Last 30 days';
  }
  return 'Custom';
}

// ─── Component ───

export function TaskFilters({
  filters,
  onFilterChange,
  onClearFilters,
  onCreateClick,
  presets,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
  allTags,
  allVersions,
  onVersionManagerClick,
}: TaskFiltersProps) {
  const { t } = useI18n();
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');

  const activeCount = countActiveFilters(filters);
  const dateLabel = useMemo(() => getDateChipLabel(filters), [filters]);

  const toggle = (id: string) => setOpenPopover(prev => prev === id ? null : id);
  const close = () => setOpenPopover(null);

  const sortLabel = SORT_OPTIONS.find(o => o.value === filters.sortField)?.label;
  const groupLabel = GROUP_OPTIONS.find(o => o.value === filters.groupBy)?.label;

  const tagOptions = useMemo(() => allTags.map(t => ({ value: t, label: t })), [allTags]);
  const versionOptions = useMemo(() => allVersions.map(v => ({ value: v, label: v })), [allVersions]);

  const subGroupOptions = useMemo(
    () => GROUP_OPTIONS.filter(o => o.value !== filters.groupBy && o.value !== 'none').concat({ value: 'none', label: 'No sub-group' }),
    [filters.groupBy],
  );

  return (
    <div className="filter-bar">
      {/* Search */}
      <div className="filter-search">
        <SearchIcon />
        <input
          className="filter-search-input"
          placeholder="Search tasks..."
          value={filters.searchQuery}
          onChange={e => onFilterChange('searchQuery', e.target.value)}
        />
        {filters.searchQuery && (
          <button className="filter-search-clear" onClick={() => onFilterChange('searchQuery', '')}>
            <XIcon />
          </button>
        )}
      </div>

      <div className="filter-bar-divider" />

      {/* Status multi-select */}
      <MultiSelectFilter
        id="status"
        label="Status"
        options={STATUS_OPTIONS}
        selected={filters.statusFilter}
        onChange={v => onFilterChange('statusFilter', v)}
        isOpen={openPopover === 'status'}
        onToggle={() => toggle('status')}
        onClose={close}
      />

      {/* Priority multi-select */}
      <MultiSelectFilter
        id="priority"
        label="Priority"
        options={PRIORITY_OPTIONS}
        selected={filters.priorityFilter}
        onChange={v => onFilterChange('priorityFilter', v)}
        isOpen={openPopover === 'priority'}
        onToggle={() => toggle('priority')}
        onClose={close}
      />

      {/* Urgency multi-select */}
      <MultiSelectFilter
        id="urgency"
        label="Urgency"
        options={URGENCY_OPTIONS}
        selected={filters.urgencyFilter}
        onChange={v => onFilterChange('urgencyFilter', v)}
        isOpen={openPopover === 'urgency'}
        onToggle={() => toggle('urgency')}
        onClose={close}
      />

      {/* Tags multi-select */}
      {tagOptions.length > 0 && (
        <MultiSelectFilter
          id="tags"
          label="Tags"
          options={tagOptions}
          selected={filters.tagFilter}
          onChange={v => onFilterChange('tagFilter', v)}
          isOpen={openPopover === 'tags'}
          onToggle={() => toggle('tags')}
          onClose={close}
        />
      )}

      {/* Version multi-select */}
      {versionOptions.length > 0 && (
        <MultiSelectFilter
          id="version"
          label="Version"
          options={versionOptions}
          selected={filters.versionFilter}
          onChange={v => onFilterChange('versionFilter', v)}
          isOpen={openPopover === 'version'}
          onToggle={() => toggle('version')}
          onClose={close}
        />
      )}

      {/* Date chip */}
      <FilterPopover
        isOpen={openPopover === 'date'}
        onClose={close}
        width={320}
        trigger={
          <button
            className={`filter-chip ${dateLabel ? 'filter-chip--active' : ''}`}
            onClick={() => toggle('date')}
          >
            <CalendarIcon />
            <span className="filter-chip-label">{dateLabel ?? 'Date'}</span>
            <ChevronIcon open={openPopover === 'date'} />
          </button>
        }
        content={
          <MiniCalendar
            dateField={filters.dateField}
            dateFrom={filters.dateFrom}
            dateTo={filters.dateTo}
            onDateFieldChange={v => onFilterChange('dateField', v)}
            onDateFromChange={v => onFilterChange('dateFrom', v)}
            onDateToChange={v => onFilterChange('dateTo', v)}
          />
        }
      />

      {activeCount > 0 && (
        <button className="filter-clear-all" onClick={onClearFilters}>
          Clear <span className="filter-clear-count">{activeCount}</span>
        </button>
      )}

      <div className="filter-bar-spacer" />

      {/* View mode toggle */}
      <div className="filter-view-toggle">
        <button
          className={`filter-view-btn ${filters.viewMode === 'kanban' ? 'filter-view-btn--active' : ''}`}
          onClick={() => onFilterChange('viewMode', 'kanban')}
          title="Kanban view"
        >
          <KanbanIcon />
        </button>
        <button
          className={`filter-view-btn ${filters.viewMode === 'eisenhower' ? 'filter-view-btn--active' : ''}`}
          onClick={() => onFilterChange('viewMode', 'eisenhower')}
          title="Eisenhower matrix"
        >
          <MatrixIcon />
        </button>
      </div>

      <div className="filter-bar-divider" />

      {/* Sort chip */}
      <FilterPopover
        isOpen={openPopover === 'sort'}
        onClose={close}
        align="right"
        trigger={
          <button className="filter-chip filter-chip--subtle" onClick={() => toggle('sort')}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M2 4H12M4 7H10M6 10H8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            <span className="filter-chip-label">{sortLabel}</span>
            <ChevronIcon open={openPopover === 'sort'} />
          </button>
        }
        content={
          <div className="filter-option-list">
            <div className="filter-popover-section">Sort by</div>
            {SORT_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={`filter-option ${filters.sortField === opt.value ? 'filter-option--selected' : ''}`}
                onClick={() => { onFilterChange('sortField', opt.value as SortField); close(); }}
              >
                <span className="filter-option-label">{opt.label}</span>
                {filters.sortField === opt.value && <CheckIcon />}
              </button>
            ))}
          </div>
        }
      />

      {/* Group chip */}
      <FilterPopover
        isOpen={openPopover === 'group'}
        onClose={close}
        align="right"
        trigger={
          <button className="filter-chip filter-chip--subtle" onClick={() => toggle('group')}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <rect x="1.5" y="2" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
              <rect x="8" y="2" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
              <rect x="1.5" y="8.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
              <rect x="8" y="8.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
            <span className="filter-chip-label">{groupLabel}</span>
            <ChevronIcon open={openPopover === 'group'} />
          </button>
        }
        content={
          <div className="filter-option-list">
            <div className="filter-popover-section">Group by</div>
            {GROUP_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={`filter-option ${filters.groupBy === opt.value ? 'filter-option--selected' : ''}`}
                onClick={() => { onFilterChange('groupBy', opt.value as GroupBy); close(); }}
              >
                <span className="filter-option-label">{opt.label}</span>
                {filters.groupBy === opt.value && <CheckIcon />}
              </button>
            ))}
            {filters.groupBy !== 'none' && (
              <>
                <div className="filter-popover-section" style={{ marginTop: 'var(--space-2)' }}>Sub-group by</div>
                {subGroupOptions.map(opt => (
                  <button
                    key={`sub-${opt.value}`}
                    className={`filter-option ${filters.subGroupBy === opt.value ? 'filter-option--selected' : ''}`}
                    onClick={() => { onFilterChange('subGroupBy', opt.value as GroupBy); close(); }}
                  >
                    <span className="filter-option-label">{opt.label}</span>
                    {filters.subGroupBy === opt.value && <CheckIcon />}
                  </button>
                ))}
              </>
            )}
          </div>
        }
      />

      <div className="filter-bar-divider" />

      {/* Version manager */}
      <button className="filter-chip filter-chip--subtle" onClick={onVersionManagerClick} title="Manage versions">
        <MilestoneIcon />
      </button>

      {/* Views / Presets */}
      <FilterPopover
        isOpen={openPopover === 'views'}
        onClose={close}
        align="right"
        width={220}
        trigger={
          <button className="filter-chip filter-chip--subtle" onClick={() => toggle('views')}>
            <SaveIcon />
            <span className="filter-chip-label">Views</span>
            {presets.length > 0 && <span className="filter-chip-badge">{presets.length}</span>}
          </button>
        }
        content={
          <div className="filter-views">
            {presets.length === 0 ? (
              <div className="filter-views-empty">No saved views yet</div>
            ) : (
              <div className="filter-views-list">
                {presets.map(p => (
                  <div key={p.id} className="filter-views-item">
                    <button
                      className="filter-views-load"
                      onClick={() => { onLoadPreset(p); close(); }}
                    >
                      {p.name}
                    </button>
                    <button className="filter-views-delete" onClick={() => onDeletePreset(p.id)}>
                      <XIcon />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="filter-popover-divider" />
            <div className="filter-views-save">
              <input
                className="filter-views-input"
                placeholder="Save current view..."
                value={presetName}
                onChange={e => setPresetName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && presetName.trim()) {
                    onSavePreset(presetName.trim());
                    setPresetName('');
                  }
                }}
              />
              <button
                className="filter-views-save-btn"
                disabled={!presetName.trim()}
                onClick={() => {
                  if (presetName.trim()) {
                    onSavePreset(presetName.trim());
                    setPresetName('');
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>
        }
      />

      {/* Create */}
      <button className="filter-create-btn" onClick={onCreateClick}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 2V12M2 7H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        {t('tasks.create')}
      </button>
    </div>
  );
}
