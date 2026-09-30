import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { formatNumber } from '../chart';
import { nextSort, sortRows, toDensity, type TableSort } from '../MetricTable';
import { funnelSlice, parseSort, segmentRows, type FunnelFrame, type FunnelFrameMetric, type SegmentRow } from '../../../generated/frameOps';
import { formatMetric, notMeasuredText } from './BenchmarkBlock';
import { BlockEmpty, boolOption, drawableFrame, numberOption, stringListOption, stringOption, type BlockViewProps } from './blockCommon';
import '../MetricTable.css';
import './dataBlocks.css';
import './segments.css';

/** The column keys a segments table sorts by: the dim value, users, or a metric key. */
export const VALUE_COL = '__value';
export const USERS_COL = '__users';

/** The `sort` option as a table sort: `users`, `value` (the dim) or a metric key, `-` for descending. */
export function segmentsSort(option: unknown, metricKeys: readonly string[]): TableSort | null {
  const s = parseSort(option);
  if (!s) return null;
  const key = s.by === 'users' || s.by === 'n' ? USERS_COL : s.by === 'value' || s.by === 'label' ? VALUE_COL : s.by;
  if (key !== USERS_COL && key !== VALUE_COL && !metricKeys.includes(key)) return null;
  return { key, dir: s.dir };
}

/** A row's sort value in a column; unmeasured is null (sorts last), never 0. */
export function segmentSortValue(row: SegmentRow, key: string): number | string | null {
  if (key === VALUE_COL) return row.value;
  if (key === USERS_COL) return row.measured ? row.users : null;
  return row.cells[key]?.v ?? null;
}

/** The segments view: rows sorted then limited (`limit` counts rows after the sort). */
export function segmentsView(rows: readonly SegmentRow[], sort: TableSort | null, limit: number | null): SegmentRow[] {
  const sorted = sortRows(rows, sort, segmentSortValue);
  return limit !== null ? sorted.slice(0, limit) : sorted;
}

/** The dim to split by: the option's (visibly refused when unknown), else the first declared dim. */
function pickDim(frame: FunnelFrame, by: string | null): { key: string; label: string } | { missing: string } {
  const dims = frame.dimensions ?? [];
  if (by) {
    const d = dims.find((x) => x.key === by);
    return d ? d : { missing: by };
  }
  return dims[0] ?? { missing: '' };
}

/**
 * `segments`: one row per value of the `by` dim, each the exact slice of that
 * value under the card's selection on the other axes (frameOps segmentRows),
 * with users and a column per metric. `bands` washes a figure in its band tone
 * (tinted surface, text stays body ink); a low-sample row is faded; an
 * unmeasured cell is a dash with its reason on hover and focus, never a 0.
 * Headers sort (the `sort` option is the starting order), `limit` keeps the
 * top rows, `density` sets the rhythm. The table scrolls in its cell with a
 * sticky header; the notes above it do not.
 */
