import { useMemo, useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import {
  STATUS_COLOR_VAR, MONTH_LONG, WEEKDAY_SHORT,
  formatISO, todayISO, dateOf, isoWeekday,
} from './calendar-utils';
import './TaskCalendar.css';

interface TaskCalendarProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

interface DayCell {
  date: string;
  day: number;
  isCurrentMonth: boolean;
}

const MAX_CHIPS = 3;

export function TaskCalendar({ tasks, onTaskClick }: TaskCalendarProps) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());

  // Bucket tasks by their due date.
  const { byDate, unscheduledCount } = useMemo(() => {
    const map = new Map<string, Task[]>();
    let unscheduled = 0;
    for (const task of tasks) {
      const due = dateOf(task.due_date);
      if (!due) { unscheduled++; continue; }
      const arr = map.get(due) ?? [];
      arr.push(task);
      map.set(due, arr);
    }
    return { byDate: map, unscheduledCount: unscheduled };
  }, [tasks]);

  const days = useMemo<DayCell[]>(() => {
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const startOffset = isoWeekday(new Date(viewYear, viewMonth, 1));
    const cells: DayCell[] = [];

    const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();
    for (let i = startOffset - 1; i >= 0; i--) {
      const d = prevMonthDays - i;
      const m = viewMonth === 0 ? 11 : viewMonth - 1;
      const y = viewMonth === 0 ? viewYear - 1 : viewYear;
      cells.push({ date: formatISO(new Date(y, m, d)), day: d, isCurrentMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: formatISO(new Date(viewYear, viewMonth, d)), day: d, isCurrentMonth: true });
    }
    const remaining = (cells.length <= 35 ? 35 : 42) - cells.length;
    for (let d = 1; d <= remaining; d++) {
      const m = viewMonth === 11 ? 0 : viewMonth + 1;
      const y = viewMonth === 11 ? viewYear + 1 : viewYear;
      cells.push({ date: formatISO(new Date(y, m, d)), day: d, isCurrentMonth: false });
    }
    return cells;
  }, [viewYear, viewMonth]);

  const monthScheduled = useMemo(() => {
    let n = 0;
    for (const cell of days) {
      if (cell.isCurrentMonth) n += byDate.get(cell.date)?.length ?? 0;
    }
    return n;
  }, [days, byDate]);

  const today = todayISO();

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };
  const goToday = () => {
    // Read the clock at click time — `now` is captured at render and would be
    // stale if the tab sat open across midnight without re-rendering.
    const n = new Date();
    setViewYear(n.getFullYear());
    setViewMonth(n.getMonth());
  };

  return (
    <div className="task-cal">
      <div className="task-cal-toolbar">
        <div className="task-cal-nav">
          <button className="task-cal-nav-btn" onClick={prevMonth} aria-label="Previous month">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M8.5 3L4.5 7L8.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className="task-cal-title">{MONTH_LONG[viewMonth]} {viewYear}</span>
          <button className="task-cal-nav-btn" onClick={nextMonth} aria-label="Next month">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5.5 3L9.5 7L5.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="task-cal-today-btn" onClick={goToday}>Today</button>
        </div>
        <div className="task-cal-meta">
          <span className="task-cal-meta-count">{monthScheduled} due this month</span>
          {unscheduledCount > 0 && (
            <span className="task-cal-meta-unscheduled">{unscheduledCount} unscheduled</span>
          )}
        </div>
      </div>

      <div className="task-cal-grid task-cal-grid--head">
        {WEEKDAY_SHORT.map(d => (
          <div key={d} className="task-cal-weekday">{d}</div>
        ))}
      </div>

      <div className="task-cal-grid task-cal-grid--body">
        {days.map(cell => {
          const dayTasks = byDate.get(cell.date) ?? [];
          const overflow = dayTasks.length - MAX_CHIPS;
          return (
            <div
              key={cell.date}
              className={[
                'task-cal-cell',
                !cell.isCurrentMonth && 'task-cal-cell--outside',
                cell.date === today && 'task-cal-cell--today',
              ].filter(Boolean).join(' ')}
            >
              <div className="task-cal-cell-head">
                <span className="task-cal-cell-day">{cell.day}</span>
                {dayTasks.length > 0 && <span className="task-cal-cell-badge">{dayTasks.length}</span>}
              </div>
              <div className="task-cal-cell-tasks">
                {dayTasks.slice(0, MAX_CHIPS).map(task => {
                  const overdue = task.status !== 'completed' && cell.date < today;
                  return (
                    <button
                      key={task.slug}
                      className={`task-cal-chip ${overdue ? 'task-cal-chip--overdue' : ''}`}
                      style={{ '--chip-color': `var(${STATUS_COLOR_VAR[task.status]})` } as React.CSSProperties}
                      onClick={() => onTaskClick(task)}
                      title={`${task.name} · ${task.status.replace('_', ' ')}${overdue ? ' · overdue' : ''}`}
                    >
                      <span className="task-cal-chip-dot" />
                      <span className="task-cal-chip-name">{task.name}</span>
                    </button>
                  );
                })}
                {overflow > 0 && (
                  <button
                    className="task-cal-more"
                    onClick={() => onTaskClick(dayTasks[MAX_CHIPS])}
                    title={dayTasks.slice(MAX_CHIPS).map(t => t.name).join('\n')}
                  >
                    +{overflow} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
