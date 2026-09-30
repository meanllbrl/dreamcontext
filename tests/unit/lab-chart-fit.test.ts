/**
 * The size-adaptive chart policy (demo finding 2): chart/fit.ts decides, from
 * the measured frame, what yields as a cell shrinks (legend first, then axes,
 * then a compact sparkline-style mode), and every chart honours it: line,
 * stacked, bar (rows and columns), pie, heatmap. The pure helpers are asserted
 * directly; the charts are rendered to static markup with the dashboard's own
 * React at a mocked measured size (both the frame and the plot report it), the
 * lab-line-chart.test.ts precedent. The browser half (the real 3x3 / 9x2 / 12x2
 * cells, no clipped text, the floating tooltip) is the WebKit render check.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const SIZE = { width: 560, height: 240 };
vi.mock('../../dashboard/src/components/lab/chart/useChartSize.js', async (orig) => {
  const real = await orig<typeof import('../../dashboard/src/components/lab/chart/useChartSize.js')>();
  const { estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');
  return {
    ...real,
    useChartSize: () => ({
      ref: { current: null }, width: SIZE.width, height: SIZE.height, fontPx: 12, dpr: 2, ready: true,
      measure: (s: string) => estimateTextWidth(s, 12),
    }),
  };
});
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const {
  chartSizeClass, chartFit, compactEndLabels, legendColumnCapacity, legendRowCapacity, COMPACT_PAD,
} = await import('../../dashboard/src/components/lab/chart/fit.js');
const { cartesianLayout, estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');
const { LineChart, lineGeometry, xDomainOf, lastPoint } = await import('../../dashboard/src/components/lab/LineChart.js');
const { StackedChart } = await import('../../dashboard/src/components/lab/StackedChart.js');
const { BarChart } = await import('../../dashboard/src/components/lab/BarChart.js');
const { layoutBars, compactRowCount } = await import('../../dashboard/src/components/lab/BarList.js');
const { PieChart, pieStripGeometry, centerTextFit } = await import('../../dashboard/src/components/lab/PieChart.js');
const { HeatmapChart, HeatmapMatrix, flattenHeat, layoutHeat, tableHeatData } = await import('../../dashboard/src/components/lab/HeatmapChart.js');

const measure = (s: string) => estimateTextWidth(s, 12);
const at = (width: number, height: number) => { SIZE.width = width; SIZE.height = height; };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// The frames the demo measured: 3x3 = 244x72, 9x2 = 818x16, 12x2 = 1106x16, 6x4 = 530x128, 6x6 = 530x240.
const SMALL_3X3 = [244, 72] as const;
const WIDE_9X2 = [818, 16] as const;
const WIDE_12X2 = [1106, 16] as const;

const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
const DAU = [['ios', 18000], ['android', 14000], ['web', 7600]].map(([name, base], s) => ({
  name: name as string, points: days.map((t, i) => ({ t, v: (base as number) + i * 40 + ((i * (s + 3)) % 7) * 90 })),
}));
const ROWS = ['Organic search', 'App Store', 'Referral', 'Paid social', 'Newsletter', 'Partnerships']
  .map((name, i) => ({ name, value: 4800 - i * 800, frac: 0 }));

describe('chartSizeClass: the frame decides, in tick-font heights', () => {
  it('classes the grid extremes the demo measured', () => {
    expect(chartSizeClass(...SMALL_3X3, 12)).toBe('small');
    expect(chartSizeClass(...WIDE_9X2, 12)).toBe('compact');
    expect(chartSizeClass(...WIDE_12X2, 12)).toBe('compact');
    expect(chartSizeClass(530, 128, 12)).toBe('small');
    expect(chartSizeClass(530, 240, 12)).toBe('regular');
  });

  it('a narrow cell is small or compact too; an unmeasured frame is regular (first paint)', () => {
    expect(chartSizeClass(200, 400, 12)).toBe('small');
    expect(chartSizeClass(80, 400, 12)).toBe('compact');
    expect(chartSizeClass(0, 0, 12)).toBe('regular');
  });

  it('follows the zoom: the same box at a larger tick font is one class tighter', () => {
    expect(chartSizeClass(530, 200, 12)).toBe('regular');
    expect(chartSizeClass(530, 200, 18)).toBe('small');
    expect(chartSizeClass(530, 90, 18)).toBe('compact');
  });
});

describe('chartFit: the legend yields first', () => {
  const labels = ['iOS', 'Android', 'Web'];
  const fit = (w: number, h: number, legend: 'top' | 'bottom' | 'right' | 'none' = 'bottom', l: string[] = labels) =>
    chartFit({ width: w, height: h, fontPx: 12, measure, legend, labels: l });

  it('a regular frame keeps the legend exactly as asked (large sizes unchanged)', () => {
    expect(fit(530, 240)).toEqual({ size: 'regular', legend: 'bottom', form: 'wrap', capacity: 3 });
    expect(fit(530, 240, 'right')).toMatchObject({ legend: 'right', form: 'column', capacity: 3 });
    expect(fit(530, 240, 'top')).toMatchObject({ legend: 'top', form: 'wrap' });
  });

  it('a short small frame (3x3) hides it: the tooltip still names every series', () => {
    expect(fit(...SMALL_3X3)).toMatchObject({ size: 'small', legend: 'none' });
  });

  it('a small frame with room keeps ONE row, "+N" when it cannot hold them all', () => {
    expect(fit(300, 130)).toEqual({ size: 'small', legend: 'bottom', form: 'row', capacity: 3 });
    expect(fit(300, 130, 'right')).toMatchObject({ legend: 'bottom', form: 'row' });
    const many = ['Organic search', 'App Store', 'Referral', 'Paid social', 'Newsletter'];
    const f = fit(260, 130, 'bottom', many);
    expect(f.form).toBe('row');
    expect(f.capacity).toBeGreaterThanOrEqual(1);
    expect(f.capacity).toBeLessThan(many.length);
  });

  it('a wide, short small frame takes it beside the plot as a column that fits', () => {
    expect(fit(1100, 72)).toEqual({ size: 'small', legend: 'right', form: 'column', capacity: 3 });
    expect(fit(1100, 72, 'bottom', ['a', 'b', 'c', 'd', 'e', 'f']).capacity).toBe(legendColumnCapacity(72, 12));
  });

  it('a compact frame draws no legend; `none` or a single series never does', () => {
    expect(fit(...WIDE_9X2)).toMatchObject({ size: 'compact', legend: 'none' });
    expect(fit(530, 240, 'none')).toMatchObject({ legend: 'none' });
    expect(fit(530, 240, 'bottom', [])).toMatchObject({ legend: 'none' });
  });

  it('legendRowCapacity leaves room for the "+N" entry', () => {
    const l = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    expect(legendRowCapacity(l, 2000, 12, measure)).toBe(6);
    const k = legendRowCapacity(l, 200, 12, measure);
    const itemW = (s: string) => 12 + 4 + measure(s) + 8;
    const used = l.slice(0, k).reduce((a, s) => a + itemW(s), 0) + 12 * (k - 1) + measure('+6') + 8 + 12;
    expect(used).toBeLessThanOrEqual(200);
    expect(legendRowCapacity(['a very long series name indeed'], 40, 12, measure)).toBe(1);
  });
});

describe('compactEndLabels: direct last-value labels beside a compact mark', () => {
  const item = (id: string, value: string, name = id) => ({ id, color: 'c', shape: 'line' as const, name, value });

  it('flows into the one line a 16px frame has, right-aligned inside the frame', () => {
    const e = compactEndLabels([item('iOS', '19.5K'), item('Android', '15.5K'), item('Web', '8,621')], { width: 818, height: 16, fontPx: 12, measure });
    expect(e.placed.map((p) => p.id)).toEqual(['iOS', 'Android', 'Web']);
    expect(new Set(e.placed.map((p) => p.y)).size).toBe(1);
    expect(e.more).toBe(0);
    for (const p of e.placed) expect(p.x).toBeGreaterThanOrEqual(818 - e.width);
    expect(e.width).toBeLessThanOrEqual(818 * 0.45 + 20);
  });

  it('stacks one per line when there are lines for every item', () => {
    const e = compactEndLabels([item('a', '1'), item('b', '2')], { width: 400, height: 50, fontPx: 12, measure });
    expect(e.placed[0].y).toBeLessThan(e.placed[1].y);
    expect(e.placed[0].x).toBe(e.placed[1].x);
  });

  it('what does not fit becomes "+N" on the last line; a lone overlong name is truncated', () => {
    const many = Array.from({ length: 8 }, (_, i) => item(`series-${i}`, '12,345'));
    const e = compactEndLabels(many, { width: 300, height: 16, fontPx: 12, measure });
    expect(e.more).toBeGreaterThan(0);
    expect(e.placed.length + e.more).toBe(8);
    expect(e.moreAt).not.toBeNull();
    const long = compactEndLabels([item('x', '1', 'An extremely long series name that cannot fit anywhere')], { width: 200, height: 16, fontPx: 12, measure });
    expect(long.placed[0].shownName.endsWith('…')).toBe(true);
  });

  it('nothing to label takes no room', () => {
    expect(compactEndLabels([], { width: 500, height: 16, fontPx: 12, measure }).width).toBe(0);
  });
});

describe('y axis: at least two value labels, or none', () => {
  const base = { width: 300, fontPx: 12, measure, showX: false, showY: true, xTicks: () => [] };
  it('a lone value label is replaced by the two extremes when they sit far enough apart', () => {
    const l = cartesianLayout({ ...base, height: 60, yTicks: (h) => [{ pos: h, label: '0', value: 0 }, { pos: h - 10, label: '5', value: 5 }, { pos: 0, label: '20K', value: 20000 }] });
    expect(l.y.labels.map((t) => t.label)).toEqual(['0', '20K']);
  });
  it('...and dropped (no band) when even they would collide', () => {
    const l = cartesianLayout({ ...base, height: 20, yTicks: (h) => [{ pos: h, label: '0', value: 0 }, { pos: h - 4, label: '5', value: 5 }] });
    expect(l.y.labels).toEqual([]);
    expect(l.y.band).toBe(0);
  });
  it('a lone CATEGORY label (a one-row bar or heat axis) keeps its name', () => {
    const l = cartesianLayout({ ...base, height: 20, yTicks: () => [{ pos: 10, label: 'Only row' }] });
    expect(l.y.labels.map((t) => t.label)).toEqual(['Only row']);
  });
});

describe('line: legend yields at 3x3, compact sparkline mode at a 2-row height', () => {
  it('3x3: no legend, two y labels, a plot of real height', () => {
    at(...SMALL_3X3);
    const html = renderToStaticMarkup(createElement(LineChart, { series: DAU }));
    expect(html).toContain('data-size="small"');
    expect(html).not.toContain('data-chart-legend');
    const y = html.match(/<g class="lab-chart-axis" data-axis="y"[\s\S]*?<\/g>/)?.[0] ?? '';
    expect(count(y, /<text/g)).toBeGreaterThanOrEqual(2);
    const geo = lineGeometry({
      visible: DAU, domain: xDomainOf(DAU), width: 244, height: 72, fontPx: 12, measure, color: () => 'c', curve: 'linear',
      points: 'auto', area: false, zero: false, reference: null, referenceLabel: null, showX: true, showY: true, format: 'auto', unit: null,
    });
    expect(geo?.plot.height).toBeGreaterThanOrEqual(36);
  });

  for (const [label, [w, h]] of [['9x2', WIDE_9X2], ['12x2', WIDE_12X2]] as const) {
    it(`${label}: compact, no axes, no grid, no legend; every line drawn with an end dot and a named last value`, () => {
      at(w, h);
      const html = renderToStaticMarkup(createElement(LineChart, { series: DAU, unit: 'users' }));
      expect(html).toContain('data-size="compact"');
      expect(html).not.toContain('data-chart-legend');
      expect(html).not.toContain('lab-chart-grid');
      expect(html).not.toContain('data-axis');
      expect(count(html, /fill="none" stroke="[^"]*"[^>]*data-series=/g)).toBe(3);
      expect(count(html, /data-point=""/g)).toBe(3);
      expect(count(html, /data-end-label=/g)).toBe(3);
      expect(html).toContain('>ios<');
      // The unit stays in the title: the label budget goes to the number.
      expect(html).not.toMatch(/lab-chart-end-value[^>]*>[^<]*users/);
    });
  }

  it('compact geometry fills the frame height (inset by the end dot) and reserves the labels column', () => {
    const domain = xDomainOf(DAU);
    const endItems = DAU.map((s) => ({ id: s.name, color: 'c', shape: 'line' as const, name: s.name, value: String(lastPoint(s, domain)?.v) }));
    const geo = lineGeometry({
      visible: DAU, domain, width: 818, height: 16, fontPx: 12, measure, color: () => 'c', curve: 'linear', points: 'auto', area: false,
      zero: false, reference: 5, referenceLabel: null, showX: true, showY: true, format: 'auto', unit: null, compact: true, endItems,
    });
    expect(geo?.plot.height).toBe(16 - COMPACT_PAD * 2);
    expect(geo?.plot.width).toBeGreaterThan(818 * 0.5);
    expect((geo?.plot.left ?? 0) + (geo?.plot.width ?? 0)).toBeLessThanOrEqual(818 - (geo?.ends?.width ?? 0));
    expect(geo?.reference).toBeNull();
    expect(geo?.layout.y.labels).toEqual([]);
  });

  it('a regular frame renders exactly as before (no size-policy marks)', () => {
    at(560, 240);
    const html = renderToStaticMarkup(createElement(LineChart, { series: DAU }));
    expect(html).toContain('data-size="regular"');
    expect(html).toContain('data-chart-legend');
    expect(html).not.toContain('data-end-labels');
    expect(html).toContain('data-axis="y"');
  });
});

describe('stacked: compact columns and bands fill the frame', () => {
  for (const mode of ['bar', 'area'] as const) {
    it(`${mode} at 9x2: every layer drawn, no axes, end labels`, () => {
      at(...WIDE_9X2);
      const html = renderToStaticMarkup(createElement(StackedChart, { series: DAU, unit: 'users', mode, fill: true }));
      expect(html).toContain('data-size="compact"');
      expect(html).not.toContain('data-axis');
      expect(html).not.toContain('data-chart-legend');
      expect(count(html, mode === 'bar' ? /data-segment=""/g : /data-band=""/g)).toBe(mode === 'bar' ? 90 : 3);
      expect(count(html, /data-end-label=/g)).toBe(3);
    });
  }
});

describe('bar: rows keep the ones that fit, columns fill the frame', () => {
  const model = {
    categories: ROWS.map((r) => ({ key: r.name, label: r.name })),
    series: [{ id: 'v', label: '', values: ROWS.map((r) => r.value) }],
  };

  it('compact rows: only the rows that fit, "+N" for the rest, names and values kept, no value axis', () => {
    const g = layoutBars({ model, opts: { compact: true, unit: 'signups' }, width: 818, height: 16, fontPx: 12, measure });
    expect(new Set(g.marks.map((m) => m.cat)).size).toBe(compactRowCount(16, 12));
    expect(g.ends?.more).toBe(ROWS.length - compactRowCount(16, 12));
    expect(g.layout.x.labels).toEqual([]);
    expect(g.layout.y.labels.map((l) => l.label)).toEqual(['Organic search']);
    expect(g.labels[0].text).toBe('4,800');
  });

  it('small rows (3x3): every drawn row keeps its name, the value axis yields to the value labels', () => {
    const g = layoutBars({ model, opts: { small: true, unit: 'signups' }, width: 244, height: 72, fontPx: 12, measure });
    const drawn = new Set(g.marks.map((m) => m.cat)).size;
    expect(drawn).toBeGreaterThanOrEqual(3);
    expect(drawn).toBeLessThan(ROWS.length);
    expect(g.layout.y.labels.length).toBe(drawn);
    expect(g.layout.x.labels).toEqual([]);
    expect(g.ends?.more).toBe(ROWS.length - drawn);
  });

  it('compact columns: no axes, no value labels, the columns span the frame height', () => {
    const g = layoutBars({ model, opts: { compact: true, orientation: 'v' }, width: 818, height: 16, fontPx: 12, measure });
    expect(g.marks).toHaveLength(ROWS.length);
    expect(g.labels).toEqual([]);
    expect(g.layout.y.labels).toEqual([]);
    expect(g.layout.x.labels).toEqual([]);
    expect(g.plot.height).toBe(16 - COMPACT_PAD * 2);
  });

  it('compact grouped columns name their series on the right instead of a legend', () => {
    at(...WIDE_12X2);
    const grouped = {
      categories: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
      series: [{ id: 'W1', label: 'W1', values: [5, 6] }, { id: 'W2', label: 'W2', values: [3, 4] }],
    };
    const html = renderToStaticMarkup(createElement(BarChart, { model: grouped, unit: null, orientation: 'v' }));
    expect(html).toContain('data-size="compact"');
    expect(html).not.toContain('data-chart-legend');
    expect(count(html, /data-end-label=/g)).toBe(2);
    expect(count(html, /data-bar=""/g)).toBe(4);
  });

  it('regular bars are unchanged: every row, the value axis, no "+N"', () => {
    const g = layoutBars({ model, opts: {}, width: 560, height: 260, fontPx: 12, measure });
    expect(new Set(g.marks.map((m) => m.cat)).size).toBe(ROWS.length);
    expect(g.ends).toBeNull();
    expect(g.layout.x.labels.length).toBeGreaterThan(1);
  });
});

describe('pie: a compact frame draws the shares as one strip; the donut text only where it fits', () => {
  const slices = [['Free', 61200], ['Plus', 9400], ['Pro', 5100], ['Team', 1800]].map(([id, value]) => ({ id: id as string, label: id as string, value: value as number }));

  it('pieStripGeometry: segments in order span the width with 2px gaps; labels only where they fit', () => {
    const s = pieStripGeometry({ slices, width: 818, height: 16, fontPx: 12, measure });
    expect(s.segments.map((g) => g.id)).toEqual(['Free', 'Plus', 'Pro', 'Team']);
    const last = s.segments[s.segments.length - 1];
    expect(last.x + last.w).toBeCloseTo(818, 0);
    expect(s.segments[1].x - (s.segments[0].x + s.segments[0].w)).toBeCloseTo(2, 5);
    expect(s.segments[0].label).toBe('Free 79%');
    expect(last.label).toBeNull();
    expect(s.top).toBeGreaterThanOrEqual(0);
    expect(s.top + s.thickness).toBeLessThanOrEqual(16);
  });

  it('renders the strip (no pie, no legend) at 9x2, and a pie at 6x6', () => {
    at(...WIDE_9X2);
    const rows = slices.map((s) => ({ name: s.id, value: s.value, frac: 0 }));
    const strip = renderToStaticMarkup(createElement(PieChart, { rows, donut: true, centerTotal: true }));
    expect(strip).toContain('data-pie-form="strip"');
    expect(count(strip, /lab-pie-strip-seg/g)).toBe(4);
    expect(strip).not.toContain('data-chart-legend');
    expect(strip).not.toContain('data-center-total');
    at(530, 240);
    const pie = renderToStaticMarkup(createElement(PieChart, { rows, donut: true, centerTotal: true }));
    expect(pie).toContain('data-pie-form="pie"');
    expect(pie).toContain('data-center-total');
  });

  it('centerTextFit: a small hole drops the caption first, then the figure', () => {
    expect(centerTextFit(60, '77.5K', 12, 22, measure)).toEqual({ value: true, caption: true });
    expect(centerTextFit(22, '77.5K', 12, 13, measure)).toEqual({ value: true, caption: false });
    expect(centerTextFit(10, '77.5K', 12, 13, measure)).toEqual({ value: false, caption: false });
  });
});

describe('heatmap: a compact frame draws one strip of cells, no axes, no scale legend', () => {
  const matrix = tableHeatData(
    [{ key: 'cohort', label: 'Cohort' }, { key: 'week', label: 'Week' }],
    [['Aug 03', 'W1', 58], ['Aug 03', 'W2', 47], ['Aug 10', 'W1', 59], ['Aug 10', 'W2', 48]].map(([cohort, week, v]) => ({ d: { cohort: cohort as string, week: week as string }, v: v as number })),
  );

  it('flattenHeat keeps every cell, in row order, each with its own title', () => {
    const flat = flattenHeat(matrix!);
    expect(flat.rows).toHaveLength(1);
    expect(flat.cells.map((c) => [c.col, c.v])).toEqual([[0, 58], [1, 47], [2, 59], [3, 48]]);
    expect(flat.cols.map((c) => c.label)).toEqual(['Aug 03, W1', 'Aug 03, W2', 'Aug 10, W1', 'Aug 10, W2']);
  });

  it('layoutHeat compact: the cells fill the frame, no axis labels, no legend band', () => {
    const g = layoutHeat({ data: flattenHeat(matrix!), width: 818, height: 16, fontPx: 12, measure, compact: true });
    expect(g.layout.x.labels).toEqual([]);
    expect(g.legendBand).toBe(0);
    expect(g.gridH).toBeGreaterThanOrEqual(12);
  });

  it('renders the matrix as a strip at 9x2 and the weekday grid as a day strip', () => {
    at(...WIDE_9X2);
    const m = renderToStaticMarkup(createElement(HeatmapMatrix, {
      dims: [{ key: 'cohort', label: 'Cohort' }, { key: 'week', label: 'Week' }],
      rows: [{ d: { cohort: 'Aug 03', week: 'W1' }, v: 58 }, { d: { cohort: 'Aug 10', week: 'W1' }, v: 59 }], unit: '%',
    }));
    expect(m).toContain('data-heat-form="strip"');
    expect(m).not.toContain('data-heat-legend');
    expect(m).not.toContain('data-axis="x"');
    const d = renderToStaticMarkup(createElement(HeatmapChart, { series: DAU, unit: 'users', granularity: 'daily' }));
    expect(d).toContain('data-heat-form="strip"');
    expect(count(d, /data-heat-cell=""/g)).toBe(30);
  });

  it('small (3x3): the scale legend yields and a too-thin weekday grid becomes the day strip, axes kept', () => {
    at(...SMALL_3X3);
    const d = renderToStaticMarkup(createElement(HeatmapChart, { series: DAU, unit: 'users', granularity: 'daily' }));
    expect(d).toContain('data-size="small"');
    expect(d).toContain('data-heat-form="strip"');
    expect(d).not.toContain('data-heat-legend');
    expect(d).toContain('data-axis="x"');
    at(560, 240);
    const big = renderToStaticMarkup(createElement(HeatmapChart, { series: DAU, unit: 'users', granularity: 'daily' }));
    expect(big).toContain('data-heat-form="grid"');
    expect(big).toContain('data-heat-legend');
  });
});
