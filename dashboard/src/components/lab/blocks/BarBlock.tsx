import { useMemo } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { Frame } from '../../../generated/frameOps';
import { BarChart } from '../BarChart';
import { otherLabel, type BarCategory, type BarModel, type BarSeries } from '../BarList';
import { toChartFormat, toLegendPosition } from '../chart';
import { BlockEmpty, boolOption, drawableFrame, numberOption, type BlockViewProps } from './blockCommon';
import { rowLabel } from './frameAdapters';

/**
 * `bar`: values side by side, on the shared BarPlot. Every option passes
 * through: `orientation` (h rows, v columns), `sort` (missing = rank by value,
 * `none` = the frame's order, `desc`/`asc` by value, a column sort = the
 * order frameOps already gave the rows), `topN` (its Other bar is grey and
 * last), `group` (a two-dim table's series grouped or stacked),
 * `comparePrev` (each bar's previous value as a recessive paired bar, delta in
 * the tooltip), `valueLabels`, `color`, `format`, `axes`, `grid`, `legend`.
 * The chart fills the cell and never scrolls.
 */

export type BarSortMode = 'rank' | 'desc' | 'asc' | 'none';

/** The block `sort` as a bar order: missing = today's ranking; a non-value column = keep the frame's order. */
export function barSortMode(v: unknown): BarSortMode {
  if (v === undefined || v === null || v === '') return 'rank';
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 'rank';
    if (s === 'desc' || s === '-v') return 'desc';
    if (s === 'asc' || s === 'v') return 'asc';
    return 'none';
  }
  if (typeof v === 'object' && (v as { by?: unknown }).by === 'v') return (v as { dir?: unknown }).dir === 'desc' ? 'desc' : 'asc';
  return 'none';
}

