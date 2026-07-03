import { useEffect, useRef, useState } from 'react';
import { RM_STATUS, RM_RED, RM_TASK, softColor } from './chrome';
import type { RoadmapItem } from '../../hooks/useRoadmapItems';
import type { Forecast } from './roadmap-forecast';
import { fmtShort } from './roadmap-forecast';
import { useUpdateObjective, useAddDependency, useRemoveDependency, useDeleteObjective, type UpdateObjectivePatch } from '../../hooks/useObjectives';
import { DateRangePicker } from './DateRangePicker';
import { DependencyPicker } from './DependencyPicker';
import './ObjectiveDetailPanel.css';

/**
 * ObjectiveDetailPanel — the slide-over that opens when you click an objective
 * (Roadmap.dc.html detail panel), now fully EDITABLE inline. You can rename it,
 * set its status (or clear the override back to computed), set the committed
 * start→target window, set Impact × Effort, and add/remove dependencies — every
 * change persists immediately via PATCH / dependency endpoints. Progress, forecast,
 * slip, blocks and member tasks remain computed (read-only).
 */

interface Props {
  item: RoadmapItem;
  forecast: Forecast;
  itemsBySlug: Map<string, RoadmapItem>;
  forecasts: Map<string, Forecast>;
  onOpen: (slug: string) => void;
  onClose: () => void;
  onToast: (msg: string) => void;
}

const STATUS_KEYS = ['not_started', 'active', 'review', 'done'] as const;
const IMPACT_LABEL: Record<number, string> = { 1: 'Minimal', 2: 'Low', 3: 'Medium', 4: 'High', 5: 'Massive' };
const EFFORT_PRESETS = [1, 2, 4, 8, 12];

