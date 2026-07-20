import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThesisKind, ThesisStatus } from '../../hooks/useTheses';
import {
  type ThesisMenuKey, type ThesisSortKey, SORT_LABEL, STATUS_META, KIND_META,
  chipTrigger, popBase, optRow, sectionLabel, checkBox, radioBox,
} from './thesis-chrome';
import type { ThesisDisplayProps } from './ThesisCard';

const STATUS_ORDER: ThesisStatus[] = ['draft', 'open', 'validated', 'invalidated'];
const KIND_OPTS: { value: 'all' | ThesisKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'observational', label: 'Observational' },
  { value: 'experimental', label: 'Experimental' },
];
const DISPLAY_DEFS: [keyof ThesisDisplayProps, string][] = [
  ['kind', 'Kind'], ['confidence', 'Confidence'], ['evidence', 'Evidence breakdown'],
  ['cycles', 'Cycles checked'], ['staleness', 'Staleness'], ['links', 'Linked counts'],
  ['blocked', 'Blocked flag'], ['createdBy', 'Created by'],
];

export interface ObjectiveFilterOption { slug: string; title: string; count: number }

interface ThesisBoardToolbarProps {
  count: number;
  search: string;
  setSearch: (v: string) => void;
  statusInc: ThesisStatus[];
  toggleStatus: (s: ThesisStatus) => void;
  statusCounts: Record<string, number>;
  kind: 'all' | ThesisKind;
  setKind: (k: 'all' | ThesisKind) => void;
  objectiveOptions: ObjectiveFilterOption[];
  objective: string | null;
  setObjective: (slug: string | null) => void;
  blockedOnly: boolean;
  toggleBlocked: () => void;
  sort: ThesisSortKey;
  setSort: (s: ThesisSortKey) => void;
  display: ThesisDisplayProps;
  toggleDisplay: (k: keyof ThesisDisplayProps) => void;
  archive: boolean;
  toggleArchive: () => void;
  hasActiveFilters: boolean;
  clearAllFilters: () => void;
  openMenu: ThesisMenuKey;
  setOpenMenu: (m: ThesisMenuKey) => void;
  onCreate: () => void;
}

