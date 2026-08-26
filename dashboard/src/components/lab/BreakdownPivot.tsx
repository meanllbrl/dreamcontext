import { useMemo, useState } from 'react';
import { toBarRows } from './barRows';
import { BarList } from './BarList';
import { CHART_COLORS } from './chartColors';
import { ChartEmpty, formatValue, type ChartBodyProps } from './chartBody';
import {
  cellPrev,
  dimLabel,
  dimValues,
  heatFrac,
  isLowSample,
  pickPreviousSnapshot,
  pivotCell,
  pivotToMarkdown,
  LOW_SAMPLE_THRESHOLD,
  type MatrixCacheEntry,
  type MatrixSet,
  type MatrixSnapshot,
} from './matrixModel';

/**
 * `breakdown` render — the pivot over a `matrix/v1` payload (cache.matrix).
 *
 * 1 dim → the shared BarList (same rows/ranking the bar and pie renders use).
 * 2 dims → a pivot table: rows = dims[0], columns = dims[1], each cell value +
 * heat tint (`--chart-1` via color-mix — a token, so themes repaint it) and an
 * `n` chip. A 3rd dim becomes filter chips. Cells with n < 30 render
 * de-emphasized (funnel F4 idiom): rates on a handful of users are noise.
 *
 * The detail body adds dim swap, per-column sorting, Δ vs the previous
 * comparable snapshot (adapter `prev` wins; else the equal-window guarded
 * history entry — no Δ beats a fake Δ), and copy-as-Markdown.
 *
 * Legacy Series[] payloads under `render: breakdown` (no cache.matrix) degrade
 * to the compact bar list, mirroring the funnel card's legacy fallback.
 */

const CELL: React.CSSProperties = {
  padding: '5px 10px',
  textAlign: 'right',
  fontFamily: 'var(--font-mono)',
  whiteSpace: 'nowrap',
  fontSize: 12,
};

function heatBackground(frac: number): string | undefined {
  if (frac <= 0) return undefined;
  // 4%..28% of the first chart token — visible tint, text stays readable.
  const pct = Math.round(4 + frac * 24);
  return `color-mix(in srgb, var(--chart-1) ${pct}%, transparent)`;
}

function deltaChip(v: number | null, prev: number | null): React.ReactNode {
  if (v === null || prev === null) return null;
  const delta = v - prev;
  if (delta === 0) return null;
  const color = delta > 0 ? 'var(--color-success)' : 'var(--color-error)';
  return (
    <span style={{ display: 'block', fontSize: 9.5, fontWeight: 600, color }}>
      {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toLocaleString()}
    </span>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '3px 9px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
    border: '1px solid var(--color-border)',
    background: active ? 'var(--color-accent-soft)' : 'transparent',
    color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
  };
}

/** The one-dim view: pivot rows through the SHARED BarList (bar/pie's renderer). */
function OneDimBars({ set, unit, full }: { set: MatrixSet; unit: string | null; full: boolean }) {
  const dim = set.dims[0];
  const values = dimValues(set, dim.key);
  const rows = values
    .map((value, i) => ({ value, cell: pivotCell(set, { [dim.key]: value }), i }))
    .filter((r) => r.cell.v !== null && r.cell.v > 0);
  const total = rows.reduce((a, r) => a + (r.cell.v ?? 0), 0);
  if (total <= 0) return <ChartEmpty hint="No positive values to draw." />;
  return (
    <BarList
      rows={rows.map((r) => ({
        name: r.value,
        value: r.cell.v ?? 0,
        frac: (r.cell.v ?? 0) / total,
        color: CHART_COLORS[r.i % CHART_COLORS.length],
      }))}
      unit={unit}
      full={full}
    />
  );
}

interface PivotTableProps {
  set: MatrixSet;
  rowDim: string;
  colDim: string;
  filter: Record<string, string>;
  prevSnapshot: MatrixSnapshot | null;
  /** Detail only — the card stays a thumbnail. */
  showDeltas: boolean;
  sort: { col: string | null; dir: 'asc' | 'desc' } | null;
  onSort?: (col: string | null) => void;
  unit: string | null;
}

