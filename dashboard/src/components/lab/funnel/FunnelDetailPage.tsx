import { useEffect, useMemo, useRef, useState } from 'react';
import { useLabInsight, useSyncInsight, useUpdateTweaks } from '../../../hooks/useLab';
import { copyPreservingUnicode } from '../../../lib/clipboard';
import {
  applyClientFilters,
  breakdownLanes,
  clientFilters,
  computeStepRows,
  formatDelta,
  formatMetricValue,
  isLowSample,
  prettifyKey,
  readViewState,
  stepTableMarkdown,
  writeViewState,
  FUNNEL_COLORS,
  REMAINDER_VALUE,
  type FunnelDimension,
  type FunnelViewState,
} from './funnelModel';
import { useLabSearchParams } from './labRoute';
import { FunnelFilterBar } from './FunnelFilterBar';
import { FunnelLane, type LaneArc } from './FunnelLane';
import { FunnelStepTable } from './FunnelStepTable';
import { FunnelBars } from './FunnelBars';
import './FunnelDetailPage.css';

/**
 * Funnel insight page 2 — one funnel's step lane (A6-A10): the node lane with
 * drop badges, the two-click arc gesture (pinned arcs live in the URL), the
 * step-table twin, dimension filters, and the one-dimension breakdown as
 * stacked node bands or aligned small-multiple lanes. Esc clears arcs.
 */

const COMPACT_BREAKPOINT = 560;

