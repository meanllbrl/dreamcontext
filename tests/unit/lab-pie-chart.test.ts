/**
 * The pie on the chart foundation (AC "Pie"): slice hover highlights and reads out value
 * and share, a 2px surface gap between slices, donut, a centre total that follows the
 * hover, legend / outside (collision-free leader lines) / inside / no labels, top N with
 * Other, sort, colour start, format, and the >= 7-slice degrade to bars kept. Static
 * markup at a fixed measured size; hover is driven by pinning the mark-hover hook.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';

const SIZE = { width: 480, height: 240 };
const hoverState: { active: number | null } = { active: null };

const COPY: Record<string, string> = {
  'lab.blocks.other': 'Other',
  'lab.blocks.otherCount': 'Other ({n})',
  'lab.chart.totalCaption': 'Total',
  'lab.chart.share': 'Share: {pct}',
  'lab.chart.pie.aria': 'Pie chart',
  'lab.chart.donut.aria': 'Donut chart',
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
    useMarkHover: (...a: Parameters<typeof real.useMarkHover>) => ({
      ...real.useMarkHover(...a),
      active: hoverState.active,
      anchor: hoverState.active === null ? null : { x: 100, y: 100 },
    }),
  };
});

const { PieChart, PieBody, pieGeometry, slicePath, shareText } = await import('../../dashboard/src/components/lab/PieChart.js');
const { PieBlock, pieRowsFromFrame } = await import('../../dashboard/src/components/lab/blocks/PieBlock.js');
const { estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const measure = (s: string) => estimateTextWidth(s, 12);

const ROWS = [
  { name: 'organic', value: 490, frac: 0.49, color: '' },
  { name: 'direct', value: 286, frac: 0.286, color: '' },
  { name: 'referral', value: 147, frac: 0.147, color: '' },
  { name: 'social', value: 77, frac: 0.077, color: '' },
];

const TABLE: Frame = {
  kind: 'table', insight: 'traffic', dataset: 'by-source', label: 'Visits',
  dims: [{ key: 'source', label: 'Source' }],
  rows: [
    { d: { source: 'direct' }, v: 286 },
    { d: { source: 'organic' }, v: 490 },
    { d: { source: 'referral' }, v: 147 },
    { d: { source: 'Other' }, v: 77, other: 4 },
  ],
  sourceTotal: { v: 1000 }, total: { count: 4, v: 1000 }, unit: null,
} as Frame;

function renderBlock(options: Record<string, unknown> = {}, frame: Frame = TABLE): string {
  return html(createElement(PieBlock as never, { frame, options, block: { type: 'pie', data: 'x', options } }));
}

function withHover<T>(i: number, fn: () => T): T {
  hoverState.active = i;
  try {
    return fn();
  } finally {
    hoverState.active = null;
  }
}

describe('pie geometry', () => {
  it('slices are clockwise from 12 o\'clock and sum to the whole circle', () => {
    const g = pieGeometry({ slices: ROWS.map((r) => ({ id: r.name, label: r.name, value: r.value })), width: 300, height: 200, fontPx: 12, measure, hole: false, labels: 'legend' });
    expect(g.arcs[0].a0).toBeCloseTo(-Math.PI / 2);
    expect(g.arcs[g.arcs.length - 1].a1).toBeCloseTo(Math.PI * 1.5);
    expect(g.total).toBe(1000);
    expect(g.arcs.map((a) => a.share)).toEqual([0.49, 0.286, 0.147, 0.077]);
  });

  it('a lone slice is a full disc (two half arcs), a lone donut slice a full ring', () => {
    expect(count(slicePath(50, 50, 40, 0, 0, Math.PI * 2), /A/g)).toBe(2);
    expect(count(slicePath(50, 50, 40, 24, 0, Math.PI * 2), /A/g)).toBe(4);
  });

  it('outside labels never overlap on either side, and each has a leader line', () => {
    const many = [40, 3, 2, 2, 1, 1].map((v, i) => ({ id: `s${i}`, label: `Source ${i}`, value: v }));
    const g = pieGeometry({ slices: many, width: 480, height: 240, fontPx: 12, measure, hole: false, labels: 'outside' });
    expect(g.outside).toHaveLength(6);
    for (const anchor of ['start', 'end'] as const) {
      const ys = g.outside.filter((l) => l.anchor === anchor).map((l) => l.y).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(12 * 1.4 - 1e-9);
      for (const y of ys) {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(240);
      }
    }
    for (const l of g.outside) expect(l.leader).toMatch(/^M[\d.]+,[\d.]+L[\d.]+,[\d.]+L[\d.]+,[\d.]+$/);
    // Room for the labels: the radius shrinks versus the legend layout.
    const legend = pieGeometry({ slices: many, width: 480, height: 240, fontPx: 12, measure, hole: false, labels: 'legend' });
    expect(g.r).toBeLessThanOrEqual(legend.r);
  });

  it('inside labels carry the slice name where a second line fits (identity is never colour alone)', () => {
    const slices = [{ id: 'a', label: 'organic', value: 60 }, { id: 'b', label: 'direct', value: 40 }];
    const g = pieGeometry({ slices, width: 300, height: 240, fontPx: 12, measure, hole: false, labels: 'inside' });
    expect(g.inside.map((l) => l.name)).toEqual(['organic', 'direct']);
  });

  it('inside labels only go where they fit', () => {
    const slices = [{ id: 'big', label: 'big', value: 95 }, { id: 'tiny', label: 'tiny', value: 5 }];
    const g = pieGeometry({ slices, width: 300, height: 240, fontPx: 12, measure, hole: false, labels: 'inside' });
    expect(g.inside.map((l) => l.id)).toEqual(['big']);
    expect(shareText(0.049, 'en')).toBe('4.9%');
    expect(shareText(0.49, 'en')).toBe('49%');
  });
});

describe('PieChart', () => {
  it('slices are split by a 2px surface gap and coloured from the validated palette', () => {
    const out = html(createElement(PieChart, { rows: ROWS }));
    expect(count(out, /class="lab-pie-slice"/g)).toBe(4);
    expect(out).toContain('fill="var(--viz-cat-1)"');
    expect(out).toContain('fill="var(--viz-cat-4)"');
    // The gap is the stylesheet's surface stroke on every slice (lab-bar-pie-heat.css .lab-pie-slice).
    expect(out).toContain('width="480" height="240"');
  });

  it('hover lifts the slice, dims the others, and the tooltip reads value and share', () => {
    const out = withHover(1, () => html(createElement(PieChart, { rows: ROWS, format: 'number' })));
    expect(count(out, /data-dim="true"/g)).toBe(3);
    expect(out).toMatch(/data-slice="direct"[^>]*data-share/);
    expect(out).toMatch(/<path class="lab-pie-slice"[^>]*transform="translate\([^"]+\)"[^>]*data-slice="direct"/);
    const tip = out.match(/data-chart-tooltip[\s\S]*$/)?.[0] ?? '';
    expect(tip).toContain('lab-chart-tooltip-title">direct<');
    expect(tip).toMatch(/data-value="">286</);
    expect(tip).toContain('Share: 29%');
  });

  it('donut draws ring sectors (each slice two arcs); pie one', () => {
    const pie = html(createElement(PieChart, { rows: ROWS }));
    const donut = html(createElement(PieChart, { rows: ROWS, donut: true }));
    expect(pie).not.toContain('data-donut');
    expect(donut).toContain('data-donut');
    const arcs = (s: string) => count(s, /A[\d.]+,[\d.]+ 0 [01] [01] /g);
    expect(arcs(pie)).toBe(4);
    expect(arcs(donut)).toBe(8);
    expect(donut).toContain('Donut chart');
  });

  it('centerTotal writes the formatted total in the hole; hovering shows that slice there', () => {
    const out = html(createElement(PieChart, { rows: ROWS, centerTotal: true, format: 'number' }));
    const center = out.match(/data-center-total=""[\s\S]*?<\/g>/)?.[0] ?? '';
    expect(center).toContain('>1,000<');
    expect(center).toContain('>Total<');
    expect(out).toContain('data-donut');
    const hovered = withHover(0, () => html(createElement(PieChart, { rows: ROWS, centerTotal: true, format: 'number' })));
    const hc = hovered.match(/data-center-total=""[\s\S]*?<\/g>/)?.[0] ?? '';
    expect(hc).toContain('>490<');
    expect(hc).toContain('>organic<');
    expect(html(createElement(PieChart, { rows: ROWS }))).not.toContain('data-center-total');
  });

  it('labels: legend (toggle buttons with shares), outside (leader lines), inside, none', () => {
    const legend = html(createElement(PieChart, { rows: ROWS }));
    expect(count(legend, /class="lab-chart-legend-item"/g)).toBe(4);
    expect(legend).toContain('organic 49%');
    const outside = html(createElement(PieChart, { rows: ROWS, labels: 'outside' }));
    expect(outside).not.toContain('lab-chart-legend');
    expect(count(outside, /class="lab-pie-leader"/g)).toBe(4);
    const inside = html(createElement(PieChart, { rows: ROWS, labels: 'inside' }));
    expect(count(inside, /data-pie-label="inside"/g)).toBeGreaterThanOrEqual(2);
    // Inside text wears the contrast-safe ink token for its slot, never the slice colour.
    expect(inside).toMatch(/data-pie-label="inside"[^>]*fill="var\(--lab-cat-ink-1\)"/);
    const none = html(createElement(PieChart, { rows: ROWS, labels: 'none' }));
    expect(none).not.toContain('lab-chart-legend');
    expect(none).not.toContain('data-pie-label');
  });

  it('colorIndex starts the palette at that slot; format drives the readouts', () => {
    const out = html(createElement(PieChart, { rows: ROWS, colorIndex: 3 }));
    expect(out).toContain('fill="var(--viz-cat-3)"');
    expect(out).not.toContain('fill="var(--viz-cat-1)"');
    const cur = withHover(0, () => html(createElement(PieChart, { rows: ROWS, unit: 'EUR', format: 'currency' })));
    expect(cur).toContain('€490.00');
  });

  it('seven or more slices still degrade to the bar list, donut or not', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `s${i}`, points: [{ t: '', v: i + 1 }] }));
    const out = html(createElement(PieChart, { series: many, donut: true }));
    expect(out).not.toContain('Donut chart');
    expect(out).toContain('data-chart="bar-list"');
    expect(out).toContain('data-fill="true"');
  });

  it('a host box (the board insight block passes its height) makes the pie render fill it', () => {
    const series = [{ name: 'a', points: [{ t: '1', v: 2 }] }, { name: 'b', points: [{ t: '1', v: 8 }] }];
    const out = html(createElement(PieBody as never, { summary: { unit: null }, cache: null, series, height: 150 }));
    expect(out).not.toContain('--lab-chart-h:');
    expect(out).toContain('class="lab-pie-box"');
  });

  it('the legacy pie render sizes its own box and ranks slices largest first', () => {
    const series = [{ name: 'small', points: [{ t: '1', v: 2 }] }, { name: 'large', points: [{ t: '1', v: 8 }] }];
    const out = html(createElement(PieBody as never, { summary: { unit: null }, cache: null, series }));
    expect(out).toContain('style="--lab-chart-h:170px"');
    expect(out.indexOf('data-slice="large"')).toBeLessThan(out.indexOf('data-slice="small"'));
  });
});

describe('PieBlock passes every option through', () => {
  it('sort: missing ranks largest first, asc, none keeps the frame; Other is grey and last', () => {
    const order = (o: Record<string, unknown>) => [...renderBlock(o).matchAll(/data-slice="([^"]+)"/g)].map((m) => m[1]);
    expect(order({})).toEqual(['organic', 'direct', 'referral', 'Other (4)']);
    expect(order({ sort: 'asc' })).toEqual(['referral', 'direct', 'organic', 'Other (4)']);
    expect(order({ sort: 'none' })).toEqual(['direct', 'organic', 'referral', 'Other (4)']);
    expect(renderBlock()).toMatch(/fill="var\(--viz-other\)"[^>]*data-slice="Other \(4\)"/);
    expect(pieRowsFromFrame(TABLE, 'rank').map((r) => r.other ?? null)).toEqual([null, null, null, 4]);
  });

  it('every option changes the render', () => {
    const base = renderBlock();
    const variants: Record<string, unknown>[] = [
      { donut: true }, { centerTotal: true }, { labels: 'outside' }, { labels: 'inside' }, { labels: 'none' },
      { sort: 'asc' }, { color: 5 }, { format: 'percent' },
    ];
    for (const v of variants) expect(renderBlock(v), JSON.stringify(v)).not.toBe(base);
  });

  it('fills its cell', () => {
    expect(renderBlock()).toMatch(/class="lab-block-fill lab-chart-cell"/);
  });
});
