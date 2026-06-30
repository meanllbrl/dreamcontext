import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useUpdateTask } from '../../hooks/useTasks';
import { TaskCard } from './TaskCard';
import { taskAssignee, STATUS_META, STATUS_ORDER } from './boardModel';
import {
  MONTH_SHORT,
  formatISO, todayISO, parseISO, addDays, diffDays, taskSpan,
} from './calendar-utils';
import './TimelineGantt.css';

interface TimelineGanttProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

interface ScheduledRow {
  task: Task;
  start: string;
  end: string;
  overdue: boolean;
}

type DragMode = 'move' | 'start' | 'end';

interface DragState {
  slug: string;
  mode: DragMode;
  startX: number;
  dayW: number;
  origStart: string;
  origEnd: string;
  rangeStart: string;
  rangeEnd: string;
}

/** Pixels-per-day ladder for the zoom control (zoom out → see everything, zoom in → read detail). */
const ZOOM_LADDER = [10, 16, 24, 36, 52, 72, 100];

/** Pick a sensible starting zoom so the initial plan is legible without manual zooming. */
function defaultZoomIndex(totalDays: number): number {
  if (totalDays <= 21) return 6; // 100px
  if (totalDays <= 40) return 5; // 72px
  if (totalDays <= 70) return 4; // 52px
  if (totalDays <= 140) return 3; // 36px
  if (totalDays <= 280) return 1; // 16px
  return 0; // 10px
}

const LABEL_W = 240;

const clampIdx = (i: number) => Math.max(0, Math.min(ZOOM_LADDER.length - 1, i));
const addISO = (iso: string, days: number) => formatISO(addDays(parseISO(iso), days));
const fmtShort = (iso: string) => {
  const d = parseISO(iso);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
};
const rangeLabel = (start: string, end: string) =>
  start === end ? fmtShort(start) : `${fmtShort(start)} → ${fmtShort(end)}`;