export function FunnelDetailPage({ slug, funnelId, onBack, onBackToBoard, onToast }: {
  slug: string;
  funnelId: string;
  onBack: () => void;
  onBackToBoard: () => void;
  onToast: (msg: string) => void;
}) {
  const detail = useLabInsight(slug);
  const sync = useSyncInsight();
  const updateTweaks = useUpdateTweaks();
  const [params, updateParams] = useLabSearchParams();
  const view = useMemo(() => readViewState(params), [params]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);

  const setView = (next: FunnelViewState) => updateParams((p) => writeViewState(p, next));

  const entry = detail.data?.cache?.funnel;
  const set = entry?.set;
  const funnel = set?.funnels.find((f) => f.id === funnelId) ?? null;
  const prev = detail.data?.funnelPrev ?? null;
  const tweaks = detail.data?.insight.tweaks ?? [];

  // Compact fallback below the width breakpoint (A6).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setNarrow(e.contentRect.width < COMPACT_BREAKPOINT);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Filtered steps (client dims sum matching segment cells). ──
  const activeClient = useMemo(() => set ? clientFilters(view.filters, set.dimensions) : {}, [set, view.filters]);
  const filtersActive = Object.keys(activeClient).length > 0;
  const filtered = useMemo(
    () => funnel ? applyClientFilters(funnel, activeClient) : null,
    [funnel, activeClient],
  );
  const steps = filtered?.steps ?? funnel?.steps.map((s) => ({ key: s.key, label: s.label, users: s.users })) ?? [];
  const filtersUnavailable = filtersActive && filtered === null;

  // ── Pinned arcs: validate against present steps; swap so from = earlier. ──
  const stepOrder = useMemo(() => new Map(steps.map((s, i) => [s.key, i])), [steps]);
  const arcs: LaneArc[] = useMemo(
    () => view.arcs
      .filter(([a, b]) => stepOrder.has(a) && stepOrder.has(b))
      .map(([a, b]) => (stepOrder.get(a)! <= stepOrder.get(b)! ? { from: a, to: b } : { from: b, to: a })),
    [view.arcs, stepOrder],
  );

  const handleNodeClick = (key: string) => {
    if (!anchor) { setAnchor(key); return; }
    if (anchor === key) { setAnchor(null); return; }
    const ia = stepOrder.get(anchor) ?? 0;
    const ib = stepOrder.get(key) ?? 0;
    const [from, to] = ia <= ib ? [anchor, key] : [key, anchor]; // backwards picks swap automatically
    const existing = arcs.findIndex((a) => a.from === from && a.to === to);
    if (existing >= 0) {
      setView({ ...view, arcs: view.arcs.filter((_, i) => i !== existing) });
    } else {
      setView({ ...view, arcs: [...view.arcs, [from, to]] });
    }
    setAnchor(null);
  };

  // Esc: first press disarms the anchor, next clears every pinned arc (A7).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (anchor) { setAnchor(null); return; }
      if (view.arcs.length > 0) setView({ ...view, arcs: [] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, view]);

  // ── Breakdown (A10). ──
  const breakdownDim = set?.dimensions.find((d) => d.key === view.breakdown && d.mode === 'client') ?? null;
  const lanes = useMemo(
    () => funnel && breakdownDim ? breakdownLanes(funnel, breakdownDim.key) : [],
    [funnel, breakdownDim],
  );
  const legend = useMemo(
    () => lanes.map((lane, i) => ({
      value: lane.value,
      color: lane.value === REMAINDER_VALUE ? 'var(--color-bg-tertiary)' : FUNNEL_COLORS[i % FUNNEL_COLORS.length],
    })),
    [lanes],
  );
  const bands = useMemo(() => {
    if (!breakdownDim || lanes.length === 0 || !funnel) return null;
    const map = new Map<string, { value: string; users: number }[]>();
    for (const step of funnel.steps) {
      map.set(step.key, lanes.map((lane) => ({ value: lane.value, users: lane.steps.get(step.key) ?? 0 })));
    }
    return map;
  }, [breakdownDim, lanes, funnel]);

  const arcDetail = useMemo(() => {
    if (!breakdownDim || lanes.length === 0) return undefined;
    return (arc: LaneArc) => lanes.map((lane) => ({
      value: lane.value,
      from: lane.steps.get(arc.from) ?? 0,
      to: lane.steps.get(arc.to) ?? 0,
    }));
  }, [breakdownDim, lanes]);

  const applyRefetchDim = (dim: FunnelDimension, value: string | null) => {
    const tweakKey = dim.tweak ?? dim.key;
    if (!tweaks.some((t) => t.key === tweakKey)) {
      onToast(`Dimension "${dim.label}" points at tweak "${tweakKey}", which this insight does not declare.`);
      return;
    }
    updateTweaks.mutate({ slug, tweaks: { [tweakKey]: value ?? '' } }, {
      onSuccess: () => sync.mutate(slug, { onError: (e) => onToast(`Re-fetch failed — ${(e as Error).message}`) }),
      onError: (e) => onToast(`Filter failed — ${(e as Error).message}`),
    });
  };

  const refetchValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const dim of set?.dimensions ?? []) {
      if (dim.mode !== 'refetch') continue;
      out[dim.key] = tweaks.find((t) => t.key === (dim.tweak ?? dim.key))?.value ?? '';
    }
    return out;
  }, [set, tweaks]);

  // ── Page states. ──
  if (detail.isLoading) {
    return <div className="funnel-det"><div className="funnel-det-state">Loading funnel…</div></div>;
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="funnel-det">
        <Crumbs onBackToBoard={onBackToBoard} onBack={onBack} title={slug} name={funnelId} />
        <div className="funnel-det-state error-state">Failed to load the insight. {(detail.error as Error)?.message}</div>
      </div>
    );
  }
  const title = detail.data.insight.title;
  if (!entry || !set) {
    return (
      <div className="funnel-det">
        <Crumbs onBackToBoard={onBackToBoard} onBack={onBack} title={title} name={funnelId} />
        <div className="funnel-det-state">No funnel-set data — sync the insight, then reopen this page.</div>
      </div>
    );
  }
  if (!funnel) {
    return (
      <div className="funnel-det">
        <Crumbs onBackToBoard={onBackToBoard} onBack={onBack} title={title} name={funnelId} />
        <div className="funnel-det-state">
          Funnel “{funnelId}” is not in the current set (the data window or a refetch filter may have changed).
          <button className="funnel-det-linkbtn" onClick={onBack}>Back to the table</button>
        </div>
      </div>
    );
  }

  const low = isLowSample(funnel, set);
  const prevSteps = prev?.steps[funnel.id] ?? {};
  const prevMetrics = prev?.metrics[funnel.id] ?? {};
  const laneMax = Math.max(1, ...lanes.map((l) => l.users), steps[0]?.users ?? 0);

  const copyStepTable = () => {
    void copyPreservingUnicode(stepTableMarkdown(funnel.name, computeStepRows(steps)))
      .then((ok) => onToast(ok ? 'Step table copied as Markdown.' : 'Copy failed.'));
  };
  const copyDeepLink = () => {
    void copyPreservingUnicode(window.location.href)
      .then((ok) => onToast(ok ? 'Deep link copied.' : 'Copy failed.'));
  };

  return (
    <div className="funnel-det">
      <Crumbs onBackToBoard={onBackToBoard} onBack={onBack} title={title} name={funnel.name} />

      <div className="funnel-det-toolbar">
        <FunnelFilterBar
          set={set}
          filters={view.filters}
          refetchValues={refetchValues}
          onChange={(filters) => setView({ ...view, filters })}
          onApplyRefetch={applyRefetchDim}
          syncing={sync.isPending || updateTweaks.isPending}
        />
        <div className="funnel-det-toolbar-spacer" />
        <label className="funnel-det-bd">
          Breakdown
          <select
            value={breakdownDim?.key ?? ''}
            onChange={(e) => setView({ ...view, breakdown: e.target.value || null })}
            aria-label="Break down by dimension"
          >
            <option value="">none</option>
            {set.dimensions.filter((d) => d.mode === 'client').map((d) => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </select>
        </label>
        {breakdownDim && (
          <div className="funnel-det-bdmode" role="group" aria-label="Breakdown layout">
            <button
              className={`funnel-det-mode${view.breakdownMode === 'stack' ? ' funnel-det-mode--on' : ''}`}
              onClick={() => setView({ ...view, breakdownMode: 'stack' })}
              aria-pressed={view.breakdownMode === 'stack'}
            >Stacked</button>
            <button
              className={`funnel-det-mode${view.breakdownMode === 'lanes' ? ' funnel-det-mode--on' : ''}`}
              onClick={() => setView({ ...view, breakdownMode: 'lanes' })}
              aria-pressed={view.breakdownMode === 'lanes'}
            >Lanes</button>
          </div>
        )}
        <button className="funnel-det-action" onClick={() => setShowTable((v) => !v)} aria-pressed={showTable} aria-expanded={showTable}>
          {showTable ? 'Hide table' : 'Step table'}
        </button>
        <button className="funnel-det-action" onClick={copyStepTable} title="Copy the step table as Markdown">Copy MD</button>
        <button className="funnel-det-action" onClick={copyDeepLink} title="Copy a link to exactly this view">Copy link</button>
      </div>

      {low && (
        <div className="funnel-det-warn" role="note">
          Low sample — n={funnel.steps[0]?.users ?? 0} at the top step. Rates below are noise, not signal.
        </div>
      )}
      {filtersUnavailable && (
        <div className="funnel-det-warn" role="note">
          This funnel's payload carries no segments — client-side filters can't apply here. Showing unfiltered steps.
        </div>
      )}
      {anchor && (
        <div className="funnel-det-hint" role="status">
          Arc anchor set on “{steps.find((s) => s.key === anchor)?.label ?? anchor}” — click a second step to draw the arrow, Esc to cancel.
        </div>
      )}

      <div className="funnel-det-body" ref={bodyRef}>
        {narrow ? (
          <FunnelBars steps={steps} />
        ) : breakdownDim && view.breakdownMode === 'lanes' && lanes.length > 0 ? (
          <div className="funnel-det-multiples">
            {lanes.map((lane, i) => (
              <div key={lane.value} className="funnel-det-multiple">
                <div className="funnel-det-multiple-head">
                  <span className="funnel-det-swatch" style={{ background: legend[i].color }} aria-hidden />
                  {lane.value}
                  <span className="funnel-det-multiple-n">{lane.users.toLocaleString('en-US')} users</span>
                </div>
                <FunnelLane
                  compact
                  steps={funnel.steps.map((s) => ({ key: s.key, label: s.label, users: lane.steps.get(s.key) ?? 0 }))}
                  volumeMax={laneMax}
                />
              </div>
            ))}
          </div>
        ) : (
          <FunnelLane
            steps={steps}
            arcs={arcs}
            anchor={anchor}
            onNodeClick={handleNodeClick}
            onArcRemove={(i) => setView({ ...view, arcs: view.arcs.filter((_, idx) => idx !== i) })}
            bands={view.breakdownMode === 'stack' ? bands : null}
            bandLegend={legend}
            arcDetail={arcDetail}
          />
        )}

        {breakdownDim && view.breakdownMode === 'stack' && legend.length > 0 && !narrow && (
          <div className="funnel-det-legend" role="list" aria-label={`${breakdownDim.label} legend`}>
            {legend.map((l) => (
              <span key={l.value} className="funnel-det-legenditem" role="listitem">
                <span className="funnel-det-swatch" style={{ background: l.color }} aria-hidden />
                {l.value}
              </span>
            ))}
          </div>
        )}

        {showTable && (
          <div className="funnel-det-tablewrap">
            <FunnelStepTable
              steps={steps}
              caption={`Step table for funnel ${funnel.name}`}
              prevUsers={filtersActive ? undefined : prevSteps}
            />
          </div>
        )}
      </div>

      <aside className="funnel-det-rail">
        <h3 className="funnel-det-railtitle">Metrics</h3>
        <dl className="funnel-det-metrics">
          {Object.entries(funnel.metrics).map(([key, metric]) => {
            const p = prevMetrics[key] ?? null;
            return (
              <div key={key} className="funnel-det-metric">
                <dt>{metric.label ?? prettifyKey(key)}</dt>
                <dd>
                  {formatMetricValue(metric.v, metric.format)}
                  {metric.v !== null && p !== null && (
                    <span
                      className={`funnel-delta funnel-delta--${formatDelta(metric.v, p, metric.format).direction}`}
                      title={`${formatMetricValue(metric.v, metric.format)} now vs ${formatMetricValue(p, metric.format)} previous period`}
                    >{formatDelta(metric.v, p, metric.format).text}</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        {Object.keys(funnel.meta).length > 0 && (
          <>
            <h3 className="funnel-det-railtitle">About</h3>
            <dl className="funnel-det-meta">
              {Object.entries(funnel.meta).map(([key, value]) => (
                <div key={key} className="funnel-det-metarow">
                  <dt>{prettifyKey(key)}</dt>
                  <dd>
                    {/^https?:\/\//.test(value)
                      ? <a href={value} target="_blank" rel="noreferrer">{value}</a>
                      : value}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <div className="funnel-det-window">Window: {entry.range.fromISO} → {entry.range.toISO}</div>
        {prev?.source && <div className="funnel-det-window">Δ vs {prev.source.range.fromISO} → {prev.source.range.toISO}</div>}
      </aside>
    </div>
  );
}

function Crumbs({ onBackToBoard, onBack, title, name }: {
  onBackToBoard: () => void;
  onBack: () => void;
  title: string;
  name: string;
}) {
  return (
    <nav className="funnel-crumbs" aria-label="Breadcrumb">
      <button className="funnel-crumb-link" onClick={onBackToBoard}>Insights</button>
      <span className="funnel-crumb-sep" aria-hidden>/</span>
      <button className="funnel-crumb-link" onClick={onBack}>{title}</button>
      <span className="funnel-crumb-sep" aria-hidden>/</span>
      <span className="funnel-crumb-here" aria-current="page">{name}</span>
    </nav>
  );
}
