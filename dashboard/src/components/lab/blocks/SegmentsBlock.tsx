import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { nextSort, sortRows, toDensity, type TableSort } from '../MetricTable';
import {
  funnelSlice, isSmallKn, orderedNotes, parseSort, segmentRows, selectionKey, unmeasuredColumns,
  type FunnelFrame, type FunnelFrameMetric, type SegmentRow,
} from '../../../generated/frameOps';
import {
  fill, fmtCompact, fmtCount, fmtMetric, fmtMetricDelta, formatRateOrKn, hintLine, minUsersFor, rateAttrs, reasonText,
} from '../explorer/explorerFormat';
import { notMeasuredText, NoteMark, notesByKey } from './BenchmarkBlock';
import { useCompactFit } from './BreakdownBlock';
import { BlockEmpty, boolOption, drawableFrame, numberOption, stringListOption, stringOption, type BlockViewProps } from './blockCommon';
import '../MetricTable.css';
import './dataBlocks.css';
import './segments.css';
import '../explorer/explorer.css';

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

/**
 * The metric columns to fold into one note: no measured row carries a value for them, none has
 * a small-denominator k/n to show instead, and no row says WHY it lacks one (`ownReason`: a
 * segment's own "not measured: ..." is information and keeps its column of dashes). A column of
 * bare "not measured" cells tells the reader nothing a single sentence does not, and the
 * sentence can say how to fill it.
 */
export function foldedColumns(
  rows: readonly SegmentRow[],
  keys: readonly string[],
  ownReason: (row: SegmentRow, key: string) => string | null = () => null,
): string[] {
  return unmeasuredColumns(rows, keys).filter((k) => !rows.some((r) => r.measured && (isSmallKn(r.cells[k]?.kn) || ownReason(r, k) !== null)));
}

/** The snapshot's hint for a folded column: the metric's own, else the axis', else the segments'. */
function columnHint(t: (key: string) => string, frame: FunnelFrame, keys: readonly string[], by: string): string | null {
  for (const k of keys) {
    const h = hintLine(t, frame, `metric:${k}`);
    if (h) return h;
  }
  return hintLine(t, frame, `dim:${by}`) ?? hintLine(t, frame, 'segments');
}

/**
 * The metric columns a table draws, in reading order: a metric that only repeats the Users column
 * (key `users`, or the same figure as each row's users) is dropped; with no `metrics` pick the
 * ladder's stages lead (the funnel's own story, in its order), then the rest as the payload lists
 * them, so a narrow card scrolls only past the least useful columns.
 */