export function ObjectiveDetailPanel({ item, forecast, itemsBySlug, forecasts, onOpen, onClose, onToast }: Props) {
  const update = useUpdateObjective();
  const addDep = useAddDependency();
  const removeDep = useRemoveDependency();
  const deleteObjective = useDeleteObjective();

  const [title, setTitle] = useState(item.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTitle(item.title); setEditingTitle(false); setStatusOpen(false); }, [item.slug, item.title]);
  useEffect(() => { if (editingTitle) titleRef.current?.select(); }, [editingTitle]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); if (statusOpen) setStatusOpen(false); else if (editingTitle) setEditingTitle(false); else onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, statusOpen, editingTitle]);

  const meta = RM_STATUS[item.status];
  const pct = item.progress.pct;

  const patch = (p: UpdateObjectivePatch, errMsg = 'Could not save.') =>
    update.mutate({ slug: item.slug, patch: p }, { onError: (e) => onToast(e instanceof Error ? e.message : errMsg) });

  const commitTitle = () => {
    setEditingTitle(false);
    const t = title.trim();
    if (t && t !== item.title) patch({ title: t }, 'Could not rename.');
    else setTitle(item.title);
  };
  const setStatus = (s: RoadmapItem['status'] | null) => { setStatusOpen(false); patch({ status: s }); };
  const handleDelete = () => {
    if (!window.confirm(`Delete objective “${item.title}”?\n\nThis removes it from the roadmap and clears it from any dependent objectives and any tasks assigned to it. This cannot be undone.`)) return;
    deleteObjective.mutate(item.slug, {
      onSuccess: (res) => {
        onClose();
        if (res.unhealedTasks?.length) {
          onToast(`Deleted — but ${res.unhealedTasks.length} task file(s) couldn't be updated; check them for a stale reference to “${item.slug}”.`);
        }
      },
      onError: (e) => onToast(e instanceof Error ? e.message : 'Could not delete objective.'),
    });
  };
  const setDates = (s: string | null, e: string | null) => patch({ start_date: s, target_date: e });
  const setImpact = (n: number) => patch({ impact: item.impact === n ? null : n });
  const setEffort = (w: number) => patch({ effort: item.effort === w ? null : w });
  const setDeps = (next: string[]) => {
    for (const to of next.filter((s) => !item.depends_on.includes(s))) {
      addDep.mutate({ slug: item.slug, to }, { onError: (e) => onToast(e instanceof Error ? e.message : 'Could not link.') });
    }
    for (const to of item.depends_on.filter((s) => !next.includes(s))) {
      removeDep.mutate({ slug: item.slug, to }, { onError: () => onToast('Could not unlink.') });
    }
  };

  // Risk banner (computed).
  let riskKind: 'slip' | 'unforecastable' | 'ontrack';
  let riskGlyph: string, riskTitle: string, riskSub: string, riskInk: string;
  if (forecast.slipping) {
    riskKind = 'slip'; riskGlyph = '🔴'; riskInk = RM_RED;
    riskTitle = `Slipping — ${forecast.slipDays} day${forecast.slipDays === 1 ? '' : 's'} past target`;
    riskSub = `Forecast end (${fmtShort(forecast.forecast_end!)}) overshoots the committed target (${fmtShort(forecast.target!)}). The slip cascades to everything this blocks.`;
  } else if (!forecast.forecastable) {
    riskKind = 'unforecastable'; riskGlyph = '◔'; riskInk = 'var(--color-text-secondary)';
    riskTitle = 'Unforecastable';
    riskSub = 'No dates to project from. Set a start/target below (or link dated member tasks) to compute a forecast.';
  } else {
    riskKind = 'ontrack'; riskGlyph = '🟢'; riskInk = '#3fb950';
    const buf = Math.abs(forecast.slipDays);
    riskTitle = `On track — ${buf} day${buf === 1 ? '' : 's'} of buffer`;
    riskSub = `Forecast end (${fmtShort(forecast.forecast_end!)}) lands before the committed target (${fmtShort(forecast.target!)}).`;
  }

  const dependents = forecast.dependents.map((slug) => {
    const it = itemsBySlug.get(slug);
    const f = forecasts.get(slug);
    return { slug, title: it?.title ?? slug, color: RM_STATUS[it?.status ?? 'not_started'].color, slipping: !!f?.slipping };
  });
  const depOptions = [...itemsBySlug.values()]
    .filter((o) => o.slug !== item.slug)
    .map((o) => ({ slug: o.slug, title: o.title, status: o.status }));

  return (
    <>
      <div className="odp-overlay" onClick={onClose} />
      <div className="odp-panel" role="dialog" aria-modal="true" aria-label={item.title}>
        <div className="odp-head">
          <div className="odp-head-row">
            <div className="odp-status-wrap">
              <button className="odp-status" style={{ color: 'var(--color-text)', background: softColor(meta.color, 0.14), border: `1px solid ${softColor(meta.color, 0.3)}` }} onClick={() => setStatusOpen((v) => !v)} title="Change status">
                <span className="odp-status-dot" style={{ background: meta.color }} />{meta.label}<span className="odp-caret">▾</span>
              </button>
              {statusOpen && (
                <>
                  <div className="odp-drop-away" onClick={() => setStatusOpen(false)} />
                  <div className="odp-drop">
                    {STATUS_KEYS.map((k) => (
                      <div key={k} className="odp-drop-row" onClick={() => setStatus(k)}>
                        <span className="odp-drop-dot" style={{ background: RM_STATUS[k].color }} />
                        <span className="odp-drop-label">{RM_STATUS[k].label}</span>
                        {item.status === k && item.statusOverride && <span className="odp-drop-check">✓</span>}
                      </div>
                    ))}
                    <div className="odp-drop-sep" />
                    <div className="odp-drop-row" onClick={() => setStatus(null)} title="Clear the manual override — status falls back to the task rollup">
                      <span className="odp-drop-dot odp-drop-dot--auto">↺</span>
                      <span className="odp-drop-label">Auto (from tasks)</span>
                      {!item.statusOverride && <span className="odp-drop-check">✓</span>}
                    </div>
                  </div>
                </>
              )}
            </div>
            {item.statusOverride && <span className="odp-override" title="Status set manually — click the pill → Auto to clear">✎ override</span>}
            <span className="odp-spacer" />
            <span className="odp-close" onClick={onClose} title="Close (Esc)">✕</span>
          </div>

          {editingTitle ? (
            <input ref={titleRef} className="odp-title-input" value={title} autoFocus
              onChange={(e) => setTitle(e.target.value)} onBlur={commitTitle}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitTitle(); } }} />
          ) : (
            <div className="odp-title" onClick={() => setEditingTitle(true)} title="Click to rename">{item.title}<span className="odp-title-edit">✎</span></div>
          )}
          <div className="odp-slug">{item.slug}</div>
        </div>

        <div className="odp-body bd-scroll">
          {/* risk */}
          <div className={`odp-risk odp-risk--${riskKind}`}>
            <span className="odp-risk-glyph">{riskGlyph}</span>
            <div>
              <div className="odp-risk-title" style={{ color: riskInk }}>{riskTitle}</div>
              <div className="odp-risk-sub">{riskSub}</div>
            </div>
          </div>

          {/* timing — editable committed window + computed forecast */}
          <div className="odp-section-label">Committed window <span className="odp-hint">editable</span></div>
          <div className="odp-range"><DateRangePicker start={item.start_date} end={item.target_date} onChange={setDates} placeholder="Set start & target dates" /></div>
          <div className="odp-forecast-line">
            <span className="odp-forecast-cap">Forecast · computed</span>
            <span style={{ color: forecast.slipping ? RM_RED : forecast.forecastable ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              {forecast.forecast_end ? fmtShort(forecast.forecast_end) : 'none'}
            </span>
            {forecast.forecastable && <span className="odp-forecast-note">{forecast.slipping ? `slipping ${forecast.slipDays}d` : `${Math.abs(forecast.slipDays)}d buffer`}</span>}
          </div>

          {/* progress */}
          <div className="odp-section-label">Progress</div>
          {item.progress.total > 0 ? (
            <div className="odp-prog">
              <div className="odp-prog-track"><div className="odp-prog-fill" style={{ width: `${pct ?? 0}%`, background: `linear-gradient(90deg, ${meta.lite}, ${meta.color})` }} /></div>
              <span className="odp-prog-label">{item.progress.done} / {item.progress.total} · {pct}%</span>
            </div>
          ) : (
            <div className="odp-prog-empty">No tasks yet — assign tasks to track progress.</div>
          )}

          {/* priority — editable */}
          <div className="odp-section-label">Impact <span className="odp-times">×</span> Effort <span className="odp-hint">editable</span></div>
          <div className="odp-prio">
            <div className="odp-prio-axis">
              <span className="odp-prio-cap">Impact</span>
              <div className="odp-seg">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} className={`odp-seg-btn ${item.impact === n ? 'odp-seg-btn--on' : ''}`} onClick={() => setImpact(n)} title={IMPACT_LABEL[n]}>{n}</button>
                ))}
              </div>
            </div>
            <div className="odp-prio-axis">
              <span className="odp-prio-cap">Effort</span>
              <div className="odp-seg">
                {EFFORT_PRESETS.map((w) => (
                  <button key={w} className={`odp-seg-btn ${item.effort === w ? 'odp-seg-btn--on' : ''}`} onClick={() => setEffort(w)} title={`${w} week${w === 1 ? '' : 's'}`}>{w}w</button>
                ))}
              </div>
            </div>
          </div>

          {/* deps — editable depends-on + read-only blocks */}
          <div className="odp-deps">
            <div className="odp-deps-col">
              <div className="odp-section-label">Depends on <span className="odp-hint">editable</span></div>
              <DependencyPicker options={depOptions} selected={item.depends_on} onChange={setDeps} />
            </div>
          </div>
          <div className="odp-blocks">
            <div className="odp-section-label">Blocks</div>
            {dependents.length === 0 ? <div className="odp-none">— none</div> : dependents.map((c) => (
              <div key={c.slug} className="odp-dep-chip" onClick={() => onOpen(c.slug)}>
                <span className="odp-dep-dot" style={{ background: c.color }} />
                <span className="odp-dep-title">{c.title}</span>
                {c.slipping && <span className="odp-dep-slip">●</span>}
              </div>
            ))}
          </div>

          {/* member tasks */}
          <div className="odp-tasks-head">
            <span className="odp-section-label" style={{ margin: 0 }}>Member tasks</span>
            <span className="odp-tasks-count">{item.tasks.length}</span>
          </div>
          {item.tasks.length === 0 ? (
            <div className="odp-notasks">No tasks yet — link work by adding <span className="odp-mono">objectives: [{item.slug}]</span> to a task's frontmatter.</div>
          ) : (
            <div className="odp-tasklist">
              {item.tasks.map((t) => {
                const tm = RM_TASK[t.status] ?? { label: t.status, color: 'var(--color-text-tertiary)' };
                return (
                  <div key={t.slug} className="odp-task">
                    <span className="odp-task-dot" style={{ background: tm.color }} />
                    <span className="odp-task-slug">{t.slug}</span>
                    <span className="odp-task-status" style={{ color: tm.color }}>{tm.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="odp-foot">
          <span className="odp-foot-note">
            {item.progress.total > 0 ? `forecast from ${item.progress.total} task${item.progress.total === 1 ? '' : 's'} + deps` : 'forecast from committed dates + deps'}
          </span>
          <button className="odp-delete" onClick={handleDelete} title="Delete this objective">
            {deleteObjective.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </>
  );
}