function PivotTable({ set, rowDim, colDim, filter, prevSnapshot, showDeltas, sort, onSort, unit }: PivotTableProps) {
  const rowValues = dimValues(set, rowDim);
  const colValues = dimValues(set, colDim);

  // Materialize every cell once — heat needs the visible max, sort needs columns.
  const grid = rowValues.map((rowValue) => ({
    rowValue,
    cells: colValues.map((colValue) => {
      const coords = { ...filter, [rowDim]: rowValue, [colDim]: colValue };
      const cell = pivotCell(set, coords);
      return { colValue, coords, cell };
    }),
  }));
  const max = Math.max(0, ...grid.flatMap((r) => r.cells.map((c) => c.cell.v ?? 0)));

  const sorted = sort === null ? grid : [...grid].sort((a, b) => {
    const pick = (row: typeof a): number | string => {
      if (sort.col === null) return row.rowValue;
      const cell = row.cells.find((c) => c.colValue === sort.col)?.cell;
      return cell?.v ?? -Infinity;
    };
    const av = pick(a); const bv = pick(b);
    const cmp = typeof av === 'string' || typeof bv === 'string'
      ? String(av).localeCompare(String(bv))
      : av - bv;
    return sort.dir === 'desc' ? -cmp : cmp;
  });

  const header = (label: string, col: string | null) => (
    <th key={col ?? '@row'} scope="col" style={{ padding: 0, textAlign: col === null ? 'left' : 'right' }}>
      {onSort ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSort(col); }}
          style={{
            width: '100%', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit',
            padding: '6px 10px', fontWeight: 600, textAlign: col === null ? 'left' : 'right',
            color: sort?.col === col ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          }}
          title="Sort by this column"
        >
          {label}{sort?.col === col ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
        </button>
      ) : (
        <span style={{ display: 'block', padding: '6px 10px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>{label}</span>
      )}
    </th>
  );

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ background: 'var(--color-bg-tertiary)' }}>
            {header(dimLabel(set.dims.find((d) => d.key === rowDim) ?? { key: rowDim }), null)}
            {colValues.map((colValue) => header(colValue, colValue))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ rowValue, cells }) => (
            <tr key={rowValue} style={{ borderTop: '1px solid var(--color-border)' }}>
              <td style={{ padding: '5px 10px', color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }} title={rowValue}>
                {rowValue}
              </td>
              {cells.map(({ colValue, coords, cell }) => {
                const low = isLowSample(cell);
                const prev = showDeltas ? cellPrev(cell, prevSnapshot, coords) : null;
                return (
                  <td
                    key={colValue}
                    style={{
                      ...CELL,
                      background: heatBackground(heatFrac(cell.v, max)),
                      opacity: low ? 0.45 : 1,
                      color: 'var(--color-text)',
                    }}
                    title={low ? `n=${cell.n} — below the low-sample threshold (${LOW_SAMPLE_THRESHOLD}); treat as noise, not signal.` : undefined}
                  >
                    {cell.v === null ? <span style={{ color: 'var(--color-text-tertiary)' }}>—</span> : formatValue(cell.v, unit)}
                    {cell.n !== null && (
                      <span style={{ display: 'block', fontSize: 9.5, color: 'var(--color-text-tertiary)' }}>n={cell.n.toLocaleString()}</span>
                    )}
                    {deltaChip(cell.v, prev)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BreakdownView({ matrix, matrixHistory, fetchedAt, unit, full, pivot }: {
  matrix: MatrixCacheEntry;
  matrixHistory: MatrixSnapshot[] | undefined;
  fetchedAt: string;
  unit: string | null;
  full: boolean;
  pivot?: ChartBodyProps['pivot'];
}) {
  const { set } = matrix;
  // Dim swap (detail): pivot axes in declared order until the user flips them.
  // A caller may ask to START swapped — `pivot.rows` naming the SECOND declared dim is the
  // only thing that can mean "put that on the rows axis", since the axes are the dims. An
  // unrecognised name is ignored rather than erroring: it degrades to the declared order,
  // which is a correct pivot, just not the requested one.
  const [swapped, setSwapped] = useState(
    () => !!pivot?.rows && set.dims.length > 1 && pivot.rows === set.dims[1].key,
  );
  const [sort, setSort] = useState<{ col: string | null; dir: 'asc' | 'desc' } | null>(null);
  const [filterValue, setFilterValue] = useState<string | null>(
    () => (set.dims[2] && pivot?.filter ? pivot.filter[set.dims[2].key] ?? null : null),
  );
  const [copied, setCopied] = useState(false);

  const effectiveUnit = set.unit ?? unit;
  const [dim1, dim2, dim3] = set.dims;
  const rowDim = swapped && dim2 ? dim2.key : dim1.key;
  const colDim = swapped && dim2 ? dim1.key : dim2?.key;

  const filter: Record<string, string> = {};
  if (dim3 && filterValue) filter[dim3.key] = filterValue;

  const prevSnapshot = useMemo(
    () => (full ? pickPreviousSnapshot({ at: fetchedAt, range: matrix.range }, matrixHistory) : null),
    [full, fetchedAt, matrix.range, matrixHistory],
  );

  const toggleSort = (col: string | null) => {
    setSort((current) => (current?.col === col && current.dir === 'desc'
      ? { col, dir: 'asc' }
      : { col, dir: 'desc' }));
  };

  const copyMarkdown = async () => {
    const md = pivotToMarkdown(set, colDim
      ? { rowDim, colDim, filter: dim3 && filterValue ? filter : undefined }
      : { rowDim });
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard denied — the button simply doesn't confirm */ }
  };

  return (
    <div>
      {(dim3 || (full && dim2)) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          {dim3 && (
            <>
              <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{dimLabel(dim3)}:</span>
              <button style={chipStyle(filterValue === null)} onClick={() => setFilterValue(null)}>All</button>
              {dimValues(set, dim3.key).map((value) => (
                <button key={value} style={chipStyle(filterValue === value)} onClick={() => setFilterValue(value)}>
                  {value}
                </button>
              ))}
            </>
          )}
          {full && dim2 && (
            <>
              <span style={{ flex: 1 }} />
              <button style={chipStyle(false)} onClick={() => setSwapped((s) => !s)} title="Swap pivot rows and columns">
                ⇄ swap dims
              </button>
              <button style={chipStyle(copied)} onClick={copyMarkdown} title="Copy the visible pivot as a Markdown table">
                {copied ? '✓ copied' : 'copy as Markdown'}
              </button>
            </>
          )}
        </div>
      )}

      {colDim ? (
        <PivotTable
          set={set}
          rowDim={rowDim}
          colDim={colDim}
          filter={filter}
          prevSnapshot={prevSnapshot}
          showDeltas={full}
          sort={full ? sort : null}
          onSort={full ? toggleSort : undefined}
          unit={effectiveUnit}
        />
      ) : (
        <OneDimBars set={set} unit={effectiveUnit} full={full} />
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8, fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
        {set.total && set.total.v !== null && (
          <span>Total: <strong style={{ color: 'var(--color-text)' }}>{formatValue(set.total.v, effectiveUnit)}</strong></span>
        )}
        {full && prevSnapshot && (
          <span title="Δ chips compare against this snapshot (equal-length window).">
            Δ vs {prevSnapshot.range.fromISO} → {prevSnapshot.range.toISO}
          </span>
        )}
      </div>
      {full && matrix.notices.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--color-warning, var(--color-text-tertiary))' }}>
          {matrix.notices.map((notice, i) => <div key={i}>⚠ {notice}</div>)}
        </div>
      )}
    </div>
  );
}

/** Registry body (`breakdown`). Chips/sort/copy are the body's own affordances,
 *  so it swallows clicks that would otherwise open the card's detail panel. */
export function BreakdownBody({ summary, cache, series, full = false, emptyHint, pivot }: ChartBodyProps) {
  if (!cache?.matrix) {
    // Legacy Series[] under render:breakdown — the funnel card's fallback idiom.
    const rows = toBarRows(series);
    if (rows.length === 0) return <ChartEmpty hint={emptyHint} />;
    return <BarList rows={rows} unit={summary.unit} full={full} />;
  }
  return (
    <div onClick={full ? undefined : (e) => e.stopPropagation()}>
      <BreakdownView
        matrix={cache.matrix}
        matrixHistory={cache.matrixHistory}
        fetchedAt={cache.fetchedAt}
        unit={summary.unit}
        full={full}
        pivot={pivot}
      />
    </div>
  );
}
