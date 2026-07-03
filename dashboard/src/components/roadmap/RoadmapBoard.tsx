import { useState, useCallback, useEffect, useMemo } from 'react';
import { RoadmapToolbar } from './RoadmapToolbar';
import { ObjectiveCreateModal } from './ObjectiveCreateModal';
import { RoadmapTimeline } from './RoadmapTimeline';
import { RoadmapBoardView } from './RoadmapBoardView';
import { ObjectiveDetailPanel } from './ObjectiveDetailPanel';
import type { RoadmapMenuKey } from './chrome';
import type { RoadmapFilterField } from './RoadmapToolbar';
import { buildForecasts } from './roadmap-forecast';
import { useRoadmapPrefs } from '../../hooks/useRoadmapPrefs';
import { useRoadmapItems } from '../../hooks/useRoadmapItems';
import '../tasks/Board.css';
import './RoadmapBoard.css';

/**
 * Roadmap board — the PO-authored OKR board. Renders the toolbar chrome (mirroring
 * the Tasks board) over an interactive body styled to the Claude roadmap design:
 * a forecast timeline (drag to reschedule, live dependency cascade) or a status
 * board, with a slide-over detail panel. Filters/sort/search are applied here and
 * fully wired; toolbar state persists per-machine via `useRoadmapPrefs`.
 */

/** A value passes a field filter when not excluded and (if includes are set) included. */
function passField(value: string, f: RoadmapFilterField): boolean {
  if (f.exc.includes(value)) return false;
  if (f.inc.length > 0 && !f.inc.includes(value)) return false;
  return true;
}

