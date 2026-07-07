import { useEffect, useMemo, useRef, useState } from 'react';
import { useObjectives, useCreateObjective, type Objective, type ObjectiveMetric } from '../../hooks/useObjectives';
import { useLabInsights, useUpdateBinding } from '../../hooks/useLab';
import { DateRangePicker } from './DateRangePicker';
import { DependencyPicker } from './DependencyPicker';
import { InsightPicker } from './InsightPicker';
import './ObjectiveCreateModal.css';

/**
 * New Objective — the buttery create flow for the PO-authored OKR roadmap.
 *
 * Title is the only required field; the slug is derived live (and de-duped against
 * existing objectives) but stays editable. Target date, dependencies, and a "why"
 * are optional. Esc closes; ⌘/Ctrl+Enter submits; the primary button is disabled
 * until the input is genuinely valid, and backend validation errors surface inline
 * (never an alert). Store-level rules (calendar date, cycle guard) are enforced
 * server-side; this form just makes them pleasant to satisfy.
 */

interface ObjectiveCreateModalProps {
  onClose: () => void;
  onCreated?: (objective: Objective) => void;
}

/** Mirror of `objectives-store.isSafeObjectiveSlug` / `slugifyObjective`. */
function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}
function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && !slug.includes('--') && !slug.endsWith('-');
}
function dedupeSlug(base: string, taken: Set<string>): string {
  if (!base || !taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

// Value/effort 2×2 (impact 1–5; effort in weeks, preset buckets that stay within
// the store's (0, 52] range). Both optional.
const IMPACT_LABEL: Record<number, string> = { 1: 'Minimal', 2: 'Low', 3: 'Medium', 4: 'High', 5: 'Massive' };
const EFFORT_PRESETS = [1, 2, 4, 8, 12];

export function ObjectiveCreateModal({ onClose, onCreated }: ObjectiveCreateModalProps) {
  const { data: objectives = [] } = useObjectives();
  const createObjective = useCreateObjective();

  const [title, setTitle] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [manualSlug, setManualSlug] = useState('');
  const [editingSlug, setEditingSlug] = useState(false);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [impact, setImpact] = useState<number | null>(null);
  const [effort, setEffort] = useState<number | null>(null);
  const [deps, setDeps] = useState<string[]>([]);
  const [why, setWhy] = useState('');
  // Optional Key Result metric ("custom goal") — outcome-based progress instead of
  // task rollup. Off by default; when on, its label + a target that differs from the
  // baseline are required (mirrors the store's validateMetric).
  const [useMetric, setUseMetric] = useState(false);
  const [metric, setMetric] = useState<ObjectiveMetric>({ label: '', unit: null, baseline: 0, target: 100, current: 0 });
  // Optional Lab insight feeding the Key Result — selecting one prefills the
  // metric from the insight's cached snapshot; the binding itself is written to
  // the insight AFTER the objective exists (it needs the new slug).
  const [insightSlug, setInsightSlug] = useState<string | null>(null);
  const { data: insights = [] } = useLabInsights();
  const bindInsight = useUpdateBinding();
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);

  const taken = useMemo(() => new Set(objectives.map((o) => o.slug)), [objectives]);
  const derivedSlug = useMemo(() => dedupeSlug(slugify(title), taken), [title, taken]);
  const slug = slugTouched ? manualSlug : derivedSlug;
  const slugValid = isSafeSlug(slug);
  const slugCollides = taken.has(slug);
  const metricValid = !useMetric || (
    metric.label.trim().length > 0
    && Number.isFinite(metric.baseline)
    && Number.isFinite(metric.target)
    && Number.isFinite(metric.current)
    && metric.target !== metric.baseline
  );
  const canSubmit = title.trim().length > 0 && slugValid && !slugCollides && metricValid
    && !createObjective.isPending && !bindInsight.isPending;

  // Picking an insight prefills the metric from its cached snapshot — the label
  // and unit only when still blank (never clobber what the user typed); the
  // current value always (that's the point of connecting).
  const selectInsight = (slug: string | null) => {
    setInsightSlug(slug);
    if (!slug) return;
    const ins = insights.find((i) => i.slug === slug);
    if (!ins) return;
    setMetric((m) => ({
      ...m,
      label: m.label.trim() ? m.label : ins.title,
      unit: m.unit && m.unit.trim() ? m.unit : ins.unit,
      current: ins.latest !== null && Number.isFinite(ins.latest) ? ins.latest : m.current,
    }));
  };

  const submit = () => {
    if (!canSubmit) return;
    setError(null);
    createObjective.mutate(
      {
        title: title.trim(),
        slug,
        start_date: startDate,
        target_date: endDate,
        impact,
        effort,
        depends_on: deps,
        why: why.trim() || undefined,
        metric: useMetric
          ? {
              label: metric.label.trim(),
              unit: metric.unit && metric.unit.trim() ? metric.unit.trim() : null,
              baseline: metric.baseline,
              target: metric.target,
              current: metric.current,
            }
          : undefined,
      },
      {
        onSuccess: async (res) => {
          // Connect the chosen insight to the freshly-created objective. The
          // objective already exists at this point, so a bind failure must stay
          // LOUD but not lose the creation: surface it inline and let the user
          // close — the connection can be retried from the objective's panel.
          if (useMetric && insightSlug) {
            try {
              await bindInsight.mutateAsync({ slug: insightSlug, binding: { objective: res.objective.slug, value: 'latest' } });
            } catch (e) {
              onCreated?.(res.objective);
              setError(`Objective created, but connecting the insight failed: ${e instanceof Error ? e.message : 'unknown error'}. Connect it from the objective's panel.`);
              return;
            }
          }
          onCreated?.(res.objective);
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Failed to create objective.'),
      },
    );
  };

  // Esc closes; ⌘/Ctrl+Enter submits from anywhere in the form. `submit` reads
  // fresh state via a ref so the global keydown listener is bound ONCE, not
  // re-attached on every render/keystroke.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="ocm-overlay" onClick={onClose}>
      <div className="ocm-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="New objective">
        <div className="ocm-header">
          <span className="ocm-header-icon">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="4.5" x2="21" y2="4.5" /><rect x="3" y="7.4" width="11" height="3.2" rx="1.2" /><rect x="8" y="13.2" width="13" height="3.2" rx="1.2" /><rect x="3" y="19" width="8" height="3.2" rx="1.2" /></svg>
          </span>
          <div className="ocm-header-text">
            <div className="ocm-title">New Objective</div>
            <div className="ocm-subtitle">An outcome you're driving toward.</div>
          </div>
          <button className="ocm-close" onClick={onClose} title="Close (Esc)" aria-label="Close">×</button>
        </div>

        <form
          className="ocm-body"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          {/* Title + live slug */}
          <div className="ocm-field">
            <label className="ocm-label" htmlFor="ocm-title">Objective</label>
            <input
              id="ocm-title"
              ref={titleRef}
              className="ocm-input ocm-input--title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Increase retention 20%"
              spellCheck={false}
            />
            {title.trim() && (
              <div className="ocm-slug-row">
                <span className="ocm-slug-glyph">/</span>
                {editingSlug || slugTouched ? (
                  <input
                    className="ocm-slug-input"
                    value={slug}
                    autoFocus={editingSlug}
                    onChange={(e) => { setSlugTouched(true); setManualSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')); }}
                    onBlur={() => setEditingSlug(false)}
                    spellCheck={false}
                  />
                ) : (
                  <button type="button" className="ocm-slug-preview" onClick={() => setEditingSlug(true)} title="Edit slug">
                    {slug || 'slug'}
                    <span className="ocm-slug-edit">edit</span>
                  </button>
                )}
                {slug && slugCollides && <span className="ocm-slug-warn">already exists</span>}
                {slug && !slugValid && !slugCollides && <span className="ocm-slug-warn">invalid</span>}
              </div>
            )}
          </div>

          {/* Dates — committed start → end window */}
          <div className="ocm-field">
            <label className="ocm-label">Dates <span className="ocm-optional">optional</span></label>
            <DateRangePicker start={startDate} end={endDate} onChange={(s, e) => { setStartDate(s); setEndDate(e); }} />
          </div>

          {/* Impact × Effort (value/effort 2×2) */}
          <div className="ocm-field">
            <label className="ocm-label">Impact <span className="ocm-times">×</span> Effort <span className="ocm-optional">optional</span></label>
            <div className="ocm-rice">
              <div className="ocm-rice-axis">
                <span className="ocm-rice-axis-label">Impact</span>
                <div className="ocm-seg">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      type="button"
                      key={n}
                      className={`ocm-seg-btn${impact === n ? ' ocm-seg-btn--on' : ''}`}
                      onClick={() => setImpact(impact === n ? null : n)}
                      title={IMPACT_LABEL[n]}
                    >{n}</button>
                  ))}
                </div>
              </div>
              <div className="ocm-rice-axis">
                <span className="ocm-rice-axis-label">Effort</span>
                <div className="ocm-seg">
                  {EFFORT_PRESETS.map((w) => (
                    <button
                      type="button"
                      key={w}
                      className={`ocm-seg-btn${effort === w ? ' ocm-seg-btn--on' : ''}`}
                      onClick={() => setEffort(effort === w ? null : w)}
                      title={`${w} week${w === 1 ? '' : 's'}`}
                    >{w}w</button>
                  ))}
                </div>
              </div>
            </div>
            {impact !== null && effort !== null && (
              <span className="ocm-rice-hint">leverage {(impact / effort).toFixed(2)} — outcome per week</span>
            )}
          </div>

          {/* Key Result metric (custom goal) — outcome-based progress. Optional.
             A segmented toggle (mirrors Impact/Effort above) makes the choice
             obvious instead of hiding it behind a text link. */}
          <div className="ocm-field">
            <label className="ocm-label">
              Key Result <span className="ocm-optional">optional</span>
            </label>
            <div className="ocm-seg ocm-seg--wide" role="group" aria-label="Progress source">
              <button
                type="button"
                className={`ocm-seg-btn ocm-seg-btn--wide${!useMetric ? ' ocm-seg-btn--on' : ''}`}
                onClick={() => setUseMetric(false)}
                aria-pressed={!useMetric}
              >Track by tasks</button>
              <button
                type="button"
                className={`ocm-seg-btn ocm-seg-btn--wide${useMetric ? ' ocm-seg-btn--on' : ''}`}
                onClick={() => setUseMetric(true)}
                aria-pressed={useMetric}
              >Track by a metric</button>
            </div>
            {useMetric ? (
              <div className="ocm-metric">
                <div className="ocm-metric-row">
                  <input
                    className="ocm-input ocm-metric-label"
                    value={metric.label}
                    onChange={(e) => setMetric((m) => ({ ...m, label: e.target.value }))}
                    placeholder="e.g. MRR"
                    spellCheck={false}
                    autoFocus
                  />
                  <input
                    className="ocm-input ocm-metric-unit"
                    value={metric.unit ?? ''}
                    onChange={(e) => setMetric((m) => ({ ...m, unit: e.target.value || null }))}
                    placeholder="unit"
                    spellCheck={false}
                  />
                </div>
                <div className="ocm-metric-grid">
                  <label className="ocm-metric-field">
                    <span>Baseline</span>
                    <input className="ocm-input" type="number" value={Number.isFinite(metric.baseline) ? metric.baseline : ''}
                      onChange={(e) => setMetric((m) => ({ ...m, baseline: e.target.valueAsNumber }))} />
                  </label>
                  <label className="ocm-metric-field">
                    <span>Target</span>
                    <input className="ocm-input" type="number" value={Number.isFinite(metric.target) ? metric.target : ''}
                      onChange={(e) => setMetric((m) => ({ ...m, target: e.target.valueAsNumber }))} />
                  </label>
                  <label className="ocm-metric-field">
                    <span>Current</span>
                    <input className="ocm-input" type="number" value={Number.isFinite(metric.current) ? metric.current : ''}
                      onChange={(e) => setMetric((m) => ({ ...m, current: e.target.valueAsNumber }))} />
                  </label>
                </div>
                {!metricValid && (
                  <span className="ocm-rice-hint">Needs a label and a target that differs from the baseline.</span>
                )}
                {insights.length > 0 && (
                  <div className="ocm-metric-insight">
                    <InsightPicker
                      insights={insights}
                      selected={insightSlug}
                      objectiveSlug={null}
                      onSelect={selectInsight}
                    />
                    {insightSlug && (
                      <span className="ocm-rice-hint">Current updates automatically from the insight on every lab sync.</span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="ocm-metric-hint">Progress rolls up from member tasks. Switch to a metric (e.g. MRR, customers) to track an outcome instead.</div>
            )}
          </div>

          {/* Dependencies (only when there are objectives to depend on) */}
          {objectives.length > 0 && (
            <div className="ocm-field">
              <label className="ocm-label">Depends on <span className="ocm-optional">optional</span></label>
              <DependencyPicker
                options={objectives.map((o) => ({ slug: o.slug, title: o.title, status: o.status }))}
                selected={deps}
                onChange={setDeps}
              />
            </div>
          )}

          {/* Why */}
          <div className="ocm-field">
            <label className="ocm-label" htmlFor="ocm-why">Why <span className="ocm-optional">optional</span></label>
            <textarea
              id="ocm-why"
              className="ocm-input ocm-textarea"
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              placeholder="What outcome is this driving, and why does it matter?"
              rows={2}
              spellCheck={false}
            />
          </div>

          {error && <div className="ocm-error">{error}</div>}

          <div className="ocm-actions">
            <span className="ocm-hint">⌘↵ to create</span>
            <div className="ocm-actions-btns">
              <button type="button" className="ocm-btn ocm-btn--ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="ocm-btn ocm-btn--primary" disabled={!canSubmit}>
                {createObjective.isPending ? <span className="ocm-spinner" /> : 'Create objective'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
