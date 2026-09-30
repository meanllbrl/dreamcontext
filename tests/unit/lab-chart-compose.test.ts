/**
 * The chart foundation's pieces compose: ReferenceLineChart (sizing -> layout -> scales ->
 * grid + axes -> marks -> hover -> legend) rendered to static markup with the dashboard's
 * own React, at a fixed measured size, the lab-block-chart-options.test.ts precedent. The
 * browser half (real ResizeObserver, hover under zoom, tooltip flip) is the foundation's
 * WebKit proof; this pins the markup contract Wave 2 charts build on.
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

const { ReferenceLineChart } = await import('../../dashboard/src/components/lab/chart/ReferenceLineChart.js');
const { Tooltip } = await import('../../dashboard/src/components/lab/chart/Tooltip.js');
const { Legend } = await import('../../dashboard/src/components/lab/chart/Legend.js');

const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
const SERIES = [
  { name: 'web', points: days.map((t, i) => ({ t, v: 1000 + i * 40 })) },
  { name: 'ios', points: days.map((t, i) => ({ t, v: 600 + (i % 7) * 30 })) },
  { name: 'android', points: days.map((t, i) => ({ t, v: 300 + i * 5 })) },
];

function render(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(ReferenceLineChart, { series: SERIES, locale: 'en', ...props }));
}

describe('the foundation composes into a chart', () => {
  it('draws at the measured pixels, 1:1 (no viewBox stretch)', () => {
    const html = render();
    expect(html).toContain('width="560" height="240" viewBox="0 0 560 240"');
    expect(html).toContain('class="lab-chart"');
    expect(html).toContain('data-legend="bottom"');
  });

  it('has formatted y ticks, calendar x ticks, and recessive gridlines', () => {
    const html = render();
    const y = html.match(/<g class="lab-chart-axis" data-axis="y"[\s\S]*?<\/g>/)?.[0] ?? '';
    expect(y).toMatch(/>1,[0-9]00</); // grouped thousands
    const x = html.match(/<g class="lab-chart-axis" data-axis="x"[\s\S]*?<\/g>/)?.[0] ?? '';
    expect(x).toContain('Sep ');
    expect(x).toContain('class="lab-chart-axis-line"');
    expect((html.match(/<g class="lab-chart-grid"/g) ?? []).length).toBe(1);
  });

  it('colours series by entity from the validated palette; the legend toggles are buttons', () => {
    const html = render();
    expect(html).toContain('stroke="var(--viz-cat-1)" stroke-width="2"');
    expect(html).toContain('stroke="var(--viz-cat-3)"');
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(3);
    expect(render({ colorStart: 7 })).toContain('stroke="var(--viz-cat-8)"');
  });

  it('options change the render: legend position, axes, grid, format', () => {
    expect(render({ legend: 'right' })).toContain('data-legend="right"');
    expect(render({ legend: 'none' })).not.toContain('lab-chart-legend');
    expect(render({ showY: false })).not.toContain('data-axis="y"');
    expect(render({ grid: false })).not.toContain('lab-chart-grid');
    expect(render({ format: 'compact' })).toMatch(/>1\.?\d?K</);
  });

  it('a single series needs no legend (the title names it)', () => {
    const html = renderToStaticMarkup(createElement(ReferenceLineChart, { series: [SERIES[0]], locale: 'en' }));
    expect(html).not.toContain('lab-chart-legend');
  });

  it('the tooltip and legend render untrusted labels as text', () => {
    const tip = renderToStaticMarkup(createElement(Tooltip, {
      anchor: { x: 10, y: 10 }, bounds: { width: 200, height: 100 }, title: 'Sep 3, 2026',
      rows: [{ id: 'a', label: '<b>web</b>', value: '1,204', color: 'var(--viz-cat-1)', shape: 'line' }],
    }));
    expect(tip).toContain('&lt;b&gt;web&lt;/b&gt;');
    expect(tip).toContain('data-shape="line"');
    expect(tip).toContain('class="lab-chart-tooltip-value" data-value="">1,204<');
    const legend = renderToStaticMarkup(createElement(Legend, {
      items: [{ id: 'x', label: '<i>x</i>', color: 'var(--viz-cat-2)' }], hidden: new Set(['x']), onToggle: () => {},
    }));
    expect(legend).toContain('aria-pressed="false"');
    expect(legend).toContain('&lt;i&gt;x&lt;/i&gt;');
  });
});
