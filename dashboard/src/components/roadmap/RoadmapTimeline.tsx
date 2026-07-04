import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RM_STATUS, RM_RED, RM_ACCENT, softColor, fmtMetricValue } from './chrome';
import type { RoadmapCardProps } from './RoadmapToolbar';
import type { RoadmapItem } from '../../hooks/useRoadmapItems';
import { useUpdateObjective, useAddDependency, useRemoveDependency } from '../../hooks/useObjectives';
import { useAppZoom } from '../../hooks/useAppZoom';
import {
  buildForecasts, MONTH_SHORT,
  parseISO, diffDays, addISO, todayISO, fmtShort,
} from './roadmap-forecast';
import './RoadmapTimeline.css';

/**
 * RoadmapTimeline — the interactive timeline body, styled to the Claude roadmap
 * design (Roadmap.dc.html): a month-gridded date axis, gradient status bars showing
 * the computed FORECAST window, a dotted ◆ target marker, red slip-overshoot
 * hatching, and dependency bezier connectors that turn red when the cascade slips.
 *
 * The bar renders at the forecast window (roadmap-forecast.ts). Dragging edits the
 * objective's committed dates and re-runs the cascade live — so dependents slide to
 * stay after their predecessor and redden the instant a forecast overruns its target.
 * Only the dragged objective's dates are persisted; the rest is computed.
 */

interface RoadmapTimelineProps {
  items: RoadmapItem[];      // visible rows (post-filter)
  allItems: RoadmapItem[];   // full set — the cascade must see hidden predecessors
  cardProps: RoadmapCardProps;
  onOpen: (slug: string) => void;
  onToast: (msg: string) => void;
}

const PAD = 22;
const LABEL_OPEN = 268;
const LABEL_COLLAPSED = 46;
const HEADER_H = 40;
const ROW_H = 66;
const BAR_H = 40;
const PPD_LADDER = [3, 4, 5, 6, 8, 11, 15, 22];
const clampIdx = (i: number) => Math.max(0, Math.min(PPD_LADDER.length - 1, i));

/** Short progress caption under the row title: metric value/target, or task counts. */
function progressText(it: RoadmapItem): string {
  const p = it.progress;
  if (p.source === 'metric' && p.metric) {
    return `${fmtMetricValue(p.metric.current, p.metric.unit)}/${fmtMetricValue(p.metric.target, p.metric.unit)}`;
  }
  return p.total > 0 ? `${p.done}/${p.total}` : 'no tasks';
}

type DragMode = 'move' | 'start' | 'end';
interface DragState {
  slug: string; mode: DragMode; startX: number; ppd: number; z: number;
  origStart: string; origEnd: string;
}
interface LinkState { from: string; sx: number; sy: number; }

