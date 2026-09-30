import { useState, type ReactNode } from 'react';
import type { Series } from '../../hooks/useLab';
import { useI18n } from '../../context/I18nContext';
import { ROW_CAP } from './barRows';
import { Sparkline } from './Sparkline';
import { ChartEmpty, DeltaMark, latestPoint, type ChartBodyProps } from './chartBody';
import { OTHER_COLOR, colorScale, formatNumber, formatValue, type ChartFormat } from './chart';
import './MetricTable.css';

/**
 * The lab's two tables, on one look and one set of options:
 *
 *   MetricTable - the `table` render and a board `table` block over a SERIES frame:
 *                 one row per series with its latest value, the change since the
 *                 previous point, and a trend glyph.
 *   FrameTable  - a board `table` block over a TABLE frame: dims as text columns,
 *                 values as numbers, the change against `prev`, the frame total.
 *
 * Both: click (or Enter/Space on) a header to sort, desc/asc then back to the
 * delivered order (a manifest author's ordering is a choice, not an accident),
 * with `aria-sort` on the header; the header sticks while the table scrolls in
 * its own wrapper; `density` sets the row rhythm; `bars` draws an inline data
 * bar beside the value; the change carries an arrow and a sign, and colour only
 * on top of them (`deltaColor`); `format` writes every figure. An `Other` row
 * (frameOps `topN`) is labelled as such and always stays last.
 */

export type TableDensity = 'compact' | 'comfortable';
export type SortDir = 'asc' | 'desc';
export interface TableSort { key: string; dir: SortDir }

/** The shared table options (board `table` block). */
export interface TableOptions {
  density?: TableDensity;
  /** Inline data bars in the value column. */
  bars?: boolean;
  /** Colour the change (status ink) on top of its arrow and sign. */
  deltaColor?: boolean;
  /** How figures are written (chart `ChartFormat`). */
  format?: ChartFormat;
}

export function toDensity(v: unknown): TableDensity {
  return v === 'comfortable' ? 'comfortable' : 'compact';
}

/**
 * The next sort after a header click: a new column starts descending for
 * numbers (largest first) and ascending for text, the second click flips it,
 * the third returns to the delivered order.
 */
export function nextSort(current: TableSort | null, key: string, numeric: boolean): TableSort | null {
  const first: SortDir = numeric ? 'desc' : 'asc';
  if (!current || current.key !== key) return { key, dir: first };
  if (current.dir === first) return { key, dir: first === 'desc' ? 'asc' : 'desc' };
  return null;
}

/**
 * Rows in the chosen order. Missing values sort last in both directions and a
 * row `pinned` (the `Other` fold) stays at the bottom; ties keep their order.
 */