/** Category order for `mode` by each category's total; an Other bucket always stays last. */
export function orderCategories(totals: readonly number[], other: readonly boolean[], mode: BarSortMode): number[] {
  const idx = totals.map((_, i) => i);
  if (mode === 'none') return [...idx.filter((i) => !other[i]), ...idx.filter((i) => other[i])];
  const sign = mode === 'asc' ? 1 : -1;
  return idx.sort((a, b) => Number(other[a]) - Number(other[b]) || sign * (totals[a] - totals[b]) || a - b);
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A shaped frame as the BarModel the block draws. Series: one bar per series
 * at its latest point (the previous point is its comparePrev). A one-dim table:
 * one bar per row (`prev` is its comparePrev). Exactly two dims where every
 * (first, second) pair is unique: the first dim across, one series per
 * second-dim value, grouped or stacked. Anything else (3+ dims, or repeated
 * pairs) keeps one bar per row labelled with every dim joined: a value is never
 * summed, because a rate, an average or a share does not add up.
 */

/** Can this table pivot without combining rows? Two dims, each (first, second) pair once. */
export function pivotsCleanly(rows: readonly { d: Record<string, string> }[], dims: readonly { key: string }[]): boolean {
  if (dims.length !== 2) return false;
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.d[dims[0].key] ?? ''}\u0000${r.d[dims[1].key] ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}
export function barModelFromFrame(frame: Frame, mode: BarSortMode, other: (n: number | null | undefined) => string): BarModel {
  let cats: BarCategory[] = [];
  let series: BarSeries[] = [];
  if (frame.kind === 'series') {
    const kept = frame.series.filter((s) => s.points.some((p) => num(p.v)));
    cats = kept.map((s) => ({ key: s.name, label: s.other ? other(s.other) : s.name, other: !!s.other }));
    const latest = kept.map((s) => {
      const pts = s.points.filter((p) => num(p.v));
      return { v: pts[pts.length - 1]?.v ?? null, p: pts.length >= 2 ? pts[pts.length - 2].v : null };
    });
    series = [{ id: 'value', label: frame.insight, values: latest.map((x) => x.v), prev: latest.map((x) => x.p) }];
  } else if (frame.kind === 'table') {
    const rows = frame.rows.filter((r) => num(r.v) || num(r.prev));
    if (pivotsCleanly(rows, frame.dims)) {
      const [xDim, sDim] = frame.dims;
      const catKeys: string[] = [];
      const serKeys: string[] = [];
      const catOther = new Map<string, number>();
      const cell = new Map<string, { v: number | null; p: number | null }>();
      for (const r of rows) {
        const x = r.d[xDim.key] ?? '';
        const s = r.d[sDim.key] ?? '';
        if (!catKeys.includes(x)) catKeys.push(x);
        if (!serKeys.includes(s)) serKeys.push(s);
        if (r.other) catOther.set(x, r.other);
        const k = `${x}\u0000${s}`;
        const c = cell.get(k) ?? { v: null, p: null };
        // Each pair is unique (pivotsCleanly): the cell IS the row's value, never a sum.
        if (num(r.v)) c.v = r.v;
        if (num(r.prev)) c.p = r.prev;
        cell.set(k, c);
      }
      cats = catKeys.map((k) => ({ key: k, label: catOther.has(k) ? other(catOther.get(k)) : k, other: catOther.has(k) }));
      // The topN Other row names every dim `Other`: its series is Other only when nothing else feeds it.
      const otherOnly = (s: string) => rows.some((r) => r.other && (r.d[sDim.key] ?? '') === s)
        && rows.every((r) => (r.d[sDim.key] ?? '') !== s || !!r.other);
      series = serKeys.map((s) => ({
        id: s,
        label: otherOnly(s) ? other(null) : s,
        other: otherOnly(s),
        values: catKeys.map((x) => cell.get(`${x}\u0000${s}`)?.v ?? null),
        prev: catKeys.map((x) => cell.get(`${x}\u0000${s}`)?.p ?? null),
      }));
    } else {
      cats = rows.map((r, i) => {
        const label = rowLabel(r, frame.dims) || String(i + 1);
        return { key: `${i}:${label}`, label: r.other ? other(r.other) : label, other: !!r.other };
      });
      series = [{
        id: 'value',
        label: frame.label ?? frame.insight,
        values: rows.map((r) => (num(r.v) ? r.v : null)),
        prev: rows.map((r) => (num(r.prev) ? r.prev : null)),
      }];
    }
  }
  const totals = cats.map((_, c) => series.reduce((a, s) => a + (num(s.values[c]) ? (s.values[c] as number) : 0), 0));
  const order = orderCategories(totals, cats.map((c) => !!c.other), mode);
  return {
    categories: order.map((i) => cats[i]),
    series: series.map((s) => ({ ...s, values: order.map((i) => s.values[i]), prev: s.prev ? order.map((i) => s.prev?.[i] ?? null) : null })),
  };
}

export function BarBlock({ frame, options, colorDomain }: BlockViewProps) {
  const { t } = useI18n();
  const drawable = drawableFrame(frame, ['table', 'series'] as const);
  const shaped = 'frame' in drawable ? drawable.frame : null;
  const mode = barSortMode(options.sort);
  const model = useMemo(
    () => (shaped ? barModelFromFrame(shaped, mode, (n) => otherLabel(t, n)) : null),
    [shaped, mode, t],
  );
  const orientation = options.orientation === 'v' ? 'v' : 'h';
  const axes = typeof options.axes === 'string' ? options.axes : 'both';
  const comparePrev = boolOption(options, 'comparePrev');
  const hasPrev = !!model?.series.some((s) => s.prev?.some((v) => v !== null));

  let body;
  if ('empty' in drawable) {
    body = <BlockEmpty reason={drawable.empty} />;
  } else if (!model || model.categories.length === 0) {
    body = <BlockEmpty />;
  } else if (comparePrev && !hasPrev) {
    body = <BlockEmpty message={t('lab.blocks.compare.noPrev')} />;
  } else {
    body = (
      <BarChart
        model={model}
        unit={drawable.frame.unit}
        orientation={orientation}
        group={options.group === 'stacked' ? 'stacked' : 'grouped'}
        comparePrev={comparePrev}
        valueLabels={boolOption(options, 'valueLabels', true)}
        colorIndex={numberOption(options, 'color', 1, 1, 8)}
        format={toChartFormat(options.format)}
        showX={axes === 'both' || axes === 'x'}
        showY={axes === 'both' || axes === 'y'}
        grid={boolOption(options, 'grid', true)}
        legend={toLegendPosition(options.legend, 'bottom')}
        colorDomain={colorDomain?.series}
      />
    );
  }
  return (
    <div className="lab-block-fill lab-chart-cell" data-orientation={orientation} data-sort={mode}>
      {body}
    </div>
  );
}
