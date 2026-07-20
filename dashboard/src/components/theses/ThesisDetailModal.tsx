import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useThesis,
  useSetStatus,
  useLinkThesis,
  useUnlinkThesis,
  usePromoteThesis,
  type EvidenceSource,
  type EvidenceVerdict,
  type PredictionStanding,
  type ThesisLinkKind,
} from '../../hooks/useTheses';
import { useLabInsights } from '../../hooks/useLab';
import { useObjectives } from '../../hooks/useObjectives';
import { useTasks } from '../../hooks/useTasks';
import { ConfidenceBar } from './ConfidenceBar';
import './theses.css';
import './ThesisDetailModal.css';

/**
 * Centered detail modal for one thesis (Hypotheses board). Confidence is always
 * DERIVED upstream (src/lib/theses/confidence.ts) — this component only renders
 * the breakdown the server already computed, never recomputes it.
 */
export interface ThesisDetailModalProps {
  slug: string;
  onClose: () => void;
  /**
   * Navigate the shell to another page, optionally focusing one item on it
   * (e.g. `onNavigate('lab', insightSlug)`). See the T11 hand-off note in the
   * implementation report for the exact contract expected here.
   */
  onNavigate?: (page: string, focusId?: string) => void;
}

type EvidenceFilter = 'all' | EvidenceVerdict;
type ToastKind = 'ok' | 'info' | 'warn' | 'undo';
interface ToastState { msg: string; kind: ToastKind; }

const TOAST_GLYPH: Record<ToastKind, string> = { ok: '✓', info: '◈', warn: '⚑', undo: '⟲' };
const TOAST_INK: Record<ToastKind, string> = {
  ok: 'var(--thesis-validated)', info: 'var(--thesis-open)', warn: 'var(--thesis-amber)', undo: 'var(--thesis-violet)',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', open: 'Open', validated: 'Validated', invalidated: 'Invalidated', retired: 'Retired',
};

const KIND_META: Record<string, { glyph: string; label: string; ink: string }> = {
  observational: { glyph: '👁', label: 'Observational', ink: 'var(--thesis-violet)' },
  experimental: { glyph: '⚗', label: 'Experimental', ink: 'var(--thesis-amber)' },
};

const VERDICT_META: Record<EvidenceVerdict, { label: string; ink: string }> = {
  supports: { label: 'Supports', ink: 'var(--thesis-validated)' },
  contradicts: { label: 'Contradicts', ink: 'var(--thesis-invalidated)' },
  'no-signal': { label: 'No signal', ink: 'var(--thesis-draft)' },
};

// 'changelog' is a valid EvidenceSource (a cited session/changelog entry) but the
// PO's captured design only pinned glyphs for insight/task/objective/external —
// this entry is a sane default so the ledger never renders an undefined glyph.
const SOURCE_META: Record<EvidenceSource, { glyph: string; label: string; ink: string }> = {
  insight: { glyph: '◈', label: 'Insight', ink: 'var(--thesis-open)' },
  task: { glyph: '▦', label: 'Task', ink: 'var(--thesis-violet)' },
  objective: { glyph: '◇', label: 'Objective', ink: 'var(--thesis-amber)' },
  external: { glyph: '⇲', label: 'External', ink: 'var(--thesis-draft)' },
  changelog: { glyph: '≡', label: 'Changelog', ink: 'var(--thesis-draft)' },
};

const STANDING_META: Record<PredictionStanding, { glyph: string; ink: string; label: string }> = {
  supported: { glyph: '✓', ink: 'var(--thesis-validated)', label: 'Supported' },
  contradicted: { glyph: '✕', ink: 'var(--thesis-invalidated)', label: 'Contradicted' },
  untested: { glyph: '○', ink: 'var(--thesis-draft)', label: 'Untested' },
};

const EVIDENCE_FILTERS: { key: EvidenceFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'supports', label: 'Supports' },
  { key: 'contradicts', label: 'Contradicts' },
  { key: 'no-signal', label: 'No signal' },
];