export function sortRows<R>(
  rows: readonly R[],
  sort: TableSort | null,
  value: (row: R, key: string) => number | string | null,
  pinned: (row: R) => boolean = () => false,
): R[] {
  const free = rows.filter((r) => !pinned(r));
  const tail = rows.filter(pinned);
  if (!sort) return [...free, ...tail];
  const sign = sort.dir === 'asc' ? 1 : -1;
  const sorted = free
    .map((row, i) => ({ row, i, v: value(row, sort.key) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number'
        ? a.v - b.v
        : String(a.v).localeCompare(String(b.v), undefined, { numeric: true });
      return c !== 0 ? sign * c : a.i - b.i;
    })
    .map((x) => x.row);
  return [...sorted, ...tail];
}

function ariaSort(sort: TableSort | null, key: string): 'ascending' | 'descending' | 'none' {
  if (sort?.key !== key) return 'none';
  return sort.dir === 'asc' ? 'ascending' : 'descending';
}

/** A sortable column header: the button is the affordance, the `th` carries `aria-sort`. */
function SortHeader({ label, colKey, numeric, sort, onSort }: {
  label: string;
  colKey: string;
  numeric: boolean;
  sort: TableSort | null;
  onSort: (key: string, numeric: boolean) => void;
}) {
  const state = ariaSort(sort, colKey);
  return (
    <th scope="col" aria-sort={state} data-col={colKey} className={numeric ? 'lab-table-num' : undefined}>
      <button
        type="button"
        className="lab-table-sort"
        data-sorted={state === 'none' ? undefined : state}
        // The header is the table's own control: its click sorts, it never opens the card.
        onClick={(e) => { e.stopPropagation(); onSort(colKey, numeric); }}
      >
        <span className="lab-table-sort-label">{label}</span>
        <svg className="lab-table-sort-icon" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
          {state === 'ascending' ? <path d="M5 2 9 8H1z" /> : state === 'descending' ? <path d="M5 8 1 2h8z" /> : <path d="M5 1 8 4H2zM5 9 2 6h6z" />}
        </svg>
      </button>
    </th>
  );
}

/** The value cell's inline bar: magnitude against the largest shown value, beside (never under) the number. */
function BarCell({ value, max, other, children }: { value: number | null; max: number; other?: boolean; children: ReactNode }) {
  const frac = value === null || !(max > 0) ? 0 : Math.min(1, Math.abs(value) / max);
  return (
    <span className="lab-table-barcell">
      <span className="lab-table-bar" aria-hidden="true">
        <span
          className="lab-table-bar-fill"
          data-bar-frac={frac.toFixed(3)}
          style={{ width: `${(frac * 100).toFixed(1)}%`, background: other ? OTHER_COLOR : undefined }}
        />
      </span>
      <span className="lab-table-barvalue">{children}</span>
    </span>
  );
}

function useTableSort(): [TableSort | null, (key: string, numeric: boolean) => void] {
  const [sort, setSort] = useState<TableSort | null>(null);
  return [sort, (key, numeric) => setSort((current) => nextSort(current, key, numeric))];
}

function tableClass(density: TableDensity): string {
  return `lab-table lab-table--${density}`;
}

// ─── MetricTable (series) ───────────────────────────────────────────────────

interface MetricRow {
  name: string;
  latest: number | null;
  delta: number | null;
  points: { t: string; v: number }[];
  color: string;
  other?: number;
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

export function MetricTable({
  series, unit, full = false, emptyHint, columns, density = 'compact', bars = false, deltaColor = true, format = 'number',
}: {
  series: (Series & { other?: number })[];
  unit: string | null;
  full?: boolean;
  emptyHint?: string;
  /** Column pick (board `table` block `columns`); absent = every column. */
  columns?: readonly string[] | null;
} & TableOptions) {
  const { t, locale } = useI18n();
  const [sort, onSort] = useTableSort();
  const show = new Set<MetricColumn>(pickMetricColumns(columns));
  // Colour follows the series over the FULL list, so a sort never repaints a trend.
  const colors = colorScale(series.filter((s) => s.other === undefined).map((s) => s.name));

  const rows: MetricRow[] = series.map((s) => {
    const last = latestPoint(s);
    const prev = s.points.length >= 2 ? s.points[s.points.length - 2] : null;
    return {
      name: s.other !== undefined ? t('lab.blocks.otherCount').replace('{n}', String(s.other)) : s.name,
      latest: last ? last.v : null,
      delta: last && prev ? last.v - prev.v : null,
      points: s.points,
      color: s.other !== undefined ? OTHER_COLOR : colors.color(s.name),
      other: s.other,
    };
  });

  if (rows.length === 0) return <ChartEmpty hint={emptyHint} />;

  // Snapshot honesty: single-point series have no move and no trend; a column
  // of '-' and flat sparklines reads as "broken", so those columns step aside.
  const hasHistory = series.some((s) => s.points.length >= 2);
  const cols = METRIC_COLUMNS.filter((c) => show.has(c) && (hasHistory || c === 'series' || c === 'latest'));

  const sorted = sortRows(rows, sort, (r, key) => (key === 'series' ? r.name : key === 'latest' ? r.latest : r.delta), (r) => r.other !== undefined);
  const shown = full ? sorted : sorted.slice(0, ROW_CAP);
  const hidden = sorted.length - shown.length;
  const max = Math.max(0, ...shown.map((r) => Math.abs(r.latest ?? 0)));
  const fmt = (v: number) => formatValue(v, { format, unit, locale });
  const fmtAbs = (v: number) => formatNumber(v, { format, unit, locale });

  const label: Record<MetricColumn, string> = {
    series: t('lab.blocks.table.series'),
    latest: t('lab.blocks.table.latest'),
    delta: t('lab.blocks.table.change'),
    trend: t('lab.blocks.table.trend'),
  };

  return (
    <div className="lab-table-wrap">
      <table className={tableClass(density)} data-density={density} data-bars={bars ? '' : undefined} data-columns={cols.join(',')}>
        <thead className="lab-table-head">
          <tr>
            {cols.map((c) => (c === 'trend'
              ? <th key={c} scope="col" className="lab-table-num" data-col={c}><span className="lab-table-static">{label[c]}</span></th>
              : <SortHeader key={c} label={label[c]} colKey={c} numeric={c !== 'series'} sort={sort} onSort={onSort} />))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.name} data-other={row.other !== undefined ? '' : undefined}>
              {cols.map((c) => {
                if (c === 'series') return <td key={c} className="lab-table-text" title={row.name}>{row.name}</td>;
                if (c === 'latest') {
                  const text = row.latest !== null ? fmt(row.latest) : '-';
                  return (
                    <td key={c} className="lab-table-num">
                      {bars ? <BarCell value={row.latest} max={max} other={row.other !== undefined}>{text}</BarCell> : text}
                    </td>
                  );
                }
                if (c === 'delta') return <td key={c} className="lab-table-num"><DeltaMark delta={row.delta} format={fmtAbs} colored={deltaColor} /></td>;
                return (
                  <td key={c} className="lab-table-num lab-table-trend">
                    <Sparkline points={row.points.slice(-24)} width={56} height={16} color={row.color} />
                  </td>
                );
              })}
            </tr>
          ))}
          {hidden > 0 && (
            <tr className="lab-table-more">
              <td colSpan={Math.max(1, cols.length)}>{t('lab.blocks.table.more').replace('{n}', String(hidden))}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── FrameTable (table frame) ───────────────────────────────────────────────

/** A table-frame row as FrameTable draws it (mirrors the board frame's row). */
export interface FrameTableRow {
  d: Record<string, string>;
  v: number | null;
  n?: number | null;
  prev?: number | null;
  /** The `Other` row topN folds: how many rows it holds. */
  other?: number;
}

/** The value columns a table frame can show beside its dims; `delta` is `v - prev`. */
export const FRAME_VALUE_COLUMNS = ['v', 'n', 'prev', 'delta'] as const;

/**
 * The columns a table frame shows: the pick (dim keys and `v`/`n`/`prev`/`delta`),
 * in the pick's order, unknown names dropped; absent or empty = every dim, then
 * `v`, then `n` when any row carries it, then `prev` and the change `delta` when
 * any row carries a previous value.
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
  if (rows.some((r) => typeof r.prev === 'number')) out.push('prev', 'delta');
  return out;
}

function rowDelta(row: FrameTableRow): number | null {
  return typeof row.v === 'number' && typeof row.prev === 'number' ? row.v - row.prev : null;
}

/**
 * The board `table` block over a TABLE frame: one row per frame row, dims as
 * text columns, values as numbers, and the frame's own total (after filters,
 * before the limit) as a sticky footer. Headers are localized here; `labels`
 * overrides them.
 */
export function FrameTable({
  dims, rows, unit, columns, total, labels, emptyHint, density = 'compact', bars = false, deltaColor = true, format = 'auto',
}: {
  dims: readonly { key: string; label: string }[];
  rows: readonly FrameTableRow[];
  unit: string | null;
  columns?: readonly string[] | null;
  total?: { count: number; v: number | null; n: number | null } | null;
  labels?: Partial<{ v: string; n: string; prev: string; delta: string; total: string; rows: string }>;
  emptyHint?: string;
} & TableOptions) {
  const { t, locale } = useI18n();
  const [sort, onSort] = useTableSort();
  if (rows.length === 0 && !total?.count) return <ChartEmpty hint={emptyHint} />;

  const L = {
    v: labels?.v ?? t('lab.blocks.table.value'),
    n: labels?.n ?? t('lab.blocks.table.n'),
    prev: labels?.prev ?? t('lab.blocks.table.prev'),
    delta: labels?.delta ?? t('lab.blocks.table.change'),
    total: labels?.total ?? t('lab.blocks.table.total'),
    rows: labels?.rows ?? t('lab.blocks.table.rows'),
  };
  const cols = pickFrameColumns(dims, rows, columns);
  const firstDim = cols.find((c) => !(FRAME_VALUE_COLUMNS as readonly string[]).includes(c)) ?? null;
  const isValue = (key: string) => (FRAME_VALUE_COLUMNS as readonly string[]).includes(key);
  const dimLabel = (key: string) => dims.find((d) => d.key === key)?.label ?? key;
  const headerFor = (key: string) => (isValue(key) ? L[key as keyof typeof L] : dimLabel(key));
  const fmtOpts = { format, unit, locale };
  // Counts are whole things: they keep the grouping (or compaction) but never a currency or percent.
  const countFormat: ChartFormat = format === 'compact' || format === 'auto' ? format : 'number';
  const fmtCount = (n: number) => formatNumber(n, { format: countFormat, locale, maxDecimals: 0 });
  const fmtAbs = (v: number) => formatNumber(v, fmtOpts);

  const valueOf = (row: FrameTableRow, key: string): number | string | null => {
    if (key === 'v') return row.v;
    if (key === 'n') return typeof row.n === 'number' ? row.n : null;
    if (key === 'prev') return typeof row.prev === 'number' ? row.prev : null;
    if (key === 'delta') return rowDelta(row);
    return row.d[key] ?? null;
  };
  const sorted = sortRows(rows, sort, valueOf, (r) => r.other !== undefined);
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.v ?? 0)));
  const lead = Math.max(0, cols.findIndex(isValue) === -1 ? cols.length : cols.findIndex(isValue));
  const totalLabel = total ? `${L.total} (${total.count.toLocaleString(locale)} ${L.rows})` : '';
  const otherLabel = (row: FrameTableRow) => t('lab.blocks.otherCount').replace('{n}', String(row.other));

  const cell = (row: FrameTableRow, key: string): ReactNode => {
    const other = row.other !== undefined;
    if (key === 'v') {
      const text = typeof row.v === 'number' ? formatValue(row.v, fmtOpts) : '';
      return bars ? <BarCell value={row.v} max={max} other={other}>{text}</BarCell> : text;
    }
    if (key === 'n') return typeof row.n === 'number' ? fmtCount(row.n) : '';
    if (key === 'prev') return typeof row.prev === 'number' ? formatValue(row.prev, fmtOpts) : '';
    if (key === 'delta') return <DeltaMark delta={rowDelta(row)} format={fmtAbs} colored={deltaColor} />;
    // The fold's label goes in the first text column; the other dims stay blank.
    if (other) return key === firstDim ? otherLabel(row) : '';
    return row.d[key] ?? '';
  };

  return (
    <div className="lab-table-wrap">
      <table className={tableClass(density)} data-density={density} data-bars={bars ? '' : undefined} data-columns={cols.join(',')}>
        <thead className="lab-table-head">
          <tr>
            {cols.map((key) => (
              <SortHeader key={key} label={headerFor(key)} colKey={key} numeric={isValue(key)} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i} data-other={row.other !== undefined ? '' : undefined}>
              {cols.map((key) => {
                const content = cell(row, key);
                return (
                  <td
                    key={key}
                    className={isValue(key) ? 'lab-table-num' : 'lab-table-text'}
                    title={!isValue(key) && typeof content === 'string' ? content : undefined}
                  >{content}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot className="lab-table-foot">
            <tr data-total-count={total.count}>
              {/* The label spans the leading text columns, so a narrow first column never truncates it. */}
              {lead > 0 && <td colSpan={lead} className="lab-table-total-label">{totalLabel}</td>}
              {cols.slice(lead).map((key, i) => (
                <td key={key} className={isValue(key) ? 'lab-table-num' : 'lab-table-text'}>
                  {key === 'v' ? (total.v !== null ? formatValue(total.v, fmtOpts) : '')
                    : key === 'n' ? (total.n !== null ? fmtCount(total.n) : '')
                      : lead === 0 && i === 0 ? totalLabel : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
