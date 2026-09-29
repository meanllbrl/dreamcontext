/**
 * Every board block option VISIBLY changes the render (plan AC5, the unit
 * half; scripts/verify/lab-boards.mjs measures the real browser). Charts and
 * blocks are rendered to static markup with the dashboard's own React, the
 * subagent-card-one-entry.test.ts precedent, and each option is asserted as a
 * markup difference between its off and on states.
 *
 * Also: the client frame shaping (filter -> total before limit), the stat
 * formats, the remote-media strip for text/callout, and blocks.css speaking
 * only in tokens.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

// t() returns the key: the copy lives in I18nContext (merged by the I18n owner); the
// assertions here are about which string a block asks for, not its wording.
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { LineChart } = await import('../../dashboard/src/components/lab/LineChart.js');
const { BarChart } = await import('../../dashboard/src/components/lab/BarChart.js');
const { BarCompareChart } = await import('../../dashboard/src/components/lab/BarCompareChart.js');
const { StackedChart } = await import('../../dashboard/src/components/lab/StackedChart.js');
const { PieChart } = await import('../../dashboard/src/components/lab/PieChart.js');
const { MetricTable, FrameTable } = await import('../../dashboard/src/components/lab/MetricTable.js');
const { HeatmapChart, HeatmapMatrix } = await import('../../dashboard/src/components/lab/HeatmapChart.js');
const { NumberCard } = await import('../../dashboard/src/components/lab/NumberCard.js');
const { orderPivotDims } = await import('../../dashboard/src/components/lab/BreakdownPivot.js');
const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
const { StatBlock } = await import('../../dashboard/src/components/lab/blocks/StatBlock.js');
const { LineBlock } = await import('../../dashboard/src/components/lab/blocks/LineBlock.js');
const { BarBlock } = await import('../../dashboard/src/components/lab/blocks/BarBlock.js');
const { PieBlock } = await import('../../dashboard/src/components/lab/blocks/PieBlock.js');
const { TableBlock } = await import('../../dashboard/src/components/lab/blocks/TableBlock.js');
const { HeatmapBlock } = await import('../../dashboard/src/components/lab/blocks/HeatmapBlock.js');
const { StackedBlock } = await import('../../dashboard/src/components/lab/blocks/StackedBlock.js');
const { FunnelBlock } = await import('../../dashboard/src/components/lab/blocks/FunnelBlock.js');
const { FilterBlock } = await import('../../dashboard/src/components/lab/blocks/FilterBlock.js');
const { TabsBlock } = await import('../../dashboard/src/components/lab/blocks/TabsBlock.js');
const { shapeBlockFrame, setActiveFilter, filterTarget } = await import('../../dashboard/src/components/lab/blocks/frameShape.js');
const { formatStat, currencyCode } = await import('../../dashboard/src/components/lab/blocks/format.js');
const { stripRemoteMedia } = await import('../../dashboard/src/components/lab/blocks/safeMarkdown.js');
const { frameToMatrixSet } = await import('../../dashboard/src/components/lab/blocks/frameAdapters.js');

const html = (el: ReactElement) => renderToStaticMarkup(el);
const count = (s: string, needle: RegExp) => (s.match(needle) ?? []).length;

// ─── Fixtures (fictional) ───────────────────────────────────────────────────

const SERIES = [
  { name: 'web', points: [{ t: '2026-09-01', v: 10 }, { t: '2026-09-02', v: 14 }, { t: '2026-09-03', v: 12 }] },
  { name: 'ios', points: [{ t: '2026-09-01', v: 4 }, { t: '2026-09-02', v: 6 }, { t: '2026-09-03', v: 9 }] },
  { name: 'android', points: [{ t: '2026-09-01', v: 2 }, { t: '2026-09-02', v: 3 }, { t: '2026-09-03', v: 5 }] },
];

const SERIES_FRAME: Frame = { kind: 'series', insight: 'signups', series: SERIES, unit: null, granularity: 'daily' };

const TABLE_FRAME: Frame = {
  kind: 'table',
  insight: 'orders',
  dataset: 'by-country',
  label: 'Orders',
  dims: [{ key: 'country', label: 'Country' }, { key: 'plan', label: 'Plan' }],
  rows: [
    { d: { country: 'Atlantis', plan: 'pro' }, v: 50, n: 500, prev: 40 },
    { d: { country: 'Atlantis', plan: 'free' }, v: 30, n: 300, prev: 35 },
    { d: { country: 'Lemuria', plan: 'pro' }, v: 20, n: 200, prev: 10 },
    { d: { country: 'Lemuria', plan: 'free' }, v: 10, n: 100, prev: 12 },
    { d: { country: 'Mu', plan: 'pro' }, v: 5, n: 50, prev: 6 },
  ],
  sourceTotal: { v: 115, n: 1150 },
  total: { count: 5, v: 115, n: 1150 },
  unit: null,
};

const VALUE_FRAME: Frame = { kind: 'value', insight: 'mrr', value: 1234.5, prev: 1200, spark: [1100, 1150, 1200, 1234.5], unit: 'EUR' };

function block(type: Block['type'], options: Record<string, unknown> = {}, extra: Partial<Block> = {}): Block {
  return { type, data: 'x', options, ...extra };
}

function renderBlock(Component: (p: BlockProps & { block: Block }) => unknown, b: Block, props: Partial<BlockProps> = {}): string {
  const frame = props.frame !== undefined ? props.frame : null;
  return html(createElement(I18nProvider, null, createElement(Component as never, { ...props, frame, options: b.options, block: b })));
}

// ─── Charts ─────────────────────────────────────────────────────────────────

describe('LineChart: area, colorIndex, series filter', () => {
  it('area fills under each line', () => {
    expect(count(html(createElement(LineChart, { series: SERIES })), /data-area/g)).toBe(0);
    expect(count(html(createElement(LineChart, { series: SERIES, area: true })), /data-area/g)).toBe(3);
  });

  it('colorIndex shifts the palette the lines start at', () => {
    const plain = html(createElement(LineChart, { series: SERIES }));
    const shifted = html(createElement(LineChart, { series: SERIES, colorIndex: 3 }));
    expect(plain).toMatch(/<polyline[^>]*stroke="var\(--chart-1\)"/);
    expect(shifted).toMatch(/<polyline[^>]*stroke="var\(--chart-3\)"/);
    expect(shifted).not.toMatch(/<polyline[^>]*stroke="var\(--chart-1\)"/);
  });

  it('the series filter keeps only the named lines, in the filter order', () => {
    const out = html(createElement(LineChart, { series: SERIES, seriesFilter: ['android', 'web'] }));
    expect(count(out, /<polyline/g)).toBe(2);
    expect(out.indexOf('android')).toBeLessThan(out.indexOf('>web<'));
  });
});

const ROWS = [
  { name: 'b', value: 5, frac: 0.25, color: 'var(--chart-1)' },
  { name: 'a', value: 15, frac: 0.75, color: 'var(--chart-2)' },
];

describe('BarChart: orientation, color, ranking', () => {
  it('orientation v draws columns, h draws the bar list', () => {
    const h = html(createElement(BarChart, { rows: ROWS, unit: null }));
    const v = html(createElement(BarChart, { rows: ROWS, unit: null, orientation: 'v' }));
    expect(count(h, /data-bar/g)).toBe(0);
    expect(count(v, /data-bar/g)).toBe(2);
    expect(v).toContain('Vertical bar chart');
  });

  it('colorIndex recolors from that palette slot', () => {
    const out = html(createElement(BarChart, { rows: ROWS, unit: null, orientation: 'v', colorIndex: 5 }));
    expect(out).toContain('var(--chart-5)');
    expect(out).toContain('var(--chart-6)');
    expect(out).not.toContain('var(--chart-1)');
  });

  it('ranked=false keeps the caller order (a block sort)', () => {
    const ranked = html(createElement(BarChart, { rows: ROWS, unit: null }));
    const kept = html(createElement(BarChart, { rows: ROWS, unit: null, ranked: false }));
    expect(ranked.indexOf('title="a"')).toBeLessThan(ranked.indexOf('title="b"'));
    expect(kept.indexOf('title="b"')).toBeLessThan(kept.indexOf('title="a"'));
  });
});

describe('BarCompareChart (comparePrev reuses bar_compare)', () => {
  it('explicit groups draw one group per row with a bar per series, colored from colorIndex', () => {
    const series = [
      { name: 'Previous', points: [{ t: 'Atlantis', v: 40 }, { t: 'Lemuria', v: 10 }] },
      { name: 'Current', points: [{ t: 'Atlantis', v: 50 }, { t: 'Lemuria', v: 20 }] },
    ];
    const out = html(createElement(BarCompareChart, { series, unit: null, groups: ['Atlantis', 'Lemuria'], colorIndex: 2 }));
    expect(count(out, /<rect/g)).toBe(4);
    expect(out).toContain('>Atlantis<');
    expect(out).toContain('var(--chart-2)');
    expect(out).toContain('var(--chart-3)');
  });
});

describe('StackedChart: color offset', () => {
  it('the bottom layer takes the chosen slot', () => {
    expect(html(createElement(StackedChart, { series: SERIES, unit: null }))).toContain('fill="var(--chart-1)"');
    const shifted = html(createElement(StackedChart, { series: SERIES, unit: null, colorIndex: 4 }));
    expect(shifted).toContain('fill="var(--chart-4)"');
    expect(shifted).not.toContain('fill="var(--chart-1)"');
  });
});

describe('PieChart: donut, degrade kept', () => {
  it('donut draws ring sectors (two arcs per slice)', () => {
    const pie = html(createElement(PieChart, { series: SERIES }));
    const donut = html(createElement(PieChart, { series: SERIES, donut: true }));
    expect(pie).not.toContain('data-donut');
    expect(donut).toContain('data-donut');
    const arcs = (s: string) => count(s, / A /g);
    expect(arcs(donut)).toBe(2 * arcs(pie));
  });

  it('seven or more slices still degrade to bars, donut or not', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `s${i}`, points: [{ t: '', v: i + 1 }] }));
    const out = html(createElement(PieChart, { series: many, donut: true }));
    expect(out).not.toContain('Donut chart');
    expect(out).toContain('Share by series');
  });
});

describe('MetricTable / FrameTable: column pick', () => {
  it('series table keeps only the picked columns', () => {
    const all = html(createElement(MetricTable, { series: SERIES, unit: null, full: true }));
    const picked = html(createElement(MetricTable, { series: SERIES, unit: null, full: true, columns: ['series', 'latest'] }));
    expect(count(all, /<th[ >]/g)).toBe(4);
    expect(count(picked, /<th[ >]/g)).toBe(2);
    expect(picked).not.toContain('Trend');
  });

  const labels = { v: 'Value', n: 'n', prev: 'Previous', total: 'Total', rows: 'rows' };
  const t = TABLE_FRAME as Extract<Frame, { kind: 'table' }>;

  it('table frame: the pick chooses and orders columns', () => {
    const all = html(createElement(FrameTable, { dims: t.dims, rows: t.rows, unit: null, labels }));
    const picked = html(createElement(FrameTable, { dims: t.dims, rows: t.rows, unit: null, labels, columns: ['v', 'country'] }));
    expect(all).toContain('data-columns="country,plan,v,n,prev"');
    expect(picked).toContain('data-columns="v,country"');
  });

  it('draws the frame total as a footer', () => {
    const out = html(createElement(FrameTable, { dims: t.dims, rows: t.rows, unit: null, labels, total: t.total }));
    expect(out).toContain('data-total-count="5"');
    expect(out).toContain('Total (5 rows)');
  });
});

describe('HeatmapChart / HeatmapMatrix: color', () => {
  it('series grid tints with the chosen chart token', () => {
    const plain = html(createElement(HeatmapChart, { series: SERIES, unit: null, granularity: 'daily' }));
    const tinted = html(createElement(HeatmapChart, { series: SERIES, unit: null, granularity: 'daily', colorIndex: 4 }));
    expect(plain).toContain('var(--chart-1)');
    expect(tinted).toContain('var(--chart-4)');
    expect(tinted).not.toContain('var(--chart-1)');
  });

  it('table matrix: rows by the first dim, columns by the second', () => {
    const t = TABLE_FRAME as Extract<Frame, { kind: 'table' }>;
    const out = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: null, colorIndex: 6 }));
    expect(count(out, /data-heat-cell/g)).toBe(3 * 2);
    expect(out).toContain('var(--chart-6)');
  });
});

describe('NumberCard: delta, spark, format', () => {
  const series = [{ name: 's', points: [{ t: '1', v: 10 }, { t: '2', v: 12 }] }];

  it('showSpark false drops the sparkline, showDelta false drops the change', () => {
    const full = html(createElement(NumberCard, { latest: 12, unit: null, series }));
    expect(full).toContain('aria-label="Trend"');
    expect(full).toContain('+2');
    const bare = html(createElement(NumberCard, { latest: 12, unit: null, series, showSpark: false, showDelta: false }));
    expect(bare).not.toContain('aria-label="Trend"');
    expect(bare).not.toContain('+2');
  });

  it('format writes the figure', () => {
    const out = html(createElement(NumberCard, { latest: 0.5, unit: null, series, showDelta: false, format: (v: number) => `${v * 100}pct` }));
    expect(out).toContain('50pct');
  });
});

describe('pivot: rows/cols choose the axes', () => {
  it('orders dims rows first, cols second, the rest after', () => {
    const set = frameToMatrixSet(TABLE_FRAME as Extract<Frame, { kind: 'table' }>);
    expect(orderPivotDims(set, 'plan', 'country').dims.map((d) => d.key)).toEqual(['plan', 'country']);
    expect(orderPivotDims(set, null, null).dims.map((d) => d.key)).toEqual(['country', 'plan']);
    expect(orderPivotDims(set, 'ghost', null).dims.map((d) => d.key)).toEqual(['country', 'plan']);
  });
});

// ─── Blocks (option -> render, end to end) ──────────────────────────────────

describe('blocks: each option changes the render', () => {
  it('stat: delta, spark, format, unit', () => {
    const base = renderBlock(StatBlock, block('stat'), { frame: VALUE_FRAME });
    const withDelta = renderBlock(StatBlock, block('stat', { delta: 'prev' }), { frame: VALUE_FRAME });
    const withSpark = renderBlock(StatBlock, block('stat', { spark: true }), { frame: VALUE_FRAME });
    const currency = renderBlock(StatBlock, block('stat', { format: 'currency' }), { frame: VALUE_FRAME });
    const unit = renderBlock(StatBlock, block('stat', { unit: 'orders' }), { frame: VALUE_FRAME });
    expect(base).toContain('data-delta="none"');
    expect(withDelta).toContain('+34.5');
    expect(base).not.toContain('+34.5');
    expect(base).not.toContain('aria-label="Trend"');
    expect(withSpark).toContain('aria-label="Trend"');
    expect(currency).toContain('€');
    expect(base).toContain('EUR');
    expect(unit).toContain('orders');
  });

  it('line: area, color, series', () => {
    const base = renderBlock(LineBlock, block('line'), { frame: SERIES_FRAME });
    expect(renderBlock(LineBlock, block('line', { area: true }), { frame: SERIES_FRAME })).toContain('data-area');
    expect(base).not.toContain('data-area');
    expect(renderBlock(LineBlock, block('line', { color: 7 }), { frame: SERIES_FRAME })).toMatch(/stroke="var\(--chart-7\)"/);
    expect(count(renderBlock(LineBlock, block('line', { series: ['ios'] }), { frame: SERIES_FRAME }), /<polyline/g)).toBe(1);
  });

  it('bar: orientation, color, comparePrev', () => {
    const base = renderBlock(BarBlock, block('bar'), { frame: TABLE_FRAME });
    const vertical = renderBlock(BarBlock, block('bar', { orientation: 'v' }), { frame: TABLE_FRAME });
    const colored = renderBlock(BarBlock, block('bar', { orientation: 'v', color: 3 }), { frame: TABLE_FRAME });
    const compare = renderBlock(BarBlock, block('bar', { comparePrev: true }), { frame: TABLE_FRAME });
    expect(base).toContain('data-orientation="h"');
    expect(count(base, /data-bar/g)).toBe(0);
    expect(count(vertical, /data-bar/g)).toBeGreaterThan(0);
    expect(colored).toContain('var(--chart-3)');
    expect(compare).toContain('Grouped bar chart');
    expect(compare).toContain('lab.blocks.compare.prev');
    expect(compare).toContain('lab.blocks.compare.current');
  });

  it('stacked: color', () => {
    expect(renderBlock(StackedBlock, block('stacked', { color: 5 }), { frame: SERIES_FRAME })).toContain('fill="var(--chart-5)"');
  });

  it('pie: donut', () => {
    const three: Frame = { ...(TABLE_FRAME as Extract<Frame, { kind: 'table' }>), rows: TABLE_FRAME.kind === 'table' ? TABLE_FRAME.rows.slice(0, 3) : [] };
    expect(renderBlock(PieBlock, block('pie'), { frame: three })).not.toContain('data-donut');
    expect(renderBlock(PieBlock, block('pie', { donut: true }), { frame: three })).toContain('data-donut');
  });

  it('table: columns', () => {
    const all = renderBlock(TableBlock, block('table'), { frame: TABLE_FRAME });
    const picked = renderBlock(TableBlock, block('table', { columns: ['country', 'v'] }), { frame: TABLE_FRAME });
    expect(all).toContain('data-columns="country,plan,v,n,prev"');
    expect(picked).toContain('data-columns="country,v"');
  });

  it('heatmap: color', () => {
    expect(renderBlock(HeatmapBlock, block('heatmap', { color: 2 }), { frame: TABLE_FRAME })).toContain('var(--chart-2)');
    expect(renderBlock(HeatmapBlock, block('heatmap'), { frame: TABLE_FRAME })).not.toContain('var(--chart-2)');
  });

  it('funnel: compact draws the dense bars and one funnel', () => {
    const funnel: Frame = {
      kind: 'funnel', insight: 'onboarding',
      funnels: [
        { id: 'a', name: 'Signup', steps: [{ key: 's1', label: 'Visit', users: 100 }, { key: 's2', label: 'Join', users: 40 }] },
        { id: 'b', name: 'Checkout', steps: [{ key: 's1', label: 'Cart', users: 50 }, { key: 's2', label: 'Paid', users: 20 }] },
      ],
    };
    const base = renderBlock(FunnelBlock, block('funnel'), { frame: funnel });
    const compact = renderBlock(FunnelBlock, block('funnel', { compact: true }), { frame: funnel });
    expect(base).toContain('Checkout');
    expect(compact).not.toContain('Checkout');
    expect(compact).toContain('funnel-bars--dense');
    expect(base).not.toContain('funnel-bars--dense');
  });

  it('filter: chips over the dim, the active one pressed', () => {
    const out = renderBlock(FilterBlock, block('filter', { dim: 'country' }), { frame: TABLE_FRAME, filter: { dim: 'country', value: 'Lemuria' } });
    expect(out).toContain('data-dim="country"');
    for (const v of ['Atlantis', 'Lemuria', 'Mu']) expect(out).toContain(`>${v}<`);
    expect(out).toMatch(/aria-pressed="true"[^>]*>Lemuria</);
    const plan = renderBlock(FilterBlock, block('filter', { dim: 'plan' }), { frame: TABLE_FRAME });
    expect(plan).toContain('>pro<');
    expect(plan).not.toContain('>Atlantis<');
  });

  it('tabs: one panel at a time through renderChild, relative paths, no nesting', () => {
    const tabs = block('tabs', {}, {
      data: undefined,
      tabs: [
        { label: 'Overview', blocks: [block('text', { markdown: 'first' }), block('tabs', {}, { tabs: [] })] },
        { label: 'Detail', blocks: [block('text', { markdown: 'second' })] },
      ],
    });
    const paths: number[][] = [];
    const out = renderBlock(TabsBlock, tabs, {
      renderChild: (child, path) => { paths.push(path); return createElement('i', null, String(child.options.markdown)); },
    });
    expect(out).toContain('>Overview<');
    expect(out).toContain('>Detail<');
    expect(out).toContain('<i>first</i>');
    expect(out).not.toContain('second');
    expect(out).toContain('lab.blocks.tabs.nested');
    expect(paths).toEqual([[0, 0]]);
  });

  it('an empty frame renders its reason, not a chart', () => {
    const out = renderBlock(LineBlock, block('line'), { frame: { kind: 'empty', reason: 'no-cache', ref: 'signups' } });
    expect(out).toContain('data-empty-reason="no-cache"');
    expect(out).not.toContain('<svg');
    const wrongKind = renderBlock(LineBlock, block('line'), { frame: TABLE_FRAME });
    expect(wrongKind).toContain('data-empty-reason="kind-mismatch"');
  });
});

// ─── Client frame shaping ───────────────────────────────────────────────────

describe('shapeBlockFrame: filter -> sort -> limit, total before limit', () => {
  const filterBlock = block('filter', { dim: 'country' });
  const target = filterTarget(TABLE_FRAME)!;

  it('a sibling on the same dataset is filtered, and its total counts every matching row under a limit', () => {
    const active = setActiveFilter([], 'c-1:0', target, { dim: 'country', value: 'Atlantis' });
    const table = block('table', { limit: 1, sort: '-v' });
    const shaped = shapeBlockFrame(table, TABLE_FRAME, active)!;
    expect(shaped.kind).toBe('table');
    if (shaped.kind !== 'table') return;
    expect(shaped.rows).toHaveLength(1);
    expect(shaped.rows[0].d).toEqual({ country: 'Atlantis', plan: 'pro' });
    expect(shaped.total).toEqual({ count: 2, v: 80, n: 800 });
  });

  it('no filter + a limit keeps the source total', () => {
    const shaped = shapeBlockFrame(block('table', { limit: 2 }), TABLE_FRAME, [])!;
    if (shaped.kind !== 'table') throw new Error('table expected');
    expect(shaped.rows).toHaveLength(2);
    expect(shaped.total.v).toBe(115);
    expect(shaped.total.count).toBe(5);
  });

  it('the filter block itself is never narrowed by a filter (its chips stay)', () => {
    const active = setActiveFilter([], 'c-1:0', target, { dim: 'country', value: 'Mu' });
    const shaped = shapeBlockFrame(filterBlock, TABLE_FRAME, active)!;
    if (shaped.kind !== 'table') throw new Error('table expected');
    expect(shaped.rows).toHaveLength(5);
  });

  it('a block on another dataset is untouched', () => {
    const active = setActiveFilter([], 'c-1:0', { insight: 'orders', dataset: 'by-plan' }, { dim: 'country', value: 'Mu' });
    const shaped = shapeBlockFrame(block('table'), TABLE_FRAME, active)!;
    if (shaped.kind !== 'table') throw new Error('table expected');
    expect(shaped.rows).toHaveLength(5);
  });

  it('two filters on one dataset compose in one pass', () => {
    let active = setActiveFilter([], 'c-1:0', target, { dim: 'country', value: 'Lemuria' });
    active = setActiveFilter(active, 'c-1:1', target, { dim: 'plan', value: 'pro' });
    const shaped = shapeBlockFrame(block('table', { limit: 5 }), TABLE_FRAME, active)!;
    if (shaped.kind !== 'table') throw new Error('table expected');
    expect(shaped.rows.map((r) => r.d)).toEqual([{ country: 'Lemuria', plan: 'pro' }]);
    expect(shaped.total).toEqual({ count: 1, v: 20, n: 200 });
    expect(setActiveFilter(active, 'c-1:0', target, null)).toHaveLength(1);
  });
});

describe('stat formats', () => {
  it('writes number, compact, percent and currency distinctly', () => {
    const outs = (['number', 'compact', 'percent', 'currency'] as const).map((f) => formatStat(12345.678, f, 'EUR', 'en-US'));
    expect(outs).toEqual(['12,345.68', '12.3K', '1,234,567.8%', '€12,345.68']);
    expect(currencyCode('try')).toBe('USD');
    expect(currencyCode('TRY')).toBe('TRY');
  });
});

describe('text/callout: remote media stripped before markdown', () => {
  it('drops remote images, keeps their alt text and data: images', () => {
    const out = stripRemoteMedia('A ![chart](https://tracker.example/p.png) B ![inline](data:image/png;base64,AAAA)');
    expect(out).toBe('A chart B ![inline](data:image/png;base64,AAAA)');
  });

  it('drops raw fetching tags, reference images and css urls', () => {
    const out = stripRemoteMedia([
      '<img src="https://tracker.example/p.gif" alt="x">',
      '<IMG SRC=//tracker.example/a>',
      '<picture><source srcset="https://x.example/a.webp"></picture>',
      '<iframe src="data:text/html,hi"></iframe>',
      '![ref image][logo]',
      '<div style="background:url(https://x.example/bg.png)">hi</div>',
      '<img src="data:image/png;base64,AAAA">',
    ].join('\n'));
    expect(out).not.toMatch(/https?:|\/\/tracker/);
    expect(out).not.toMatch(/<iframe/i);
    expect(out).toContain('ref image');
    expect(out).toContain('<img src="data:image/png;base64,AAAA">');
  });
});

describe('blocks.css speaks only in tokens', () => {
  const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/blocks.css'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('has no literal colors, font sizes, off-ladder weights or durations', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/i);
    expect(css).not.toMatch(/cubic-bezier\(/);
    expect(css).not.toMatch(/font-size:\s*[\d.]/);
    expect(css).not.toMatch(/font-family:/);
    for (const m of css.matchAll(/font-weight:\s*([^;]+);/g)) {
      expect(m[1].trim()).toMatch(/^var\(--font-weight-(normal|semibold)\)$/);
    }
    for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
      expect(m[1]).not.toMatch(/(?<![\w-])\d*\.?\d+m?s\b/);
    }
  });
});
