import { useState } from 'react';
import { CHART_COLORS } from './chartColors';
import { ROW_CAP } from './barRows';
import { Sparkline } from './Sparkline';
import { ChartEmpty, formatValue, latestPoint, type ChartBodyProps } from './chartBody';

/**
 * `table` render — the metric table: one row per series with its latest value,
 * the move since the previous point, and a trend glyph. What a stakeholder reads
 * when "which of these went up this week" matters more than the exact curve.
 *
 * Click a column header to sort; the default order is the one the adapter
 * delivered (a manifest author's ordering is a choice, not an accident).
 */

type SortKey = 'name' | 'latest' | 'delta';

interface MetricRow {
  name: string;
  latest: number | null;
  delta: number | null;
  points: { t: string; v: number }[];
  color: string;
}

const NUM_CELL: React.CSSProperties = {
  padding: '5px 10px',
  textAlign: 'right',
  fontFamily: 'var(--font-mono)',
  whiteSpace: 'nowrap',
};

function deltaColor(delta: number | null): string {
  if (delta === null || delta === 0) return 'var(--color-text-tertiary)';
  return delta > 0 ? 'var(--color-success)' : 'var(--color-error)';
}

function deltaLabel(delta: number | null): string {
  if (delta === null) return '—';
  if (delta === 0) return '0';
  return `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toLocaleString()}`;
}

/** Nulls always sort last, whichever direction the user picked. */
function compareNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

export function TableBody({ summary, series, full = false, emptyHint }: ChartBodyProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const rows: MetricRow[] = series.map((s, i) => {
    const last = latestPoint(s);
    const prev = s.points.length >= 2 ? s.points[s.points.length - 2] : null;
    return {
      name: s.name,
      latest: last ? last.v : null,
      delta: last && prev ? last.v - prev.v : null,
      points: s.points,
      color: CHART_COLORS[i % CHART_COLORS.length],
    };
  });

  if (rows.length === 0) return <ChartEmpty hint={emptyHint} />;

  const sorted = sort === null ? rows : [...rows].sort((a, b) => {
    const desc = sort.key === 'name'
      ? b.name.localeCompare(a.name)
      : compareNullable(a[sort.key], b[sort.key]);
    return sort.dir === 'desc' ? desc : -desc;
  });
  const shown = full ? sorted : sorted.slice(0, ROW_CAP);
  const hidden = sorted.length - shown.length;

  const toggleSort = (key: SortKey) => {
    setSort((current) => (current?.key === key && current.dir === 'desc'
      ? { key, dir: 'asc' }
      : { key, dir: 'desc' }));
  };

  const header = (key: SortKey, label: string, align: 'left' | 'right') => (
    <th
      scope="col"
      style={{ textAlign: align, padding: 0, fontWeight: 600 }}
    >
      <button
        type="button"
        // The header is the body's own affordance — its click sorts, it does not
        // open the card's detail panel.
        onClick={(e) => { e.stopPropagation(); toggleSort(key); }}
        style={{
          width: '100%', border: 'none', background: 'none', cursor: 'pointer',
          padding: '6px 10px', font: 'inherit', color: sort?.key === key ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          textAlign: align,
        }}
      >
        {label}{sort?.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ background: 'var(--color-bg-tertiary)' }}>
            {header('name', 'Series', 'left')}
            {header('latest', 'Latest', 'right')}
            {header('delta', 'Δ', 'right')}
            <th scope="col" style={{ textAlign: 'right', padding: '6px 10px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Trend</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.name} style={{ borderTop: '1px solid var(--color-border)' }}>
              <td style={{ padding: '5px 10px', color: 'var(--color-text)', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.name}>
                {row.name}
              </td>
              <td style={{ ...NUM_CELL, color: 'var(--color-text)' }}>{formatValue(row.latest, summary.unit)}</td>
              <td style={{ ...NUM_CELL, color: deltaColor(row.delta), fontWeight: 600 }}>{deltaLabel(row.delta)}</td>
              <td style={{ ...NUM_CELL, width: 1 }}>
                <span style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
                  <Sparkline points={row.points.slice(-24)} width={56} height={16} color={row.color} />
                </span>
              </td>
            </tr>
          ))}
          {hidden > 0 && (
            <tr style={{ borderTop: '1px solid var(--color-border)' }}>
              <td colSpan={4} style={{ padding: '5px 10px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                +{hidden} more — open to see every series
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
