import type { CSSProperties } from 'react';
import {
  type RoadmapLayout, type RoadmapSortKey, type RoadmapMenuKey,
  SORT_LABEL, STATUS_COLOR, SIGNAL_COLOR,
  chipTrigger, popBase, optRow, sectionLabel, radioBox, checkBox, incBtn, excBtn,
} from './chrome';

/**
 * Roadmap toolbar — second row of the board card. Mirrors the Tasks `BoardToolbar`
 * atom-for-atom (search, Filter, Sort on the left; View-type + Properties on the
 * right; a primary "+ New Objective" button), but with roadmap-relevant controls
 * (drops task-only Sync/Versions/RICE/Assignee). Every chip opens its popover; the
 * state is real (search/sort/view-type/properties/filters), it just has nothing to
 * drive until the roadmap renderer lands.
 */

export interface RoadmapFilterField { inc: string[]; exc: string[] }
export interface RoadmapFilters { status: RoadmapFilterField; signal: RoadmapFilterField }
export type RoadmapCardProps = Record<'target' | 'forecast' | 'progress' | 'status' | 'dependencies' | 'priority' | 'tasks', boolean>;

interface RoadmapToolbarProps {
  search: string;
  setSearch: (v: string) => void;
  sortBy: RoadmapSortKey;
  setSort: (k: RoadmapSortKey) => void;
  sortDir: 'asc' | 'desc';
  toggleSortDir: () => void;
  layout: RoadmapLayout;
  setLayout: (l: RoadmapLayout) => void;
  cardProps: RoadmapCardProps;
  toggleCardProp: (k: keyof RoadmapCardProps) => void;
  filters: RoadmapFilters;
  cycleFilter: (section: keyof RoadmapFilters, value: string, kind: 'inc' | 'exc') => void;
  clearAllFilters: () => void;
  openMenu: RoadmapMenuKey;
  setOpenMenu: (m: RoadmapMenuKey) => void;
  onNewObjective: () => void;
}

const VIEW_TYPES: { v: RoadmapLayout; label: string; icon: string }[] = [
  { v: 'timeline', label: 'Timeline', icon: 'M4 6h10M8 11h11M4 16h7' },
  { v: 'board', label: 'Board', icon: 'M3 4h4v12H3zM10 4h4v9h-4zM17 4h4v6h-4z' },
];

const STATUS_OPTS: { value: string; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'active', label: 'Active' },
  { value: 'review', label: 'In review' },
  { value: 'done', label: 'Done' },
];
const SIGNAL_OPTS: { value: string; label: string }[] = [
  { value: 'on_track', label: 'On track' },
  { value: 'slipping', label: 'Slipping' },
  { value: 'unforecastable', label: 'Unforecastable' },
];

const PROP_DEFS: [keyof RoadmapCardProps, string][] = [
  ['target', 'Target date'], ['forecast', 'Forecast date'], ['progress', 'Progress bar'],
  ['status', 'Status dot'], ['dependencies', 'Dependencies'], ['priority', 'Impact / Effort'], ['tasks', 'Member tasks'],
];

