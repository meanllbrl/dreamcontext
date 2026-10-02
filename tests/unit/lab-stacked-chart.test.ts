/**
 * StackedChart on the chart foundation: bar | area shape, 100% normalize (the
 * values come from frameOps, the axis pins to 0-100%), colour start, legend,
 * axes and grid, and the crosshair readout with every visible layer AND the
 * bucket total. Static markup at a fixed measured size (the
 * lab-chart-compose.test.ts precedent) plus the pure stack/tooltip helpers.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

vi.mock('../../dashboard/src/components/lab/chart/useChartSize.js', async (orig) => {
  const real = await orig<typeof import('../../dashboard/src/components/lab/chart/useChartSize.js')>();
  const { estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');
  return {
    ...real,
    useChartSize: () => ({
      ref: { current: null }, width: 560, height: 240, fontPx: 12, dpr: 2, ready: true,
      measure: (s: string) => estimateTextWidth(s, 12),
    }),
  };
});
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { StackedChart, StackedBody, stackColumns, stackedTooltip, stackedGeometry } = await import('../../dashboard/src/components/lab/StackedChart.js');
const { StackedBlock } = await import('../../dashboard/src/components/lab/blocks/StackedBlock.js');
const { xDomainOf } = await import('../../dashboard/src/components/lab/LineChart.js');
const { applyFrameOps } = await import('../../dashboard/src/generated/frameOps.js');
const { colorScale } = await import('../../dashboard/src/components/lab/chart/palette.js');
const { estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');

const SERIES = [
  { name: 'web', points: [{ t: '2026-09-01', v: 10 }, { t: '2026-09-02', v: 14 }, { t: '2026-09-03', v: 12 }] },
  { name: 'ios', points: [{ t: '2026-09-01', v: 4 }, { t: '2026-09-02', v: 6 }, { t: '2026-09-03', v: 9 }] },
  { name: 'android', points: [{ t: '2026-09-01', v: 2 }, { t: '2026-09-03', v: 5 }] },
];
const KEYS = ['2026-09-01', '2026-09-02', '2026-09-03'];

const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(StackedChart, { series: SERIES, unit: null, fill: true, ...props }));
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const yAxis = (html: string) => html.match(/<g class="lab-chart-axis" data-axis="y"[\s\S]*?<\/g>/)?.[0] ?? '';
const xAxis = (html: string) => html.match(/<g class="lab-chart-axis" data-axis="x"[\s\S]*?<\/g>/)?.[0] ?? '';

describe('StackedChart shape', () => {
  it('bar mode draws one segment per non-empty part, the top one with a rounded data end', () => {
    const html = render();
    expect(html).toContain('data-mode="bar"');
    expect(count(html, /data-segment=""/g)).toBe(8);
    expect(count(html, /data-band=""/g)).toBe(0);
    const segs = html.match(/<path data-segment=""[^>]*>/g)!;
    // Bucket 1 is web / ios / android bottom to top: only android (the top) is rounded.
    expect(segs[0]).not.toContain('Q');
    expect(segs[2]).toContain('Q');
  });

  it('area mode draws one stacked band per series and a crosshair shape instead of columns', () => {
    const html = render({ mode: 'area' });
    expect(html).toContain('data-mode="area"');
    expect(count(html, /data-band=""/g)).toBe(3);
    expect(count(html, /data-segment=""/g)).toBe(0);
  });

  it('segments above the first leave a 2px surface gap at their foot', () => {
    const geo = stackedGeometry({
      visible: SERIES, domain: xDomainOf(SERIES), mode: 'bar', normalized: false, width: 560, height: 240, fontPx: 12,
      measure: (s) => estimateTextWidth(s, 12), color: () => 'c', showX: true, showY: true, format: 'auto', unit: null,
    })!;
    const bottomOf = (d: string) => Number(d.match(/^M[\d.]+,([\d.]+)/)![1]);
    const topOf = (d: string) => Number(d.match(/V([\d.]+)/)![1]);
    const [web, ios] = geo.segments.filter((s) => s.index === 1);
    expect(topOf(web.d) - bottomOf(ios.d)).toBeCloseTo(2, 0);
    expect(geo.bandwidth).toBeLessThanOrEqual(24);
  });

  it('a negative part draws nothing while the readout reports it', () => {
    const cols = stackColumns([{ name: 'a', points: [{ t: 'x', v: 5 }] }, { name: 'b', points: [{ t: 'x', v: -3 }] }], ['x']);
    expect(cols[0].total).toBe(5);
    expect(cols[0].spans[1]).toMatchObject({ lo: 5, hi: 5, value: -3 });
  });
});

describe('StackedChart normalize', () => {
  it('frameOps shares sum to 100 per bucket and the chart pins its axis to 0-100%', () => {
    const frame = { kind: 'series' as const, insight: 'i', series: SERIES, unit: 'users', granularity: 'day' };
    const shaped = applyFrameOps(frame, { normalize: true });
    if (shaped.kind !== 'series') throw new Error('series expected');
    expect(shaped.unit).toBe('%');
    for (const col of stackColumns(shaped.series, KEYS)) expect(col.total).toBeCloseTo(100, 6);
    const html = render({ series: shaped.series, unit: shaped.unit, normalized: true });
    expect(html).toContain('data-normalized="true"');
    expect(yAxis(html)).toContain('>100%<');
    expect(yAxis(html)).toContain('>0%<');
    expect(yAxis(render())).not.toContain('%');
  });

  it('the normalized readout reads shares, and the total reads 100%', () => {
    const shaped = applyFrameOps({ kind: 'series', insight: 'i', series: SERIES, unit: null, granularity: null }, { normalize: true });
    if (shaped.kind !== 'series') throw new Error('series expected');
    const col = stackColumns(shaped.series, KEYS)[0];
    const out = stackedTooltip(col, { color: () => 'c', label: (n) => n, format: 'number', unit: '%', locale: 'en' });
    expect(out.rows.map((r) => r.value)).toEqual(['62.5%', '25%', '12.5%']);
    expect(out.total).toBe('100%');
    const odd = stackedTooltip({ key: 'k', total: 100, spans: [{ name: 'a', lo: 0, hi: 46.74, value: 46.74 }] }, { color: () => 'c', label: (n) => n, format: 'number', unit: '%', locale: 'en' });
    expect(odd.rows[0].value).toBe('46.7%');
  });

  it('StackedBlock passes normalize, mode and the chrome options through and fills the cell', () => {
    const raw = { kind: 'series' as const, insight: 'i', series: SERIES, unit: null, granularity: 'day' };
    const block = (options: Record<string, unknown>) => renderToStaticMarkup(createElement(StackedBlock as never, {
      frame: applyFrameOps(raw, { normalize: options.normalize === true }), options, block: { type: 'stacked', options },
    }));
    const plain = block({});
    expect(plain).toContain('class="lab-block-fill"');
    expect(plain).not.toContain('style="height');
    expect(plain).toContain('data-mode="bar"');
    const all = block({ mode: 'area', normalize: true, legend: 'right', axes: 'none', grid: false, color: 4 });
    expect(all).toContain('data-mode="area"');
    expect(all).toContain('data-normalized="true"');
    expect(all).toContain('data-legend="right"');
    expect(all).not.toContain('data-axis="y"');
    expect(xAxis(all)).not.toContain('<text');
    expect(all).not.toContain('lab-chart-grid');
    expect(all).toContain('fill="var(--viz-cat-4)"');
  });
});

describe('StackedChart colour, legend, axes', () => {
  it('colour start: the bottom layer takes the chosen slot', () => {
    expect(render()).toContain('fill="var(--viz-cat-1)"');
    const shifted = render({ colorIndex: 4 });
    expect(shifted).toContain('fill="var(--viz-cat-4)"');
    expect(shifted).not.toContain('fill="var(--viz-cat-1)"');
  });

  it('hiding a layer restacks the rest without recolouring them', () => {
    const colors = colorScale(SERIES.map((s) => s.name));
    const geo = (visible: typeof SERIES) => stackedGeometry({
      visible, domain: xDomainOf(SERIES), mode: 'bar', normalized: false, width: 560, height: 240, fontPx: 12,
      measure: (s) => estimateTextWidth(s, 12), color: colors.color, showX: true, showY: true, format: 'auto', unit: null,
    })!;
    const toggled = geo([SERIES[0], SERIES[2]]);
    expect([...new Set(toggled.segments.map((s) => `${s.name}:${s.color}`))]).toEqual(['web:var(--viz-cat-1)', 'android:var(--viz-cat-3)']);
    expect(toggled.columns[0].total).toBe(12);
  });

  it('legend buttons for two or more series; axes and grid toggle; calendar x labels', () => {
    const html = render();
    expect(count(html, /aria-pressed="true"/g)).toBe(3);
    expect(html).toContain('data-legend="bottom"');
    expect(render({ legend: 'none' })).not.toContain('lab-chart-legend');
    expect(xAxis(html)).toContain('Sep 1');
    expect(yAxis(html)).toMatch(/>2[0-9]</);
    expect(render({ axes: 'x' })).not.toContain('data-axis="y"');
    expect(render({ grid: false })).not.toContain('lab-chart-grid');
  });

  it('format reaches the axis', () => {
    const big = SERIES.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, v: p.v * 1000 })) }));
    expect(yAxis(render({ series: big, format: 'compact' }))).toMatch(/K</);
    expect(yAxis(render({ series: big, format: 'number' }))).toMatch(/,000</);
  });
});

describe('StackedChart readout', () => {
  it('lists every visible layer at the bucket in fixed order, with the total', () => {
    const colors = colorScale(SERIES.map((s) => s.name));
    const col = stackColumns(SERIES, KEYS)[1];
    const out = stackedTooltip(col, { color: colors.color, label: (n) => n, format: 'auto', unit: 'users', locale: 'en' });
    expect(out.rows.map((r) => [r.id, r.value, r.dim, r.color])).toEqual([
      ['web', '14 users', false, 'var(--viz-cat-1)'],
      ['ios', '6 users', false, 'var(--viz-cat-2)'],
      ['android', '-', true, 'var(--viz-cat-3)'],
    ]);
    expect(out.total).toBe('20 users');
  });

  it('the legacy body keeps its card and panel heights', () => {
    const summary = { unit: null } as never;
    expect(renderToStaticMarkup(createElement(StackedBody, { summary, series: SERIES } as never))).toContain('style="height:150px');
    expect(renderToStaticMarkup(createElement(StackedBody, { summary, series: SERIES, full: true } as never))).toContain('style="height:280px');
    const hosted = renderToStaticMarkup(createElement(StackedBody, { summary, series: SERIES, height: 180 } as never));
    expect(hosted).not.toContain('style="height');
    expect(hosted.startsWith('<div class="lab-chart"')).toBe(true);
  });
});
