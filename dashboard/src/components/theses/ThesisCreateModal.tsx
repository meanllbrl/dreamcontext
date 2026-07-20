import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useCreateThesis,
  useAppendChangelog,
  type ThesisCandidate,
  type ThesisKind,
} from '../../hooks/useTheses';
import { useLabInsights } from '../../hooks/useLab';
import { useObjectives } from '../../hooks/useObjectives';
import { useTasks } from '../../hooks/useTasks';
import '../tasks/Board.css';
import './ThesisCreateModal.css';

/**
 * Create / review modal (design §Create). One shared form, two modes:
 * - `create`: blank "New hypothesis" form → Save as draft / Save & open.
 * - `review`: meeting-note candidates reviewed one at a time (Candidate i/n,
 *   Skip / Confirm & next|finish); confirmed candidates always land as `draft`
 *   (offer-and-confirm capture protocol — never auto-created, never auto-opened).
 */

interface ThesisCreateModalProps {
  mode: 'create' | 'review';
  candidates?: ThesisCandidate[];
  initialObjective?: string | null;
  onClose: () => void;
}

interface LinkOption { slug: string; label: string; }

const KIND_INFO: Record<ThesisKind, { glyph: string; label: string; blurb: string; colorVar: string }> = {
  observational: {
    glyph: '👁',
    label: 'Observational',
    blurb: 'Validated by watching data over time — no intervention needed.',
    colorVar: 'var(--thesis-violet)',
  },
  experimental: {
    glyph: '⚗',
    label: 'Experimental',
    blurb: 'Needs an intervention. Surfaces as a suggestion; its outcome is the evidence.',
    colorVar: 'var(--thesis-amber)',
  },
};

/** Blank draft of the shared form fields. */
function emptyForm(initialObjective?: string | null) {
  return {
    claim: '',
    kind: 'observational' as ThesisKind,
    predictions: [] as string[],
    insights: [] as string[],
    objectives: initialObjective ? [initialObjective] : [] as string[],
    tasks: [] as string[],
    notes: '',
  };
}

function formFromCandidate(c: ThesisCandidate, initialObjective?: string | null) {
  return {
    claim: c.claim,
    kind: c.kind,
    predictions: [...c.predictions],
    insights: [] as string[],
    objectives: initialObjective ? [initialObjective] : [] as string[],
    tasks: [] as string[],
    notes: '',
  };
}

