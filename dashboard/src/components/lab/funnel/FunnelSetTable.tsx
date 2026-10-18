import { useEffect, useId, useState, type ReactNode } from 'react';
import { pushOverlay, popOverlay } from '../../../lib/overlayStack';
import { FilterPopover } from '../../tasks/FilterPopover';
import {
  benchmarkClass,
  formatDelta,
  formatMetricValue,
  isLowSample,
  overviewCellPrev,
  overviewCellValue,
  type FunnelDef,
  type FunnelPrev,
  type FunnelSet,
  type FunnelViewState,
  type OverviewColumn,
  type OverviewColumnKind,
} from './funnelModel';
import './FunnelOverviewPage.css';

/**
 * The all-funnels comparison table: one row per funnel, the chosen columns, stable sort, Δ chips,
 * low-sample de-emphasis and benchmark marks. Drawn by the funnel overview page (`render: funnel`)
 * and by a funnel block's `table` layout (the explorer's Table tab), so both read one table.
 */

/** Every word the table and its column picker put on screen. */
export interface FunnelTableCopy {
  funnel: string;
  selectForCompare: string;
  rowActions: string;
  open: (name: string) => string;
  lowSample: string;
  lowSampleTitle: (n: number) => string;
  noiseTitle: (n: number) => string;
  deltaTitle: (now: string, prev: string) => string;
  columns: string;
  columnsTitle: string;
  reset: string;
  groups: Record<OverviewColumnKind, string>;
}

/** The overview page's copy (English, as it has always read). */
export const FUNNEL_TABLE_EN: FunnelTableCopy = {
  funnel: 'Funnel',
  selectForCompare: 'Select for compare',
  rowActions: 'Row actions',
  open: (name) => `Open funnel ${name}`,
  lowSample: 'low sample',
  lowSampleTitle: (n) => `Below the low-sample threshold — rates on n=${n} are noise, not signal.`,
  noiseTitle: (n) => `n=${n} — below the sample threshold; treat this rate as noise`,
  deltaTitle: (now, prev) => `${now} now vs ${prev} previous period`,
  columns: 'Columns',
  columnsTitle: 'Choose which columns the table shows',
  reset: 'Reset',
  groups: { metric: 'Metrics', conversion: 'Step conversion', of_top: '% of top' },
};

/** Rows in `sort` order (stable; nulls last whatever the direction); unsorted = as given. */
export function sortFunnels(
  funnels: readonly FunnelDef[],
  sort: FunnelViewState['sort'],
  colByKey: ReadonlyMap<string, OverviewColumn>,
): FunnelDef[] {
  if (!sort) return [...funnels];
  const { key, dir } = sort;
  // Sorts on ANY column, derived ones included — one lookup, so a new column
  // kind never needs a new sort branch. Unknown key (a stale deep link) → null.
  const col = colByKey.get(key);
  const value = (f: FunnelDef): number | string | null =>
    key === 'name' ? f.name : col ? overviewCellValue(f, col) : null;
  return funnels
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const va = value(a.f);
      const vb = value(b.f);
      let cmp = 0;
      if (va === null && vb === null) cmp = 0;
      else if (va === null) cmp = 1; // nulls last regardless of direction
      else if (vb === null) cmp = -1;
      else if (typeof va === 'string' || typeof vb === 'string') cmp = String(va).localeCompare(String(vb)) * (dir === 'desc' ? -1 : 1);
      else cmp = (va - vb) * (dir === 'desc' ? -1 : 1);
      return cmp !== 0 ? cmp : a.i - b.i; // stable
    })
    .map((e) => e.f);
}

/** The next sort after a header click: desc, asc, off. */
export function nextSort(sort: FunnelViewState['sort'], key: string): FunnelViewState['sort'] {
  if (sort?.key !== key) return { key, dir: 'desc' };
  if (sort.dir === 'desc') return { key, dir: 'asc' };
  return null;
}

