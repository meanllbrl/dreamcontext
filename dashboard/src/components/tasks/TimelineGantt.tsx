import { useMemo, useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import { TaskCard } from './TaskCard';
import { taskAssignee } from './boardModel';
import {
  STATUS_COLOR_VAR, MONTH_SHORT,
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

/** Pixels per day, chosen so a typical plan fits without horizontal scroll. */
function dayWidthFor(totalDays: number): number {
  if (totalDays <= 21) return 34;
  if (totalDays <= 45) return 22;
  if (totalDays <= 90) return 12;
  if (totalDays <= 180) return 7;
  return 4;
}

const LABEL_W = 220;

export function TimelineGantt({ tasks, onTaskClick }: TimelineGanttProps) {
  const [unscheduledOpen, setUnscheduledOpen] = useState(false);

  const { scheduled, unscheduled } = useMemo(() => {
    const sched: ScheduledRow[] = [];
    const unsched: Task[] = [];
    for (const task of tasks) {
      const span = taskSpan(task);
      if (span) sched.push({ task, ...span });
      else unsched.push(task);
    }
    // Earliest start first; ties broken by the due date so bars cascade.
    sched.sort((a, b) => (a.start === b.start ? a.end.localeCompare(b.end) : a.start.localeCompare(b.start)));
    return { scheduled: sched, unscheduled: unsched };
  }, [tasks]);

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
    // Breathing room on both ends.
    const start = formatISO(addDays(parseISO(min), -2));
    const end = formatISO(addDays(parseISO(max), 3));
    return { start, end, totalDays: diffDays(start, end) + 1 };
  }, [scheduled]);

  const ticks = useMemo(() => {
    if (!range) return [];
    const dayW = dayWidthFor(range.totalDays);
    const labelEvery = dayW >= 22 ? 1 : dayW >= 12 ? 2 : dayW >= 7 ? 7 : 14;
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
  }, [range]);

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

  const dayW = dayWidthFor(range!.totalDays);
  const trackW = range!.totalDays * dayW;
  const todayOffset = (() => {
    const t = todayISO();
    if (t < range!.start || t > range!.end) return null;
    return diffDays(range!.start, t);
  })();

  return (
    <div className="gantt">
      <div className="gantt-legend">
        {(['todo', 'in_progress', 'in_review', 'completed'] as Task['status'][]).map(s => (
          <span key={s} className="gantt-legend-item">
            <span className="gantt-legend-swatch" style={{ background: `var(${STATUS_COLOR_VAR[s]})` }} />
            {s.replace('_', ' ')}
          </span>
        ))}
        <span className="gantt-legend-spacer" />
        <span className="gantt-legend-count">{scheduled.length} scheduled</span>
      </div>

      <div className="gantt-scroll">
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
            {scheduled.map(({ task, start, end, overdue }, i) => {
              const offset = diffDays(range!.start, start);
              const span = diffDays(start, end) + 1;
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
                    {taskAssignee(task) !== 'none' && <span className="gantt-row-assignee">{taskAssignee(task)}</span>}
                  </button>
                  <div className="gantt-row-track" style={{ width: trackW }}>
                    <button
                      className={`gantt-bar ${overdue ? 'gantt-bar--overdue' : ''} ${task.status === 'completed' ? 'gantt-bar--done' : ''}`}
                      style={{
                        left: offset * dayW,
                        width: Math.max(span * dayW - 2, 6),
                        background: `var(${STATUS_COLOR_VAR[task.status]})`,
                      }}
                      onClick={() => onTaskClick(task)}
                      title={`${task.name}\n${start}${end !== start ? ` → ${end}` : ''}${overdue ? ' · overdue' : ''}`}
                    >
                      {span * dayW > 56 && <span className="gantt-bar-label">{task.name}</span>}
                    </button>
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
