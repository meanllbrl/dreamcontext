import { useMemo, useState } from 'react';
import type { Task } from '../../hooks/useTasks';
import {
  MONTH_SHORT, formatISO, todayISO, parseISO, addDays, dateOf, isoWeekday,
} from './calendar-utils';
import './ActivityHeatmap.css';

interface ActivityHeatmapProps {
  tasks: Task[];
  onSelectDay?: (date: string, tasks: Task[]) => void;
}

type Metric = 'created' | 'updated' | 'completed' | 'due';

const METRICS: { key: Metric; label: string; verb: string }[] = [
  { key: 'created', label: 'Created', verb: 'created' },
  { key: 'updated', label: 'Updated', verb: 'updated' },
  { key: 'completed', label: 'Completed', verb: 'completed' },
  { key: 'due', label: 'Due', verb: 'due' },
];

const WEEKS = 53;

/** The date a task contributes to for a given metric (null = no contribution). */
function metricDate(task: Task, metric: Metric): string | null {
  switch (metric) {
    case 'created': return dateOf(task.created_at);
    case 'updated': return dateOf(task.updated_at);
    case 'completed': return task.status === 'completed' ? dateOf(task.updated_at) : null;
    case 'due': return dateOf(task.due_date);
  }
}

function levelFor(count: number, max: number): number {
  if (count <= 0) return 0;
  // Sparse projects where no day exceeds one task: render a mid-tone, not peak,
  // so the Less↔More scale stays meaningful instead of collapsing to all-dark.
  if (max <= 1) return 2;
  return Math.min(4, Math.ceil((count / max) * 4));
}

export function ActivityHeatmap({ tasks, onSelectDay }: ActivityHeatmapProps) {
  const [metric, setMetric] = useState<Metric>('updated');

  const byDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const d = metricDate(task, metric);
      if (!d) continue;
      const arr = map.get(d) ?? [];
      arr.push(task);
      map.set(d, arr);
    }
    return map;
  }, [tasks, metric]);

  const { weeks, monthLabels, max, total, activeDays, busiest } = useMemo(() => {
    const todayMid = parseISO(todayISO());
    const curMonday = addDays(todayMid, -isoWeekday(todayMid));
    const firstMonday = addDays(curMonday, -(WEEKS - 1) * 7);
    const todayStr = todayISO();

    const cols: { date: string | null; count: number; tasks: Task[] }[][] = [];
    const labels: { col: number; label: string }[] = [];
    let prevMonth = -1;
    let maxCount = 0;
    let totalCount = 0;
    let active = 0;
    let busy: { date: string; count: number } | null = null;

    for (let w = 0; w < WEEKS; w++) {
      const weekMonday = addDays(firstMonday, w * 7);
      const col: { date: string | null; count: number; tasks: Task[] }[] = [];
      for (let d = 0; d < 7; d++) {
        const cellDate = addDays(weekMonday, d);
        const iso = formatISO(cellDate);
        if (iso > todayStr) { col.push({ date: null, count: 0, tasks: [] }); continue; }
        const dayTasks = byDate.get(iso) ?? [];
        const count = dayTasks.length;
        if (count > maxCount) maxCount = count;
        totalCount += count;
        if (count > 0) active++;
        if (count > 0 && (!busy || count > busy.count)) busy = { date: iso, count };
        col.push({ date: iso, count, tasks: dayTasks });
      }
      // Month label when the month of this column's Monday changes.
      const m = weekMonday.getMonth();
      if (m !== prevMonth) {
        labels.push({ col: w, label: MONTH_SHORT[m] });
        prevMonth = m;
      }
      cols.push(col);
    }
    return { weeks: cols, monthLabels: labels, max: maxCount, total: totalCount, activeDays: active, busiest: busy };
  }, [byDate]);

  const verb = METRICS.find(m => m.key === metric)!.verb;

  return (
    <div className="heatmap">
      <div className="heatmap-toolbar">
        <div className="heatmap-metric-toggle">
          {METRICS.map(m => (
            <button
              key={m.key}
              className={`heatmap-metric-btn ${metric === m.key ? 'heatmap-metric-btn--active' : ''}`}
              onClick={() => setMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="heatmap-stats">
          <span className="heatmap-stat"><strong>{total}</strong> {verb}</span>
          <span className="heatmap-stat"><strong>{activeDays}</strong> active days</span>
          {busiest && (
            <span className="heatmap-stat heatmap-stat--muted">
              peak {busiest.count} on {busiest.date.slice(5)}
            </span>
          )}
        </div>
      </div>

      <div className="heatmap-scroll">
        <div className="heatmap-canvas">
          <div className="heatmap-months">
            {monthLabels.map(({ col, label }) => (
              <span key={`${col}-${label}`} className="heatmap-month" style={{ gridColumnStart: col + 2 }}>
                {label}
              </span>
            ))}
          </div>

          <div className="heatmap-body">
            <div className="heatmap-weekdays">
              <span />
              <span>Mon</span>
              <span />
              <span>Wed</span>
              <span />
              <span>Fri</span>
              <span />
            </div>

            <div className="heatmap-weeks">
              {weeks.map((col, w) => (
                <div key={w} className="heatmap-week">
                  {col.map((cell, d) => {
                    if (cell.date === null) return <span key={d} className="heatmap-cell heatmap-cell--empty" />;
                    const level = levelFor(cell.count, max);
                    return (
                      <button
                        key={d}
                        className={`heatmap-cell heatmap-cell--l${level}`}
                        title={`${cell.count} ${cell.count === 1 ? 'task' : 'tasks'} ${verb} · ${cell.date}`}
                        onClick={() => onSelectDay?.(cell.date!, cell.tasks)}
                        disabled={cell.count === 0}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="heatmap-legend">
            <span className="heatmap-legend-label">Less</span>
            {[0, 1, 2, 3, 4].map(l => (
              <span key={l} className={`heatmap-cell heatmap-cell--l${l}`} />
            ))}
            <span className="heatmap-legend-label">More</span>
          </div>
        </div>
      </div>

      {/* Visually-hidden overview so screen readers get the gist without
          tabbing every active cell (mirrors RiceScatter's SR-only list). */}
      <ol className="heatmap-sr-list" aria-label={`Daily ${verb} activity over the past 53 weeks`}>
        {weeks.flat().filter(c => c.date && c.count > 0).map(c => (
          <li key={c.date!}>{`${c.date}: ${c.count} ${c.count === 1 ? 'task' : 'tasks'} ${verb}`}</li>
        ))}
      </ol>
    </div>
  );
}
