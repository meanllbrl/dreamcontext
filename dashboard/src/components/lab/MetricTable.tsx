import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import type { Series } from '../../hooks/useLab';
import { useI18n } from '../../context/I18nContext';
import { ROW_CAP } from './barRows';
import { Sparkline } from './Sparkline';
import { ChartEmpty, DeltaMark, latestPoint, type ChartBodyProps } from './chartBody';
import { OTHER_COLOR, colorScale, formatNumber, unitSuffix, type ChartFormat } from './chart';
import { elementFont, textWidth } from './textMeasure';
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
function BarCell({ value, max, other, width, children }: {
  value: number | null;
  max: number;
  other?: boolean;
  /** The bar's least width (px), from the table's fit. */
  width: number;
  children: ReactNode;
}) {
  const frac = value === null || !(max > 0) ? 0 : Math.min(1, Math.abs(value) / max);
  return (
    <span className="lab-table-barcell">
      <span className="lab-table-bar" aria-hidden="true" style={{ minWidth: `${width}px` }}>
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

// ─── Fitting the width ──────────────────────────────────────────────────────

/**
 * One rung of the ladder a table climbs down when its columns do not fit:
 * drop a column, write the figures compact, or take the data bar away.
 */
export type FitStep = { drop: string } | { compact: true } | { noBar: true };

/** What one column needs, padding included (px): its header, its widest cell full and compact. */
export interface ColumnWidth { header: number; cell: number; compact: number }

export interface FitSpec {
  /** The columns in display order. */
  columns: readonly string[];
  widths: Readonly<Record<string, ColumnWidth>>;
  /** The data bar: the column it sits in and the width it wants and needs at least (gap included). */
  bar?: { column: string; ideal: number; min: number } | null;
  /** What gives way, in order. A step naming a column that is not shown is skipped. */
  ladder: readonly FitStep[];
}

export interface TableFit {
  columns: string[];
  dropped: string[];
  compact: boolean;
  /** The data bar's width (px); 0 = no bar. */
  bar: number;
  /** False when the whole ladder was not enough: the label then wraps instead of the table scrolling. */
  fits: boolean;
}

/**
 * The columns a table shows in `avail` px. The data bar shrinks first (down to
 * its minimum), then the ladder's rungs apply one at a time until the columns
 * fit. An unmeasured width (0 or less: server render, first paint) shows
 * everything at the bar's ideal width.
 */
export function fitTable(spec: FitSpec, avail: number): TableFit {
  const bar = spec.bar && spec.columns.includes(spec.bar.column) ? spec.bar : null;
  if (!(avail > 0)) {
    return { columns: [...spec.columns], dropped: [], compact: false, bar: bar ? bar.ideal : 0, fits: true };
  }
  const dropped = new Set<string>();
  let compact = false;
  let barOn = bar !== null;
  const need = (key: string, barWidth: number): number => {
    const w = spec.widths[key] ?? { header: 0, cell: 0, compact: 0 };
    return Math.max(w.header, (compact ? w.compact : w.cell) + barWidth);
  };
  /** The bar width that fits now (0 without a bar), or null when nothing fits. */
  const attempt = (): number | null => {
    const shown = spec.columns.filter((c) => !dropped.has(c));
    if (!barOn || !bar) return shown.reduce((s, c) => s + need(c, 0), 0) <= avail ? 0 : null;
    const rest = shown.filter((c) => c !== bar.column).reduce((s, c) => s + need(c, 0), 0);
    if (rest + need(bar.column, bar.min) > avail) return null;
    const w = spec.widths[bar.column];
    const room = avail - rest - (w ? (compact ? w.compact : w.cell) : 0);
    return Math.max(bar.min, Math.min(bar.ideal, Math.floor(room)));
  };
  const result = (barWidth: number, fits: boolean): TableFit => ({
    columns: spec.columns.filter((c) => !dropped.has(c)),
    dropped: spec.columns.filter((c) => dropped.has(c)),
    compact,
    bar: barWidth,
    fits,
  });

  let got = attempt();
  if (got !== null) return result(got, true);
  for (const step of spec.ladder) {
    if ('drop' in step) {
      if (!spec.columns.includes(step.drop) || dropped.has(step.drop)) continue;
      dropped.add(step.drop);
    } else if ('compact' in step) {
      if (compact) continue;
      compact = true;
    } else {
      if (!barOn) continue;
      barOn = false;
    }
    got = attempt();
    if (got !== null) return result(got, true);
  }
  return result(0, false);
}

/** Header padding plus the sort icon and its gap, and a cell's side padding, per density (MetricTable.css). */
const CELL_PAD: Record<TableDensity, number> = { compact: 16, comfortable: 24 };
const SORT_ICON = 14;
/** The change mark's arrow and its gap (chartBody.css .lab-delta). */
const DELTA_ICON = 14;
/** A little air per column, so rounding and tabular digits never tip a fit into a scroll. */
const FIT_SLACK = 4;
/** The data bar: the width it grows to, the least it keeps, and its gap to the figure. */
const BAR_IDEAL = 120;
const BAR_MIN = 24;
const BAR_GAP = 8;
/** The trend sparkline's width (the MetricTable draws it at 56px). */
const TREND_WIDTH = 56;

/** The texts a column shows: its header, its cells full and compact, and any icon beside a cell. */
interface ColumnTexts { header: string; cells: string[]; compact: string[]; icon?: number }

function measureColumns(
  table: HTMLElement,
  density: TableDensity,
  texts: Readonly<Record<string, ColumnTexts>>,
): Record<string, ColumnWidth> {
  const th = table.querySelector('th');
  const body = elementFont(table);
  const head = elementFont(table, th ? getComputedStyle(th).fontWeight : '600');
  const pad = CELL_PAD[density] + FIT_SLACK;
  const widest = (list: string[]) => list.reduce((m, s) => Math.max(m, textWidth(s, body)), 0);
  const out: Record<string, ColumnWidth> = {};
  for (const [key, c] of Object.entries(texts)) {
    const icon = c.icon ?? 0;
    out[key] = {
      header: Math.ceil(textWidth(c.header, head) + SORT_ICON + pad),
      cell: Math.ceil(widest(c.cells) + icon + pad),
      compact: Math.ceil(widest(c.compact) + icon + pad),
    };
  }
  return out;
}

/**
 * The table's scroll box and the width inside it (scrollbar excluded), read
 * before paint and followed on resize. 0 until mounted.
 */
function useInnerWidth(): [(el: HTMLDivElement | null) => void, number, HTMLDivElement | null] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => setWidth((prev) => (prev === el.clientWidth ? prev : el.clientWidth));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width, el];
}

