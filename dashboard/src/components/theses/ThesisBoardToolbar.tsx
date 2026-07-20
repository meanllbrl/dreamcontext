import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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

// Triggers/rows are real <button>s so the toolbar is keyboard-operable;
// this strips the UA button chrome so chipTrigger/optRow styles win.
const btnReset: CSSProperties = { background: 'none', border: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', margin: 0 };
const rowBtn: CSSProperties = { ...optRow, ...btnReset, width: '100%' };

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
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openMenu === 'objective') objInputRef.current?.focus();
    else setObjQuery('');
  }, [openMenu]);

  // Close any open dropdown on outside click or Escape (mirrors the
  // LinkedItemPicker/ConfidencePopover pattern in ThesisDetailModal).
  useEffect(() => {
    if (!openMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu, setOpenMenu]);

  const selectedObjective = objectiveOptions.find((o) => o.slug === objective) ?? null;
  const filteredObjectives = useMemo(() => {
    const q = objQuery.trim().toLowerCase();
    const pool = q ? objectiveOptions.filter((o) => o.title.toLowerCase().includes(q)) : objectiveOptions;
    return pool.slice(0, 5);
  }, [objectiveOptions, objQuery]);

  return (
    <div ref={rootRef} style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', background: 'var(--color-bg-secondary)', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}>
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
        <button type="button" className="bd-chip" onClick={() => toggle('status')} aria-haspopup="menu" aria-expanded={openMenu === 'status'} style={chipTrigger(statusInc.length > 0)}>
          <span>Status</span>
          {statusInc.length > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 20, background: 'var(--thesis-violet)', color: '#fff' }}>{statusInc.length}</span>}
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'status' ? '▲' : '▼'}</span>
        </button>
        {openMenu === 'status' && (
          <div className="bd-pop" role="menu" style={{ ...popBase, left: 0, width: 200 }}>
            <div style={sectionLabel}>Status</div>
            {STATUS_ORDER.map((s) => (
              <button type="button" key={s} className="bd-row" role="menuitemcheckbox" aria-checked={statusInc.includes(s)} onClick={() => toggleStatus(s)} style={rowBtn}>
                <span style={checkBox(statusInc.includes(s))}>{statusInc.includes(s) ? '✓' : ''}</span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META[s].colorVar, flex: '0 0 auto' }} />
                <span style={{ flex: 1 }}>{STATUS_META[s].label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{statusCounts[s] ?? 0}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Kind radio */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <button type="button" className="bd-chip" onClick={() => toggle('kind')} aria-haspopup="menu" aria-expanded={openMenu === 'kind'} style={chipTrigger(kind !== 'all')}>
          <span>{kind === 'all' ? 'Kind' : KIND_META[kind].label}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'kind' ? '▲' : '▼'}</span>
        </button>
        {openMenu === 'kind' && (
          <div className="bd-pop" role="menu" style={{ ...popBase, left: 0, width: 190 }}>
            <div style={sectionLabel}>Kind</div>
            {KIND_OPTS.map((o) => (
              <button type="button" key={o.value} className="bd-row" role="menuitemradio" aria-checked={kind === o.value} onClick={() => { setKind(o.value); setOpenMenu(null); }} style={rowBtn}>
                <span style={radioBox(kind === o.value)}>{kind === o.value ? '●' : ''}</span>
                <span style={{ flex: 1 }}>{o.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Objective single-select searchable */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <button type="button" className="bd-chip" onClick={() => toggle('objective')} aria-haspopup="menu" aria-expanded={openMenu === 'objective'} style={chipTrigger(!!selectedObjective)} title={selectedObjective?.title}>
          <span style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedObjective ? selectedObjective.title : 'Objective'}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'objective' ? '▲' : '▼'}</span>
        </button>
        {openMenu === 'objective' && (
          <div className="bd-pop bd-scroll" role="menu" style={{ ...popBase, left: 0, width: 230 }}>
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
              <button type="button" className="bd-row" onClick={() => { setObjective(null); setOpenMenu(null); }} style={{ ...rowBtn, color: 'var(--color-text-tertiary)' }}>
                ✕ Clear objective
              </button>
            )}
            {filteredObjectives.length === 0 ? (
              <div style={{ padding: '8px 9px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>No objectives match</div>
            ) : (
              filteredObjectives.map((o) => (
                <button type="button" key={o.slug} className="bd-row" onClick={() => { setObjective(o.slug); setOpenMenu(null); }} style={rowBtn}>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.title}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{o.count}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Blocked toggle chip */}
      <button
        type="button"
        className="bd-chip"
        onClick={toggleBlocked}
        aria-pressed={blockedOnly}
        title="Blocked on instrumentation"
        style={{ ...chipTrigger(blockedOnly), ...(blockedOnly ? { border: '1px solid var(--thesis-amber)', background: 'rgba(227,179,65,0.14)', color: 'var(--thesis-amber)' } : {}) }}
      >
        ⚑ Blocked
      </button>

      {hasActiveFilters && (
        <button type="button" className="bd-danger" onClick={clearAllFilters} style={{ ...btnReset, fontSize: 12, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>✕ clear</button>
      )}

      <div style={{ flex: 1, minWidth: 8 }} />

      {/* Sort */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <button type="button" className="bd-chip" onClick={() => toggle('sort')} aria-haspopup="menu" aria-expanded={openMenu === 'sort'} style={chipTrigger(sort !== 'updated')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3" /></svg>
          <span>{SORT_LABEL[sort]}</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>{openMenu === 'sort' ? '▲' : '▼'}</span>
        </button>
        {openMenu === 'sort' && (
          <div className="bd-pop" role="menu" style={{ ...popBase, right: 0, width: 190 }}>
            <div style={sectionLabel}>Sort by</div>
            {(Object.keys(SORT_LABEL) as ThesisSortKey[]).map((k) => (
              <button type="button" key={k} className="bd-row" role="menuitemradio" aria-checked={sort === k} onClick={() => { setSort(k); setOpenMenu(null); }} style={rowBtn}>
                <span style={radioBox(sort === k)}>{sort === k ? '●' : ''}</span>
                <span style={{ flex: 1 }}>{SORT_LABEL[k]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Display */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <button type="button" className="bd-chip" onClick={() => toggle('display')} aria-haspopup="menu" aria-expanded={openMenu === 'display'} title="Choose which parts show on cards" style={{ ...chipTrigger(false), gap: 5, padding: '0 10px' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><circle cx="8" cy="7" r="2.4" /><path d="M13 7h7" /><circle cx="16" cy="17" r="2.4" /><path d="M4 17h7" /></svg>
          <span style={{ fontSize: 12.5 }}>Display</span>
          <span style={{ fontSize: 9, opacity: 0.7 }}>⌄</span>
        </button>
        {openMenu === 'display' && (
          <div className="bd-pop" role="menu" style={{ ...popBase, right: 0, width: 204 }}>
            <div style={{ ...sectionLabel, padding: '6px 8px 8px' }}>Shown on cards</div>
            {DISPLAY_DEFS.map(([k, l]) => (
              <button type="button" key={k} className="bd-row" role="menuitemcheckbox" aria-checked={display[k]} onClick={() => toggleDisplay(k)} style={rowBtn}>
                <span style={checkBox(display[k])}>{display[k] ? '✓' : ''}</span>
                <span style={{ flex: 1 }}>{l}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Archive toggle */}
      <button type="button" className="bd-chip" onClick={toggleArchive} aria-pressed={archive} style={chipTrigger(archive)} title="Show retired hypotheses as a 5th column">
        Archive
      </button>

      <button
        type="button"
        onClick={onCreate}
        className="bd-chip thesis-cta"
        aria-label="New hypothesis"
        style={{ border: 'none', font: 'inherit', margin: 0, display: 'flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, boxShadow: '0 4px 12px -4px rgba(123,104,238,0.6)', flex: '0 0 auto' }}
      >
        +
      </button>
    </div>
  );
}
