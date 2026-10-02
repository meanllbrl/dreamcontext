/**
 * The heatmap on the chart foundation (AC "Heatmap"): cell hover tooltip with row /
 * column / value, a sequential or diverging scale from the validated palette (diverging
 * with a neutral midpoint), contrast-safe cell labels, colour, format, collision-free
 * axis labels and a scale legend. Static markup at a fixed measured size; hover is
 * driven by pinning the mark-hover hook.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';

const SIZE = { width: 560, height: 240 };
const hoverState: { active: number | null } = { active: null };

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => (key === 'lab.chart.heatmap.aria' ? 'Heatmap' : key) }),
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
      anchor: hoverState.active === null ? null : { x: 80, y: 60 },
    }),
  };
});

const { HeatmapChart, HeatmapMatrix, HeatmapBody, heatColor, seriesHeatData, tableHeatData, layoutHeat } = await import('../../dashboard/src/components/lab/HeatmapChart.js');
const { HeatmapBlock } = await import('../../dashboard/src/components/lab/blocks/HeatmapBlock.js');
const { estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const days = Array.from({ length: 21 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
const SERIES = [
  { name: 'web', points: days.map((t, i) => ({ t, v: 10 + (i % 7) * 3 })) },
  { name: 'ios', points: days.map((t, i) => ({ t, v: 2 + (i % 3) })) },
];

const TABLE: Frame = {
  kind: 'table', insight: 'margin', dataset: 'by-region-plan', label: 'Margin',
  dims: [{ key: 'region', label: 'Region' }, { key: 'plan', label: 'Plan' }],
  rows: [
    { d: { region: 'Atlantis', plan: 'pro' }, v: 1200 },
    { d: { region: 'Atlantis', plan: 'free' }, v: -300 },
    { d: { region: 'Lemuria', plan: 'pro' }, v: 0 },
    { d: { region: 'Lemuria', plan: 'free' }, v: 450 },
    { d: { region: 'Mu', plan: 'pro' }, v: 800 },
  ],
  sourceTotal: { v: 2150 }, total: { count: 5, v: 2150 }, unit: null,
} as Frame;

const t = TABLE as Extract<Frame, { kind: 'table' }>;

function renderBlock(options: Record<string, unknown> = {}, frame: Frame = TABLE): string {
  return html(createElement(HeatmapBlock as never, { frame, options, block: { type: 'heatmap', data: 'x', options } }));
}

describe('heat colour by job', () => {
  it('diverging: the midpoint is the neutral grey; either side leaves it toward its own pole', () => {
    const c = heatColor([-300, 0, 1200], 'diverging');
    expect(c.color(0)).toBe('var(--viz-div-4)');
    expect(c.color(1200)).toBe('var(--viz-div-7)');
    expect(c.color(-1200)).toBe('var(--viz-div-1)');
    // A small real deviation never reads as "nothing".
    expect(c.color(5)).not.toBe('var(--viz-div-4)');
    expect(c.color(-5)).not.toBe('var(--viz-div-4)');
    expect(c.steps[3]).toBe('var(--viz-div-4)');
    expect(c.mid).toBe(0);
  });

  it('the diverging legend reads the symmetric reach: its red end is -max, not the smallest value', () => {
    const c = heatColor([-300, 1200], 'diverging');
    expect([c.min, c.max]).toEqual([-1200, 1200]);
  });

  it('sequential: slot 1 is the validated blue ramp with its inks; zero-based for magnitudes', () => {
    const c = heatColor([10, 50, 100], 'sequential');
    expect(c.min).toBe(0);
    expect(c.color(100)).toBe('var(--viz-seq-7)');
    expect(c.color(0)).toBe('var(--viz-seq-1)');
    expect(c.ink(100)).toBe('var(--viz-seq-ink-7)');
    expect(c.steps).toHaveLength(7);
  });

  it('the color option picks another hue: the validated 6-step ramp over that slot, an ink per step', () => {
    const c = heatColor([0, 100], 'sequential', 3);
    expect(c.steps).toHaveLength(6);
    expect(c.color(0)).toBe('color-mix(in srgb, var(--viz-cat-3) 16%, var(--viz-surface))');
    expect(c.color(60)).toBe('var(--viz-cat-3)');
    expect(c.color(100)).toBe('color-mix(in srgb, var(--viz-cat-3) 36%, var(--lab-heat-far))');
    // Near the surface: the text token; the full hue: that slot's ink; past the hue: the far ink.
    expect(c.ink(0)).toBe('var(--color-text)');
    expect(c.ink(60)).toBe('var(--lab-cat-ink-3)');
    expect(c.ink(100)).toBe('var(--lab-heat-far-ink)');
  });
});

describe('heat data', () => {
  it('daily series: weekdays down (Monday first), weeks across, summed per day', () => {
    const d = seriesHeatData(SERIES, 'daily', 'en');
    expect(d?.rows.map((r) => r.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    // Sep 1 2026 is a Tuesday: the first column starts Monday Aug 31.
    expect(d?.cols[0].label).toBe('Aug 31');
    expect(d?.cols).toHaveLength(4);
    const sep1 = d?.cells.find((c) => c.title === 'Sep 1, 2026');
    expect(sep1).toMatchObject({ row: 1, col: 0, v: 12, label: 'Tuesday' });
    expect(d?.cells).toHaveLength(21);
  });

  it('non-daily buckets degrade to one strip in time order', () => {
    const weekly = [{ name: 'w', points: [{ t: '2026-09-14', v: 3 }, { t: '2026-09-07', v: 5 }] }];
    const d = seriesHeatData(weekly, 'weekly', 'en');
    expect(d?.rows).toHaveLength(1);
    expect(d?.cells.map((c) => c.v)).toEqual([5, 3]);
  });

  it('a table: first dim down, second across, a missing combination is an empty cell', () => {
    const d = tableHeatData(t.dims, t.rows);
    expect(d?.rows.map((r) => r.label)).toEqual(['Atlantis', 'Lemuria', 'Mu']);
    expect(d?.cols.map((c) => c.label)).toEqual(['pro', 'free']);
    expect(d?.cells.find((c) => c.row === 2 && c.col === 1)?.v).toBeNull();
  });

  it('cells stop growing at their cap in a roomy cell', () => {
    const d = tableHeatData(t.dims, t.rows);
    if (!d) throw new Error('no data');
    const g = layoutHeat({ data: d, width: 1600, height: 900, fontPx: 12, measure: (s: string) => estimateTextWidth(s, 12) });
    expect(g.cellW).toBeLessThanOrEqual(240);
    expect(g.cellH).toBeLessThanOrEqual(120);
  });

  it('cells grow to fill a large cell: a 4x4 grid spans >= 85% of one axis and >= 60% of the other', () => {
    const regions = ['north', 'south', 'east', 'west'];
    const rows = regions.flatMap((region, r) => ['Q1', 'Q2', 'Q3', 'Q4'].map((quarter, q) => ({ d: { region, quarter }, v: 1000 + r * 1700 + q * 600 })));
    const d = tableHeatData([{ key: 'region', label: 'Region' }, { key: 'quarter', label: 'Quarter' }], rows);
    if (!d) throw new Error('no data');
    const [W, H] = [780, 400];
    const g = layoutHeat({ data: d, width: W, height: H, fontPx: 12, measure: (s: string) => estimateTextWidth(s, 12) });
    const spanW = (g.layout.plot.left + g.gridW) / W;
    const spanH = (g.legendY + 12) / H;
    expect(Math.max(spanW, spanH)).toBeGreaterThanOrEqual(0.85);
    expect(Math.min(spanW, spanH)).toBeGreaterThanOrEqual(0.6);
  });
});

describe('the rendered heatmap', () => {
  it('draws cells with a 2px surface gap, labelled axes and a scale legend', () => {
    const out = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: null }));
    expect(count(out, /data-heat-cell=""/g)).toBe(6);
    expect(count(out, /data-empty="true"/g)).toBe(1);
    expect(out.match(/data-axis="y"[\s\S]*?<\/g>/)?.[0]).toContain('>Atlantis<');
    expect(out.match(/data-axis="x"[\s\S]*?<\/g>/)?.[0]).toContain('>pro<');
    expect(out).toContain('data-heat-legend');
    expect(count(out, /data-step="/g)).toBe(7);
    expect(out).toContain('Heatmap');
  });

  it('hover index -> the tooltip names the row and column and reads the value', () => {
    hoverState.active = 0;
    try {
      const out = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: 'EUR', format: 'currency' }));
      const tip = out.match(/data-chart-tooltip[\s\S]*$/)?.[0] ?? '';
      expect(tip).toContain('lab-chart-tooltip-title">Atlantis, pro<');
      expect(tip).toContain('Region: Atlantis');
      expect(tip).toMatch(/data-value="">€1,200.00</);
      expect(out).toMatch(/data-active="true"/);
    } finally {
      hoverState.active = null;
    }
  });

  it('scale: diverging paints the zero cell the neutral grey', () => {
    const seq = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: null }));
    const div = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: null, scale: 'diverging' }));
    expect(div).toMatch(/data-value="0"[^>]*fill="var\(--viz-div-4\)"/);
    expect(seq).not.toContain('var(--viz-div-');
    expect(seq).toContain('var(--viz-seq-');
  });

  it('cellLabels writes values that fit, in the fill\'s contrast ink (or a haloed text token)', () => {
    const off = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: null }));
    const on = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: null, cellLabels: true }));
    expect(count(off, /data-cell-label/g)).toBe(0);
    expect(count(on, /data-cell-label/g)).toBe(5);
    expect(on).toMatch(/data-cell-label=""[^>]*fill="var\(--viz-seq-ink-\d\)"/);
    const hue = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: null, cellLabels: true, colorIndex: 4 }));
    const inks = [...hue.matchAll(/data-cell-label=""[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
    expect(inks.length).toBe(5);
    for (const ink of inks) expect(['var(--color-text)', 'var(--lab-cat-ink-4)', 'var(--lab-heat-far-ink)']).toContain(ink);
  });

  it('format changes the labels and legend', () => {
    const plain = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: null, cellLabels: true }));
    const compact = html(createElement(HeatmapMatrix, { dims: t.dims, rows: t.rows, unit: null, cellLabels: true, format: 'compact' }));
    expect(plain).toContain('>1,200<');
    expect(compact).toContain('>1.2K<');
  });

  it('the weekday grid draws 7 rows of day cells; the legacy render sizes its own box', () => {
    const out = html(createElement(HeatmapChart, { series: SERIES, unit: null, granularity: 'daily' }));
    expect(count(out, /data-heat-cell=""/g)).toBe(21);
    expect(out.match(/data-axis="y"[\s\S]*?<\/g>/)?.[0]).toContain('>Mon<');
    const body = html(createElement(HeatmapBody as never, { summary: { unit: null, granularity: 'daily' }, cache: null, series: SERIES }));
    expect(body).toContain('style="--lab-chart-h:160px"');
  });
});

describe('HeatmapBlock passes every option through', () => {
  it('every option changes the render', () => {
    const base = renderBlock();
    for (const v of [{ scale: 'diverging' }, { cellLabels: true }, { color: 6 }, { format: 'compact' }]) {
      expect(renderBlock(v), JSON.stringify(v)).not.toBe(base);
    }
  });

  it('fills its cell (no scroll box)', () => {
    const out = renderBlock();
    expect(out).toMatch(/class="lab-block-fill lab-chart-cell"/);
    expect(out).not.toContain('lab-block-scroll');
  });
});