/** Generic chip-input typeahead row for Initial links (Insights/Objectives/Tasks). Client-side filter only. */
function LinkPickerRow({
  icon,
  placeholder,
  options,
  selected,
  onChange,
}: {
  icon: string;
  placeholder: string;
  options: LinkOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const bySlug = useMemo(() => new Map(options.map((o) => [o.slug, o])), [options]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const avail = options.filter((o) => !selected.includes(o.slug));
    if (!q) return avail;
    return avail.filter((o) => o.label.toLowerCase().includes(q) || o.slug.includes(q));
  }, [options, query, selected]);

  const add = (slug: string) => { onChange([...selected, slug]); setQuery(''); };
  const remove = (slug: string) => onChange(selected.filter((s) => s !== slug));

  return (
    <div className="tcm-link-row" ref={ref}>
      <div className="tcm-link-chips" onClick={() => setOpen(true)}>
        <span className="tcm-link-icon">{icon}</span>
        {selected.map((slug) => (
          <span key={slug} className="tcm-link-chip" title={slug}>
            <span className="tcm-link-chip-label">{bySlug.get(slug)?.label ?? slug}</span>
            <span className="tcm-link-chip-x" onClick={(e) => { e.stopPropagation(); remove(slug); }} title="Remove">×</span>
          </span>
        ))}
        <input
          className="tcm-link-input"
          value={query}
          placeholder={selected.length ? '' : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        />
      </div>
      {open && filtered.length > 0 && (
        <div className="tcm-link-pop bd-scroll">
          {filtered.slice(0, 8).map((o) => (
            <div key={o.slug} className="tcm-link-opt" onMouseDown={(e) => { e.preventDefault(); add(o.slug); }}>
              <span className="tcm-link-opt-label">{o.label}</span>
              <span className="tcm-link-opt-slug">{o.slug}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ThesisCreateModal({ mode, candidates, initialObjective = null, onClose }: ThesisCreateModalProps) {
  const createThesis = useCreateThesis();
  const appendChangelog = useAppendChangelog();
  const { data: insightSummaries = [] } = useLabInsights();
  const { data: objectives = [] } = useObjectives();
  const { data: tasks = [] } = useTasks();

  const reviewCandidates = mode === 'review' ? (candidates ?? []) : [];
  const [index, setIndex] = useState(0);
  const [resultByIndex, setResultByIndex] = useState<Record<number, 'done'>>({});
  const [form, setForm] = useState(() =>
    mode === 'review' && reviewCandidates.length > 0
      ? formFromCandidate(reviewCandidates[0], initialObjective)
      : emptyForm(initialObjective),
  );

  const currentCandidate = mode === 'review' ? reviewCandidates[index] ?? null : null;
  const isLastCandidate = mode === 'review' && index >= reviewCandidates.length - 1;

  useEffect(() => {
    if (mode !== 'review' || !currentCandidate) return;
    setForm(formFromCandidate(currentCandidate, initialObjective));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const insightOptions: LinkOption[] = useMemo(
    () => insightSummaries.map((i) => ({ slug: i.slug, label: i.title })),
    [insightSummaries],
  );
  const objectiveOptions: LinkOption[] = useMemo(
    () => objectives.map((o) => ({ slug: o.slug, label: o.title })),
    [objectives],
  );
  const taskOptions: LinkOption[] = useMemo(
    () => tasks.map((t) => ({ slug: t.slug, label: t.name })),
    [tasks],
  );

  const claimValid = form.claim.trim().length > 0;
  const nonEmptyPredictions = form.predictions.map((p) => p.trim()).filter(Boolean);
  const canOpen = claimValid && nonEmptyPredictions.length > 0;

  const setPrediction = (i: number, text: string) =>
    setForm((f) => ({ ...f, predictions: f.predictions.map((p, idx) => (idx === i ? text : p)) }));
  const addPredictionRow = () => setForm((f) => ({ ...f, predictions: [...f.predictions, ''] }));
  const removePredictionRow = (i: number) =>
    setForm((f) => ({ ...f, predictions: f.predictions.filter((_, idx) => idx !== i) }));

  const persistNotes = (slug: string) => {
    const text = form.notes.trim();
    if (!text) return;
    appendChangelog.mutate(
      { slug, text, cycle: null },
      { onError: (e) => console.error('[thesis-create] failed to append initial notes as changelog:', e) },
    );
  };

  const submitCreate = (open: boolean) => {
    if (!claimValid || (open && !canOpen)) return;
    createThesis.mutate(
      {
        claim: form.claim.trim(),
        kind: form.kind,
        predictions: nonEmptyPredictions,
        insights: form.insights,
        objectives: form.objectives,
        related_tasks: form.tasks,
        open,
        created_by: 'user',
      },
      {
        onSuccess: (res) => { persistNotes(res.thesis.slug); onClose(); },
      },
    );
  };

  const confirmCandidate = () => {
    if (!claimValid || createThesis.isPending) return;
    createThesis.mutate(
      {
        claim: form.claim.trim(),
        kind: form.kind,
        predictions: nonEmptyPredictions,
        insights: form.insights,
        objectives: form.objectives,
        related_tasks: form.tasks,
        open: false, // confirmed candidates always land as draft (capture protocol)
        created_by: 'user',
      },
      {
        onSuccess: (res) => {
          persistNotes(res.thesis.slug);
          setResultByIndex((r) => ({ ...r, [index]: 'done' }));
          if (isLastCandidate) onClose();
          else setIndex((i) => i + 1);
        },
      },
    );
  };

  const skipCandidate = () => {
    setResultByIndex((r) => ({ ...r, [index]: 'done' }));
    if (isLastCandidate) onClose();
    else setIndex((i) => i + 1);
  };

  const footerHint = !claimValid
    ? 'Add a claim to save.'
    : nonEmptyPredictions.length === 0
      ? 'Zero predictions saves as a draft · add at least one to open it directly.'
      : 'Ready — save as a draft, or open it now to start the validation loop.';

  return (
    <div className="tcm-overlay" onClick={onClose}>
      <div className="tcm-modal" role="dialog" aria-modal="true" aria-label={mode === 'review' ? 'Review extracted hypotheses' : 'New hypothesis'} onClick={(e) => e.stopPropagation()}>
        <div className="tcm-head">
          <div className="tcm-head-row">
            <h2 className="tcm-title">{mode === 'review' ? 'Review extracted hypotheses' : 'New hypothesis'}</h2>
            <span className="tcm-close" onClick={onClose} title="Close (Esc)">✕</span>
          </div>
          {mode === 'create' && (
            <div className="tcm-subtitle">Capture a falsifiable claim the brain will try to prove or disprove across sleep cycles.</div>
          )}
          {mode === 'review' && reviewCandidates.length > 0 && (
            <div className="tcm-review-strip">
              <span className="tcm-review-badge">Candidate {index + 1}/{reviewCandidates.length}</span>
              <div className="tcm-review-dots">
                {reviewCandidates.map((_, i) => (
                  <span
                    key={i}
                    className={`tcm-review-dot ${resultByIndex[i] === 'done' ? 'tcm-review-dot--done' : i === index ? 'tcm-review-dot--current' : 'tcm-review-dot--pending'}`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {mode === 'review' && reviewCandidates.length === 0 ? (
          <div className="tcm-body bd-scroll">
            <div className="tcm-empty">No candidates to review.</div>
          </div>
        ) : (
          <div className="tcm-body bd-scroll">
            <label className="tcm-field">
              <span className="tcm-field-label">Claim*</span>
              <textarea
                className="tcm-textarea"
                value={form.claim}
                onChange={(e) => setForm((f) => ({ ...f, claim: e.target.value }))}
                placeholder='A falsifiable claim — e.g. "Compressing stale memories during sleep improves recall precision."'
                rows={3}
                autoFocus
              />
            </label>

            <div className="tcm-field">
              <span className="tcm-field-label">Kind</span>
              <div className="tcm-kind-cards">
                {(Object.keys(KIND_INFO) as ThesisKind[]).map((k) => {
                  const info = KIND_INFO[k];
                  const on = form.kind === k;
                  return (
                    <div
                      key={k}
                      className={`tcm-kind-card${on ? ' tcm-kind-card--on' : ''}`}
                      style={on ? { borderColor: info.colorVar } : undefined}
                      onClick={() => setForm((f) => ({ ...f, kind: k }))}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setForm((f) => ({ ...f, kind: k })); } }}
                    >
                      <span className="tcm-kind-glyph" style={{ color: info.colorVar }}>{info.glyph}</span>
                      <span className="tcm-kind-label">{info.label}</span>
                      <span className="tcm-kind-blurb">{info.blurb}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="tcm-field">
              <span className="tcm-field-label">Predictions</span>
              <div className="tcm-predictions">
                {form.predictions.map((p, i) => (
                  <div key={i} className="tcm-prediction-row">
                    <span className="tcm-prediction-num">{i + 1}</span>
                    <input
                      className="tcm-prediction-input"
                      value={p}
                      onChange={(e) => setPrediction(i, e.target.value)}
                      placeholder="A falsifiable, checkable prediction…"
                    />
                    <span className="tcm-prediction-remove" onClick={() => removePredictionRow(i)} title="Remove">×</span>
                  </div>
                ))}
                <button type="button" className="tcm-add-prediction" onClick={addPredictionRow}>
                  + Add prediction
                </button>
                <div className="tcm-hint">zero allowed for a draft · at least one to open</div>
              </div>
            </div>

            <div className="tcm-field">
              <span className="tcm-field-label">Initial links</span>
              <LinkPickerRow icon="◈" placeholder="Link insights…" options={insightOptions} selected={form.insights} onChange={(v) => setForm((f) => ({ ...f, insights: v }))} />
              <LinkPickerRow icon="◇" placeholder="Link objectives…" options={objectiveOptions} selected={form.objectives} onChange={(v) => setForm((f) => ({ ...f, objectives: v }))} />
              <LinkPickerRow icon="▦" placeholder="Link tasks…" options={taskOptions} selected={form.tasks} onChange={(v) => setForm((f) => ({ ...f, tasks: v }))} />
            </div>

            <label className="tcm-field">
              <span className="tcm-field-label">Notes</span>
              <textarea
                className="tcm-textarea"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional context — saved as the first understanding-changelog entry."
                rows={2}
              />
            </label>
          </div>
        )}

        <div className="tcm-foot">
          {mode === 'create' ? (
            <>
              <span className="tcm-foot-hint">{footerHint}</span>
              <div className="tcm-foot-actions">
                <button type="button" className="tcm-btn tcm-btn--ghost" onClick={() => submitCreate(false)} disabled={!claimValid || createThesis.isPending}>
                  Save as draft
                </button>
                <button
                  type="button"
                  className="tcm-btn tcm-btn--cta"
                  onClick={() => submitCreate(true)}
                  disabled={!canOpen || createThesis.isPending}
                  title={canOpen ? undefined : 'Add at least one prediction to open directly — or save as a draft.'}
                >
                  Save & open
                </button>
              </div>
            </>
          ) : reviewCandidates.length > 0 ? (
            <>
              <button type="button" className="tcm-btn tcm-btn--ghost" onClick={skipCandidate} disabled={createThesis.isPending}>
                Skip this one
              </button>
              <div className="tcm-foot-actions">
                <button type="button" className="tcm-btn tcm-btn--cta" onClick={confirmCandidate} disabled={!claimValid || createThesis.isPending}>
                  {isLastCandidate ? 'Confirm & finish' : 'Confirm & next'}
                </button>
              </div>
            </>
          ) : (
            <div className="tcm-foot-actions">
              <button type="button" className="tcm-btn tcm-btn--ghost" onClick={onClose}>Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
