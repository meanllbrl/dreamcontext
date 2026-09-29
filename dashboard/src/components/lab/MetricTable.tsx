import { useState } from 'react';
import type { Series } from '../../hooks/useLab';
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
  return <MetricTable series={series} unit={summary.unit} full={full} emptyHint={emptyHint} />;
}

/** The metric table's columns, in display order. `columns` on a board `table` block picks among them. */
export const METRIC_COLUMNS = ['series', 'latest', 'delta', 'trend'] as const;
export type MetricColumn = (typeof METRIC_COLUMNS)[number];

/** The columns a pick keeps, in the table's own order. Empty or unknown-only = all. */
export function pickMetricColumns(columns: readonly string[] | null | undefined): MetricColumn[] {
  const wanted = (columns ?? []).map((c) => (c === 'name' ? 'series' : c));
  const kept = METRIC_COLUMNS.filter((c) => wanted.includes(c));
  return kept.length > 0 ? kept : [...METRIC_COLUMNS];
}

export function MetricTable({ series, unit, full = false, emptyHint, columns }: {
  series: Series[];
  unit: string | null;
  full?: boolean;
  emptyHint?: string;
  /** Column pick (board `table` block `columns`); absent = every column. */
  columns?: readonly string[] | null;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const show = new Set<MetricColumn>(pickMetricColumns(columns));

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

  // Snapshot honesty: single-point series have no move and no trend — a column
  // of '—' and flat sparklines reads as "broken", so those columns step aside.
  const hasHistory = series.some((s) => s.points.length >= 2);

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
            {show.has('series') && header('name', 'Series', 'left')}
            {show.has('latest') && header('latest', 'Latest', 'right')}
            {hasHistory && show.has('delta') && header('delta', 'Δ', 'right')}
            {hasHistory && show.has('trend') && (
              <th scope="col" style={{ textAlign: 'right', padding: '6px 10px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Trend</th>
            )}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.name} style={{ borderTop: '1px solid var(--color-border)' }}>
              {show.has('series') && (
                <td style={{ padding: '5px 10px', color: 'var(--color-text)', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.name}>
                  {row.name}
                </td>
              )}
              {show.has('latest') && <td style={{ ...NUM_CELL, color: 'var(--color-text)' }}>{formatValue(row.latest, unit)}</td>}
              {hasHistory && show.has('delta') && (
                <td style={{ ...NUM_CELL, color: deltaColor(row.delta), fontWeight: 600 }}>{deltaLabel(row.delta)}</td>
              )}
              {hasHistory && show.has('trend') && (
                <td style={{ ...NUM_CELL, width: 1 }}>
                  <span style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
                    <Sparkline points={row.points.slice(-24)} width={56} height={16} color={row.color} />
                  </span>
                </td>
              )}
            </tr>
          ))}
          {hidden > 0 && (
            <tr style={{ borderTop: '1px solid var(--color-border)' }}>
              <td colSpan={Math.max(1, [...show].filter((c) => hasHistory || c === 'series' || c === 'latest').length)} style={{ padding: '5px 10px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                +{hidden} more — open to see every series
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A table-frame row as FrameTable draws it (mirrors the board frame's row). */
export interface FrameTableRow {
  d: Record<string, string>;
  v: number | null;
  n?: number | null;
  prev?: number | null;
}

/** The value columns a table frame can show beside its dims. */
export const FRAME_VALUE_COLUMNS = ['v', 'n', 'prev'] as const;

/**
 * The columns a table frame shows: the pick (dim keys and `v`/`n`/`prev`), in
 * the pick's order, unknown names dropped; absent or empty = every dim, then
 * `v`, then `n`/`prev` when any row carries them.
 */
export function pickFrameColumns(
  dims: readonly { key: string }[],
  rows: readonly FrameTableRow[],
  columns: readonly string[] | null | undefined,
): string[] {
  const known = new Set<string>([...dims.map((d) => d.key), ...FRAME_VALUE_COLUMNS]);
  const picked = (columns ?? []).filter((c, i, all) => known.has(c) && all.indexOf(c) === i);
  if (picked.length > 0) return picked;
  const out = [...dims.map((d) => d.key), 'v'];
  if (rows.some((r) => typeof r.n === 'number')) out.push('n');
  if (rows.some((r) => typeof r.prev === 'number')) out.push('prev');
  return out;
}

/**
 * The board `table` block over a TABLE frame: one row per frame row, dims as
 * text columns, values as numbers, and the frame's own total (after filters,
 * before the limit) as a footer. Column headers for the value columns come in
 * from the caller already localized.
 */
export function FrameTable({ dims, rows, unit, columns, total, labels, emptyHint }: {
  dims: readonly { key: string; label: string }[];
  rows: readonly FrameTableRow[];
  unit: string | null;
  columns?: readonly string[] | null;
  total?: { count: number; v: number | null; n: number | null } | null;
  labels: { v: string; n: string; prev: string; total: string; rows: string };
  emptyHint?: string;
}) {
  if (rows.length === 0 && !total?.count) return <ChartEmpty hint={emptyHint} />;
  const cols = pickFrameColumns(dims, rows, columns);
  const dimLabel = (key: string) => dims.find((d) => d.key === key)?.label ?? key;
  const isValue = (key: string) => (FRAME_VALUE_COLUMNS as readonly string[]).includes(key);
  const headerFor = (key: string) => (key === 'v' ? labels.v : key === 'n' ? labels.n : key === 'prev' ? labels.prev : dimLabel(key));
  const cell = (row: FrameTableRow, key: string): string => {
    if (key === 'v') return formatValue(row.v, unit);
    if (key === 'n') return typeof row.n === 'number' ? row.n.toLocaleString() : '';
    if (key === 'prev') return typeof row.prev === 'number' ? formatValue(row.prev, unit) : '';
    return row.d[key] ?? '';
  };

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }} data-columns={cols.join(',')}>
        <thead>
          <tr style={{ background: 'var(--color-bg-tertiary)' }}>
            {cols.map((key) => (
              <th key={key} scope="col" style={{ padding: '6px 10px', fontWeight: 600, color: 'var(--color-text-secondary)', textAlign: isValue(key) ? 'right' : 'left' }}>
                {headerFor(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
              {cols.map((key) => (
                <td
                  key={key}
                  style={isValue(key)
                    ? { ...NUM_CELL, color: 'var(--color-text)' }
                    : { padding: '5px 10px', color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}
                >{cell(row, key)}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot>
            <tr style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-tertiary)' }} data-total-count={total.count}>
              {cols.map((key, i) => (
                <td key={key} style={isValue(key) ? { ...NUM_CELL, fontWeight: 600, color: 'var(--color-text)' } : { padding: '5px 10px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                  {key === 'v' ? formatValue(total.v, unit)
                    : key === 'n' ? (total.n !== null ? total.n.toLocaleString() : '')
                      : i === 0 ? `${labels.total} (${total.count.toLocaleString()} ${labels.rows})` : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
