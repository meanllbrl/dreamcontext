import { useState } from 'react';
import { ChartEmpty, type ChartBodyProps } from './chartBody';

/**
 * `heatmap` render — the contributions grid: weeks across, weekdays down, cell
 * intensity from the value. Answers "which days carry this metric" (weekday
 * rhythm, dead weekends, a gap where a sync failed) — a shape a line chart hides.
 *
 * The grid only means anything on DAILY buckets. Weekly/monthly caches (the
 * rollup switches granularity as the window widens) degrade to a one-row
 * intensity strip rather than pretending each bucket is a day.
 */

/** Intensity steps, least → most. Zero/absent renders as the empty cell. */
const LEVELS = [0.22, 0.42, 0.64, 0.85, 1];
const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
/** Weekday labels shown down the left gutter (GitHub shows every other one). */
const LABELLED_DAYS = [0, 2, 4];
/** Reserved strip above the grid for the readout — the card body clips overflow. */
const READOUT_GUTTER = 30;
const GAP = 3;

interface Cell {
  /** Bucket key (a date for daily, else the raw key). */
  key: string;
  value: number;
}

function cellSize(full: boolean): number {
  return full ? 15 : 11;
}

function dayOf(key: string): Date | null {
  const d = new Date(`${key}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Monday-first weekday index (0 = Monday). */
function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

function levelColor(value: number, max: number): string {
  if (value <= 0 || max <= 0) return 'var(--color-bg-tertiary)';
  const step = Math.min(LEVELS.length - 1, Math.ceil((value / max) * LEVELS.length) - 1);
  return `color-mix(in srgb, var(--chart-1) ${Math.round(LEVELS[Math.max(0, step)] * 100)}%, transparent)`;
}

/** One value per bucket: every series summed, because a heatmap cell is a day's
 *  total — a per-series grid would be N grids, which is what `stacked` is for. */
function bucketTotals(series: { name: string; points: { t: string; v: number }[] }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of series) {
    for (const p of s.points) totals.set(p.t, (totals.get(p.t) ?? 0) + p.v);
  }
  return totals;
}

export function HeatmapBody({ summary, cache, series, full = false, emptyHint }: ChartBodyProps) {
  const [hover, setHover] = useState<{ cell: Cell; x: number } | null>(null);

  const totals = bucketTotals(series);
  if (totals.size === 0) return <ChartEmpty hint={emptyHint} />;

  const granularity = cache?.granularity ?? summary.granularity;
  const size = cellSize(full);
  const max = Math.max(...totals.values(), 0);
  const keys = [...totals.keys()].sort();

  const readout = hover && (
    <div
      style={{
        position: 'absolute', top: 0, left: hover.x, transform: 'translate(-50%, 0)',
        pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap',
        background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
        borderRadius: 8, boxShadow: 'var(--shadow-md)', padding: '4px 9px', fontSize: 11.5,
      }}
    >
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{hover.cell.key}</span>
      <span style={{ fontWeight: 700, color: 'var(--color-text)', fontFamily: 'var(--font-mono)', marginLeft: 6 }}>
        {hover.cell.value.toLocaleString()}{summary.unit ? ` ${summary.unit}` : ''}
      </span>
    </div>
  );

  const cellStyle = (value: number): React.CSSProperties => ({
    width: size,
    height: size,
    borderRadius: 2,
    background: levelColor(value, max),
  });

  // Weekly/monthly buckets: a week is not a weekday, so the grid degrades to one
  // strip of buckets in time order — same scale, same readout, no false calendar.
  if (granularity !== 'daily') {
    return (
      <div style={{ position: 'relative', paddingTop: READOUT_GUTTER }}>
        {readout}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP }}>
          {keys.map((key, i) => (
            <div
              key={key}
              style={cellStyle(totals.get(key) ?? 0)}
              title={`${key}: ${(totals.get(key) ?? 0).toLocaleString()}`}
              onPointerEnter={() => setHover({ cell: { key, value: totals.get(key) ?? 0 }, x: (i % 20) * (size + GAP) + size / 2 })}
              onPointerLeave={() => setHover(null)}
            />
          ))}
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          {granularity ?? 'non-daily'} buckets — the week grid needs daily granularity.
        </div>
      </div>
    );
  }

  const days = keys.map(dayOf);
  const firstDay = days.find((d): d is Date => d !== null);
  const lastDay = [...days].reverse().find((d): d is Date => d !== null);
  if (!firstDay || !lastDay) return <ChartEmpty hint={emptyHint} />;

  // Columns start on the Monday on/before the first bucket, so every cell lands
  // on its true weekday row.
  const gridStart = new Date(firstDay);
  gridStart.setDate(gridStart.getDate() - weekdayIndex(firstDay));
  const spanDays = Math.round((lastDay.getTime() - gridStart.getTime()) / 86_400_000);
  const weeks = Math.floor(spanDays / 7) + 1;
  const labelW = full ? 22 : 18;

  return (
    <div style={{ position: 'relative', paddingTop: READOUT_GUTTER }}>
      {readout}
      <div style={{ display: 'flex', gap: GAP }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP, width: labelW, flexShrink: 0 }}>
          {DAY_LABELS.map((label, row) => (
            <span key={label} style={{ height: size, fontSize: 9.5, lineHeight: `${size}px`, color: 'var(--color-text-tertiary)' }}>
              {LABELLED_DAYS.includes(row) ? label : ''}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: GAP }}>
          {Array.from({ length: weeks }, (_, week) => (
            <div key={week} style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
              {DAY_LABELS.map((_label, row) => {
                const date = new Date(gridStart);
                date.setDate(date.getDate() + week * 7 + row);
                const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                const value = totals.get(key);
                // Outside the synced window: no cell at all, so a partial first
                // or last week doesn't read as a run of zero days.
                if (value === undefined && (date < firstDay || date > lastDay)) {
                  return <div key={row} style={{ width: size, height: size }} />;
                }
                return (
                  <div
                    key={row}
                    style={cellStyle(value ?? 0)}
                    title={`${key}: ${(value ?? 0).toLocaleString()}`}
                    onPointerEnter={() => setHover({
                      cell: { key, value: value ?? 0 },
                      x: labelW + GAP + week * (size + GAP) + size / 2,
                    })}
                    onPointerLeave={() => setHover(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
