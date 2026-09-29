import { useState } from 'react';
import { ChartEmpty, formatValue, type ChartBodyProps } from './chartBody';

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

/** The chart token a heatmap tints with: palette slot 1-8 (board block `color`). */
export function heatToken(colorIndex = 1): string {
  const slot = Math.min(8, Math.max(1, Math.round(colorIndex)));
  return `var(--chart-${slot})`;
}

export function levelColor(value: number, max: number, colorIndex = 1): string {
  if (value <= 0 || max <= 0) return 'var(--color-bg-tertiary)';
  const step = Math.min(LEVELS.length - 1, Math.ceil((value / max) * LEVELS.length) - 1);
  return `color-mix(in srgb, ${heatToken(colorIndex)} ${Math.round(LEVELS[Math.max(0, step)] * 100)}%, transparent)`;
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
  return (
    <HeatmapChart
      series={series}
      unit={summary.unit}
      granularity={cache?.granularity ?? summary.granularity}
      full={full}
      emptyHint={emptyHint}
    />
  );
}

/** The heatmap drawing. `colorIndex` picks the chart token (1-8) the cells tint with. */
export function HeatmapChart({ series, unit, granularity, full = false, emptyHint, colorIndex = 1 }: {
  series: { name: string; points: { t: string; v: number }[] }[];
  unit: string | null;
  granularity: string | null;
  full?: boolean;
  emptyHint?: string;
  colorIndex?: number;
}) {
  const [hover, setHover] = useState<{ cell: Cell; x: number } | null>(null);

  const totals = bucketTotals(series);
  if (totals.size === 0) return <ChartEmpty hint={emptyHint} />;

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
        {hover.cell.value.toLocaleString()}{unit ? ` ${unit}` : ''}
      </span>
    </div>
  );

  const cellStyle = (value: number): React.CSSProperties => ({
    width: size,
    height: size,
    borderRadius: 2,
    background: levelColor(value, max, colorIndex),
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

/**
 * A table frame's heatmap: rows = the first dim, columns = the second, each
 * cell tinted by its share of the largest cell. One dim = a single row of
 * cells. What a board `heatmap` block bound to a dataset draws.
 */
export function HeatmapMatrix({ dims, rows, unit, colorIndex = 1, emptyHint }: {
  dims: readonly { key: string; label: string }[];
  rows: readonly { d: Record<string, string>; v: number | null }[];
  unit: string | null;
  colorIndex?: number;
  emptyHint?: string;
}) {
  const rowDim = dims[0]?.key;
  const colDim = dims[1]?.key;
  if (!rowDim || rows.length === 0) return <ChartEmpty hint={emptyHint} />;
  const distinct = (key: string) => rows.reduce<string[]>((acc, r) => {
    const v = r.d[key];
    if (v !== undefined && !acc.includes(v)) acc.push(v);
    return acc;
  }, []);
  const rowValues = distinct(rowDim);
  const colValues = colDim ? distinct(colDim) : [''];
  const cells = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.v !== 'number') continue;
    const k = `${r.d[rowDim] ?? ''}\u0000${colDim ? r.d[colDim] ?? '' : ''}`;
    cells.set(k, (cells.get(k) ?? 0) + r.v);
  }
  const max = Math.max(0, ...cells.values());

  return (
    <div style={{ overflow: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: GAP, fontSize: 11 }} role="img" aria-label="Heatmap">
        {colDim && (
          <thead>
            <tr>
              <th />
              {colValues.map((c) => (
                <th key={c} scope="col" style={{ fontWeight: 600, color: 'var(--color-text-tertiary)', padding: '0 2px', whiteSpace: 'nowrap' }}>{c}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rowValues.map((rv) => (
            <tr key={rv}>
              <th scope="row" style={{ fontWeight: 400, color: 'var(--color-text-secondary)', textAlign: 'left', paddingRight: 6, whiteSpace: 'nowrap' }}>{rv}</th>
              {colValues.map((cv) => {
                const v = cells.get(`${rv}\u0000${cv}`);
                return (
                  <td
                    key={cv}
                    data-heat-cell=""
                    title={`${rv}${cv ? ` / ${cv}` : ''}: ${formatValue(v ?? null, unit)}`}
                    style={{ minWidth: 22, height: 18, borderRadius: 3, background: levelColor(v ?? 0, max, colorIndex) }}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