export function segmentColumns(
  keys: readonly string[],
  rows: readonly SegmentRow[],
  ladder: readonly string[] | undefined,
  picked: boolean,
): string[] {
  const duplicate = (k: string) => {
    if (k === 'users') return true;
    const carried = rows.filter((r) => r.measured && r.cells[k] && r.cells[k].v !== null);
    return carried.length > 0 && carried.every((r) => r.cells[k].v === r.users);
  };
  const kept = keys.filter((k) => !duplicate(k));
  if (picked || !ladder || ladder.length === 0) return kept;
  const lead = ladder.filter((k) => kept.includes(k));
  return [...lead, ...kept.filter((k) => !lead.includes(k))];
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
  // Wider than its card: changes move into each figure's title and large figures go short, so the
  // full card shows every column without scrolling; only a narrow card still scrolls.
  const [fitRef, tight] = useCompactFit<HTMLDivElement>('width', `${JSON.stringify(options)}|${selectionKey(selection ?? {})}`);
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
  const askedKeys = picked ? picked.filter((k) => k in levels) : Object.keys(levels);
  const unknown = picked ? picked.filter((k) => !(k in levels)) : [];
  if (unknown.length > 0) notes.push({ key: 'metrics', attr: 'data-lab-unknown-metrics', text: t('lab.blocks.explorer.unknownMetrics').replace('{keys}', unknown.join(', ')) });
  const ignored = slice.ignored.filter((k) => k !== dim.key);
  if (ignored.length > 0) notes.push({ key: 'split', attr: 'data-lab-not-split', text: t('lab.blocks.explorer.notSplit').replace('{dims}', ignored.join(', ')) });

  const bands = boolOption(options, 'bands', true);
  const density = toDensity(options.density);
  const limit = typeof options.limit === 'number' ? numberOption(options, 'limit', 0, 1, 400) : null;
  const sort = userSort === undefined ? segmentsSort(options.sort, askedKeys) : userSort;
  const rows = segmentRows(f, pick, dim.key, sel, askedKeys);
  // Each measured row's OWN metrics (a null cell names the segment's reason, never the funnel level's).
  const ownOf = new Map(rows.map((r) => [r.value, r.measured ? funnelSlice(f, pick, r.selection).metrics : {}] as const));
  const folded = foldedColumns(rows, askedKeys, (r, k) => {
    const m = ownOf.get(r.value)?.[k];
    return m && m.measured === false && m.reason ? m.reason : null;
  });
  const metricKeys = segmentColumns(askedKeys.filter((k) => !folded.includes(k)), rows, f.ladder, !!picked);
  const foldedNote = folded.length > 0 ? {
    text: fill(t('lab.explorer.emptyColumn'), { metric: folded.map((k) => levels[k]?.label ?? k).join(', ') }),
    hint: columnHint(t, f, folded, dim.key),
  } : null;
  const shown = segmentsView(rows, sort, limit);
  const notesOf = notesByKey(orderedNotes(f, slice.funnelId));
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
      {foldedNote && (
        <div className="lab-seg-note lab-seg-folded" data-lab-empty="column" data-metrics={folded.join(',')} role="note">
          <span>{foldedNote.text}</span>
          {foldedNote.hint && <span className="lab-x-empty-hint" data-lab-hint="">{foldedNote.hint}</span>}
        </div>
      )}
      {rows.length === 0 ? <BlockEmpty /> : (
        <div className="lab-table-wrap" ref={fitRef}>
          <table className={`lab-table lab-table--${density} lab-seg-table`} data-density={density} data-bands={bands ? '' : undefined} data-tight={tight ? '' : undefined}>
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
                        <NoteMark markKey={c.key === VALUE_COL ? `dim:${dim.key}` : c.key} notes={notesOf.get(c.key === VALUE_COL ? `dim:${dim.key}` : c.key) ?? []} t={t} />
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
                // An unmeasured row says WHY (the path's own reason, else never pulled / under the floor).
                const why = row.measured ? null : reasonText(
                  t,
                  row.reason,
                  funnelSlice(f, pick, { ...sel, [dim.key]: row.value }).reasonCode,
                  minUsersFor(f, { ...sel, [dim.key]: row.value }),
                );
                const unmeasured = notMeasuredText(t, why);
                // A measured row's null cell is the SEGMENT's own metric (its reason), never the funnel level's.
                const own = ownOf.get(row.value) ?? {};
                const low = row.measured && row.lowSample ? t('lab.blocks.explorer.lowSample').replace('{n}', fmtCount(row.users, locale)) : null;
                return (
                  <tr
                    key={row.value}
                    data-lab-segment-row={row.value}
                    data-lab-low-sample={low ? '' : undefined}
                    data-lab-unmeasured={row.measured ? undefined : ''}
                    data-active={active === row.value ? '' : undefined}
                    title={low ?? (row.measured ? undefined : unmeasured)}
                  >
                    <td className="lab-table-text lab-seg-value" title={row.value}>
                      <span className="lab-seg-value-text">{row.value}</span>
                    </td>
                    <td className="lab-table-num lab-seg-users">
                      {row.measured
                        ? (tight ? fmtCompact(row.users, locale) : fmtCount(row.users, locale))
                        : <Dash reason={unmeasured} />}
                    </td>
                    {!row.measured && metricKeys.length > 0 && (
                      // Every metric of an unmeasured row would be the same dash: one muted line says why instead.
                      <td className="lab-seg-row-why" colSpan={metricKeys.length} data-lab-seg-row-why="">{unmeasured}</td>
                    )}
                    {row.measured && metricKeys.map((k) => {
                      const cell = row.cells[k];
                      const fmtKey = levels[k]?.format ?? 'number';
                      // A small denominator shows its counts, never a rate: unless the metric itself was
                      // declared not measured (a broken denominator has no honest counts either).
                      if (row.measured && cell && isSmallKn(cell.kn) && own[k]?.measured !== false) {
                        const d = formatRateOrKn(cell.v, fmtKey, cell.kn, locale, t);
                        return (
                          <td key={k} className="lab-table-num lab-seg-cell" data-metric={k} {...rateAttrs(d)}>
                            <span className="lab-seg-figure"><span className="lab-seg-v lab-seg-kn">{d.text}</span></span>
                          </td>
                        );
                      }
                      if (!cell || cell.v === null) {
                        const reason = row.measured ? notMeasuredText(t, own[k]?.reason ?? null) : unmeasured;
                        return <td key={k} className="lab-table-num" data-metric={k}><Dash reason={reason} /></td>;
                      }
                      const tone = bands ? cell.tone : null;
                      const delta = cell.prev !== null ? cell.v - cell.prev : null;
                      const value = fmtMetric(cell.v, fmtKey, locale, tight);
                      const deltaText = delta === null ? null : fmtMetricDelta(delta, fmtKey, locale, tight);
                      const titleParts = [
                        tone ? `${value} · ${statusWord(tone)}` : null,
                        tight && deltaText ? t('lab.blocks.benchmark.delta').replace('{delta}', deltaText) : null,
                      ].filter((x): x is string => x !== null);
                      return (
                        <td
                          key={k}
                          className="lab-table-num lab-seg-cell"
                          data-metric={k}
                          data-tone={tone ?? undefined}
                          title={titleParts.length > 0 ? titleParts.join('\n') : undefined}
                        >
                          <span className="lab-seg-figure">
                            {tone && <span className="lab-x-dot" data-tone={tone} aria-hidden="true" />}
                            <span className="lab-seg-v">{value}</span>
                            {deltaText !== null && !tight && <span className="lab-seg-delta" data-lab-seg-delta="">{deltaText}</span>}
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
    <span className="lab-seg-dash" tabIndex={0} role="img" aria-label={reason} data-lab-seg-unmeasured="" title={reason}>
      <span aria-hidden="true">–</span>
      <span className="lab-seg-reason" data-lab-seg-reason="" aria-hidden="true">{reason}</span>
    </span>
  );
}