export function TimelineGantt({ tasks, onTaskClick }: TimelineGanttProps) {
  const [unscheduledOpen, setUnscheduledOpen] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const updateTask = useUpdateTask();
  // Held in a ref so the drag callbacks can stay referentially stable — react-query
  // recreates the mutation object every render, and a changing dep would tear down
  // the window listeners mid-drag (leaving the cursor stuck in the grab state).
  const updateTaskRef = useRef(updateTask);
  updateTaskRef.current = updateTask;

  // Measure the scroll viewport so days can stretch to fill the available width
  // (no dead space on wide screens) while still allowing zoom-in to overflow.
  const [containerW, setContainerW] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const setScrollEl = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!el) return;
    setContainerW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerW(e.contentRect.width);
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  // Optimistic date overrides so a dragged bar stays put until the refetch lands.
  const [optim, setOptim] = useState<Record<string, { start: string; end: string }>>({});

  // Live drag preview (drives the dragged bar's position before commit).
  const [dragPreview, setDragPreview] = useState<{ slug: string; start: string; end: string } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const previewRef = useRef<{ start: string; end: string } | null>(null);
  const movedRef = useRef(false);

  // Drop an optimistic override once the real task data agrees with it.
  useEffect(() => {
    setOptim((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const t of tasks) {
        const o = prev[t.slug];
        if (!o) continue;
        const span = taskSpan(t);
        if (span && span.start === o.start && span.end === o.end) {
          delete next[t.slug];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  const { scheduled, unscheduled } = useMemo(() => {
    const sched: ScheduledRow[] = [];
    const unsched: Task[] = [];
    for (const task of tasks) {
      const span = taskSpan(task);
      if (!span) {
        unsched.push(task);
        continue;
      }
      const o = optim[task.slug];
      sched.push({ task, start: o?.start ?? span.start, end: o?.end ?? span.end, overdue: span.overdue });
    }
    // Earliest start first; ties broken by the due date so bars cascade.
    sched.sort((a, b) => (a.start === b.start ? a.end.localeCompare(b.end) : a.start.localeCompare(b.start)));
    return { scheduled: sched, unscheduled: unsched };
  }, [tasks, optim]);

  const range = useMemo(() => {
    if (scheduled.length === 0) return null;
    const today = todayISO();
    let min = scheduled[0].start;
    let max = scheduled[0].end;
    for (const r of scheduled) {
      if (r.start < min) min = r.start;
      if (r.end > max) max = r.end;
    }
    // Always keep "today" in view so the marker has somewhere to land.
    if (today < min) min = today;
    if (today > max) max = today;
    // Modest breathing room — enough to drag a bar outward a few days without a
    // wall of empty columns. The range re-expands after a drag commits.
    const start = addISO(min, -2);
    const end = addISO(max, 6);
    return { start, end, totalDays: diffDays(start, end) + 1 };
  }, [scheduled]);

  // Day width. Auto mode (default): stretch days to fill the viewport exactly so
  // there's no dead space on a wide screen, falling back to a readable minimum
  // when the plan is too long to fit (then it scrolls). Manual zoom: honour the
  // chosen step exactly.
  const MIN_AUTO_DAY_W = 28;
  const dayW = (() => {
    if (!range) return ZOOM_LADDER[3];
    if (zoom !== null) return ZOOM_LADDER[clampIdx(zoom)];
    if (containerW <= 0) return ZOOM_LADDER[defaultZoomIndex(range.totalDays)];
    return Math.max(MIN_AUTO_DAY_W, (containerW - LABEL_W) / range.totalDays);
  })();

  const ticks = useMemo(() => {
    if (!range) return [];
    const labelEvery = dayW >= 20 ? 1 : dayW >= 14 ? 2 : dayW >= 9 ? 7 : 14;
    const out: { offset: number; label: string | null; major: boolean; weekStart: boolean }[] = [];
    for (let i = 0; i < range.totalDays; i++) {
      const d = addDays(parseISO(range.start), i);
      const dom = d.getDate();
      const isMonthStart = dom === 1;
      const isWeekStart = d.getDay() === 1; // Monday
      let label: string | null = null;
      if (isMonthStart) label = MONTH_SHORT[d.getMonth()];
      else if (i % labelEvery === 0 && dayW >= 7) label = String(dom);
      out.push({ offset: i, label, major: isMonthStart, weekStart: isWeekStart });
    }
    return out;
  }, [range, dayW]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    let dayDelta = Math.round((e.clientX - d.startX) / d.dayW);
    if (dayDelta !== 0) movedRef.current = true;
    let start = d.origStart;
    let end = d.origEnd;
    if (d.mode === 'move') {
      const minDelta = diffDays(d.origStart, d.rangeStart); // ≤ 0
      const maxDelta = diffDays(d.origEnd, d.rangeEnd); // ≥ 0
      dayDelta = Math.max(minDelta, Math.min(maxDelta, dayDelta));
      start = addISO(d.origStart, dayDelta);
      end = addISO(d.origEnd, dayDelta);
    } else if (d.mode === 'start') {
      let ns = addISO(d.origStart, dayDelta);
      if (ns < d.rangeStart) ns = d.rangeStart;
      if (ns > d.origEnd) ns = d.origEnd; // never start after due
      start = ns;
    } else {
      let ne = addISO(d.origEnd, dayDelta);
      if (ne > d.rangeEnd) ne = d.rangeEnd;
      if (ne < d.origStart) ne = d.origStart; // never end before start
      end = ne;
    }
    previewRef.current = { start, end };
    setDragPreview({ slug: d.slug, start, end });
  }, []);

  const endDrag = useCallback(() => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    const d = dragRef.current;
    const p = previewRef.current;
    if (d && p && movedRef.current && (p.start !== d.origStart || p.end !== d.origEnd)) {
      const updates =
        d.mode === 'move'
          ? { start_date: p.start, due_date: p.end }
          : d.mode === 'start'
            ? { start_date: p.start }
            : { due_date: p.end };
      setOptim((o) => ({ ...o, [d.slug]: { start: p.start, end: p.end } }));
      updateTaskRef.current.mutate({ slug: d.slug, updates });
    }
    dragRef.current = null;
    previewRef.current = null;
    setDragPreview(null);
  }, [onPointerMove]);

  const beginDrag = useCallback(
    (e: React.PointerEvent, row: ScheduledRow, mode: DragMode) => {
      if (e.button !== 0 || !range) return;
      e.preventDefault();
      e.stopPropagation();
      movedRef.current = false;
      dragRef.current = {
        slug: row.task.slug,
        mode,
        startX: e.clientX,
        dayW,
        origStart: row.start,
        origEnd: row.end,
        rangeStart: range.start,
        rangeEnd: range.end,
      };
      previewRef.current = { start: row.start, end: row.end };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endDrag);
    },
    [range, dayW, onPointerMove, endDrag],
  );

  // Tear down listeners only on unmount. onPointerMove/endDrag are referentially
  // stable, so this effect must NOT re-run mid-drag (that was the stuck-cursor bug).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, []);

  if (scheduled.length === 0) {
    return (
      <div className="gantt">
        <div className="gantt-empty">
          <p className="gantt-empty-title">No scheduled tasks yet</p>
          <p className="gantt-empty-sub">
            Set a due date on a task to place it on the timeline.
            {unscheduled.length > 0 && ` ${unscheduled.length} task${unscheduled.length === 1 ? '' : 's'} waiting below.`}
          </p>
        </div>
        {unscheduled.length > 0 && (
          <UnscheduledTray tasks={unscheduled} open={unscheduledOpen} onToggle={() => setUnscheduledOpen(v => !v)} onTaskClick={onTaskClick} />
        )}
      </div>
    );
  }

  const trackW = range!.totalDays * dayW;
  // In auto mode the zoom buttons start from the ladder step nearest the current
  // (fill-driven) day width, so the first +/- click feels continuous.
  const zoomIdx = zoom !== null
    ? clampIdx(zoom)
    : (() => { const i = ZOOM_LADDER.findIndex((w) => w >= dayW); return i === -1 ? ZOOM_LADDER.length - 1 : i; })();
  const todayOffset = (() => {
    const t = todayISO();
    if (t < range!.start || t > range!.end) return null;
    return diffDays(range!.start, t);
  })();

  return (
    <div className={`gantt ${dragPreview ? 'gantt--dragging' : ''}`}>
      <div className="gantt-legend">
        {STATUS_ORDER.map(s => (
          <span key={s} className="gantt-legend-item">
            <span className="gantt-legend-swatch" style={{ background: STATUS_META[s].color }} />
            {STATUS_META[s].label}
          </span>
        ))}
        <span className="gantt-legend-spacer" />
        <div className="gantt-zoom" role="group" aria-label="Zoom timeline">
          <button
            type="button"
            className="gantt-zoom-btn"
            onClick={() => setZoom(clampIdx(zoomIdx - 1))}
            disabled={zoomIdx === 0}
            aria-label="Zoom out"
            title="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="gantt-zoom-btn"
            onClick={() => setZoom(clampIdx(zoomIdx + 1))}
            disabled={zoomIdx === ZOOM_LADDER.length - 1}
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
        </div>
        <span className="gantt-legend-count">{scheduled.length} scheduled · drag a bar to reschedule</span>
      </div>

      <div className="gantt-scroll" ref={setScrollEl}>
        <div className="gantt-inner" style={{ width: LABEL_W + trackW }}>
          {/* Header: month / day ticks */}
          <div className="gantt-header" style={{ height: 30 }}>
            <div className="gantt-corner" style={{ width: LABEL_W }} />
            <div className="gantt-track-head" style={{ width: trackW }}>
              {ticks.map(tk => (
                <div
                  key={tk.offset}
                  className={`gantt-tick ${tk.major ? 'gantt-tick--major' : ''} ${tk.weekStart ? 'gantt-tick--week' : ''}`}
                  style={{ left: tk.offset * dayW }}
                >
                  {tk.label && <span className="gantt-tick-label">{tk.label}</span>}
                </div>
              ))}
              {todayOffset !== null && (
                <div className="gantt-today-line" style={{ left: todayOffset * dayW + dayW / 2 }}>
                  <span className="gantt-today-flag">today</span>
                </div>
              )}
            </div>
          </div>

          {/* Rows */}
          <div className="gantt-body">
            {todayOffset !== null && (
              <div
                className="gantt-today-rule"
                style={{ left: LABEL_W + todayOffset * dayW + dayW / 2 }}
              />
            )}
            {scheduled.map((row, i) => {
              const { task, overdue } = row;
              const isDragging = dragPreview?.slug === task.slug;
              const start = isDragging ? dragPreview!.start : row.start;
              const end = isDragging ? dragPreview!.end : row.end;
              const offset = diffDays(range!.start, start);
              const span = diffDays(start, end) + 1;
              const barW = Math.max(span * dayW - 2, 6);
              const assignee = taskAssignee(task);
              return (
                <div className="gantt-row" key={task.slug} style={{ animationDelay: `${Math.min(i, 16) * 18}ms` }}>
                  <button
                    className="gantt-row-label"
                    style={{ width: LABEL_W }}
                    onClick={() => onTaskClick(task)}
                    title={task.name}
                  >
                    <span className={`priority-dot priority-dot--${task.priority}`} />
                    <span className="gantt-row-name">{task.name}</span>
                    {assignee !== 'none' && <span className="gantt-row-assignee">{assignee}</span>}
                  </button>
                  <div className="gantt-row-track" style={{ width: trackW }}>
                    <div
                      className={`gantt-bar ${overdue ? 'gantt-bar--overdue' : ''} ${task.status === 'completed' ? 'gantt-bar--done' : ''} ${isDragging ? 'gantt-bar--active' : ''}`}
                      role="button"
                      tabIndex={0}
                      style={{
                        left: offset * dayW,
                        width: barW,
                        background: STATUS_META[task.status].color,
                      }}
                      onPointerDown={(e) => beginDrag(e, row, 'move')}
                      onClick={() => { if (!movedRef.current) onTaskClick(task); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTaskClick(task); } }}
                      title={`${task.name}\n${rangeLabel(start, end)}${overdue ? ' · overdue' : ''}\nDrag to reschedule · drag an edge to resize`}
                      aria-label={`${task.name}, ${rangeLabel(start, end)}`}
                    >
                      <span
                        className="gantt-handle gantt-handle--start"
                        onPointerDown={(e) => beginDrag(e, row, 'start')}
                        title="Drag to set start date"
                      />
                      {barW > 56 && <span className="gantt-bar-label">{task.name}</span>}
                      <span
                        className="gantt-handle gantt-handle--end"
                        onPointerDown={(e) => beginDrag(e, row, 'end')}
                        title="Drag to set due date"
                      />
                    </div>
                    <span
                      className="gantt-bar-meta"
                      style={{ left: offset * dayW + barW + 6 }}
                    >
                      {rangeLabel(start, end)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {unscheduled.length > 0 && (
        <UnscheduledTray tasks={unscheduled} open={unscheduledOpen} onToggle={() => setUnscheduledOpen(v => !v)} onTaskClick={onTaskClick} />
      )}
    </div>
  );
}

function UnscheduledTray({
  tasks, open, onToggle, onTaskClick,
}: {
  tasks: Task[];
  open: boolean;
  onToggle: () => void;
  onTaskClick: (task: Task) => void;
}) {
  return (
    <div className={`gantt-unscheduled ${open ? 'gantt-unscheduled--open' : ''}`}>
      <button type="button" className="gantt-unscheduled-toggle" onClick={onToggle} aria-expanded={open}>
        <span>Unscheduled ({tasks.length})</span>
        <svg className={`gantt-chevron ${open ? 'gantt-chevron--open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="gantt-unscheduled-cards">
          {tasks.map(task => (
            <TaskCard key={task.slug} task={task} onClick={() => onTaskClick(task)} onDragStart={() => { /* no drag */ }} />
          ))}
        </div>
      )}
    </div>
  );
}
