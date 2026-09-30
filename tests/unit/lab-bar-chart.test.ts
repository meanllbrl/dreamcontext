/**
 * The bar chart on the chart foundation (task: Insights v2 blocks reach a polished,
 * fully customizable chart standard; AC "Bar"). Rendered to static markup with the
 * dashboard's own React at a fixed measured size (the lab-chart-compose precedent);
 * hover is driven by pinning the hover hook's index, so "hover index -> tooltip
 * content" is asserted on the real component. Every option is asserted as a markup or
 * geometry difference between its states.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';

const SIZE = { width: 560, height: 260 };
const hoverState: { index: number | null } = { index: null };

const COPY: Record<string, string> = {
  'lab.blocks.other': 'Other',
  'lab.blocks.otherCount': 'Other ({n})',
  'lab.blocks.compare.prev': 'Previous',
  'lab.blocks.compare.current': 'Current',
  'lab.blocks.compare.noPrev': 'No previous values to compare with.',
  'lab.chart.totalCaption': 'Total',
  'lab.chart.vsPrev': '{delta} vs previous',
  'lab.chart.share': 'Share: {pct}',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/components/lab/chart/useChartSize.js', async (orig) => {
  const real = await orig<typeof import('../../dashboard/src/components/lab/chart/useChartSize.js')>();
  const { estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');
  return {
    ...real,
    useChartSize: () => ({ ref: { current: null }, ...SIZE, fontPx: 12, dpr: 2, ready: true, measure: (s: string) => estimateTextWidth(s, 12) }),
  };
});
vi.mock('../../dashboard/src/components/lab/chart/useChartHover.js', async (orig) => {
  const real = await orig<typeof import('../../dashboard/src/components/lab/chart/useChartHover.js')>();
  return {
    ...real,
    useChartHover: (o: Parameters<typeof real.useChartHover>[0]) => ({ ...real.useChartHover(o), index: hoverState.index, pointer: null }),
  };
});

const { BarChart, BarBody } = await import('../../dashboard/src/components/lab/BarChart.js');
const { BarList, layoutBars, barPath, barTooltipContent, barColors, formatDelta, MAX_BAR, BAR_GAP } = await import('../../dashboard/src/components/lab/BarList.js');
const { BarCompareChart } = await import('../../dashboard/src/components/lab/BarCompareChart.js');
const { BarBlock, barModelFromFrame, barSortMode } = await import('../../dashboard/src/components/lab/blocks/BarBlock.js');
const { estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');

type Model = Parameters<typeof layoutBars>[0]['model'];

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const other = (n: number | null | undefined) => (n ? `Other (${n})` : 'Other');

// ─── Fixtures (fictional) ───────────────────────────────────────────────────

const ONE_DIM: Frame = {
  kind: 'table', insight: 'orders', dataset: 'by-country', label: 'Orders',
  dims: [{ key: 'country', label: 'Country' }],
  rows: [
    { d: { country: 'Lemuria' }, v: 20, prev: 10 },
    { d: { country: 'Atlantis' }, v: 50, prev: 40 },
    { d: { country: 'Mu' }, v: 5, prev: 6 },
    { d: { country: 'Other' }, v: 7, prev: 9, other: 3 },
  ],
  sourceTotal: { v: 82 }, total: { count: 4, v: 82 }, unit: null,
} as Frame;

const TWO_DIM: Frame = {
  kind: 'table', insight: 'orders', dataset: 'by-country-plan', label: 'Orders',
  dims: [{ key: 'country', label: 'Country' }, { key: 'plan', label: 'Plan' }],
  rows: [
    { d: { country: 'Atlantis', plan: 'pro' }, v: 50, prev: 40 },
    { d: { country: 'Atlantis', plan: 'free' }, v: 30, prev: 35 },
    { d: { country: 'Lemuria', plan: 'pro' }, v: 20, prev: 10 },
    { d: { country: 'Lemuria', plan: 'free' }, v: 10, prev: 12 },
  ],
  sourceTotal: { v: 110 }, total: { count: 4, v: 110 }, unit: null,
} as Frame;

const SERIES_FRAME: Frame = {
  kind: 'series', insight: 'signups', unit: null, granularity: 'daily',
  series: [
    { name: 'web', points: [{ t: '2026-09-01', v: 10 }, { t: '2026-09-02', v: 14 }] },
    { name: 'ios', points: [{ t: '2026-09-01', v: 4 }, { t: '2026-09-02', v: 3 }] },
    { name: 'android', points: [{ t: '2026-09-01', v: 2 }, { t: '2026-09-02', v: 25 }] },
  ],
} as Frame;

function renderBlock(frame: Frame, options: Record<string, unknown> = {}): string {
  return html(createElement(BarBlock as never, { frame, options, block: { type: 'bar', data: 'x', options } }));
}

const layout = (model: Model, opts: Record<string, unknown> = {}) =>
  layoutBars({ model, opts, width: SIZE.width, height: SIZE.height, fontPx: 12, measure: (s: string) => estimateTextWidth(s, 12), locale: 'en' });

const BIG: Model = { categories: [{ key: 'a', label: 'a' }, { key: 'b', label: 'b' }], series: [{ id: 'value', label: '', values: [120, -30] }] };

// ─── Geometry: the dataviz mark spec ────────────────────────────────────────

describe('bar marks follow the mark spec', () => {
  it('bars are at most 24px thick, even in a roomy cell', () => {
    const g = layout(BIG, { orientation: 'v' });
    expect(g.marks).toHaveLength(2);
    for (const m of g.marks) expect(m.rect.right - m.rect.left).toBeLessThanOrEqual(MAX_BAR);
    const h = layout(BIG, { orientation: 'h' });
    for (const m of h.marks) expect(m.rect.bottom - m.rect.top).toBeLessThanOrEqual(MAX_BAR);
  });

  it('the data end is rounded, the baseline end square; a negative bar grows down', () => {
    expect(barPath(0, 0, 20, 100, 'top')).toMatch(/^M0,100V4A4,4 0 0 1 4,0H16A4,4 0 0 1 20,4V100Z$/);
    expect(barPath(0, 0, 20, 100, 'bottom')).toContain('V96A4,4');
    expect(barPath(0, 0, 100, 20, 'right')).toMatch(/^M0,0H96A4,4/);
    expect(barPath(0, 0, 20, 100, null)).toBe('M0,0H20V100H0Z');
    // A 3px bar cannot take a 4px radius.
    expect(barPath(0, 0, 3, 100, 'top')).toContain('A1.5,1.5');
    const g = layout(BIG, { orientation: 'v' });
    const neg = g.marks.find((m) => m.value < 0);
    expect(neg?.tip.side).toBe('bottom');
    expect(g.marks.find((m) => m.value > 0)?.tip.side).toBe('top');
  });

  it('columns label all or nothing: one label that does not fit drops them all', () => {
    const many: Model = { categories: Array.from({ length: 30 }, (_, i) => ({ key: `c${i}`, label: `c${i}` })), series: [{ id: 'value', label: '', values: Array.from({ length: 30 }, (_, i) => 1000 + i * 1111) }] };
    expect(layout(many, { orientation: 'v' }).labels).toHaveLength(0);
    expect(layout(BIG, { orientation: 'v' }).labels).toHaveLength(2);
  });

  it('grouped bars sit 2px apart; stacked segments leave a 2px surface gap and only the outer one is rounded', () => {
    const model = barModelFromFrame(TWO_DIM, 'rank', other);
    const grouped = layout(model, { orientation: 'v', group: 'grouped' });
    const inCat0 = grouped.marks.filter((m) => m.cat === 0).sort((p, q) => p.rect.left - q.rect.left);
    expect(inCat0).toHaveLength(2);
    expect(inCat0[1].rect.left - inCat0[0].rect.right).toBeCloseTo(BAR_GAP, 5);

    const stacked = layout(model, { orientation: 'v', group: 'stacked' });
    const segs = stacked.marks.filter((m) => m.cat === 0);
    expect(segs).toHaveLength(2);
    expect(segs.filter((m) => m.d.includes('A'))).toHaveLength(1);
    // The two segments of a stack share one x lane, 2px of surface between them.
    expect(segs[0].rect.left).toBe(segs[1].rect.left);
    const [lower, upper] = [...segs].sort((p, q) => q.rect.bottom - p.rect.bottom);
    expect(lower.rect.top - upper.rect.bottom).toBeCloseTo(BAR_GAP, 5);
  });
});

// ─── The rendered chart: axes, hover, options ──────────────────────────────

const ROWS = [
  { name: 'b', value: 5000, frac: 0.25, color: '' },
  { name: 'a', value: 15000, frac: 0.75, color: '' },
];

describe('BarChart draws on the foundation', () => {
  it('has a value axis with nice formatted ticks and a category axis, drawn 1:1', () => {
    const out = html(createElement(BarChart, { rows: ROWS, unit: null, orientation: 'v' }));
    expect(out).toContain('width="560" height="260" viewBox="0 0 560 260"');
    const y = out.match(/<g class="lab-chart-axis" data-axis="y"[\s\S]*?<\/g>/)?.[0] ?? '';
    expect(y).toMatch(/>1[05]K</);
    const x = out.match(/<g class="lab-chart-axis" data-axis="x"[\s\S]*?<\/g>/)?.[0] ?? '';
    expect(x).toContain('>a<');
    expect(x).toContain('>b<');
    expect(out).toContain('data-chart-hit');
  });

  it('orientation: v draws columns (category labels on x), h draws rows (category labels on y)', () => {
    const v = html(createElement(BarChart, { rows: ROWS, unit: null, orientation: 'v' }));
    const h = html(createElement(BarChart, { rows: ROWS, unit: null, orientation: 'h' }));
    expect(v).toContain('data-orientation="v"');
    expect(h).toContain('data-orientation="h"');
    expect(v.match(/data-axis="x"[\s\S]*?<\/g>/)?.[0]).toContain('>a<');
    expect(h.match(/data-axis="y"[\s\S]*?<\/g>/)?.[0]).toContain('>a<');
  });

  it('ranked (missing sort) puts the largest first; ranked=false keeps the caller order', () => {
    const ranked = html(createElement(BarChart, { rows: ROWS, unit: null }));
    const kept = html(createElement(BarChart, { rows: ROWS, unit: null, ranked: false }));
    const firstLabel = (s: string) => s.match(/data-axis="y"[\s\S]*?<text[^>]*>([^<]*)</)?.[1];
    expect(firstLabel(ranked)).toBe('a');
    expect(firstLabel(kept)).toBe('b');
  });

  it('valueLabels puts the value at each bar tip; off removes them', () => {
    const on = html(createElement(BarChart, { rows: ROWS, unit: null }));
    const off = html(createElement(BarChart, { rows: ROWS, unit: null, valueLabels: false }));
    expect(count(on, /data-value-label/g)).toBe(2);
    expect(on).toContain('>15K<');
    expect(count(off, /data-value-label/g)).toBe(0);
  });

  it('format changes ticks and labels; color starts the palette at that slot', () => {
    const num = html(createElement(BarChart, { rows: ROWS, unit: null, format: 'number' }));
    expect(num).toContain('>15,000<');
    const cur = html(createElement(BarChart, { rows: ROWS, unit: 'EUR', format: 'currency' }));
    expect(cur).toContain('€15,000.00');
    expect(html(createElement(BarChart, { rows: ROWS, unit: null }))).toContain('fill="var(--viz-cat-1)"');
    const five = html(createElement(BarChart, { rows: ROWS, unit: null, colorIndex: 5 }));
    // One series, one hue: every bar wears slot 5 (never a value ramp on nominal categories).
    expect(count(five, /fill="var\(--viz-cat-5\)"/g)).toBe(2);
    expect(five).not.toContain('var(--viz-cat-1)');
  });

  it('axes and grid toggle', () => {
    const both = html(createElement(BarChart, { rows: ROWS, unit: null, orientation: 'v' }));
    const none = html(createElement(BarChart, { rows: ROWS, unit: null, orientation: 'v', showX: false, showY: false }));
    const yOnly = html(createElement(BarChart, { rows: ROWS, unit: null, orientation: 'v', showX: false }));
    expect(both).toContain('data-axis="y"');
    expect(none).not.toContain('data-axis="y"');
    expect(none).not.toMatch(/data-axis="x"[^>]*>[^]*?class="lab-chart-tick"/);
    expect(yOnly).toContain('data-axis="y"');
    expect(both).toContain('class="lab-chart-grid"');
    expect(html(createElement(BarChart, { rows: ROWS, unit: null, orientation: 'v', grid: false }))).not.toContain('lab-chart-grid');
  });

  it('hover index -> a tooltip for THAT bar: its label, value and share', () => {
    hoverState.index = 1;
    try {
      const out = html(createElement(BarChart, { rows: ROWS, unit: null, ranked: false, format: 'number' }));
      const tip = out.match(/data-chart-tooltip[\s\S]*$/)?.[0] ?? '';
      expect(tip).toContain('lab-chart-tooltip-title">a<');
      expect(tip).toMatch(/data-value="">15,000</);
      expect(tip).toContain('Share: 75%');
      expect(out).toContain('data-hover-slot');
      expect(out).toContain('data-hover-index="1"');
    } finally {
      hoverState.index = null;
    }
  });
});

describe('BarBlock passes every option through', () => {
  it('sort: missing ranks, none keeps the frame order, asc/desc by value; Other stays last', () => {
    const labels = (s: string) => [...(s.match(/data-axis="y"[\s\S]*?<\/g>/)?.[0] ?? '').matchAll(/>([^<>]+)</g)].map((m) => m[1]);
    expect(labels(renderBlock(ONE_DIM))).toEqual(['Atlantis', 'Lemuria', 'Mu', 'Other (3)']);
    expect(labels(renderBlock(ONE_DIM, { sort: 'none' }))).toEqual(['Lemuria', 'Atlantis', 'Mu', 'Other (3)']);
    expect(labels(renderBlock(ONE_DIM, { sort: 'asc' }))).toEqual(['Mu', 'Lemuria', 'Atlantis', 'Other (3)']);
    expect(labels(renderBlock(ONE_DIM, { sort: 'desc' }))).toEqual(['Atlantis', 'Lemuria', 'Mu', 'Other (3)']);
    expect(barSortMode(undefined)).toBe('rank');
    expect(barSortMode('-v')).toBe('desc');
    expect(barSortMode('country')).toBe('none');
  });

  it('topN: the Other row reads "Other (n)" and wears the Other grey', () => {
    const out = renderBlock(ONE_DIM);
    expect(out).toContain('>Other (3)<');
    expect(out).toMatch(/<path[^>]*fill="var\(--viz-other\)"[^>]*data-bar=""/);
  });

  it('group: a two-dim table draws one series per plan, grouped side by side or stacked', () => {
    const grouped = renderBlock(TWO_DIM, { orientation: 'v' });
    const stacked = renderBlock(TWO_DIM, { orientation: 'v', group: 'stacked' });
    expect(grouped).toContain('data-group="grouped"');
    expect(stacked).toContain('data-group="stacked"');
    expect(count(grouped, /data-bar=""/g)).toBe(4);
    expect(count(stacked, /data-bar=""/g)).toBe(4);
    // Grouped bars are thinner lanes side by side; stacked segments share one lane per category.
    const lanes = (s: string) => new Set([...s.matchAll(/<path d="M(-?[\d.]+),[^"]*" fill="[^"]*" data-bar=""/g)].map((m) => m[1])).size;
    expect(lanes(grouped)).toBe(4);
    expect(lanes(stacked)).toBe(2);
    // Two series -> a legend of toggles.
    expect(count(grouped, /class="lab-chart-legend-item"/g)).toBe(2);
    expect(renderBlock(TWO_DIM, { legend: 'none' })).not.toContain('lab-chart-legend');
    expect(renderBlock(TWO_DIM, { legend: 'top' })).toContain('data-legend="top"');
  });

  it('comparePrev: a recessive ghost bar beside each bar, and the delta in the tooltip', () => {
    const plain = renderBlock(ONE_DIM);
    const cmp = renderBlock(ONE_DIM, { comparePrev: true });
    expect(count(plain, /data-ghost="true"/g)).toBe(0);
    expect(count(cmp, /data-ghost="true"/g)).toBe(4);
    expect(cmp).toMatch(/fill="color-mix\(in srgb, var\(--viz-cat-1\) 38%, transparent\)"/);
    expect(cmp).toContain('>Previous<');
    hoverState.index = 0;
    try {
      const tip = renderBlock(ONE_DIM, { comparePrev: true }).match(/data-chart-tooltip[\s\S]*$/)?.[0] ?? '';
      expect(tip).toContain('>Atlantis<');
      expect(tip).toMatch(/data-value="">50</);
      expect(tip).toMatch(/data-value="">40</);
      expect(tip).toContain('+10 (+25%) vs previous');
    } finally {
      hoverState.index = null;
    }
  });

  it('a 3-dim rate table keeps one bar per row, every dim joined, values untouched (never summed)', () => {
    const rates = {
      kind: 'table', insight: 'conversion', dataset: 'by-country-platform-plan', label: 'Conversion', unit: '%',
      dims: [{ key: 'country', label: 'Country' }, { key: 'platform', label: 'Platform' }, { key: 'plan', label: 'Plan' }],
      rows: [
        { d: { country: 'Atlantis', platform: 'ios', plan: 'pro' }, v: 62 },
        { d: { country: 'Atlantis', platform: 'ios', plan: 'free' }, v: 58 },
        { d: { country: 'Lemuria', platform: 'web', plan: 'pro' }, v: 41 },
      ],
      sourceTotal: { v: null }, total: { count: 3, v: null },
    } as unknown as Frame;
    const model = barModelFromFrame(rates, 'none', other);
    expect(model.series).toHaveLength(1);
    expect(model.categories.map((c) => c.label)).toEqual(['Atlantis / ios / pro', 'Atlantis / ios / free', 'Lemuria / web / pro']);
    expect(model.series[0].values).toEqual([62, 58, 41]);
  });

  it('two dims pivot only when every pair is unique; a repeated pair falls back to one bar per row', () => {
    const unique = barModelFromFrame(TWO_DIM, 'none', other);
    expect(unique.series.map((s) => s.id)).toEqual(['pro', 'free']);
    expect(unique.series[0].values).toEqual([50, 20]);
    const dup = { ...(TWO_DIM as Extract<Frame, { kind: 'table' }>) };
    dup.rows = [...dup.rows, { d: { country: 'Atlantis', plan: 'pro' }, v: 7 }];
    const flat = barModelFromFrame(dup as Frame, 'none', other);
    expect(flat.series).toHaveLength(1);
    expect(flat.categories.map((c) => c.label)).toEqual(['Atlantis / pro', 'Atlantis / free', 'Lemuria / pro', 'Lemuria / free', 'Atlantis / pro']);
    expect(flat.series[0].values).toEqual([50, 30, 20, 10, 7]);
  });

  it('comparePrev on a series frame compares each series with its previous point', () => {
    const model = barModelFromFrame(SERIES_FRAME, 'rank', other);
    expect(model.categories.map((c) => c.label)).toEqual(['android', 'web', 'ios']);
    expect(model.series[0].values).toEqual([25, 14, 3]);
    expect(model.series[0].prev).toEqual([2, 10, 4]);
  });

  it('the stacked tooltip carries the total; grouped does not', () => {
    const model = barModelFromFrame(TWO_DIM, 'rank', other);
    const colors = barColors(model, 1);
    const copy = { current: 'Current', previous: 'Previous', total: 'Total', vsPrev: '{delta} vs previous', share: 'Share: {pct}' };
    const st = barTooltipContent(model, 0, { group: 'stacked' }, colors, copy, undefined, 'en');
    expect(st.title).toBe('Atlantis');
    expect(st.rows.map((r) => [r.label, r.value])).toEqual([['pro', '50'], ['free', '30']]);
    expect(st.footer).toBe('Total: 80');
    expect(barTooltipContent(model, 0, { group: 'grouped' }, colors, copy, undefined, 'en').footer).toBeUndefined();
    expect(formatDelta(30, 35, { locale: 'en' })).toBe('-5 (-14.3%)');
  });

  it('every option changes the render', () => {
    const base = renderBlock(TWO_DIM);
    const variants: Record<string, unknown>[] = [
      { orientation: 'v' }, { sort: 'asc' }, { valueLabels: false }, { group: 'stacked' }, { comparePrev: true },
      { color: 4 }, { format: 'percent' }, { axes: 'none' }, { grid: false }, { legend: 'right' },
    ];
    for (const v of variants) expect(renderBlock(TWO_DIM, v), JSON.stringify(v)).not.toBe(base);
  });

  it('fills its cell: the block box pins the chart to the whole cell', () => {
    expect(renderBlock(ONE_DIM)).toMatch(/class="lab-block-fill lab-chart-cell"/);
  });
});

describe('legacy call sites keep working', () => {
  it('the bar render (BarBody) draws the ranked BarList with the tail folded into Other', () => {
    const series = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, points: [{ t: '2026-09-01', v: i + 1 }] }));
    const out = html(createElement(BarBody as never, { summary: { unit: null }, cache: null, series }));
    expect(out).toContain('data-chart="bar-list"');
    expect(out).toContain('>Other (3)<');
    expect(count(out, /data-bar=""/g)).toBe(6);
  });

  it('a host box (the board insight block passes its height) makes the bar render fill it', () => {
    const series = [{ name: 'a', points: [{ t: '1', v: 3 }] }, { name: 'b', points: [{ t: '1', v: 5 }] }];
    const own = html(createElement(BarBody as never, { summary: { unit: null }, cache: null, series }));
    const hosted = html(createElement(BarBody as never, { summary: { unit: null }, cache: null, series, height: 140 }));
    expect(own).toContain('--lab-chart-h:');
    expect(hosted).toContain('data-fill="true"');
    expect(hosted).not.toContain('--lab-chart-h:');
  });

  it('BarList sizes itself to its rows when it does not fill a cell', () => {
    const out = html(createElement(BarList, { rows: ROWS, unit: null }));
    expect(out).toMatch(/class="lab-bar-list" style="--lab-chart-h:\d+px"/);
    expect(html(createElement(BarList, { rows: ROWS, unit: null, fill: true }))).toContain('data-fill="true"');
  });

  it('bar_compare (BarCompareChart) draws grouped columns, one group per bucket, one colour per series', () => {
    const series = [
      { name: 'Previous', points: [{ t: 'Atlantis', v: 40 }, { t: 'Lemuria', v: 10 }] },
      { name: 'Current', points: [{ t: 'Atlantis', v: 50 }, { t: 'Lemuria', v: 20 }] },
    ];
    const out = html(createElement(BarCompareChart, { series, unit: null, groups: ['Atlantis', 'Lemuria'], colorIndex: 2 }));
    expect(count(out, /data-bar=""/g)).toBe(4);
    expect(out).toContain('>Atlantis<');
    expect(out).toContain('fill="var(--viz-cat-2)"');
    expect(out).toContain('fill="var(--viz-cat-3)"');
    expect(out).toContain('data-chart="bar-compare"');
  });
});

// ─── Tokens only ─────────────────────────────────────────────────────────────

describe('lab-bar-pie-heat.css speaks only in tokens', () => {
  it('no hex, no literal colour function, 12/14 type ladder, 400/600 weights, token durations', () => {
    const src = readFileSync(join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/lab-bar-pie-heat.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const bad: string[] = [];
    const re = /(^|[;{\s])(-?[a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g;
    let decls = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const [prop, value] = [m[2], m[3].trim()];
      decls++;
      if (/#[0-9a-f]{3,8}\b/i.test(value)) bad.push(`${prop}: ${value} (hex)`);
      if (/\b(rgba?|hsla?)\(/i.test(value)) bad.push(`${prop}: ${value} (colour fn)`);
      if (prop === 'font-size' && !/^(inherit|var\(--font-size-(xs|sm)\))$/.test(value)) bad.push(`${prop}: ${value}`);
      if (prop === 'font-weight' && !/^(400|600|inherit|var\(--font-weight-(normal|semibold)\))$/.test(value)) bad.push(`${prop}: ${value}`);
      if (/^(transition|animation)/.test(prop) && (value.match(/(?<![\w-])\d*\.?\d+m?s\b/g) ?? []).some((t) => parseFloat(t) !== 0)) bad.push(`${prop}: ${value}`);
    }
    expect(decls).toBeGreaterThan(30);
    expect(bad).toEqual([]);
  });
});
