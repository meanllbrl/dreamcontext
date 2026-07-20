import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTheses, type ThesisKind, type ThesisStatus, type ThesisView } from '../../hooks/useTheses';
import { useObjectives } from '../../hooks/useObjectives';
import { usePersistedState } from '../../hooks/usePersistedState';
import { ThesisBoardToolbar, type ObjectiveFilterOption } from './ThesisBoardToolbar';
import { ThesisColumn } from './ThesisColumn';
import { ThesisDetailModal } from './ThesisDetailModal';
import { ThesisCreateModal } from './ThesisCreateModal';
import { DEFAULT_THESIS_DISPLAY, type ThesisDisplayProps } from './ThesisCard';
import { BASE_COLUMNS, type ThesisMenuKey, type ThesisSortKey, daysSince } from './thesis-chrome';
import './theses.css';
import './ThesisBoard.css';

/**
 * The Hypotheses board (design §Board). Owns filter/sort/display/archive
 * prefs (persisted per-project, mirroring `useRoadmapPrefs`'s shape but
 * client-only — no server round trip needed for a v1 board), the summary
 * strip, the meeting-note review banner, columns, and the detail/create
 * modals. `initialObjective`/`initialDetailSlug` let a caller (the objective
 * detail Learning section, via HypothesesPage) open the board pre-filtered or
 * jump straight to a thesis's detail modal.
 */

interface ThesisBoardPrefs {
  statusInc: ThesisStatus[];
  kind: 'all' | ThesisKind;
  blockedOnly: boolean;
  sort: ThesisSortKey;
  display: ThesisDisplayProps;
  archive: boolean;
}

const DEFAULT_PREFS: ThesisBoardPrefs = {
  statusInc: [], kind: 'all', blockedOnly: false, sort: 'updated', display: DEFAULT_THESIS_DISPLAY, archive: false,
};

function mergePrefs(stored: Partial<ThesisBoardPrefs>): ThesisBoardPrefs {
  return {
    statusInc: Array.isArray(stored.statusInc) ? stored.statusInc : DEFAULT_PREFS.statusInc,
    kind: stored.kind ?? DEFAULT_PREFS.kind,
    blockedOnly: stored.blockedOnly ?? DEFAULT_PREFS.blockedOnly,
    sort: stored.sort ?? DEFAULT_PREFS.sort,
    display: { ...DEFAULT_PREFS.display, ...(stored.display ?? {}) },
    archive: stored.archive ?? DEFAULT_PREFS.archive,
  };
}

interface ThesisBoardProps {
  initialObjective?: string | null;
  initialDetailSlug?: string | null;
}