export function RoadmapToolbar({
  search, setSearch, sortBy, setSort, sortDir, toggleSortDir, layout, setLayout,
  cardProps, toggleCardProp, filters, cycleFilter, clearAllFilters, openMenu, setOpenMenu, onNewObjective,
}: RoadmapToolbarProps) {
  const toggle = (m: RoadmapMenuKey) => setOpenMenu(openMenu === m ? null : m);
  const curVT = VIEW_TYPES.find((x) => x.v === layout) ?? VIEW_TYPES[0];
  const activeCount = filters.status.inc.length + filters.status.exc.length + filters.signal.inc.length + filters.signal.exc.length;

  const toggleRow = (section: keyof RoadmapFilters, value: string, label: string, color: string) => {
    const fld = filters[section];
    const incOn = fld.inc.includes(value), excOn = fld.exc.includes(value);
    return (
      <div key={value} className="bd-row" style={optRow}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: '0 0 auto' }} />
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span onClick={() => cycleFilter(section, value, 'inc')} title="Include" style={incBtn(incOn)}>✓</span>
        <span onClick={() => cycleFilter(section, value, 'exc')} title="Exclude" style={excBtn(excOn)}>✕</span>
      </div>
    );
  };

  const spacer: CSSProperties = { flex: 1, minWidth: 8 };

  return (
    <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', background: 'var(--color-bg-secondary)', borderBottom: '1px solid var(--color-border)', flexWrap: 'nowrap' }}>
      {/* search */}
      <div style={{ position: 'relative', flex: '0 1 212px', minWidth: 130 }}>
        <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--color-text-tertiary)', pointerEvents: 'none' }}>⌕</span>
        <input
          className="bd-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search objectives…" spellCheck={false}
          style={{ width: '100%', height: 34, padding: '0 12px 0 32px', borderRadius: 9, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13, fontFamily: 'var(--font-family-text)', outline: 'none' }}
        />
      </div>

      {/* Filter */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('filter')} style={chipTrigger(activeCount > 0)}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flex: '0 0 auto' }}><path d="M2 3.2h12L9.2 8.6V13L6.8 14V8.6L2 3.2Z" fill="currentColor" /></svg>
          <span>Filter</span>
          {activeCount > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 20, background: 'var(--color-accent)', color: '#fff' }}>{activeCount}</span>}
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'filter' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'filter' && (
          <div className="bd-pop bd-scroll" style={{ ...popBase, left: 0, width: 260, maxHeight: 'min(468px,72vh)', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px 9px', margin: '-6px -6px 5px', background: 'var(--color-bg-elevated)', borderBottom: '1px solid var(--color-border)', borderRadius: '11px 11px 0 0' }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text)', flex: 1 }}>Filter by</span>
              {activeCount > 0 && <span className="bd-danger" onClick={clearAllFilters} style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>Clear all</span>}
            </div>
            <div style={sectionLabel}>Status</div>
            {STATUS_OPTS.map((o) => toggleRow('status', o.value, o.label, STATUS_COLOR[o.value]))}
            <div style={{ ...sectionLabel, marginTop: 3, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>Signal</div>
            {SIGNAL_OPTS.map((o) => toggleRow('signal', o.value, o.label, SIGNAL_COLOR[o.value]))}
          </div>
        )}
      </div>

      {/* Sort */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('sort')} style={chipTrigger(sortBy !== 'manual')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3" /></svg>
          <span>{SORT_LABEL[sortBy]}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'sort' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'sort' && (
          <div className="bd-pop" style={{ ...popBase, left: 0, width: 190 }}>
            <div style={sectionLabel}>Sort by</div>
            {(Object.keys(SORT_LABEL) as RoadmapSortKey[]).map((k) => (
              <div key={k} className="bd-row" onClick={() => setSort(k)} style={optRow}>
                <span style={radioBox(sortBy === k)}>{sortBy === k ? '●' : ''}</span>
                <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{SORT_LABEL[k]}</span>
              </div>
            ))}
            <div onClick={sortBy === 'manual' ? undefined : toggleSortDir} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4, padding: '8px 9px', borderTop: '1px solid var(--color-border)', cursor: sortBy === 'manual' ? 'default' : 'pointer', fontSize: 12, color: sortBy === 'manual' ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)', opacity: sortBy === 'manual' ? 0.5 : 1 }}>
              <span>{sortDir === 'asc' ? 'Ascending' : 'Descending'}</span>
              <span style={{ fontSize: 13 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
            </div>
          </div>
        )}
      </div>

      <div style={spacer} />

      {/* View type */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('viewtype')} style={chipTrigger(false)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d={curVT.icon} /></svg>
          <span>{curVT.label}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'viewtype' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'viewtype' && (
          <div className="bd-pop" style={{ ...popBase, right: 0, width: 196 }}>
            <div style={sectionLabel}>View type</div>
            {VIEW_TYPES.map((vt) => { const active = layout === vt.v; return (
              <div key={vt.v} className="bd-row" onClick={() => { setLayout(vt.v); setOpenMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 13, color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)', background: active ? 'var(--color-accent-soft)' : 'transparent' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--color-accent)' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d={vt.icon} /></svg>
                <span style={{ flex: 1 }}>{vt.label}</span>
              </div>
            ); })}
          </div>
        )}
      </div>

      {/* Properties */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('props')} title="Choose which properties show on cards" style={{ ...chipTrigger(false), gap: 5, padding: '0 10px' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><circle cx="8" cy="7" r="2.4" /><path d="M13 7h7" /><circle cx="16" cy="17" r="2.4" /><path d="M4 17h7" /></svg>
          <span style={{ fontSize: 12.5 }}>Properties</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>⌄</span>
        </div>
        {openMenu === 'props' && (
          <div className="bd-pop" style={{ ...popBase, right: 0, width: 204 }}>
            <div style={{ ...sectionLabel, padding: '6px 8px 8px' }}>Shown on cards</div>
            {PROP_DEFS.map(([k, l]) => (
              <div key={k} className="bd-row" onClick={() => toggleCardProp(k)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                <span style={checkBox(cardProps[k])}>{cardProps[k] ? '✓' : ''}</span>
                <span style={{ flex: 1 }}>{l}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* new objective */}
      <div onClick={onNewObjective} className="bd-chip" style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, cursor: 'pointer', background: 'var(--color-accent)', color: '#fff', fontSize: 12.5, fontWeight: 600, boxShadow: '0 4px 12px -4px var(--color-accent)', flex: '0 0 auto' }}>+ New Objective</div>
    </div>
  );
}