export function ThesisBoardToolbar({
  count, search, setSearch, statusInc, toggleStatus, statusCounts, kind, setKind,
  objectiveOptions, objective, setObjective, blockedOnly, toggleBlocked,
  sort, setSort, display, toggleDisplay, archive, toggleArchive,
  hasActiveFilters, clearAllFilters, openMenu, setOpenMenu, onCreate,
}: ThesisBoardToolbarProps) {
  const toggle = (m: ThesisMenuKey) => setOpenMenu(openMenu === m ? null : m);
  const [objQuery, setObjQuery] = useState('');
  const objInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openMenu === 'objective') objInputRef.current?.focus();
    else setObjQuery('');
  }, [openMenu]);

  const selectedObjective = objectiveOptions.find((o) => o.slug === objective) ?? null;
  const filteredObjectives = useMemo(() => {
    const q = objQuery.trim().toLowerCase();
    const pool = q ? objectiveOptions.filter((o) => o.title.toLowerCase().includes(q)) : objectiveOptions;
    return pool.slice(0, 5);
  }, [objectiveOptions, objQuery]);

  return (
    <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', background: 'var(--color-bg-secondary)', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}>
      <span style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 15, color: 'var(--color-text)', letterSpacing: '-0.01em' }}>Hypotheses</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{count}</span>

      {/* search — claim text only */}
      <div style={{ position: 'relative', flex: '0 1 200px', minWidth: 120 }}>
        <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--color-text-tertiary)', pointerEvents: 'none' }}>⌕</span>
        <input
          className="bd-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search claims…" spellCheck={false}
          style={{ width: '100%', height: 34, padding: '0 12px 0 32px', borderRadius: 9, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 13, fontFamily: 'var(--font-family-text)', outline: 'none' }}
        />
      </div>

      {/* Status multi-select */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('status')} style={chipTrigger(statusInc.length > 0)}>
          <span>Status</span>
          {statusInc.length > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 20, background: 'var(--thesis-violet)', color: '#fff' }}>{statusInc.length}</span>}
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'status' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'status' && (
          <div className="bd-pop" style={{ ...popBase, left: 0, width: 200 }}>
            <div style={sectionLabel}>Status</div>
            {STATUS_ORDER.map((s) => (
              <div key={s} className="bd-row" onClick={() => toggleStatus(s)} style={optRow}>
                <span style={checkBox(statusInc.includes(s))}>{statusInc.includes(s) ? '✓' : ''}</span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META[s].colorVar, flex: '0 0 auto' }} />
                <span style={{ flex: 1 }}>{STATUS_META[s].label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{statusCounts[s] ?? 0}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Kind radio */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('kind')} style={chipTrigger(kind !== 'all')}>
          <span>{kind === 'all' ? 'Kind' : KIND_META[kind].label}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'kind' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'kind' && (
          <div className="bd-pop" style={{ ...popBase, left: 0, width: 190 }}>
            <div style={sectionLabel}>Kind</div>
            {KIND_OPTS.map((o) => (
              <div key={o.value} className="bd-row" onClick={() => { setKind(o.value); setOpenMenu(null); }} style={optRow}>
                <span style={radioBox(kind === o.value)}>{kind === o.value ? '●' : ''}</span>
                <span style={{ flex: 1 }}>{o.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Objective single-select searchable */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('objective')} style={chipTrigger(!!selectedObjective)} title={selectedObjective?.title}>
          <span style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedObjective ? selectedObjective.title : 'Objective'}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'objective' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'objective' && (
          <div className="bd-pop bd-scroll" style={{ ...popBase, left: 0, width: 230 }}>
            <input
              ref={objInputRef}
              className="bd-input"
              value={objQuery}
              onChange={(e) => setObjQuery(e.target.value)}
              placeholder="Search objectives…"
              spellCheck={false}
              style={{ width: '100%', height: 30, padding: '0 9px', borderRadius: 7, border: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 12.5, marginBottom: 6, outline: 'none' }}
            />
            {selectedObjective && (
              <div className="bd-row" onClick={() => { setObjective(null); setOpenMenu(null); }} style={{ ...optRow, color: 'var(--color-text-tertiary)' }}>
                ✕ Clear objective
              </div>
            )}
            {filteredObjectives.length === 0 ? (
              <div style={{ padding: '8px 9px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>No objectives match</div>
            ) : (
              filteredObjectives.map((o) => (
                <div key={o.slug} className="bd-row" onClick={() => { setObjective(o.slug); setOpenMenu(null); }} style={optRow}>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.title}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{o.count}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Blocked toggle chip */}
      <div
        className="bd-chip"
        onClick={toggleBlocked}
        style={{ ...chipTrigger(blockedOnly), ...(blockedOnly ? { border: '1px solid var(--thesis-amber)', background: 'rgba(227,179,65,0.14)', color: 'var(--thesis-amber)' } : {}) }}
      >
        ⚑ Blocked
      </div>

      {hasActiveFilters && (
        <span className="bd-danger" onClick={clearAllFilters} style={{ fontSize: 12, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>✕ clear</span>
      )}

      <div style={{ flex: 1, minWidth: 8 }} />

      {/* Sort */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('sort')} style={chipTrigger(sort !== 'updated')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3" /></svg>
          <span>{SORT_LABEL[sort]}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'sort' ? '▲' : '▼'}</span>
        </div>
        {openMenu === 'sort' && (
          <div className="bd-pop" style={{ ...popBase, right: 0, width: 190 }}>
            <div style={sectionLabel}>Sort by</div>
            {(Object.keys(SORT_LABEL) as ThesisSortKey[]).map((k) => (
              <div key={k} className="bd-row" onClick={() => { setSort(k); setOpenMenu(null); }} style={optRow}>
                <span style={radioBox(sort === k)}>{sort === k ? '●' : ''}</span>
                <span style={{ flex: 1 }}>{SORT_LABEL[k]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Display */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <div className="bd-chip" onClick={() => toggle('display')} title="Choose which parts show on cards" style={{ ...chipTrigger(false), gap: 5, padding: '0 10px' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><circle cx="8" cy="7" r="2.4" /><path d="M13 7h7" /><circle cx="16" cy="17" r="2.4" /><path d="M4 17h7" /></svg>
          <span style={{ fontSize: 12.5 }}>Display</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>⌄</span>
        </div>
        {openMenu === 'display' && (
          <div className="bd-pop" style={{ ...popBase, right: 0, width: 204 }}>
            <div style={{ ...sectionLabel, padding: '6px 8px 8px' }}>Shown on cards</div>
            {DISPLAY_DEFS.map(([k, l]) => (
              <div key={k} className="bd-row" onClick={() => toggleDisplay(k)} style={optRow}>
                <span style={checkBox(display[k])}>{display[k] ? '✓' : ''}</span>
                <span style={{ flex: 1 }}>{l}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Archive toggle */}
      <div className="bd-chip" onClick={toggleArchive} style={chipTrigger(archive)} title="Show retired hypotheses as a 5th column">
        Archive
      </div>

      <div
        onClick={onCreate}
        className="bd-chip thesis-cta"
        style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, boxShadow: '0 4px 12px -4px rgba(123,104,238,0.6)', flex: '0 0 auto' }}
      >
        +
      </div>
    </div>
  );
}