/** Confidence % ink thresholds pinned by the design — mirrors ConfidenceBar's own (unexported) helper. */
function confidenceInk(pct: number): string {
  if (pct >= 66) return 'var(--thesis-validated)';
  if (pct >= 40) return 'var(--thesis-amber)';
  return 'var(--thesis-invalidated)';
}

interface PickerOption { slug: string; title: string; }

/**
 * Inline "+" typeahead used by all three right-rail link groups. Opens a small
 * popover capped at 6 results, excluding already-linked slugs. Picking a row
 * fires immediately (no multi-select/staging) — each link is its own mutation.
 */
function LinkedItemPicker({
  options, excluded, placeholder, onPick,
}: { options: PickerOption[]; excluded: string[]; placeholder: string; onPick: (slug: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const excludedSet = useMemo(() => new Set(excluded), [excluded]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = options.filter((o) => !excludedSet.has(o.slug));
    const matched = q ? pool.filter((o) => o.title.toLowerCase().includes(q) || o.slug.includes(q)) : pool;
    return matched.slice(0, 6);
  }, [options, excludedSet, query]);

  const pick = (target: string) => { setOpen(false); setQuery(''); onPick(target); };

  return (
    <div className="td-picker" ref={ref}>
      <button type="button" className="td-picker-trigger" onClick={() => setOpen((v) => !v)} aria-label={placeholder} title={placeholder}>
        +
      </button>
      {open && (
        <div className="td-picker-pop">
          <input
            ref={inputRef}
            className="td-picker-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
          />
          <div className="td-picker-list bd-scroll">
            {filtered.length === 0 ? (
              <div className="td-picker-empty">{options.length === 0 ? 'Nothing to link yet.' : 'No matches.'}</div>
            ) : (
              filtered.map((o) => (
                <div key={o.slug} className="td-picker-row" onClick={() => pick(o.slug)}>
                  <span className="td-picker-row-title">{o.title}</span>
                  <span className="td-picker-row-slug">{o.slug}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One right-rail group: header (title + count + picker), item chips w/ remove, empty state. */
function LinkGroup({
  title, items, onRemove, onOpen, picker,
}: {
  title: string;
  items: { slug: string; title: string }[];
  onRemove: (slug: string) => void;
  onOpen: (slug: string) => void;
  picker: React.ReactNode;
}) {
  return (
    <section className="td-rail-group">
      <div className="td-rail-head">
        <span className="td-rail-title">{title}</span>
        <span className="td-rail-count">{items.length}</span>
        {picker}
      </div>
      {items.length === 0 ? (
        <p className="td-rail-empty">None linked.</p>
      ) : (
        <ul className="td-rail-list">
          {items.map((it) => (
            <li key={it.slug} className="td-rail-item">
              <span className="td-rail-item-title" onClick={() => onOpen(it.slug)} title={it.slug}>{it.title}</span>
              <button className="td-rail-item-x" onClick={() => onRemove(it.slug)} title="Remove" aria-label={`Remove ${it.title}`}>×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Controlled "How is this computed?" popover — open state lives in the parent so
 *  the modal's single Escape handler can close it in priority order. */
function ConfidencePopover({
  ws, wc, pct, open, onToggle, onRequestClose,
}: { ws: number; wc: number; pct: number; open: boolean; onToggle: () => void; onRequestClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onRequestClose(); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, onRequestClose]);

  return (
    <div className="td-conf-info" ref={ref}>
      <button type="button" className="td-conf-info-trigger" onClick={onToggle}>
        ⓘ How is this computed?
      </button>
      {open && (
        <div className="td-conf-info-pop" role="tooltip">
          <p>Confidence is computed from the evidence ledger — it is never set by hand. More recent evidence is weighted more heavily.</p>
          <div className="td-conf-info-row"><span>ws (supports)</span><span className="td-mono">{ws.toFixed(2)}</span></div>
          <div className="td-conf-info-row"><span>wc (contradicts)</span><span className="td-mono">{wc.toFixed(2)}</span></div>
          <div className="td-conf-info-formula td-mono">(ws+0.4)/(ws+wc+0.8) = {pct}%</div>
        </div>
      )}
    </div>
  );
}

export function ThesisDetailModal({ slug, onClose, onNavigate }: ThesisDetailModalProps) {
  const { data, isLoading, isError, error } = useThesis(slug);
  const thesis = data?.thesis ?? null;
  const cb = data?.confidence ?? thesis?.confidenceBreakdown ?? { confidence: 0.5, ws: 0, wc: 0, supports: 0, contradicts: 0, noSignal: 0 };
  const pct = Math.round(Math.max(0, Math.min(1, cb.confidence)) * 100);

  const setStatus = useSetStatus();
  const linkThesis = useLinkThesis();
  const unlinkThesis = useUnlinkThesis();
  const promoteThesis = usePromoteThesis();

  const { data: allInsights = [] } = useLabInsights();
  const { data: allObjectives = [] } = useObjectives();
  const { data: allTasks = [] } = useTasks();

  const insightsBySlug = useMemo(() => new Map(allInsights.map((i) => [i.slug, i.title])), [allInsights]);
  const objectivesBySlug = useMemo(() => new Map(allObjectives.map((o) => [o.slug, o.title])), [allObjectives]);
  const tasksBySlug = useMemo(() => new Map(allTasks.map((t) => [t.slug, t.name])), [allTasks]);

  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilter>('all');
  const [confidenceInfoOpen, setConfidenceInfoOpen] = useState(false);
  const [pendingFlip, setPendingFlip] = useState<'validated' | 'invalidated' | null>(null);
  const [citedIndices, setCitedIndices] = useState<number[]>([]);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promotePath, setPromotePath] = useState('');
  const [promoteRetire, setPromoteRetire] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);

  const flash = (msg: string, kind: ToastKind = 'ok') => setToast({ msg, kind });
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // Evidence ledger is stored chronologically oldest-first (see EvidenceEvent
  // JSDoc in useTheses.ts). Keep the true array index attached through both the
  // display reversal AND the citation filter, since `citations` sent to the
  // server are indices into the CANONICAL (oldest-first) `thesis.evidence` array.
  const indexed = useMemo(
    () => (thesis?.evidence ?? []).map((e, idx) => ({ ...e, idx })),
    [thesis?.evidence],
  );
  const newestFirst = useMemo(() => [...indexed].reverse(), [indexed]);
  const filteredEvidence = useMemo(
    () => (evidenceFilter === 'all' ? newestFirst : newestFirst.filter((e) => e.verdict === evidenceFilter)),
    [newestFirst, evidenceFilter],
  );

  // Single Escape-priority chain for every sub-UI this modal owns directly
  // (mirrors ObjectiveDetailPanel's own priority chain). LinkedItemPicker manages
  // its own outside-click-close and is intentionally NOT part of this chain —
  // same precedent as DependencyPicker/InsightPicker nested in that panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (confidenceInfoOpen) { setConfidenceInfoOpen(false); return; }
      if (pendingFlip) { setPendingFlip(null); setCitedIndices([]); return; }
      if (promoteOpen) { setPromoteOpen(false); return; }
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, confidenceInfoOpen, pendingFlip, promoteOpen]);

  const handleLink = (kind: ThesisLinkKind, target: string) => {
    linkThesis.mutate({ slug, kind, target }, {
      onSuccess: () => flash(`Linked ${target}`, 'ok'),
      onError: (e) => flash(e instanceof Error ? e.message : 'Could not link.', 'warn'),
    });
  };
  const handleUnlink = (kind: ThesisLinkKind, target: string) => {
    unlinkThesis.mutate({ slug, kind, target }, {
      onSuccess: () => flash(`Removed ${target}`, 'undo'),
      onError: (e) => flash(e instanceof Error ? e.message : 'Could not remove link.', 'warn'),
    });
  };

  const promoteToOpen = () => setStatus.mutate({ slug, input: { status: 'open' } }, {
    onSuccess: () => flash('Promoted to open', 'ok'),
    onError: (e) => flash(e instanceof Error ? e.message : 'Need at least one prediction to open.', 'warn'),
  });
  const retire = () => setStatus.mutate({ slug, input: { status: 'retired' } }, {
    onSuccess: () => flash('Retired', 'undo'),
    onError: (e) => flash(e instanceof Error ? e.message : 'Could not retire.', 'warn'),
  });
  const restore = () => setStatus.mutate({ slug, input: { status: 'draft' } }, {
    onSuccess: () => flash('Restored to draft', 'ok'),
    onError: (e) => flash(e instanceof Error ? e.message : 'Could not restore.', 'warn'),
  });

  const openFlip = (target: 'validated' | 'invalidated') => { setPendingFlip(target); setCitedIndices([]); };
  const cancelFlip = () => { setPendingFlip(null); setCitedIndices([]); };
  const toggleCite = (idx: number) => setCitedIndices((prev) => (prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]));
  const confirmFlip = () => {
    if (!pendingFlip || citedIndices.length === 0) return;
    setStatus.mutate({ slug, input: { status: pendingFlip, citations: citedIndices } }, {
      onSuccess: () => { flash(`Marked ${pendingFlip}`, 'ok'); setPendingFlip(null); setCitedIndices([]); },
      onError: (e) => flash(e instanceof Error ? e.message : 'Could not update status.', 'warn'),
    });
  };

  const confirmPromote = () => {
    const path = promotePath.trim();
    if (!path) return;
    promoteThesis.mutate({ slug, knowledgePath: path, retire: promoteRetire }, {
      onSuccess: () => { flash('Promoted to knowledge', 'ok'); setPromoteOpen(false); setPromotePath(''); },
      onError: (e) => flash(e instanceof Error ? e.message : 'Could not promote.', 'warn'),
    });
  };

  // Best-effort "flipped this cycle" signal — the server doesn't expose an
  // explicit `flipped` flag (see the report's gap note): a validated/invalidated
  // thesis whose most recent write is the SAME write that recorded its latest
  // evidence check (checked_at === updated_at) is treated as flipped this cycle.
  const flippedThisCycle = !!thesis
    && (thesis.status === 'validated' || thesis.status === 'invalidated')
    && thesis.checked_at !== null
    && thesis.checked_at === thesis.updated_at;

  let footNote = '';
  let footActions: React.ReactNode = null;
  if (thesis) {
    switch (thesis.status) {
      case 'draft': {
        const canOpen = thesis.predictions.length > 0;
        footNote = canOpen ? 'Ready to promote to open, or retire this hunch.' : 'Add at least one prediction to promote to open.';
        footActions = (
          <>
            <button className="td-btn td-btn--ghost" onClick={retire} disabled={setStatus.isPending}>Retire</button>
            <button
              className="td-btn td-btn--cta"
              onClick={promoteToOpen}
              disabled={!canOpen || setStatus.isPending}
              title={canOpen ? undefined : 'Add at least one prediction first'}
            >
              Promote to open
            </button>
          </>
        );
        break;
      }
      case 'open':
        footNote = 'Flips are agent/data-driven — a manual flip must cite evidence.';
        footActions = (
          <>
            <button className="td-btn td-btn--ghost" onClick={retire} disabled={setStatus.isPending}>Retire</button>
            <button className="td-btn td-btn--invalidate-ghost" onClick={() => openFlip('invalidated')}>Mark invalidated</button>
            <button className="td-btn td-btn--validate-ghost" onClick={() => openFlip('validated')}>Mark validated</button>
          </>
        );
        break;
      case 'validated':
      case 'invalidated':
        // The design only specs "validated (not promoted) → Promote to knowledge"
        // explicitly; extending the same affordance to invalidated-not-promoted
        // follows the task doc's own "anti-knowledge — every failure is a
        // learning" language rather than inventing new behavior.
        footNote = thesis.promoted_to
          ? 'Already promoted — retire when this thesis has served its purpose.'
          : `${thesis.status === 'validated' ? 'Validated' : 'Invalidated'} — promote it into knowledge (every win and every failure is a learning).`;
        footActions = (
          <>
            <button className="td-btn td-btn--ghost" onClick={retire} disabled={setStatus.isPending}>Retire</button>
            {!thesis.promoted_to && (
              <button className="td-btn td-btn--cta" onClick={() => { setPromoteOpen(true); setPromotePath(''); }}>
                Promote to knowledge
              </button>
            )}
          </>
        );
        break;
      case 'retired':
        footNote = 'Restored theses return to draft.';
        footActions = <button className="td-btn td-btn--cta" onClick={restore} disabled={setStatus.isPending}>Restore to draft</button>;
        break;
    }
  }

  const kindMeta = thesis ? (KIND_META[thesis.kind] ?? KIND_META.observational) : KIND_META.observational;

  return (
    <div className="td-overlay" onClick={onClose}>
      <div
        className="td-modal"
        role="dialog"
        aria-modal="true"
        aria-label={thesis?.claim ?? 'Hypothesis'}
        onClick={(e) => e.stopPropagation()}
      >
        {isLoading && <div className="td-loading">Loading…</div>}
        {isError && (
          <div className="td-error">
            <p>{error instanceof Error ? error.message : 'Could not load this hypothesis.'}</p>
            <button className="td-btn td-btn--ghost" onClick={onClose}>Close</button>
          </div>
        )}

        {thesis && (
          <>
            <div className="td-head">
              <div className="td-head-row">
                <span className={`td-chip td-chip--status-${thesis.status}`}>{STATUS_LABEL[thesis.status]}</span>
                <span className="td-chip td-chip--kind" style={{ color: kindMeta.ink }}>{kindMeta.glyph} {kindMeta.label}</span>
                {flippedThisCycle && (
                  <span className="td-chip td-chip--flip">⟳ FLIPPED {thesis.status.toUpperCase()}</span>
                )}
                <span className="td-spacer" />
                <button className="td-close" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
              </div>

              <h2 className="td-claim">{thesis.claim}</h2>

              <div className="td-conf-head">
                <span className="td-conf-pct" style={{ color: confidenceInk(pct) }}>{pct}%</span>
                <ConfidenceBar confidence={cb.confidence} ws={cb.ws} wc={cb.wc} hideLabel className="td-conf-bar" />
                <span className="td-conf-legend">{cb.supports} supporting · {cb.contradicts} contradicting · {cb.noSignal} no-signal</span>
                <ConfidencePopover
                  ws={cb.ws}
                  wc={cb.wc}
                  pct={pct}
                  open={confidenceInfoOpen}
                  onToggle={() => setConfidenceInfoOpen((v) => !v)}
                  onRequestClose={() => setConfidenceInfoOpen(false)}
                />
              </div>
            </div>

            <div className="td-body bd-scroll">
              <div className="td-columns">
                <div className="td-col-left">
                  {thesis.blocked_on_instrumentation && (
                    <div className="td-blocked">
                      <span className="td-blocked-glyph">⚑</span>
                      <div>
                        <div className="td-blocked-title">
                          Needs a metric nobody tracks yet{thesis.blocked_metric ? `: ${thesis.blocked_metric}` : ''}
                        </div>
                        <button
                          className="td-blocked-cta"
                          onClick={() => { onNavigate?.('lab'); flash('Opening Lab — create an insight, then link it here.', 'info'); }}
                        >
                          + Create insight to track this
                        </button>
                      </div>
                    </div>
                  )}

                  <section className="td-section">
                    <h3 className="td-section-title">Pre-registered predictions</h3>
                    {thesis.predictions.length === 0 ? (
                      <p className="td-empty">At least one falsifiable prediction is required to promote this thesis to open.</p>
                    ) : (
                      <ul className="td-predictions">
                        {thesis.predictions.map((p) => {
                          const sm = STANDING_META[p.standing];
                          return (
                            <li key={p.id} className="td-prediction">
                              <span className="td-prediction-badge" style={{ color: sm.ink }} title={sm.label}>{sm.glyph}</span>
                              <span className="td-prediction-text">{p.text}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  <section className="td-section">
                    <div className="td-section-head">
                      <h3 className="td-section-title">Evidence ledger</h3>
                      <div className="td-seg">
                        {EVIDENCE_FILTERS.map((f) => (
                          <button
                            key={f.key}
                            className={`td-seg-btn${evidenceFilter === f.key ? ' td-seg-btn--on' : ''}`}
                            onClick={() => setEvidenceFilter(f.key)}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {filteredEvidence.length === 0 ? (
                      <p className="td-empty">No evidence yet.</p>
                    ) : (
                      <ol className="td-timeline">
                        {filteredEvidence.map((e) => {
                          const vm = VERDICT_META[e.verdict];
                          const sm = SOURCE_META[e.source];
                          return (
                            <li key={e.idx} className="td-evidence" style={{ borderLeftColor: vm.ink }}>
                              <div className="td-evidence-head">
                                <span className="td-evidence-verdict" style={{ color: vm.ink }}>{vm.label}</span>
                                <span className="td-evidence-date">{e.date}</span>
                                <span className="td-evidence-source" style={{ color: sm.ink }} title={e.ref ?? sm.label}>
                                  {sm.glyph} {sm.label}
                                </span>
                              </div>
                              {e.note && <p className="td-evidence-note">{e.note}</p>}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </section>

                  <section className="td-section">
                    <h3 className="td-section-title">Understanding changelog</h3>
                    <p className="td-section-hint">The agent's reasoning, inherited cycle to cycle.</p>
                    {thesis.changelog.length === 0 ? (
                      <p className="td-empty">No entries yet.</p>
                    ) : (
                      <ul className="td-changelog">
                        {thesis.changelog.map((c, i) => (
                          <li key={i} className={`td-changelog-entry${c.condensed ? ' td-changelog-entry--condensed' : ''}`}>
                            <div className="td-changelog-head">
                              <span className="td-changelog-chip">{c.condensed ? 'CONDENSED' : `CYCLE ${c.cycle ?? '—'}`}</span>
                              <span className="td-changelog-when">{c.when}</span>
                            </div>
                            <p className="td-changelog-text">{c.text}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>

                <div className="td-rail">
                  <LinkGroup
                    title="Linked insights"
                    items={thesis.insights.map((s) => ({ slug: s, title: insightsBySlug.get(s) ?? s }))}
                    onRemove={(s) => handleUnlink('insight', s)}
                    onOpen={(s) => onNavigate?.('lab', s)}
                    picker={(
                      <LinkedItemPicker
                        options={allInsights.map((i) => ({ slug: i.slug, title: i.title }))}
                        excluded={thesis.insights}
                        placeholder="Search insights…"
                        onPick={(s) => handleLink('insight', s)}
                      />
                    )}
                  />
                  <LinkGroup
                    title="Linked objectives"
                    items={thesis.objectives.map((s) => ({ slug: s, title: objectivesBySlug.get(s) ?? s }))}
                    onRemove={(s) => handleUnlink('objective', s)}
                    onOpen={(s) => onNavigate?.('roadmap', s)}
                    picker={(
                      <LinkedItemPicker
                        options={allObjectives.map((o) => ({ slug: o.slug, title: o.title }))}
                        excluded={thesis.objectives}
                        placeholder="Search objectives…"
                        onPick={(s) => handleLink('objective', s)}
                      />
                    )}
                  />
                  <LinkGroup
                    title="Linked tasks"
                    items={thesis.related_tasks.map((s) => ({ slug: s, title: tasksBySlug.get(s) ?? s }))}
                    onRemove={(s) => handleUnlink('task', s)}
                    onOpen={(s) => onNavigate?.('tasks', s)}
                    picker={(
                      <LinkedItemPicker
                        options={allTasks.map((t) => ({ slug: t.slug, title: t.name }))}
                        excluded={thesis.related_tasks}
                        placeholder="Search tasks…"
                        onPick={(s) => handleLink('task', s)}
                      />
                    )}
                  />

                  <div className="td-meta">
                    <div className="td-meta-row">
                      <span className="td-meta-avatar" title={thesis.created_by === 'sleep-learn' ? 'sleep-learn agent' : 'You'}>
                        {thesis.created_by === 'sleep-learn' ? '◑' : '●'}
                      </span>
                      <span>{thesis.created_by === 'sleep-learn' ? 'sleep-learn agent' : 'You'}</span>
                    </div>
                    <div className="td-meta-row"><span className="td-meta-label">Created</span><span>{thesis.created_at}</span></div>
                    <div className="td-meta-row"><span className="td-meta-label">Cycles checked</span><span>{thesis.cycles_checked}</span></div>
                    <div className="td-meta-row"><span className="td-meta-label">Kind</span><span>{kindMeta.label}</span></div>
                  </div>

                  {thesis.promoted_to && (
                    <div className="td-promoted">
                      <span>✦ Promoted to knowledge</span>
                      <span className="td-mono">{thesis.promoted_to} ↗</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="td-foot">
              {pendingFlip ? (
                <div className="td-flip-panel">
                  <div className="td-flip-panel-title">Cite the evidence behind marking this {pendingFlip}</div>
                  {newestFirst.length === 0 ? (
                    <p className="td-empty">No evidence to cite yet — add evidence before flipping manually.</p>
                  ) : (
                    <ul className="td-flip-list bd-scroll">
                      {newestFirst.map((e) => (
                        <li key={e.idx} className="td-flip-item">
                          <label>
                            <input type="checkbox" checked={citedIndices.includes(e.idx)} onChange={() => toggleCite(e.idx)} />
                            <span className="td-flip-item-verdict" style={{ color: VERDICT_META[e.verdict].ink }}>{VERDICT_META[e.verdict].label}</span>
                            <span className="td-flip-item-note">{e.note || e.date}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="td-flip-actions">
                    <button className="td-btn td-btn--ghost" onClick={cancelFlip}>Cancel</button>
                    <button
                      className={`td-btn ${pendingFlip === 'validated' ? 'td-btn--validate' : 'td-btn--invalidate'}`}
                      disabled={citedIndices.length === 0 || setStatus.isPending}
                      onClick={confirmFlip}
                    >
                      {pendingFlip === 'validated' ? 'Validate' : 'Invalidate'} with {citedIndices.length} cited
                    </button>
                  </div>
                </div>
              ) : promoteOpen ? (
                <div className="td-flip-panel">
                  <div className="td-flip-panel-title">Promote to knowledge</div>
                  <input
                    className="td-promote-input"
                    value={promotePath}
                    onChange={(e) => setPromotePath(e.target.value)}
                    placeholder="knowledge/decisions/…md"
                    autoFocus
                  />
                  <label className="td-promote-retire">
                    <input type="checkbox" checked={promoteRetire} onChange={(e) => setPromoteRetire(e.target.checked)} />
                    Retire this thesis
                  </label>
                  <div className="td-flip-actions">
                    <button className="td-btn td-btn--ghost" onClick={() => setPromoteOpen(false)}>Cancel</button>
                    <button className="td-btn td-btn--cta" disabled={!promotePath.trim() || promoteThesis.isPending} onClick={confirmPromote}>
                      Promote
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="td-foot-note">{footNote}</span>
                  <div className="td-foot-actions">{footActions}</div>
                </>
              )}
            </div>
          </>
        )}

        {toast && (
          <div className="td-toast" style={{ color: TOAST_INK[toast.kind] }}>
            <span>{TOAST_GLYPH[toast.kind]}</span>{toast.msg}
          </div>
        )}
      </div>
    </div>
  );
}