export function RoadmapTimeline({ items, allItems, cardProps, onOpen, onToast }: RoadmapTimelineProps) {
  const updateObjective = useUpdateObjective();
  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const mut = useRef({ updateObjective, addDependency, removeDependency });
  mut.current = { updateObjective, addDependency, removeDependency };

  // Latest-value refs so the window-listener callbacks (onLinkMove/endLink) can be
  // referentially STABLE — the unmount cleanup below removes them by identity, so a
  // gesture that's still live at unmount must be removable even after rows/allItems
  // changed. Without this, a stale-closure removeEventListener no-ops and leaks.
  const allItemsRef = useRef(allItems);
  allItemsRef.current = allItems;
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const rowsRef = useRef<RoadmapItem[]>([]);

  const [namesOpen, setNamesOpen] = useState(true);
  const [zoom, setZoom] = useState<number | null>(null);
  const [containerW, setContainerW] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const setScrollEl = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!el) return;
    setContainerW(el.clientWidth);
    const ro = new ResizeObserver((entries) => { for (const e of entries) setContainerW(e.contentRect.width); });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  // App-wide UI zoom — the card is CSS-`zoom`ed, so pointer deltas (physical px)
  // must be divided by this to map back to the timeline's logical geometry.
  const appZoom = useAppZoom();
  const appZoomRef = useRef(appZoom);
  appZoomRef.current = appZoom;

  // Live drag preview (committed-date override that drives the whole cascade).
  const [dragPreview, setDragPreview] = useState<{ slug: string; start: string; target: string } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const previewRef = useRef<{ start: string; target: string } | null>(null);
  const movedRef = useRef(false);

  // Connect-to-link drag.
  const [link, setLink] = useState<LinkState | null>(null);
  const [linkCursor, setLinkCursor] = useState<{ x: number; y: number } | null>(null);
  const [linkTargetIdx, setLinkTargetIdx] = useState<number | null>(null);
  const linkRef = useRef<LinkState | null>(null);
  const linkTargetRef = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const LW = namesOpen ? LABEL_OPEN : LABEL_COLLAPSED;

  // Optimistic committed-date overrides — a dropped drag holds its new dates until
  // the refetch agrees (no snap-back flicker between commit and reload).
  const [optim, setOptim] = useState<Record<string, { start: string; target: string }>>({});
  useEffect(() => {
    setOptim((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const it of allItems) {
        const o = prev[it.slug];
        if (!o) continue;
        const cs = it.start_date ?? it.target_date;
        const ct = it.target_date ?? it.start_date;
        if (cs === o.start && ct === o.target) { delete next[it.slug]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [allItems]);

  // Forecasts: base (committed optim only → stable range + sort) and render (adds the
  // live drag delta → drives the bars + cascade).
  const optimOverrides = useMemo(() => {
    const keys = Object.keys(optim);
    if (!keys.length) return undefined;
    return new Map(keys.map((s) => [s, { start: optim[s].start as string | null, target: optim[s].target as string | null }]));
  }, [optim]);
  const renderOverrides = useMemo(() => {
    const m = new Map<string, { start: string | null; target: string | null }>(optimOverrides ?? []);
    if (dragPreview) m.set(dragPreview.slug, { start: dragPreview.start, target: dragPreview.target });
    return m.size ? m : undefined;
  }, [optimOverrides, dragPreview]);
  const baseForecasts = useMemo(() => buildForecasts(allItems, optimOverrides), [allItems, optimOverrides]);
  const forecasts = useMemo(() => buildForecasts(allItems, renderOverrides), [allItems, renderOverrides]);

  // Visible rows, sorted by forecast start (unforecastable last), then title.
  const rows = useMemo(() => {
    return [...items].sort((a, b) => {
      const fa = baseForecasts.get(a.slug), fb = baseForecasts.get(b.slug);
      const sa = fa?.forecast_start ?? '9999-99-99';
      const sb = fb?.forecast_start ?? '9999-99-99';
      return sa === sb ? a.title.localeCompare(b.title) : sa.localeCompare(sb);
    });
  }, [items, baseForecasts]);
  rowsRef.current = rows;
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.slug, i));
    return m;
  }, [rows]);

  // Date range across the visible forecasts + committed targets + today, month-aligned.
  const range = useMemo(() => {
    const today = todayISO();
    const dates: string[] = [today];
    for (const it of rows) {
      const f = baseForecasts.get(it.slug);
      if (f?.forecast_start) dates.push(f.forecast_start);
      if (f?.forecast_end) dates.push(f.forecast_end);
      if (f?.target) dates.push(f.target);
    }
    let min = dates.reduce((a, b) => (a < b ? a : b));
    let max = dates.reduce((a, b) => (a > b ? a : b));
    min = addISO(min, -8);
    max = addISO(max, 24);
    const md = parseISO(min);
    const start = `${md.getFullYear()}-${String(md.getMonth() + 1).padStart(2, '0')}-01`;
    return { start, end: max, totalDays: diffDays(start, max) };
  }, [rows, baseForecasts]);

  const ppd = (() => {
    if (zoom !== null) return PPD_LADDER[clampIdx(zoom)];
    if (containerW <= 0) return 6;
    const fit = (containerW - LW - PAD * 2 - 130) / Math.max(1, range.totalDays);
    return Math.max(4, Math.min(22, fit));
  })();

  const di = (d: string) => diffDays(range.start, d);
  const gx = (d: string) => PAD + di(d) * ppd;
  const gridW = PAD * 2 + range.totalDays * ppd;
  const innerW = LW + gridW;
  const rowsH = rows.length * ROW_H;
  const todayX = gx(todayISO());

  const months = useMemo(() => {
    const out: { label: string; x: number }[] = [];
    const s = parseISO(range.start);
    const e = parseISO(range.end);
    const cur = new Date(s.getFullYear(), s.getMonth(), 1);
    while (cur <= e) {
      out.push({ label: MONTH_SHORT[cur.getMonth()], x: Math.round(gx(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-01`)) });
      cur.setMonth(cur.getMonth() + 1);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, ppd, LW]);

  // Dependency connectors between two visible, forecastable rows.
  const edges = useMemo(() => {
    if (cardProps.dependencies === false) return [];
    const out: Array<{ from: string; to: string; d: string; cascade: boolean; x1: number; y1: number; x2: number; y2: number }> = [];
    for (const it of rows) {
      const iTo = rowIndex.get(it.slug);
      const ft = forecasts.get(it.slug);
      if (iTo === undefined || !ft?.forecastable) continue;
      for (const depSlug of it.depends_on) {
        const iFrom = rowIndex.get(depSlug);
        const ff = forecasts.get(depSlug);
        if (iFrom === undefined || !ff?.forecastable) continue;
        const x1 = gx(ff.forecast_end!), y1 = iFrom * ROW_H + ROW_H / 2;
        const x2 = gx(ft.forecast_start!), y2 = iTo * ROW_H + ROW_H / 2;
        const cascade = ft.slipping || ff.slipping;
        out.push({
          from: depSlug, to: it.slug, cascade, x1, y1, x2, y2,
          d: `M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, rowIndex, forecasts, ppd, range, cardProps.dependencies]);

  // ── bar drag ─────────────────────────────────────────────────────────────────
  const onDragMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // clientX is post-zoom (physical) px; /d.z maps it back to logical px, /d.ppd to days.
    const delta = Math.round((e.clientX - d.startX) / (d.ppd * d.z));
    if (delta !== 0) movedRef.current = true;
    let start = d.origStart, target = d.origEnd;
    if (d.mode === 'move') { start = addISO(d.origStart, delta); target = addISO(d.origEnd, delta); }
    else if (d.mode === 'start') { const ns = addISO(d.origStart, delta); start = ns > d.origEnd ? d.origEnd : ns; }
    else { const nt = addISO(d.origEnd, delta); target = nt < d.origStart ? d.origStart : nt; }
    previewRef.current = { start, target };
    setDragPreview({ slug: d.slug, start, target });
  }, []);

  const endDrag = useCallback(() => {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    const d = dragRef.current;
    const p = previewRef.current;
    if (d && p && movedRef.current && (p.start !== d.origStart || p.target !== d.origEnd)) {
      // Persist the full committed window (start ≤ target guaranteed by the drag
      // clamps); hold it optimistically so the bar doesn't snap back before refetch.
      setOptim((o) => ({ ...o, [d.slug]: { start: p.start, target: p.target } }));
      mut.current.updateObjective.mutate({ slug: d.slug, patch: { start_date: p.start, target_date: p.target } }, {
        onError: (err: unknown) => {
          setOptim((o) => { const n = { ...o }; delete n[d.slug]; return n; });
          onToastRef.current(err instanceof Error ? err.message : 'Could not save dates.');
        },
      });
    }
    dragRef.current = null;
    previewRef.current = null;
    setDragPreview(null);
  }, [onDragMove]);

  const beginDrag = useCallback((e: React.PointerEvent, slug: string, start: string, end: string, mode: DragMode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    movedRef.current = false;
    // Pointer-capture guarantees pointerup/pointercancel are delivered even if the
    // button is released off-window (over the dock / a second monitor) — prevents
    // the classic "stuck drag" where the bar sticks at the last preview position.
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    dragRef.current = { slug, mode, startX: e.clientX, ppd, z: appZoomRef.current, origStart: start, origEnd: end };
    previewRef.current = { start, target: end };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }, [ppd, onDragMove, endDrag]);

  // ── connect-to-link drag ─────────────────────────────────────────────────────
  // Both callbacks are referentially STABLE (empty deps; read rows/allItems/onToast
  // from refs), so the unmount cleanup can always remove the exact listeners that
  // were attached — no stale-closure leak, no setState-after-unmount.
  const onLinkMove = useCallback((e: PointerEvent) => {
    if (!linkRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    // rect + clientX are post-zoom (physical); /z maps the offset back to the SVG's
    // logical user units, which is the space the edges + row math live in.
    const z = appZoomRef.current;
    const x = (e.clientX - rect.left) / z, y = (e.clientY - rect.top) / z;
    setLinkCursor({ x, y });
    const idx = Math.floor(y / ROW_H);
    const valid = idx >= 0 && idx < rowsRef.current.length ? idx : null;
    linkTargetRef.current = valid;
    setLinkTargetIdx(valid);
  }, []);

  const endLink = useCallback(() => {
    window.removeEventListener('pointermove', onLinkMove);
    window.removeEventListener('pointerup', endLink);
    window.removeEventListener('pointercancel', endLink);
    const l = linkRef.current;
    const idx = linkTargetRef.current;
    if (l && idx !== null) {
      const target = rowsRef.current[idx];
      if (target && target.slug !== l.from) {
        const fromTitle = allItemsRef.current.find((i) => i.slug === l.from)?.title ?? l.from;
        mut.current.addDependency.mutate({ slug: target.slug, to: l.from }, {
          onSuccess: () => onToastRef.current(`Linked: “${target.title}” depends on “${fromTitle}”`),
          onError: (err: unknown) => onToastRef.current(err instanceof Error ? err.message : 'Could not link objectives.'),
        });
      }
    }
    linkRef.current = null;
    linkTargetRef.current = null;
    setLink(null);
    setLinkCursor(null);
    setLinkTargetIdx(null);
  }, [onLinkMove]);

  const beginLink = useCallback((e: React.PointerEvent, fromSlug: string, sx: number, sy: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    const s = { from: fromSlug, sx, sy };
    linkRef.current = s;
    setLink(s);
    setLinkCursor({ x: sx, y: sy });
    window.addEventListener('pointermove', onLinkMove);
    window.addEventListener('pointerup', endLink);
    window.addEventListener('pointercancel', endLink);
  }, [onLinkMove, endLink]);

  const removeEdge = useCallback((dependentSlug: string, depSlug: string) => {
    mut.current.removeDependency.mutate({ slug: dependentSlug, to: depSlug }, {
      onError: (err: unknown) => onToast(err instanceof Error ? err.message : 'Could not remove link.'),
    });
  }, [onToast]);

  // Remove any still-attached gesture listeners on unmount. onDragMove/endDrag and
  // onLinkMove/endLink are all referentially stable, so these removals hit the exact
  // functions that beginDrag/beginLink attached (no leak, no unmounted setState).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    window.removeEventListener('pointermove', onLinkMove);
    window.removeEventListener('pointerup', endLink);
    window.removeEventListener('pointercancel', endLink);
  }, []);

  const zoomIdx = zoom !== null ? clampIdx(zoom) : (() => { const i = PPD_LADDER.findIndex((w) => w >= ppd); return i === -1 ? PPD_LADDER.length - 1 : i; })();

  return (
    <div className={`rtl ${dragPreview ? 'rtl--dragging' : ''} ${link ? 'rtl--linking' : ''}`}>
      {/* legend */}
      <div className="rtl-legend">
        {(['done', 'active', 'review', 'not_started'] as const).map((s) => (
          <span key={s} className="rtl-legend-item"><span className="rtl-legend-swatch" style={{ background: RM_STATUS[s].color }} />{RM_STATUS[s].label}</span>
        ))}
        <span className="rtl-legend-div" />
        <span className="rtl-legend-item"><span className="rtl-legend-hatch" />slip overshoot</span>
        <span className="rtl-legend-item"><span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}>◆</span>target</span>
        <span className="rtl-legend-item"><span className="rtl-legend-today" />today</span>
        <span className="rtl-legend-spacer" />
        <button type="button" className={`rtl-names-btn ${namesOpen ? 'rtl-names-btn--on' : ''}`} onClick={() => setNamesOpen((v) => !v)} title="Toggle objective names column" aria-label={namesOpen ? 'Hide objective names column' : 'Show objective names column'} aria-pressed={namesOpen}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2" stroke="currentColor" strokeWidth="1.4" /><line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" strokeWidth="1.4" /></svg>
          {namesOpen ? 'Hide names' : 'Show names'}
        </button>
        <div className="rtl-zoom" role="group" aria-label="Zoom timeline">
          <button type="button" className="rtl-zoom-btn" onClick={() => setZoom(clampIdx(zoomIdx - 1))} disabled={zoomIdx === 0} title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" className="rtl-zoom-btn" onClick={() => setZoom(clampIdx(zoomIdx + 1))} disabled={zoomIdx === PPD_LADDER.length - 1} title="Zoom in" aria-label="Zoom in">+</button>
        </div>
      </div>

      <div className="rtl-scroll" ref={setScrollEl}>
        <div className="rtl-inner" style={{ width: innerW, minHeight: '100%' }}>
          {/* grid background */}
          <div className="rtl-grid" style={{ left: LW, width: gridW }}>
            {months.map((m, idx) => (
              <div key={idx}>
                <div className="rtl-month-line" style={{ left: m.x }} />
                <div className="rtl-month-label" style={{ left: m.x + 7 }}>{m.label}</div>
              </div>
            ))}
            {todayX >= 0 && todayX <= gridW && <>
              <div className="rtl-today-line" style={{ left: todayX }} />
              <div className="rtl-today-badge" style={{ left: todayX + 6 }}><span className="rtl-today-dot" />TODAY</div>
            </>}
          </div>

          <div style={{ height: HEADER_H }} />

          {/* connectors */}
          <svg ref={svgRef} className="rtl-deps" style={{ left: LW, top: HEADER_H, width: gridW, height: rowsH }} width={gridW} height={rowsH}>
            <defs>
              <marker id="rtl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill={RM_ACCENT} /></marker>
              <marker id="rtl-arrow-red" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill={RM_RED} /></marker>
            </defs>
            {edges.map((e) => {
              const mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2;
              return (
                <g className="rtl-dep" key={`${e.from}->${e.to}`}>
                  <path className="rtl-dep-hit" d={e.d} />
                  <path className="rtl-dep-line" d={e.d} markerEnd={`url(#${e.cascade ? 'rtl-arrow-red' : 'rtl-arrow'})`}
                    style={{ stroke: e.cascade ? RM_RED : 'var(--color-border-hover)', strokeWidth: e.cascade ? 2 : 1.5, strokeDasharray: e.cascade ? 'none' : '5 5', strokeOpacity: e.cascade ? 0.95 : 0.7 }} />
                  <g className="rtl-dep-remove" transform={`translate(${mx} ${my})`} onClick={() => removeEdge(e.to, e.from)} role="button" aria-label="Remove dependency">
                    <circle r="8" /><path d="M-3 -3L3 3M3 -3L-3 3" />
                  </g>
                </g>
              );
            })}
            {link && linkCursor && (
              <path className="rtl-link-live" d={`M ${link.sx} ${link.sy} C ${link.sx + 30} ${link.sy}, ${linkCursor.x - 30} ${linkCursor.y}, ${linkCursor.x} ${linkCursor.y}`} markerEnd="url(#rtl-arrow)" />
            )}
          </svg>

          {/* rows */}
          {rows.map((it, i) => {
            const f = forecasts.get(it.slug)!;
            const meta = RM_STATUS[it.status];
            const pct = it.progress.pct;
            const isLinkTarget = link && linkTargetIdx === i && it.slug !== link.from;
            return (
              <div key={it.slug} className={`rtl-row ${isLinkTarget ? 'rtl-row--linktarget' : ''}`} style={{ height: ROW_H }}>
                {/* sticky label */}
                <div className="rtl-label" style={{ width: LW, cursor: 'pointer', padding: namesOpen ? '0 14px 0 18px' : 0, alignItems: namesOpen ? 'stretch' : 'center', justifyContent: 'center' }} onClick={() => onOpen(it.slug)}>
                  {namesOpen ? (
                    <div className="rtl-label-open">
                      <div className="rtl-label-title-row">
                        <span className="rtl-label-dot" style={{ background: meta.color }} />
                        <span className="rtl-label-title">{it.title}</span>
                        {it.statusOverride && <span className="rtl-label-set" title="Status set manually by the PO">SET</span>}
                      </div>
                      {cardProps.progress !== false && (
                        <div className="rtl-label-prog">
                          <div className="rtl-label-track"><div className="rtl-label-fill" style={{ width: `${pct ?? 0}%`, background: meta.color }} /></div>
                          <span className="rtl-label-proglabel">{progressText(it)}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="rtl-label-dot" title={it.title} style={{ background: meta.color, boxShadow: `0 0 0 3px ${softColor(meta.color, 0.22)}` }} />
                  )}
                </div>

                {/* track */}
                {f.forecastable ? (() => {
                  const sx = gx(f.forecast_start!), ex = gx(f.forecast_end!), tx = gx(f.target!);
                  const splitX = Math.max(sx, Math.min(tx, ex));
                  const barLeft = LW + sx;
                  const barW = Math.max(8, ex - sx);
                  const mainW = Math.max(0, splitX - sx);
                  const overW = Math.max(0, ex - splitX);
                  const isDragging = dragPreview?.slug === it.slug;
                  return (
                    <>
                      <div
                        className={`rtl-bar ${isDragging ? 'rtl-bar--active' : ''}`}
                        style={{ left: barLeft, width: barW, height: BAR_H }}
                        onPointerDown={(e) => beginDrag(e, it.slug, f.committedStart!, f.committedEnd!, 'move')}
                        onClick={() => { if (!movedRef.current) onOpen(it.slug); }}
                        title={`${it.title} · ${fmtShort(f.forecast_start!)} → ${fmtShort(f.forecast_end!)}${f.slipping ? ` · slipping ${f.slipDays}d` : ''}\nDrag to reschedule · drag an edge to resize`}
                      >
                        <div className="rtl-bar-main" style={{ width: mainW, background: `linear-gradient(180deg, ${meta.lite}, ${meta.color})` }} />
                        {f.slipping && overW > 0 && <div className="rtl-bar-over" style={{ left: mainW, width: overW }} />}
                        <span className="rtl-bar-inner">
                          <span className="rtl-bar-title">{it.title}</span>
                          {cardProps.progress !== false && pct !== null && barW > 88 && <span className="rtl-bar-pct">{pct}%</span>}
                        </span>
                        <span className="rtl-handle rtl-handle--start" onPointerDown={(e) => beginDrag(e, it.slug, f.committedStart!, f.committedEnd!, 'start')} title="Drag to set start" />
                        <span className="rtl-handle rtl-handle--end" onPointerDown={(e) => beginDrag(e, it.slug, f.committedStart!, f.committedEnd!, 'end')} title="Drag to set target" />
                      </div>
                      {/* connect dot */}
                      <span className="rtl-connect" style={{ left: barLeft + barW + 7, top: ROW_H / 2 }}
                        onPointerDown={(e) => beginLink(e, it.slug, sx + barW, i * ROW_H + ROW_H / 2)}
                        title="Drag onto another objective to link (this must finish first)">◆</span>
                      <span className="rtl-end-label" style={{ left: LW + ex + 12, color: f.slipping ? RM_RED : 'var(--color-text-tertiary)' }}>{fmtShort(f.forecast_end!)}</span>
                      <div className="rtl-target-line" style={{ left: LW + tx }} title={`Target: ${fmtShort(f.target!)}`} />
                      <div className="rtl-target-diamond" style={{ left: LW + tx - 5.5 }}>◆</div>
                    </>
                  );
                })() : (
                  <>
                    <div className="rtl-ghost" style={{ left: LW + PAD }} onClick={() => onOpen(it.slug)}>
                      <span className="rtl-ghost-dot" style={{ background: meta.color }} />
                      <span className="rtl-ghost-title">{it.title}</span>
                      <span className="rtl-ghost-sep" />
                      <span className="rtl-ghost-note">Unforecastable — no dates</span>
                    </div>
                    {f.target && <>
                      <div className="rtl-target-line" style={{ left: LW + gx(f.target), opacity: 0.7 }} title={`Target: ${fmtShort(f.target)}`} />
                      <div className="rtl-target-diamond" style={{ left: LW + gx(f.target) - 5.5 }}>◆</div>
                    </>}
                  </>
                )}
              </div>
            );
          })}
          <div style={{ height: 20 }} />
        </div>
      </div>
    </div>
  );
}