export function SegmentsBlock({ frame, options, selection }: BlockViewProps) {
  const { t, locale } = useI18n();
  const [userSort, setUserSort] = useState<TableSort | null | undefined>(undefined);
  const drawable = drawableFrame(frame, ['funnel'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const f = drawable.frame;
  if (f.funnels.length === 0) return <BlockEmpty />;
  const sel = selection ?? {};
  const pick = stringOption(options, 'funnel');
  const dim = pickDim(f, stringOption(options, 'by'));
  const slice = funnelSlice(f, pick, sel);
  const notes: { key: string; text: string; attr: string }[] = [];
  if (pick && slice.funnelId !== pick) {
    notes.push({ key: 'funnel', attr: 'data-lab-unknown-funnel', text: t('lab.blocks.explorer.unknownFunnel').replace('{id}', pick).replace('{name}', slice.funnelName) });
  }
  if ('missing' in dim) {
    return (
      <div className="lab-block-table lab-seg" data-lab-segments="">
        {notes.map((n) => <div key={n.key} className="lab-seg-note" {...{ [n.attr]: '' }}>{n.text}</div>)}
        <div className="lab-seg-note" data-lab-segments-nodim="">{t('lab.blocks.segments.noDim').replace('{by}', dim.missing)}</div>
      </div>
    );
  }

  const levels: Record<string, FunnelFrameMetric> = f.funnels.find((x) => x.id === slice.funnelId)?.metrics ?? {};
  const picked = stringListOption(options, 'metrics');
  const metricKeys = picked ? picked.filter((k) => k in levels) : Object.keys(levels);
  const unknown = picked ? picked.filter((k) => !(k in levels)) : [];
  if (unknown.length > 0) notes.push({ key: 'metrics', attr: 'data-lab-unknown-metrics', text: t('lab.blocks.explorer.unknownMetrics').replace('{keys}', unknown.join(', ')) });
  const ignored = slice.ignored.filter((k) => k !== dim.key);
  if (ignored.length > 0) notes.push({ key: 'split', attr: 'data-lab-not-split', text: t('lab.blocks.explorer.notSplit').replace('{dims}', ignored.join(', ')) });

  const bands = boolOption(options, 'bands', true);
  const density = toDensity(options.density);
  const limit = typeof options.limit === 'number' ? numberOption(options, 'limit', 0, 1, 400) : null;
  const sort = userSort === undefined ? segmentsSort(options.sort, metricKeys) : userSort;
  const rows = segmentRows(f, pick, dim.key, sel, metricKeys);
  const shown = segmentsView(rows, sort, limit);
  const active = sel[dim.key] ?? null;
  const onSort = (key: string, numeric: boolean) => setUserSort(nextSort(sort, key, numeric));

  const statusWord = (tone: string | null) => (tone ? t(`lab.blocks.benchmark.status.${tone}`) : '');
  const columns: { key: string; label: string; numeric: boolean }[] = [
    { key: VALUE_COL, label: dim.label, numeric: false },
    { key: USERS_COL, label: t('lab.blocks.segments.users'), numeric: true },
    ...metricKeys.map((k) => ({ key: k, label: levels[k]?.label ?? k, numeric: true })),
  ];

  return (
    <div className="lab-block-table lab-seg" data-lab-segments="" data-by={dim.key}>
      {notes.map((n) => <div key={n.key} className="lab-seg-note" {...{ [n.attr]: '' }}>{n.text}</div>)}
      {rows.length === 0 ? <BlockEmpty /> : (
        <div className="lab-table-wrap">
          <table className={`lab-table lab-table--${density} lab-seg-table`} data-density={density} data-bands={bands ? '' : undefined}>
            <thead className="lab-table-head">
              <tr>
                {columns.map((c) => {
                  const state = sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
                  return (
                    <th key={c.key} scope="col" aria-sort={state} data-col={c.key} className={c.numeric ? 'lab-table-num' : undefined}>
                      <button
                        type="button"
                        className="lab-table-sort"
                        data-sorted={state === 'none' ? undefined : state}
                        onClick={(e) => { e.stopPropagation(); onSort(c.key, c.numeric); }}
                      >
                        <span className="lab-table-sort-label">{c.label}</span>
                        <svg className="lab-table-sort-icon" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
                          {state === 'ascending' ? <path d="M5 2 9 8H1z" /> : state === 'descending' ? <path d="M5 8 1 2h8z" /> : <path d="M5 1 8 4H2zM5 9 2 6h6z" />}
                        </svg>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const unmeasured = notMeasuredText(t, row.reason);
                // A measured row's null cell is the SEGMENT's own metric (its reason), never the funnel level's.
                const own = row.measured ? funnelSlice(f, pick, row.selection).metrics : {};
                const low = row.measured && row.lowSample ? t('lab.blocks.explorer.lowSample').replace('{n}', formatNumber(row.users, { maxDecimals: 0, locale })) : null;
                return (
                  <tr
                    key={row.value}
                    data-lab-segment-row={row.value}
                    data-lab-low-sample={low ? '' : undefined}
                    data-lab-unmeasured={row.measured ? undefined : ''}
                    data-active={active === row.value ? '' : undefined}
                    title={low ?? undefined}
                  >
                    <td className="lab-table-text lab-seg-value">
                      <span className="lab-seg-value-text">{row.value}</span>
                    </td>
                    <td className="lab-table-num">
                      {row.measured
                        ? formatNumber(row.users, { format: 'auto', maxDecimals: 0, locale })
                        : <Dash reason={unmeasured} />}
                    </td>
                    {metricKeys.map((k) => {
                      const cell = row.cells[k];
                      const fmtKey = levels[k]?.format ?? 'number';
                      if (!cell || cell.v === null) {
                        const reason = row.measured ? notMeasuredText(t, own[k]?.reason ?? null) : unmeasured;
                        return <td key={k} className="lab-table-num" data-metric={k}><Dash reason={reason} /></td>;
                      }
                      const tone = bands ? cell.tone : null;
                      const delta = cell.prev !== null ? cell.v - cell.prev : null;
                      const value = formatMetric(cell.v, fmtKey, locale);
                      return (
                        <td
                          key={k}
                          className="lab-table-num lab-seg-cell"
                          data-metric={k}
                          data-tone={tone ?? undefined}
                          title={tone ? `${value} · ${statusWord(tone)}` : undefined}
                        >
                          <span className="lab-seg-figure">
                            <span className="lab-seg-v">{value}</span>
                            {delta !== null && <span className="lab-seg-delta" data-lab-seg-delta="">{formatMetric(delta, fmtKey, locale, true)}</span>}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** An unmeasured cell: a dash (never a 0) whose reason shows on hover and on keyboard focus. */
function Dash({ reason }: { reason: string }) {
  return (
    <span className="lab-seg-dash" tabIndex={0} role="img" aria-label={reason} data-lab-seg-unmeasured="">
      <span aria-hidden="true">–</span>
      <span className="lab-seg-reason" data-lab-seg-reason="" aria-hidden="true">{reason}</span>
    </span>
  );
}