export function ThesisBoard({ initialObjective = null, initialDetailSlug = null }: ThesisBoardProps) {
  const { data, isLoading } = useTheses();
  const { data: objectives = [] } = useObjectives();
  const [stored, setStored] = usePersistedState<Partial<ThesisBoardPrefs>>('theses:board:prefs:v1', DEFAULT_PREFS);
  const prefs = useMemo(() => mergePrefs(stored), [stored]);
  const update = useCallback((fn: (p: ThesisBoardPrefs) => ThesisBoardPrefs) => setStored((prev) => fn(mergePrefs(prev))), [setStored]);

  const [search, setSearch] = useState('');
  // Not persisted (transient): driven by navigation from the roadmap Learning
  // section, and re-seeded whenever the caller passes a new objective/slug.
  const [objective, setObjective] = useState<string | null>(initialObjective);
  useEffect(() => setObjective(initialObjective), [initialObjective]);

  const [openMenu, setOpenMenu] = useState<ThesisMenuKey>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const [detailSlug, setDetailSlug] = useState<string | null>(initialDetailSlug);
  useEffect(() => setDetailSlug(initialDetailSlug), [initialDetailSlug]);
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2600); return () => clearTimeout(t); }, [toast]);

  const allTheses = data?.theses ?? [];
  const candidates = data?.candidates ?? null;
  useEffect(() => { setReviewDismissed(false); }, [candidates?.note]);

  const objectivesById = useMemo(() => new Map(objectives.map((o) => [o.slug, o.title])), [objectives]);
  const objectiveOptions: ObjectiveFilterOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of allTheses) for (const slug of t.objectives) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([slug, count]) => ({ slug, title: objectivesById.get(slug) ?? slug, count }))
      .sort((a, b) => b.count - a.count);
  }, [allTheses, objectivesById]);

  // Pool after every filter EXCEPT status (so the Status dropdown's per-row
  // counts reflect what the other active filters already narrowed to).
  const preStatusPool = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allTheses.filter((t) => {
      if (!prefs.archive && t.status === 'retired') return false;
      if (q && !t.claim.toLowerCase().includes(q)) return false;
      if (prefs.kind !== 'all' && t.kind !== prefs.kind) return false;
      if (objective && !t.objectives.includes(objective)) return false;
      if (prefs.blockedOnly && !t.blocked_on_instrumentation) return false;
      return true;
    });
  }, [allTheses, search, prefs.archive, prefs.kind, prefs.blockedOnly, objective]);

  const statusCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of preStatusPool) out[t.status] = (out[t.status] ?? 0) + 1;
    return out;
  }, [preStatusPool]);

  // Retired cards bypass the Status filter — Archive is their sole gate,
  // since "retired" isn't one of the Status dropdown's own options.
  const filtered = useMemo(() => {
    if (prefs.statusInc.length === 0) return preStatusPool;
    return preStatusPool.filter((t) => t.status === 'retired' || prefs.statusInc.includes(t.status));
  }, [preStatusPool, prefs.statusInc]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    if (prefs.sort === 'confidence') list.sort((a, b) => b.confidence - a.confidence);
    else if (prefs.sort === 'staleness') {
      const stale = (t: ThesisView) => (t.checked_at ? daysSince(t.checked_at) : Infinity);
      list.sort((a, b) => stale(b) - stale(a));
    } else {
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return list;
  }, [filtered, prefs.sort]);

  const columns = prefs.archive ? [...BASE_COLUMNS, 'retired'] : [...BASE_COLUMNS];
  const byColumn = useMemo(() => {
    const m = new Map<string, ThesisView[]>();
    for (const col of columns) m.set(col, sorted.filter((t) => t.status === col));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, prefs.archive]);

  const hasActiveFilters = search.trim() !== '' || prefs.statusInc.length > 0 || prefs.kind !== 'all' || objective !== null || prefs.blockedOnly;
  const clearAllFilters = () => {
    setSearch(''); setObjective(null);
    update((p) => ({ ...p, statusInc: [], kind: 'all', blockedOnly: false }));
  };

  const toggleStatus = (s: ThesisStatus) => update((p) => ({
    ...p, statusInc: p.statusInc.includes(s) ? p.statusInc.filter((x) => x !== s) : [...p.statusInc, s],
  }));
  const toggleDisplay = (k: keyof ThesisDisplayProps) => update((p) => ({ ...p, display: { ...p.display, [k]: !p.display[k] } }));

  // Summary strip counts run over the FULL dataset (not the filtered view) —
  // they answer "how is the layer doing overall", same as the roadmap's tiles.
  const openRetested = allTheses.filter((t) => t.status === 'open' && t.cycles_checked > 0).length;
  const validatedCount = allTheses.filter((t) => t.status === 'validated').length;
  const invalidatedCount = allTheses.filter((t) => t.status === 'invalidated').length;
  const awaitingInstrumentation = allTheses.filter((t) => t.blocked_on_instrumentation).length;

  // "Last learning cycle" recency — derived honestly from the latest
  // `checked_at` across all theses. No cycle NUMBER or "running now" state is
  // shown: neither is cheaply/honestly derivable from what the API exposes
  // (no sleep-cycle counter rides along with /api/theses), so per the
  // no-fake-data rule this stays a plain recency line, nothing more.
  const lastCheckedAt = allTheses.reduce<string | null>((max, t) => {
    if (!t.checked_at) return max;
    return !max || t.checked_at > max ? t.checked_at : max;
  }, null);

  const showReviewBanner = !!candidates && candidates.items.length > 0 && !reviewDismissed;
  const [reviewOpen, setReviewOpen] = useState(false);

  return (
    <div style={{
      zoom: 'var(--zoom)',
      height: 'calc(100dvh - var(--header-height) - 2 * var(--space-4))',
      maxHeight: 'calc(100dvh - var(--header-height) - 2 * var(--space-4))',
      display: 'flex', flexDirection: 'column', position: 'relative', background: 'var(--color-bg)',
      border: '1px solid var(--color-border)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-md)',
    }}>
      <ThesisBoardToolbar
        count={allTheses.length}
        search={search} setSearch={setSearch}
        statusInc={prefs.statusInc} toggleStatus={toggleStatus} statusCounts={statusCounts}
        kind={prefs.kind} setKind={(kind) => update((p) => ({ ...p, kind }))}
        objectiveOptions={objectiveOptions} objective={objective} setObjective={setObjective}
        blockedOnly={prefs.blockedOnly} toggleBlocked={() => update((p) => ({ ...p, blockedOnly: !p.blockedOnly }))}
        sort={prefs.sort} setSort={(sort) => update((p) => ({ ...p, sort }))}
        display={prefs.display} toggleDisplay={toggleDisplay}
        archive={prefs.archive} toggleArchive={() => update((p) => ({ ...p, archive: !p.archive }))}
        hasActiveFilters={hasActiveFilters} clearAllFilters={clearAllFilters}
        openMenu={openMenu} setOpenMenu={setOpenMenu}
        onCreate={() => setShowCreate(true)}
      />

      <div className="thb-summary">
        <div className="thb-tile">
          <span className="thb-tile-value" style={{ color: 'var(--thesis-open)' }}>{openRetested}</span>
          <span className="thb-tile-label">Open · re-tested</span>
        </div>
        <div className="thb-tile">
          <span className="thb-tile-value" style={{ color: 'var(--thesis-validated)' }}>{validatedCount}</span>
          <span className="thb-tile-label">Validated</span>
        </div>
        <div className="thb-tile">
          <span className="thb-tile-value" style={{ color: 'var(--thesis-invalidated)' }}>{invalidatedCount}</span>
          <span className="thb-tile-label">Invalidated</span>
        </div>
        <div className="thb-tile">
          <span className="thb-tile-value" style={{ color: 'var(--thesis-amber)' }}>{awaitingInstrumentation}</span>
          <span className="thb-tile-label">Awaiting instrumentation</span>
        </div>
        <div className="thb-spacer" />
        <div className="thb-cycle">
          {lastCheckedAt
            ? `Last learning cycle · checked ${daysSince(lastCheckedAt)} day${daysSince(lastCheckedAt) === 1 ? '' : 's'} ago`
            : 'No learning cycles yet'}
        </div>
      </div>

      {showReviewBanner && candidates && (
        <div className="thb-banner thb-banner--review">
          <span className="thb-banner-icon">✎</span>
          <span className="thb-banner-text">{candidates.items.length} candidate hypotheses extracted from your note "{candidates.note}" — review, edit, confirm</span>
          <button type="button" className="thb-banner-btn" onClick={() => setReviewOpen(true)}>Review candidates</button>
          <span className="thb-banner-x" onClick={() => { setReviewDismissed(true); flash('Dismissed — the candidates stay queued for next time.'); }} title="Dismiss">✕</span>
        </div>
      )}

      <div className="thb-scroll">
        {isLoading ? (
          <Centered>Loading hypotheses…</Centered>
        ) : allTheses.length === 0 ? (
          <EmptyState onCreate={() => setShowCreate(true)} />
        ) : sorted.length === 0 ? (
          <NoMatch onClear={clearAllFilters} />
        ) : (
          <div className="thb-cols">
            {columns.map((col) => (
              <ThesisColumn key={col} status={col} theses={byColumn.get(col) ?? []} display={prefs.display} onOpen={setDetailSlug} />
            ))}
          </div>
        )}
      </div>

      {detailSlug && (
        <ThesisDetailModal slug={detailSlug} onClose={() => setDetailSlug(null)} />
      )}
      {showCreate && (
        <ThesisCreateModal mode="create" initialObjective={objective} onClose={() => setShowCreate(false)} />
      )}
      {reviewOpen && candidates && (
        <ThesisCreateModal mode="review" candidates={candidates.items} initialObjective={objective} onClose={() => { setReviewOpen(false); setReviewDismissed(true); }} />
      )}

      {toast && (
        <div className="bd-pop" style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: 9, padding: '10px 16px', borderRadius: 11, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)', fontSize: 13, color: 'var(--color-text)' }}>
          <span style={{ color: 'var(--thesis-violet)' }}>✓</span>{toast}
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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: 40, minHeight: 320 }}>
      <div style={{ width: 70, height: 70, borderRadius: 18, background: 'linear-gradient(160deg, rgba(157,140,255,0.16), rgba(157,140,255,0.05))', border: '1px solid rgba(157,140,255,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12, fontSize: 28 }}>
        💡
      </div>
      <div style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 22, color: 'var(--color-text)', letterSpacing: '-0.02em' }}>No hypotheses yet</div>
      <div style={{ fontSize: 14, color: 'var(--color-text-tertiary)', maxWidth: 460, lineHeight: 1.55 }}>
        A hypothesis is a falsifiable claim the brain tries to prove or disprove across sleep cycles — formed by sleep-learn during consolidation, or by you (or the agent) in conversation, including from meeting notes.
      </div>
      <button type="button" onClick={onCreate} className="bd-chip thesis-cta" style={{ marginTop: 14, padding: '10px 18px', borderRadius: 11, cursor: 'pointer', fontSize: 13.5, fontWeight: 600, border: 'none', boxShadow: '0 8px 20px -6px rgba(123,104,238,0.8)' }}>
        + Create your first hypothesis
      </button>
    </div>
  );
}

function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: 40, minHeight: 320 }}>
      <div style={{ width: 56, height: 56, borderRadius: 15, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: 'var(--color-text-tertiary)', marginBottom: 8 }}>⌕</div>
      <div style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: 18, color: 'var(--color-text)' }}>No hypotheses match your filters</div>
      <button type="button" onClick={onClear} className="bd-chip" style={{ marginTop: 8, padding: '8px 15px', borderRadius: 9, cursor: 'pointer', background: 'rgba(157,140,255,0.13)', color: 'var(--thesis-violet)', fontSize: 12.5, fontWeight: 600, border: 'none' }}>✕ Clear filters</button>
    </div>
  );
}