/**
 * The fit for the table in `wrap`: measures every column's texts in the
 * rendered font and walks the ladder. Everything shows until measured.
 */
function useTableFit(
  wrap: HTMLDivElement | null,
  avail: number,
  density: TableDensity,
  columns: readonly string[],
  texts: () => Record<string, ColumnTexts>,
  bar: string | null,
  ladder: readonly FitStep[],
  deps: readonly unknown[],
): TableFit {
  const table = wrap?.querySelector('table') ?? null;
  // A web font that lands after the first measure changes every width: measure again then.
  const [fontsReady, setFontsReady] = useState(() => typeof document === 'undefined' || document.fonts?.status !== 'loading');
  useEffect(() => {
    if (fontsReady) return;
    let live = true;
    void document.fonts.ready.then(() => { if (live) setFontsReady(true); });
    return () => { live = false; };
  }, [fontsReady]);
  // Texts are measured once per data, format and font; a resize only re-walks the ladder.
  const widths = useMemo(
    () => (table && avail > 0 ? measureColumns(table, density, texts()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, avail > 0, density, fontsReady, ...deps],
  );
  const spec: FitSpec = {
    columns,
    widths: widths ?? {},
    bar: bar ? { column: bar, ideal: BAR_IDEAL + BAR_GAP, min: BAR_MIN + BAR_GAP } : null,
    ladder,
  };
  const fit = fitTable(spec, widths ? avail : 0);
  return { ...fit, bar: fit.bar > 0 ? fit.bar - BAR_GAP : 0 };
}

/** A figure's unit when it is a word ("users"): written once in the value header, never per cell. */
function wordUnit(format: ChartFormat, unit: string | null): string | null {
  const suffix = unitSuffix(format, unit);
  return suffix.startsWith(' ') ? suffix.trim() : null;
}

/** The format a narrow table writes figures in: compact where the format allows it. */
function compactFormat(format: ChartFormat): ChartFormat {
  return format === 'auto' || format === 'number' || format === 'compact' ? 'compact' : format;
}

/**
 * The magnitude a column's `auto` format resolves from: its largest absolute
 * value, so one column is written one way (never "12.4K" above "5,200").
 */
export function columnMagnitude(values: readonly (number | null | undefined)[]): number {
  return values.reduce<number>((m, v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
}

/**
 * How many source rows a total covers: the frame's row count with each `Other`
 * fold counted as the rows it holds ("Other (2)" is two rows, not one).
 */
export function coveredRows(count: number, rows: readonly { other?: number }[]): number {
  return rows.reduce((n, r) => n + (typeof r.other === 'number' && r.other > 1 ? r.other - 1 : 0), count);
}

/** The row's tooltip when columns gave way: the label, then each dropped column and its value. */
function rowTitle(label: string, dropped: readonly { header: string; text: string }[]): string | undefined {
  if (dropped.length === 0) return undefined;
  return [label, ...dropped.map((d) => `${d.header}: ${d.text}`)].join(' · ');
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

/** What gives way in a narrow metric table: the trend first, then compact figures, the bar, the change. */
const METRIC_LADDER: readonly FitStep[] = [{ drop: 'trend' }, { compact: true }, { noBar: true }, { drop: 'delta' }];

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
  const [wrapRef, avail, wrap] = useInnerWidth();
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

  // Snapshot honesty: single-point series have no move and no trend; a column
  // of '-' and flat sparklines reads as "broken", so those columns step aside.
  const hasHistory = series.some((s) => s.points.length >= 2);
  const cols = METRIC_COLUMNS.filter((c) => show.has(c) && (hasHistory || c === 'series' || c === 'latest'));

  const sorted = sortRows(rows, sort, (r, key) => (key === 'series' ? r.name : key === 'latest' ? r.latest : r.delta), (r) => r.other !== undefined);
  const shown = full ? sorted : sorted.slice(0, ROW_CAP);
  const hidden = sorted.length - shown.length;
  const max = Math.max(0, ...shown.map((r) => Math.abs(r.latest ?? 0)));
  // A word unit ("users") is written once, in the latest header; a symbol (%) stays on the figure.
  const headUnit = wordUnit(format, unit);
  const opts = (compact: boolean) => ({ format: compact ? compactFormat(format) : format, unit, locale });
  // One number style per column: `auto` resolves once, from the column's largest value.
  const mag = { latest: columnMagnitude(shown.map((r) => r.latest)), delta: columnMagnitude(shown.map((r) => r.delta)) };
  const suffix = headUnit ? '' : unitSuffix(format, unit);
  const fmt = (v: number, compact = false) => formatNumber(v, opts(compact), mag.latest) + suffix;
  const fmtAbs = (v: number, compact = false) => formatNumber(v, opts(compact), mag.delta);
  const signed = (d: number | null, compact = false) => (d === null ? '-' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${fmtAbs(Math.abs(d), compact)}`);

  const label: Record<MetricColumn, string> = {
    series: t('lab.blocks.table.series'),
    latest: headUnit ? `${t('lab.blocks.table.latest')} (${headUnit})` : t('lab.blocks.table.latest'),
    delta: t('lab.blocks.table.change'),
    trend: t('lab.blocks.table.trend'),
  };

  const fit = useTableFit(wrap, avail, density, cols, () => {
    const texts: Record<string, ColumnTexts> = {};
    for (const c of cols) {
      const list = (compact: boolean) => shown.map((r) => (c === 'series' ? r.name : c === 'latest' ? (r.latest !== null ? fmt(r.latest, compact) : '-') : c === 'delta' ? signed(r.delta, compact) : ''));
      texts[c] = {
        header: label[c],
        cells: list(false),
        compact: list(true),
        icon: c === 'delta' ? DELTA_ICON : c === 'trend' ? TREND_WIDTH : 0,
      };
    }
    return texts;
  }, bars ? 'latest' : null, METRIC_LADDER, [series, cols.join(','), format, unit, locale, full]);

  if (rows.length === 0) return <ChartEmpty hint={emptyHint} />;
  const view = fit.columns as MetricColumn[];
  const fullText = (row: MetricRow, c: MetricColumn): string => (c === 'latest'
    ? (row.latest !== null ? formatNumber(row.latest, opts(false), mag.latest) + unitSuffix(format, unit) : '-')
    : c === 'delta' ? signed(row.delta) : '');

  return (
    <div className="lab-table-wrap" ref={wrapRef}>
      <table
        className={tableClass(density)}
        data-density={density}
        data-bars={bars ? '' : undefined}
        data-columns={view.join(',')}
        data-dropped={fit.dropped.length > 0 ? fit.dropped.join(',') : undefined}
        data-compact={fit.compact ? '' : undefined}
        data-fit={fit.fits ? undefined : 'wrap'}
      >
        <thead className="lab-table-head">
          <tr>
            {view.map((c) => (c === 'trend'
              ? <th key={c} scope="col" className="lab-table-num" data-col={c}><span className="lab-table-static">{label[c]}</span></th>
              : <SortHeader key={c} label={label[c]} colKey={c} numeric={c !== 'series'} sort={sort} onSort={onSort} />))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr
              key={row.name}
              data-other={row.other !== undefined ? '' : undefined}
              title={rowTitle(row.name, (fit.dropped as MetricColumn[]).filter((c) => c !== 'trend').map((c) => ({ header: label[c], text: fullText(row, c) })))}
            >
              {view.map((c) => {
                if (c === 'series') return <td key={c} className="lab-table-text" title={row.name}>{row.name}</td>;
                if (c === 'latest') {
                  const text = row.latest !== null ? fmt(row.latest, fit.compact) : '-';
                  return (
                    <td key={c} className="lab-table-num">
                      {bars && fit.bar > 0 ? <BarCell value={row.latest} max={max} other={row.other !== undefined} width={fit.bar}>{text}</BarCell> : text}
                    </td>
                  );
                }
                if (c === 'delta') return <td key={c} className="lab-table-num"><DeltaMark delta={row.delta} format={(v) => fmtAbs(v, fit.compact)} colored={deltaColor} /></td>;
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
              <td colSpan={Math.max(1, view.length)}>{t('lab.blocks.table.more').replace('{n}', String(hidden))}</td>
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
 * What gives way in a narrow table frame, first to last: the count, then the
 * figures go compact, then the previous value, the data bar, the change, and
 * the dims after the first (last first). The first dim and the value stay.
 */
export function frameLadder(columns: readonly string[]): FitStep[] {
  const isValue = (c: string) => (FRAME_VALUE_COLUMNS as readonly string[]).includes(c);
  const dims = columns.filter((c) => !isValue(c));
  return [
    { drop: 'n' }, { compact: true }, { drop: 'prev' }, { noBar: true }, { drop: 'delta' },
    ...dims.slice(1).reverse().map((d) => ({ drop: d })),
  ];
}

/**
 * The board `table` block over a TABLE frame: one row per frame row, dims as
 * text columns, values as numbers, and the frame's own total (after filters,
 * before the limit) as a sticky footer. Headers are localized here; `labels`
 * overrides them. The columns fit the cell's width (`frameLadder`): what gives
 * way stays in the row's tooltip.
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
  const [wrapRef, avail, wrap] = useInnerWidth();

  // A word unit ("users") is written once, in the value header; a symbol (%) stays on the figure.
  const headUnit = wordUnit(format, unit);
  const L = {
    v: labels?.v ?? t('lab.blocks.table.value'),
    n: labels?.n ?? t('lab.blocks.table.n'),
    prev: labels?.prev ?? t('lab.blocks.table.prev'),
    delta: labels?.delta ?? t('lab.blocks.table.change'),
    total: labels?.total ?? t('lab.blocks.table.total'),
    rows: labels?.rows ?? t('lab.blocks.table.rows'),
  };
  const picked = pickFrameColumns(dims, rows, columns);
  const isValue = (key: string) => (FRAME_VALUE_COLUMNS as readonly string[]).includes(key);
  const firstDim = picked.find((c) => !isValue(c)) ?? null;
  const unitCol = picked.includes('v') ? 'v' : picked.includes('prev') ? 'prev' : null;
  const dimLabel = (key: string) => dims.find((d) => d.key === key)?.label ?? key;
  const headerFor = (key: string) => {
    const base = isValue(key) ? L[key as keyof typeof L] : dimLabel(key);
    return headUnit && key === unitCol ? `${base} (${headUnit})` : base;
  };
  const opts = (compact: boolean) => ({ format: compact ? compactFormat(format) : format, unit, locale });
  // One number style per column: `auto` resolves once, from the column's largest value (the total included).
  const mag = {
    v: columnMagnitude([...rows.map((r) => r.v), total?.v]),
    prev: columnMagnitude(rows.map((r) => r.prev)),
    n: columnMagnitude([...rows.map((r) => r.n), total?.n]),
    delta: columnMagnitude(rows.map(rowDelta)),
  };
  const suffix = headUnit ? '' : unitSuffix(format, unit);
  const fmtV = (v: number, compact = false, key: 'v' | 'prev' = 'v') => formatNumber(v, opts(compact), mag[key]) + suffix;
  // Counts are whole things: they keep the grouping (or compaction) but never a currency or percent.
  const countFormat = (compact: boolean): ChartFormat => (compact || format === 'compact' ? 'compact' : format === 'auto' ? 'auto' : 'number');
  const fmtCount = (n: number, compact = false) => formatNumber(n, { format: countFormat(compact), locale, maxDecimals: 0 }, mag.n);
  const fmtAbs = (v: number, compact = false) => formatNumber(v, opts(compact), mag.delta);
  const signed = (d: number | null, compact = false) => (d === null ? '-' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${fmtAbs(Math.abs(d), compact)}`);
  const otherLabel = (row: FrameTableRow) => t('lab.blocks.otherCount').replace('{n}', String(row.other));
  const totalLabel = total ? `${L.total} (${coveredRows(total.count, rows).toLocaleString(locale)} ${L.rows})` : '';

  /** A cell as plain text (the fit measures it, the tooltip quotes it). */
  const text = (row: FrameTableRow, key: string, compact = false): string => {
    if (key === 'v') return typeof row.v === 'number' ? fmtV(row.v, compact) : '';
    if (key === 'n') return typeof row.n === 'number' ? fmtCount(row.n, compact) : '';
    if (key === 'prev') return typeof row.prev === 'number' ? fmtV(row.prev, compact, 'prev') : '';
    if (key === 'delta') return signed(rowDelta(row), compact);
    // The fold's label goes in the first text column; the other dims stay blank.
    if (row.other !== undefined) return key === firstDim ? otherLabel(row) : '';
    return row.d[key] ?? '';
  };

  const fit = useTableFit(wrap, avail, density, picked, () => {
    const texts: Record<string, ColumnTexts> = {};
    const leadLabels = total && picked.findIndex(isValue) === 1 ? [totalLabel] : [];
    for (const key of picked) {
      const list = (compact: boolean) => [
        ...rows.map((r) => text(r, key, compact)),
        ...(key === firstDim ? leadLabels : []),
        ...(total && key === 'v' && total.v !== null ? [fmtV(total.v, compact)] : []),
        ...(total && key === 'n' && total.n !== null ? [fmtCount(total.n, compact)] : []),
      ];
      texts[key] = { header: headerFor(key), cells: list(false), compact: list(true), icon: key === 'delta' ? DELTA_ICON : 0 };
    }
    return texts;
  }, bars ? 'v' : null, frameLadder(picked), [rows, picked.join(','), format, unit, locale, total, labels]);

  if (rows.length === 0 && !total?.count) return <ChartEmpty hint={emptyHint} />;

  const cols = fit.columns;
  const sorted = sortRows(rows, sort, (row, key) => {
    if (key === 'v') return row.v;
    if (key === 'n') return typeof row.n === 'number' ? row.n : null;
    if (key === 'prev') return typeof row.prev === 'number' ? row.prev : null;
    if (key === 'delta') return rowDelta(row);
    return row.d[key] ?? null;
  }, (r) => r.other !== undefined);
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.v ?? 0)));
  const lead = Math.max(0, cols.findIndex(isValue) === -1 ? cols.length : cols.findIndex(isValue));
  // The tooltip quotes a dropped figure in full, unit and all.
  const titleText = (row: FrameTableRow, key: string): string => {
    if ((key === 'v' || key === 'prev') && typeof row[key] === 'number') return formatNumber(row[key] as number, opts(false), mag[key]) + unitSuffix(format, unit);
    return text(row, key);
  };
  const rowLabel = (row: FrameTableRow) => (firstDim ? text(row, firstDim) : '') || cols.filter((c) => !isValue(c)).map((c) => text(row, c)).join(' ');

  const cell = (row: FrameTableRow, key: string): ReactNode => {
    if (key === 'v') {
      const s = text(row, key, fit.compact);
      return bars && fit.bar > 0 ? <BarCell value={row.v} max={max} other={row.other !== undefined} width={fit.bar}>{s}</BarCell> : s;
    }
    if (key === 'delta') return <DeltaMark delta={rowDelta(row)} format={(v) => fmtAbs(v, fit.compact)} colored={deltaColor} />;
    return text(row, key, fit.compact);
  };

  return (
    <div className="lab-table-wrap" ref={wrapRef}>
      <table
        className={tableClass(density)}
        data-density={density}
        data-bars={bars ? '' : undefined}
        data-columns={cols.join(',')}
        data-dropped={fit.dropped.length > 0 ? fit.dropped.join(',') : undefined}
        data-compact={fit.compact ? '' : undefined}
        data-fit={fit.fits ? undefined : 'wrap'}
      >
        <thead className="lab-table-head">
          <tr>
            {cols.map((key) => (
              <SortHeader key={key} label={headerFor(key)} colKey={key} numeric={isValue(key)} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={i}
              data-other={row.other !== undefined ? '' : undefined}
              title={rowTitle(rowLabel(row), fit.dropped.map((key) => ({ header: headerFor(key), text: titleText(row, key) })))}
            >
              {cols.map((key) => {
                const content = cell(row, key);
                return (
                  <td key={key} className={isValue(key) ? 'lab-table-num' : 'lab-table-text'} title={!isValue(key) && typeof content === 'string' ? content : undefined}>{content}</td>
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
                  {key === 'v' ? (total.v !== null ? fmtV(total.v, fit.compact) : '')
                    : key === 'n' ? (total.n !== null ? fmtCount(total.n, fit.compact) : '')
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
