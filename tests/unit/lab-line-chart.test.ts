/**
 * LineChart and Sparkline on the chart foundation: every line option changes the
 * render (axes, grid, curve, points, area, yMin, reference, legend, format, series
 * pick, colour start), colours follow the entity through a pick or a legend toggle,
 * and the crosshair readout lists every visible series at a hovered x in a fixed
 * order. Rendered to static markup with the dashboard's own React at a fixed
 * measured size (the lab-chart-compose.test.ts precedent); the pure geometry and
 * tooltip helpers are asserted directly. The browser half (real hover, fit, no
 * scroll) is scripts/verify/lab-boards.mjs.
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
      ref: { current: null }, ...SIZE, fontPx: 12, dpr: 2, ready: true,
      measure: (s: string) => estimateTextWidth(s, 12),
    }),
  };
});
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const {
  LineChart, LineBody, curvePath, areaPath, lineGeometry, lineTooltipRows, xDomainOf, pickSeries, seriesLabel,
} = await import('../../dashboard/src/components/lab/LineChart.js');
const { Sparkline } = await import('../../dashboard/src/components/lab/Sparkline.js');
const { LineBlock } = await import('../../dashboard/src/components/lab/blocks/LineBlock.js');
const { colorScale } = await import('../../dashboard/src/components/lab/chart/palette.js');
const { estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');

const SERIES = [
  { name: 'web', points: [{ t: '2026-09-01', v: 10 }, { t: '2026-09-02', v: 14 }, { t: '2026-09-03', v: 12 }] },
  { name: 'ios', points: [{ t: '2026-09-01', v: 4 }, { t: '2026-09-02', v: 6 }, { t: '2026-09-03', v: 9 }] },
  { name: 'android', points: [{ t: '2026-09-01', v: 2 }, { t: '2026-09-03', v: 5 }] },
];
const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
const DENSE = [{ name: 'web', points: days.map((t, i) => ({ t, v: 1000 + i * 40 })) }];

const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(LineChart, { series: SERIES, ...props }));
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const linePaths = (html: string) => html.match(/<path d="[^"]*" fill="none" stroke="[^"]*"[^>]*data-series="[^"]*"/g) ?? [];
const yAxis = (html: string) => html.match(/<g class="lab-chart-axis" data-axis="y"[\s\S]*?<\/g>/)?.[0] ?? '';
const xAxis = (html: string) => html.match(/<g class="lab-chart-axis" data-axis="x"[\s\S]*?<\/g>/)?.[0] ?? '';

describe('LineChart axes and grid', () => {
  it('draws formatted y ticks, calendar x ticks and recessive gridlines by default', () => {
    const html = render();
    expect(html).toContain('width="560" height="240" viewBox="0 0 560 240"');
    expect(yAxis(html)).toMatch(/>1[0-9]</);
    expect(xAxis(html)).toContain('Sep ');
    expect(xAxis(html)).toContain('lab-chart-axis-line');
    expect(html).toContain('class="lab-chart-grid"');
  });

  it('axes both | x | y | none and grid off each change the render', () => {
    const x = render({ axes: 'x' });
    expect(x).not.toContain('data-axis="y"');
    expect(xAxis(x)).toContain('Sep ');
    const y = render({ axes: 'y' });
    expect(yAxis(y)).not.toBe('');
    expect(xAxis(y)).not.toContain('<text');
    const none = render({ axes: 'none' });
    expect(none).not.toContain('data-axis="y"');
    expect(xAxis(none)).not.toContain('<text');
    expect(render({ grid: false })).not.toContain('lab-chart-grid');
  });

  it('a hidden axis leaves room so the edge tick label and edge markers are never cut', () => {
    const geo = (showX: boolean, showY: boolean) => lineGeometry({
      visible: SERIES, domain: xDomainOf(SERIES), width: 560, height: 240, fontPx: 12, measure: (s) => estimateTextWidth(s, 12),
      color: () => 'c', curve: 'linear', points: 'always', area: false, zero: false, reference: null, referenceLabel: null,
      showX, showY, format: 'auto', unit: null,
    })!;
    const yOnly = geo(false, true);
    expect(240 - (yOnly.plot.top + yOnly.plot.height)).toBeGreaterThanOrEqual(6 + 2);
    const none = geo(false, false);
    expect(none.plot.left).toBeGreaterThanOrEqual(6);
    expect(Math.min(...none.lines.flatMap((l) => l.dots.map((d) => d.x)))).toBeGreaterThanOrEqual(6);
  });

  it('yMin zero pins the axis at 0; auto fits the data', () => {
    const series = [{ name: 'web', points: [{ t: '2026-09-01', v: 1000 }, { t: '2026-09-02', v: 1200 }] }];
    expect(yAxis(render({ series, yMin: 'zero' }))).toMatch(/>0</);
    expect(yAxis(render({ series }))).not.toMatch(/>0</);
  });

  it('format changes the tick and tooltip figures', () => {
    const series = [{ name: 'web', points: [{ t: '2026-09-01', v: 12000 }, { t: '2026-09-02', v: 18000 }] }];
    expect(yAxis(render({ series, format: 'number' }))).toMatch(/>1[0-9],000</);
    expect(yAxis(render({ series, format: 'compact' }))).toMatch(/>1[0-9]K</);
  });
});

describe('LineChart curve, points, area, reference', () => {
  it('curve linear | smooth | step draw different path commands', () => {
    const d = (curve: string) => linePaths(render({ curve }))[0];
    expect(d('linear')).toMatch(/d="M[\d.,]+L/);
    expect(d('linear')).not.toMatch(/[CHV]/);
    expect(d('smooth')).toMatch(/C[\d.]/);
    expect(d('step')).toMatch(/H[\d.]+V[\d.]/);
  });

  it('the smooth curve never overshoots a datum (monotone)', () => {
    const pts = [[0, 100], [10, 50], [20, 50], [30, 0]] as const;
    const nums = curvePath(pts, 'smooth').match(/-?[\d.]+/g)!.map(Number);
    const ys = nums.filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it('points always | never | auto (auto = only when the points are far enough apart)', () => {
    expect(count(render({ points: 'always' }), /data-point=""/g)).toBe(8);
    expect(count(render({ points: 'never' }), /data-point=""/g)).toBe(0);
    expect(count(render({ points: 'auto' }), /data-point=""/g)).toBe(8);
    const dense = (points: string) => renderToStaticMarkup(createElement(LineChart, { series: DENSE, points }));
    expect(count(dense('auto'), /data-point=""/g)).toBe(0);
    expect(count(dense('always'), /data-point=""/g)).toBe(30);
  });

  it('area fills under each line with a translucent wash of its hue', () => {
    expect(count(render(), /data-area/g)).toBe(0);
    const html = render({ area: true });
    expect(count(html, /data-area/g)).toBe(3);
    expect(html).toMatch(/data-area="" d="[^"]+Z" fill="var\(--viz-cat-1\)" fill-opacity="0.1"/);
    expect(areaPath([[0, 5], [10, 2]], 'linear', 20)).toBe('M0,5L10,2L10,20L0,20Z');
  });

  it('a reference value draws a dashed line with a direct label, inside the y domain', () => {
    expect(render()).not.toContain('data-reference');
    const html = render({ reference: 40, referenceLabel: 'Target' });
    expect(html).toContain('data-reference');
    expect(html).toContain('stroke-dasharray="4 3"');
    expect(html).toContain('>Target 40<');
    expect(yAxis(html)).toMatch(/>40</);
    expect(render({ reference: 11 })).toMatch(/data-reference[\s\S]*?>11</);
  });
});

describe('LineChart legend and colour', () => {
  it('legend position top | bottom | right | none; a single series gets none', () => {
    expect(render()).toContain('data-legend="bottom"');
    expect(render({ legend: 'right' })).toContain('data-legend="right"');
    expect(render({ legend: 'top' })).toContain('data-legend="top"');
    expect(render({ legend: 'none' })).not.toContain('lab-chart-legend');
    expect(renderToStaticMarkup(createElement(LineChart, { series: DENSE }))).not.toContain('lab-chart-legend');
    expect(count(render(), /aria-pressed="true"/g)).toBe(3);
  });

  it('colour start shifts the first series slot', () => {
    expect(linePaths(render())[0]).toContain('stroke="var(--viz-cat-1)"');
    const shifted = render({ colorIndex: 3 });
    expect(linePaths(shifted)[0]).toContain('stroke="var(--viz-cat-3)"');
    expect(shifted).not.toContain('stroke="var(--viz-cat-1)"');
  });

  it('the series pick keeps only the named lines, in pick order, without repainting them', () => {
    const html = render({ seriesFilter: ['android', 'web'] });
    const paths = linePaths(html);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('data-series="android"');
    expect(paths[0]).toContain('stroke="var(--viz-cat-3)"');
    expect(paths[1]).toContain('stroke="var(--viz-cat-1)"');
    expect(pickSeries(SERIES, ['nope', 'ios']).map((s) => s.name)).toEqual(['ios']);
  });

  it('a legend toggle hides a series without recolouring the others', () => {
    const colors = colorScale(SERIES.map((s) => s.name));
    const base = {
      domain: xDomainOf(SERIES), width: 560, height: 240, fontPx: 12, measure: (s: string) => estimateTextWidth(s, 12),
      color: colors.color, curve: 'linear' as const, points: 'auto' as const, area: false, zero: false,
      reference: null, referenceLabel: null, showX: true, showY: true, format: 'auto' as const, unit: null,
    };
    const all = lineGeometry({ ...base, visible: SERIES })!;
    const toggled = lineGeometry({ ...base, visible: [SERIES[0], SERIES[2]] })!;
    expect(all.lines.map((l) => l.color)).toEqual(['var(--viz-cat-1)', 'var(--viz-cat-2)', 'var(--viz-cat-3)']);
    expect(toggled.lines.map((l) => [l.name, l.color])).toEqual([['web', 'var(--viz-cat-1)'], ['android', 'var(--viz-cat-3)']]);
  });

  it('a folded Other series wears the Other grey and its localized label', () => {
    const series = [...SERIES.slice(0, 2), { name: 'Other', other: 4, points: SERIES[2].points }];
    const html = render({ series });
    expect(html).toContain('stroke="var(--viz-other)"');
    expect(html).toContain('lab.blocks.otherCount');
    expect(seriesLabel({ name: 'Other', points: [], other: 0 }, (k) => k)).toBe('lab.blocks.other');
  });
});

describe('LineChart hover readout', () => {
  it('lists every visible series at the hovered x in fixed order, formatted; a missing point is a dim dash', () => {
    const colors = colorScale(SERIES.map((s) => s.name));
    const rows = lineTooltipRows(SERIES, '2026-09-02', { color: colors.color, label: (s) => s.name, format: 'auto', unit: 'users', locale: 'en' });
    expect(rows.map((r) => [r.id, r.value, r.dim])).toEqual([
      ['web', '14 users', false],
      ['ios', '6 users', false],
      ['android', '-', true],
    ]);
    expect(rows[0].color).toBe('var(--viz-cat-1)');
    expect(rows.every((r) => r.shape === 'line')).toBe(true);
    // One series: its name is the title's job, the row carries only the value.
    expect(lineTooltipRows([SERIES[0]], '2026-09-01', { color: colors.color, label: (s) => s.name, format: 'compact', unit: null })[0])
      .toMatchObject({ label: '', value: '10' });
  });

  it('the hover positions are the rendered x of each key (the pointer maps to the nearest one)', () => {
    const geo = lineGeometry({
      visible: SERIES, domain: xDomainOf(SERIES), width: 560, height: 240, fontPx: 12, measure: (s) => estimateTextWidth(s, 12),
      color: () => 'x', curve: 'linear', points: 'auto', area: false, zero: false, reference: null, referenceLabel: null,
      showX: true, showY: true, format: 'auto', unit: null,
    })!;
    expect(geo.xs).toHaveLength(3);
    expect(geo.xs[0]).toBe(0);
    expect(geo.xs[2]).toBeCloseTo(geo.plot.width, 5);
    expect(geo.xs[1]).toBeCloseTo(geo.plot.width / 2, 5);
  });
});

describe('LineChart call sites and the block', () => {
  it('a fixed height (legacy card / panel) gets its own box', () => {
    const summary = { unit: null } as never;
    expect(renderToStaticMarkup(createElement(LineBody, { summary, series: SERIES } as never))).toContain('style="height:200px');
    expect(renderToStaticMarkup(createElement(LineBody, { summary, series: SERIES, full: true } as never))).toContain('style="height:340px');
  });

  it('a host box (the insight block passes `height`) makes the body fill it, not draw at 200px', () => {
    const summary = { unit: null } as never;
    const html = renderToStaticMarkup(createElement(LineBody, { summary, series: SERIES, height: 180 } as never));
    expect(html).not.toContain('style="height');
    expect(html.startsWith('<div class="lab-chart"')).toBe(true);
  });

  it('LineBlock passes every option through and fills the cell', () => {
    const frame = { kind: 'series', insight: 'i', series: SERIES, unit: null, granularity: 'day' };
    const block = (options: Record<string, unknown>) => renderToStaticMarkup(createElement(LineBlock as never, { frame, options, block: { type: 'line', options } }));
    const plain = block({});
    expect(plain).toContain('class="lab-block-fill"');
    expect(plain).not.toContain('style="height');
    const all = block({ curve: 'step', points: 'never', area: true, yMin: 'zero', reference: 20, referenceLabel: 'Goal', legend: 'top', axes: 'x', grid: false, color: 2, format: 'number' });
    expect(all).toContain('data-curve="step"');
    expect(count(all, /data-point=""/g)).toBe(0);
    expect(count(all, /data-area/g)).toBe(3);
    expect(all).toContain('>Goal 20<');
    expect(all).toContain('data-legend="top"');
    expect(all).not.toContain('data-axis="y"');
    expect(all).not.toContain('lab-chart-grid');
    expect(all).toContain('stroke="var(--viz-cat-2)"');
    expect(block({}).match(/data-curve="linear"/)).not.toBeNull();
  });
});

describe('Sparkline', () => {
  const pts = [{ t: '2026-09-01', v: 1 }, { t: '2026-09-02', v: 3 }, { t: '2026-09-03', v: 2 }];
  it('is a glyph: no axes, a path, and an optional last-point dot', () => {
    const html = renderToStaticMarkup(createElement(Sparkline, { points: pts }));
    expect(html).not.toContain('data-axis');
    expect(html).toMatch(/<path d="M2,16L/);
    expect(html).toContain('data-spark-dot');
    expect(renderToStaticMarkup(createElement(Sparkline, { points: pts, dot: false }))).not.toContain('data-spark-dot');
  });
  it('one point draws nothing', () => {
    expect(renderToStaticMarkup(createElement(Sparkline, { points: pts.slice(0, 1) }))).toBe('');
  });
});