export function RoadmapBoard() {
  const { prefs, setSearch, setSort, toggleSortDir, setLayout, toggleCardProp, cycleFilter, clearAllFilters } = useRoadmapPrefs();
  const { search, sortBy, sortDir, layout, cardProps, filters } = prefs;
  const [openMenu, setOpenMenu] = useState<RoadmapMenuKey>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [warnDismissed, setWarnDismissed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const { items, warnings, isLoading } = useRoadmapItems();

  const flash = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2600); return () => clearTimeout(t); }, [toast]);
  const closeMenu = useCallback(() => setOpenMenu(null), []);

  // Forecast/slip cascade over the FULL set (hidden predecessors still constrain).
  const forecasts = useMemo(() => buildForecasts(items), [items]);
  const itemsBySlug = useMemo(() => new Map(items.map((i) => [i.slug, i])), [items]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = items.filter((it) =>
      (!q || it.title.toLowerCase().includes(q) || it.slug.includes(q))
      && passField(it.status, filters.status)
      && passField(forecasts.get(it.slug)?.signal ?? 'unforecastable', filters.signal),
    );
    const dir = sortDir === 'asc' ? 1 : -1;
    const byStr = (a: string | null | undefined, b: string | null | undefined) => (a ?? '9999-99-99').localeCompare(b ?? '9999-99-99') * dir;
    if (sortBy === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title) * dir);
    else if (sortBy === 'target') list = [...list].sort((a, b) => byStr(forecasts.get(a.slug)?.target, forecasts.get(b.slug)?.target));
    else if (sortBy === 'forecast') list = [...list].sort((a, b) => byStr(forecasts.get(a.slug)?.forecast_end, forecasts.get(b.slug)?.forecast_end));
    else if (sortBy === 'progress') list = [...list].sort((a, b) => ((a.progress.pct ?? -1) - (b.progress.pct ?? -1)) * dir);
    return list;
  }, [items, search, filters, sortBy, sortDir, forecasts]);

  const selectedItem = selected ? itemsBySlug.get(selected) : undefined;
  const selectedForecast = selected ? forecasts.get(selected) : undefined;
  const showWarn = warnings.length > 0 && !warnDismissed;

  return (
    <div style={{
      // Respect the app-wide zoom (top-bar "− 100% +"). The roadmap is a pixel-
      // geometry canvas (literal px, not the --font-size tokens the global zoom
      // scales), so it's immune to the token-based zoom. CSS `zoom` scales the
      // card's CONTENTS crisply (fonts, bars, axis, detail panel); the card BOX
      // keeps its natural fill size, so it never leaves empty space — the enlarged
      // content simply scrolls inside. (Do NOT divide width/height by --zoom: that
      // shrinks the box and under-fills the area.)
      zoom: 'var(--zoom)',
      height: 'calc(100dvh - var(--header-height) - 2 * var(--space-4))',
      maxHeight: 'calc(100dvh - var(--header-height) - 2 * var(--space-4))',
      display: 'flex', flexDirection: 'column', position: 'relative', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-md)',
    }}>
      <RoadmapToolbar
        search={search} setSearch={setSearch}
        sortBy={sortBy} setSort={setSort} sortDir={sortDir} toggleSortDir={toggleSortDir}
        layout={layout} setLayout={setLayout}
        cardProps={cardProps} toggleCardProp={toggleCardProp}
        filters={filters} cycleFilter={cycleFilter} clearAllFilters={clearAllFilters}
        openMenu={openMenu} setOpenMenu={setOpenMenu}
        onNewObjective={() => setShowCreate(true)}
      />

      {showWarn && (
        <div className="rm-warn">
          <span className="rm-warn-icon">⚠</span>
          <div className="rm-warn-list">
            {warnings.map((w, i) => <span className="rm-warn-item" key={i}>{w}</span>)}
          </div>
          <span className="rm-warn-x" onClick={() => setWarnDismissed(true)} title="Dismiss">✕</span>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--color-bg)' }}>
        {isLoading ? (
          <Centered>Loading objectives…</Centered>
        ) : items.length === 0 ? (
          <EmptyState onCreate={() => setShowCreate(true)} />
        ) : visible.length === 0 ? (
          <NoMatch onClear={clearAllFilters} />
        ) : layout === 'board' ? (
          <RoadmapBoardView items={visible} forecasts={forecasts} onOpen={setSelected} />
        ) : (
          <RoadmapTimeline items={visible} allItems={items} cardProps={cardProps} onOpen={setSelected} onToast={flash} />
        )}
      </div>

      {openMenu !== null && (
        <div onClick={closeMenu} style={{ position: 'absolute', inset: 0, zIndex: 35 }} />
      )}

      {selectedItem && selectedForecast && (
        <ObjectiveDetailPanel
          key={selectedItem.slug}
          item={selectedItem}
          forecast={selectedForecast}
          itemsBySlug={itemsBySlug}
          forecasts={forecasts}
          onOpen={setSelected}
          onClose={() => setSelected(null)}
          onToast={flash}
        />
      )}

      {showCreate && (
        <ObjectiveCreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(o) => flash(`Objective “${o.title}” created`)}
        />
      )}

      {toast && (
        <div className="bd-pop" style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: 9, padding: '10px 16px', borderRadius: 11, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)', fontSize: 13, color: 'var(--color-text)' }}>
          <span style={{ color: 'var(--color-accent)' }}>✓</span>{toast}
        </div>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>{children}</div>;
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: 40 }}>
      <div style={{ width: 70, height: 70, borderRadius: 18, background: 'linear-gradient(160deg, rgba(123,104,238,0.16), rgba(123,104,238,0.05))', border: '1px solid rgba(157,140,255,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
        <svg width="34" height="34" viewBox="0 0 32 32" fill="none"><line x1="5" y1="9" x2="20" y2="9" stroke="#9d8cff" strokeWidth="2.4" strokeLinecap="round" /><line x1="9" y1="16" x2="27" y2="16" stroke="#9d8cff" strokeWidth="2.4" strokeLinecap="round" opacity="0.65" /><line x1="5" y1="23" x2="16" y2="23" stroke="#9d8cff" strokeWidth="2.4" strokeLinecap="round" opacity="0.4" /></svg>
      </div>
      <div style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 22, color: 'var(--color-text)', letterSpacing: '-0.02em' }}>No objectives yet</div>
      <div style={{ fontSize: 14, color: 'var(--color-text-tertiary)', maxWidth: 440, lineHeight: 1.55 }}>A roadmap is a board of outcomes you're driving toward. Author your first objective — the system computes progress, forecasts and slip for you.</div>
      <button onClick={onCreate} className="bd-chip" style={{ marginTop: 14, padding: '10px 18px', borderRadius: 11, cursor: 'pointer', background: 'linear-gradient(150deg,#8b7bff,#6f5ce0)', color: '#fff', fontSize: 13.5, fontWeight: 600, border: 'none', boxShadow: '0 8px 20px -6px rgba(123,104,238,0.8)' }}>+ Create your first objective</button>
    </div>
  );
}

function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: 40 }}>
      <div style={{ width: 56, height: 56, borderRadius: 15, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: 'var(--color-text-tertiary)', marginBottom: 8 }}>⌕</div>
      <div style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 18, color: 'var(--color-text)' }}>No objectives match your filters</div>
      <div style={{ fontSize: 13.5, color: 'var(--color-text-tertiary)' }}>Try clearing a status or the slipping filter.</div>
      <button onClick={onClear} className="bd-chip" style={{ marginTop: 8, padding: '8px 15px', borderRadius: 9, cursor: 'pointer', background: 'var(--color-accent-soft)', color: 'var(--color-accent-text)', fontSize: 12.5, fontWeight: 600, border: 'none' }}>✕ Clear filters</button>
    </div>
  );
}
