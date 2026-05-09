import { useMemo, useState, useRef, useEffect } from 'react';
import type { Task } from '../../hooks/useTasks';
import { TaskCard } from './TaskCard';
import './RiceScatter.css';

interface RiceScatterProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

const PADDING = { top: 32, right: 24, bottom: 56, left: 64 };
const EFFORT_MIN = 0.5;
const EFFORT_MAX = 8;
const IMPACT_MIN = 1;
const IMPACT_MAX = 5;
const QUADRANT_EFFORT = 2;
const QUADRANT_IMPACT = 3;

const STATUS_COLOR_VAR: Record<Task['status'], string> = {
  todo: '--color-status-todo',
  in_progress: '--color-status-in-progress',
  in_review: '--color-status-in-review',
  completed: '--color-status-completed',
};

function logEffort(e: number): number {
  return Math.log2(Math.max(e, 0.01) + 1);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function isFullyRated(task: Task): boolean {
  const r = task.rice;
  return !!(r && r.reach !== null && r.impact !== null && r.confidence !== null && r.effort !== null && r.score !== null);
}

export function RiceScatter({ tasks, onTaskClick }: RiceScatterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 480 });
  const [unscoredOpen, setUnscoredOpen] = useState(false);
  const [hoverSlug, setHoverSlug] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = Math.max(360, Math.min(620, w * 0.6));
        setSize({ width: w, height: h });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Filter out completed by default (matches EisenhowerMatrix behavior)
  const active = useMemo(() => tasks.filter(t => t.status !== 'completed'), [tasks]);
  const rated = useMemo(() => active.filter(isFullyRated), [active]);
  const unscored = useMemo(() => active.filter(t => !isFullyRated(t)), [active]);

  const sortedRatedForA11y = useMemo(
    () => [...rated].sort((a, b) => (b.rice!.score ?? 0) - (a.rice!.score ?? 0)),
    [rated],
  );

  const innerW = Math.max(120, size.width - PADDING.left - PADDING.right);
  const innerH = Math.max(120, size.height - PADDING.top - PADDING.bottom);

  const xMinLog = logEffort(EFFORT_MIN);
  const xMaxLog = logEffort(EFFORT_MAX);
  const xRangeLog = xMaxLog - xMinLog;

  const xScale = (effort: number) => {
    // Low effort on the right per spec ("low effort right")
    const t = (logEffort(clamp(effort, EFFORT_MIN, EFFORT_MAX)) - xMinLog) / xRangeLog;
    return PADDING.left + (1 - t) * innerW;
  };

  const yScale = (impact: number) => {
    const t = (clamp(impact, IMPACT_MIN, IMPACT_MAX) - IMPACT_MIN) / (IMPACT_MAX - IMPACT_MIN);
    return PADDING.top + (1 - t) * innerH;
  };

  const radiusFromReach = (reach: number) => 6 + ((clamp(reach, 1, 10) - 1) / 9) * (24 - 6);
  const opacityFromConfidence = (c: number) => Math.max(0.4, c / 100);

  const quadX = xScale(QUADRANT_EFFORT);
  const quadY = yScale(QUADRANT_IMPACT);

  // Effort axis ticks
  const effortTicks = [0.5, 1, 2, 4, 8];
  const impactTicks = [1, 2, 3, 4, 5];

  return (
    <div className="rice-scatter" ref={containerRef}>
      <svg
        className="rice-scatter-svg"
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        role="img"
        aria-label={`RICE scatter: ${rated.length} rated tasks plotted by impact and effort`}
      >
        {/* Quadrant overlay */}
        <rect
          x={PADDING.left}
          y={PADDING.top}
          width={quadX - PADDING.left}
          height={quadY - PADDING.top}
          className="rice-quad rice-quad--big-bets"
        />
        <rect
          x={quadX}
          y={PADDING.top}
          width={PADDING.left + innerW - quadX}
          height={quadY - PADDING.top}
          className="rice-quad rice-quad--quick-wins"
        />
        <rect
          x={PADDING.left}
          y={quadY}
          width={quadX - PADDING.left}
          height={PADDING.top + innerH - quadY}
          className="rice-quad rice-quad--time-sinks"
        />
        <rect
          x={quadX}
          y={quadY}
          width={PADDING.left + innerW - quadX}
          height={PADDING.top + innerH - quadY}
          className="rice-quad rice-quad--fill-ins"
        />

        {/* Quadrant labels */}
        <text x={PADDING.left + 8} y={PADDING.top + 18} className="rice-quad-label">Big Bets</text>
        <text x={PADDING.left + innerW - 8} y={PADDING.top + 18} textAnchor="end" className="rice-quad-label">Quick Wins</text>
        <text x={PADDING.left + 8} y={PADDING.top + innerH - 6} className="rice-quad-label">Time Sinks</text>
        <text x={PADDING.left + innerW - 8} y={PADDING.top + innerH - 6} textAnchor="end" className="rice-quad-label">Fill-ins</text>

        {/* Quadrant divider lines */}
        <line x1={quadX} y1={PADDING.top} x2={quadX} y2={PADDING.top + innerH} className="rice-quad-divider" />
        <line x1={PADDING.left} y1={quadY} x2={PADDING.left + innerW} y2={quadY} className="rice-quad-divider" />

        {/* Axes */}
        <line
          x1={PADDING.left}
          y1={PADDING.top + innerH}
          x2={PADDING.left + innerW}
          y2={PADDING.top + innerH}
          className="rice-axis"
        />
        <line
          x1={PADDING.left}
          y1={PADDING.top}
          x2={PADDING.left}
          y2={PADDING.top + innerH}
          className="rice-axis"
        />

        {/* X ticks (Effort) */}
        {effortTicks.map(e => (
          <g key={`xt-${e}`}>
            <line
              x1={xScale(e)}
              y1={PADDING.top + innerH}
              x2={xScale(e)}
              y2={PADDING.top + innerH + 4}
              className="rice-axis"
            />
            <text
              x={xScale(e)}
              y={PADDING.top + innerH + 18}
              textAnchor="middle"
              className="rice-tick"
            >
              {e}w
            </text>
          </g>
        ))}
        <text
          x={PADDING.left + innerW / 2}
          y={PADDING.top + innerH + 40}
          textAnchor="middle"
          className="rice-axis-label"
        >
          Effort (weeks) — low-effort on right
        </text>

        {/* Y ticks (Impact) */}
        {impactTicks.map(i => (
          <g key={`yt-${i}`}>
            <line
              x1={PADDING.left - 4}
              y1={yScale(i)}
              x2={PADDING.left}
              y2={yScale(i)}
              className="rice-axis"
            />
            <text
              x={PADDING.left - 8}
              y={yScale(i) + 4}
              textAnchor="end"
              className="rice-tick"
            >
              {i}
            </text>
          </g>
        ))}
        <text
          transform={`translate(${PADDING.left - 44}, ${PADDING.top + innerH / 2}) rotate(-90)`}
          textAnchor="middle"
          className="rice-axis-label"
        >
          Impact
        </text>

        {/* Dots */}
        {rated.map(task => {
          const r = task.rice!;
          const cx = xScale(r.effort!);
          const cy = yScale(r.impact!);
          const radius = radiusFromReach(r.reach!);
          const opacity = opacityFromConfidence(r.confidence!);
          const colorVar = STATUS_COLOR_VAR[task.status];
          const isHover = hoverSlug === task.slug;

          return (
            <circle
              key={task.slug}
              cx={cx}
              cy={cy}
              r={radius}
              fill={`var(${colorVar})`}
              fillOpacity={opacity}
              stroke="var(--color-bg)"
              strokeWidth={isHover ? 2.5 : 1.5}
              className="rice-dot"
              tabIndex={0}
              role="button"
              aria-label={`${task.name}: reach ${r.reach}, impact ${r.impact}, confidence ${r.confidence}, effort ${r.effort} weeks, score ${r.score}`}
              onClick={() => onTaskClick(task)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onTaskClick(task);
                }
              }}
              onMouseEnter={() => setHoverSlug(task.slug)}
              onMouseLeave={() => setHoverSlug(null)}
              onFocus={() => setHoverSlug(task.slug)}
              onBlur={() => setHoverSlug(null)}
            >
              <title>{`${task.name}\nR ${r.reach} · I ${r.impact} · C ${r.confidence}% · E ${r.effort}w\nScore: ${r.score}`}</title>
            </circle>
          );
        })}
      </svg>

      {/* Off-screen ordered list for screen readers */}
      <ol className="rice-scatter-sr-list">
        {sortedRatedForA11y.map(t => (
          <li key={t.slug}>{`${t.name} — score ${t.rice!.score}`}</li>
        ))}
      </ol>

      {/* Unscored tray */}
      {unscored.length > 0 && (
        <div className={`rice-unscored ${unscoredOpen ? 'rice-unscored--open' : ''}`}>
          <button
            type="button"
            className="rice-unscored-toggle"
            onClick={() => setUnscoredOpen(v => !v)}
            aria-expanded={unscoredOpen}
          >
            <span>Unscored ({unscored.length})</span>
            <svg className={`rice-chevron ${unscoredOpen ? 'rice-chevron--open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {unscoredOpen && (
            <div className="rice-unscored-cards">
              {unscored.map(task => (
                <TaskCard
                  key={task.slug}
                  task={task}
                  onClick={() => onTaskClick(task)}
                  onDragStart={() => { /* no drag in scatter */ }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