export function FunnelSetTable({
  set, prev, rows, cols, sort, onSort, onOpen, copy, unfiltered = false, picked = null, select, rowMenu,
}: {
  set: FunnelSet;
  prev: FunnelPrev | null;
  rows: readonly FunnelDef[];
  cols: readonly OverviewColumn[];
  sort: FunnelViewState['sort'];
  onSort: (key: string) => void;
  onOpen: (id: string) => void;
  copy: FunnelTableCopy;
  /** Client filters are on: the payload's totals are dimmed as unfiltered. */
  unfiltered?: boolean;
  /** The funnel the surrounding view has picked (marked as the current row). */
  picked?: string | null;
  /** Row checkboxes that pick funnels for compare. */
  select?: { selected: readonly string[]; max: number; onToggle: (id: string) => void };
  /** A per-row actions cell (the overview's kebab). */
  rowMenu?: (funnel: FunnelDef) => ReactNode;
}) {
  return (
    <div className="funnel-ovw-tablewrap">
      <table className="funnel-ovw-table">
        <thead>
          <tr>
            {select && <th className="funnel-ovw-th-check" scope="col"><span className="sr-only">{copy.selectForCompare}</span></th>}
            <SortableTh label={copy.funnel} sortKey="name" sort={sort} onSort={onSort} />
            {cols.map((c) => <SortableTh key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={onSort} numeric />)}
            {rowMenu && <th className="funnel-ovw-th-kebab" scope="col"><span className="sr-only">{copy.rowActions}</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((funnel) => {
            const low = isLowSample(funnel, set);
            const current = picked === funnel.id;
            return (
              <tr
                key={funnel.id}
                className={`funnel-ovw-row${low ? ' funnel-ovw-row--low' : ''}${current ? ' funnel-ovw-row--picked' : ''}`}
                tabIndex={0}
                onClick={() => onOpen(funnel.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') onOpen(funnel.id); }}
                aria-label={copy.open(funnel.name)}
                aria-current={current ? 'true' : undefined}
                data-funnel-row={funnel.id}
              >
                {select && (
                  <td className="funnel-ovw-td-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={select.selected.includes(funnel.id)}
                      disabled={!select.selected.includes(funnel.id) && select.selected.length >= select.max}
                      onChange={() => select.onToggle(funnel.id)}
                      onKeyDown={(e) => e.stopPropagation()}
                      aria-label={`Select ${funnel.name} for compare`}
                    />
                  </td>
                )}
                <td className="funnel-ovw-td-name">
                  <span className="funnel-ovw-name">{funnel.name}</span>
                  <span className="funnel-ovw-id">#{funnel.id}</span>
                  {low && (
                    <span className="funnel-ovw-lowchip" title={copy.lowSampleTitle(funnel.steps[0]?.users ?? 0)}>
                      {copy.lowSample}
                    </span>
                  )}
                </td>
                {cols.map((c) => {
                  const v = overviewCellValue(funnel, c);
                  const p = overviewCellPrev(funnel, c, prev);
                  // Benchmarks are declared per PAYLOAD metric key; a derived
                  // column has no benchmark to be measured against.
                  const bench = c.kind === 'metric' ? benchmarkClass(v, set.benchmarks?.[c.key]) : null;
                  // The F4 rule reaches derived rates too — a conversion on a
                  // tiny cohort is noise no matter who computed it.
                  const deEmph = low && c.format === 'pct';
                  return (
                    <td
                      key={c.key}
                      className={[
                        'funnel-ovw-td-num',
                        unfiltered ? 'funnel-ovw-cell--unfiltered' : '',
                        deEmph ? 'funnel-ovw-cell--low' : '',
                        bench === 'below-floor' ? 'funnel-ovw-cell--floor' : '',
                        bench === 'at-target' ? 'funnel-ovw-cell--target' : '',
                      ].filter(Boolean).join(' ')}
                      title={deEmph ? copy.noiseTitle(funnel.steps[0]?.users ?? 0) : undefined}
                    >
                      {formatMetricValue(v, c.format)}
                      {v !== null && p !== null && (
                        <DeltaChip current={v} prev={p} format={c.format} copy={copy} />
                      )}
                    </td>
                  );
                })}
                {rowMenu && (
                  <td className="funnel-ovw-td-kebab" onClick={(e) => e.stopPropagation()}>
                    {rowMenu(funnel)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortableTh({ label, sortKey, sort, onSort, numeric = false }: {
  label: string;
  sortKey: string;
  sort: FunnelViewState['sort'];
  onSort: (key: string) => void;
  numeric?: boolean;
}) {
  const active = sort?.key === sortKey;
  const dir = active ? sort!.dir : null;
  return (
    <th
      scope="col"
      className={numeric ? 'funnel-ovw-th-num' : undefined}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button className={`funnel-ovw-sort${active ? ' funnel-ovw-sort--on' : ''}`} onClick={() => onSort(sortKey)}>
        {label}
        <span className="funnel-ovw-sort-arrow" aria-hidden>{dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : ''}</span>
      </button>
    </th>
  );
}

/** Popover section order — the picker groups by column kind so a 60-step funnel
 *  stays navigable instead of listing 120 undifferentiated checkboxes. */
const COLUMN_GROUPS: OverviewColumnKind[] = ['metric', 'conversion', 'of_top'];

/**
 * The Columns popover (FilterPopover idiom, same as RangeControl): every
 * available column as a checkbox, grouped and scrolled, plus a Reset to the
 * payload's metric columns. Toggling is instant — the parent owns the selection.
 */
export function ColumnPicker({ available, visibleKeys, isDefault, onToggle, onReset, copy }: {
  available: OverviewColumn[];
  visibleKeys: string[];
  isDefault: boolean;
  onToggle: (key: string) => void;
  onReset: () => void;
  copy: FunnelTableCopy;
}) {
  const [open, setOpen] = useState(false);
  const overlayId = `funnel-columns-${useId()}`;
  const visible = new Set(visibleKeys);

  // While open the popover OWNS Escape (overlayStack) — the same reason
  // RangeControl registers: Esc must close the picker, not the surface under it.
  useEffect(() => {
    if (!open) return;
    pushOverlay(overlayId);
    return () => popOverlay(overlayId);
  }, [open, overlayId]);

  const trigger = (
    <button
      type="button"
      className={`funnel-ovw-action funnel-ovw-colbtn${open ? ' funnel-ovw-colbtn--open' : ''}`}
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-haspopup="dialog"
      title={copy.columnsTitle}
    >
      {copy.columns} <span className="funnel-ovw-colcount">{visibleKeys.length}</span>
    </button>
  );

  const content = (
    <div className="funnel-ovw-colpick">
      <div className="funnel-ovw-colpick-head">
        <span>{copy.columns}</span>
        <button type="button" className="funnel-ovw-colpick-reset" onClick={onReset} disabled={isDefault}>
          {copy.reset}
        </button>
      </div>
      <div className="funnel-ovw-colpick-list">
        {COLUMN_GROUPS.map((kind) => {
          const group = available.filter((c) => c.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className="funnel-ovw-colpick-group">
              <div className="funnel-ovw-colpick-grouphead">{copy.groups[kind]}</div>
              {group.map((c) => (
                <label key={c.key} className="funnel-ovw-colpick-row">
                  <input type="checkbox" checked={visible.has(c.key)} onChange={() => onToggle(c.key)} />
                  <span className="funnel-ovw-colpick-label">{c.label}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <FilterPopover
      trigger={trigger}
      content={content}
      isOpen={open}
      onClose={() => setOpen(false)}
      align="right"
      width={300}
    />
  );
}

function DeltaChip({ current, prev, format, copy }: {
  current: number;
  prev: number;
  format: Parameters<typeof formatDelta>[2];
  copy: FunnelTableCopy;
}) {
  const delta = formatDelta(current, prev, format);
  return (
    <span
      className={`funnel-delta funnel-delta--${delta.direction}`}
      title={copy.deltaTitle(formatMetricValue(current, format), formatMetricValue(prev, format))}
    >{delta.text}</span>
  );
}
