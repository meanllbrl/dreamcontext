/**
 * AC "colour follows the entity; a filter never repaints survivors" for bar and pie:
 * the colour identity comes from the RAW frame (frameColorDomain) on
 * BlockProps.colorDomain, next to the SHAPED frame, so a series pick, a static
 * where, an interactive filter, a sort or a top N never moves a survivor to
 * another slot. The "without the domain" cases pin the bug (a survivor took slot 1).
 * Single-series bars wear one hue whatever survives; the pivot's series and the
 * pie's slices are the entities.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';

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

const { frameColorDomain, shapeBlockFrame } = await import('../../dashboard/src/components/lab/blocks/frameShape.js');
const { BarBlock } = await import('../../dashboard/src/components/lab/blocks/BarBlock.js');
const { PieBlock } = await import('../../dashboard/src/components/lab/blocks/PieBlock.js');

const SERIES_FRAME: Frame = {
  kind: 'series', insight: 'sessions', unit: null, granularity: 'day',
  series: ['web', 'ios', 'android'].map((name, s) => ({ name, points: ['2026-09-01', '2026-09-02'].map((t, i) => ({ t, v: 10 + s * 2 + i })) })),
};
const TABLE_FRAME: Frame = {
  kind: 'table', insight: 'orders', dataset: 'by-plan', label: 'Orders',
  dims: [{ key: 'month', label: 'Month' }, { key: 'plan', label: 'Plan' }],
  rows: [
    { d: { month: '2026-07', plan: 'free' }, v: 10 }, { d: { month: '2026-07', plan: 'pro' }, v: 20 }, { d: { month: '2026-07', plan: 'team' }, v: 5 },
    { d: { month: '2026-08', plan: 'free' }, v: 12 }, { d: { month: '2026-08', plan: 'pro' }, v: 22 }, { d: { month: '2026-08', plan: 'team' }, v: 7 },
  ],
  sourceTotal: { v: 76, n: null }, total: { count: 6, v: 76, n: null }, unit: null,
} as Frame;
const TARGET = { insight: 'orders', dataset: 'by-plan' };

type Opts = Record<string, unknown>;
function render(Component: unknown, type: 'bar' | 'pie', raw: Frame, options: Opts, active: unknown[] = [], withDomain = true): string {
  const block = { type, data: 'x', options };
  return renderToStaticMarkup(createElement(Component as never, {
    frame: shapeBlockFrame(block as never, raw, active as never),
    colorDomain: withDomain ? frameColorDomain(raw) : null,
    options, block,
  }));
}
const barFill = (html: string, series: string) =>
  new RegExp(`fill="([^"]+)" data-bar="" data-series="${series}"`).exec(html)?.[1];
const sliceFill = (html: string, slice: string) =>
  new RegExp(`fill="([^"]+)"[^>]*data-slice="${slice}"`).exec(html)?.[1];

describe('bar: a pivot series keeps its colour through picks and filters', () => {
  it('the full frame paints the plans in source order', () => {
    const all = render(BarBlock, 'bar', TABLE_FRAME, {});
    expect(['free', 'pro', 'team'].map((s) => barFill(all, s))).toEqual(['var(--viz-cat-1)', 'var(--viz-cat-2)', 'var(--viz-cat-3)']);
  });

  it('a static where keeps pro and team on their slots; without the domain pro would take slot 1', () => {
    const kept = render(BarBlock, 'bar', TABLE_FRAME, { where: { plan: ['pro', 'team'] } });
    expect(barFill(kept, 'free')).toBeUndefined();
    expect([barFill(kept, 'pro'), barFill(kept, 'team')]).toEqual(['var(--viz-cat-2)', 'var(--viz-cat-3)']);
    const bare = render(BarBlock, 'bar', TABLE_FRAME, { where: { plan: ['pro', 'team'] } }, [], false);
    expect(barFill(bare, 'pro')).toBe('var(--viz-cat-1)');
  });

  it('an interactive filter and a sort never repaint the survivor', () => {
    const filtered = render(BarBlock, 'bar', TABLE_FRAME, { sort: 'asc' }, [{ key: 'k', target: TARGET, filter: { dim: 'plan', value: 'team' } }]);
    expect(barFill(filtered, 'team')).toBe('var(--viz-cat-3)');
    expect(barFill(filtered, 'pro')).toBeUndefined();
  });
});

describe('pie: a slice keeps its colour through picks, sorts, top N and filters', () => {
  it('colour follows source order, never rank: largest-first and asc paint the same', () => {
    const ranked = render(PieBlock, 'pie', SERIES_FRAME, {});
    const asc = render(PieBlock, 'pie', SERIES_FRAME, { sort: 'asc' });
    for (const html of [ranked, asc]) {
      expect(['web', 'ios', 'android'].map((s) => sliceFill(html, s))).toEqual(['var(--viz-cat-1)', 'var(--viz-cat-2)', 'var(--viz-cat-3)']);
    }
  });

  it('a series pick keeps the survivors on their slots; without the domain ios would take slot 1', () => {
    const picked = render(PieBlock, 'pie', SERIES_FRAME, { series: ['ios', 'android'] });
    expect([sliceFill(picked, 'ios'), sliceFill(picked, 'android')]).toEqual(['var(--viz-cat-2)', 'var(--viz-cat-3)']);
    // Drawn ios-first (asc) and scaled over what is drawn, ios would take slot 1.
    const bare = render(PieBlock, 'pie', SERIES_FRAME, { series: ['ios', 'android'], sort: 'asc' }, [], false);
    expect(sliceFill(bare, 'ios')).toBe('var(--viz-cat-1)');
    const kept = render(PieBlock, 'pie', SERIES_FRAME, { series: ['ios', 'android'], sort: 'asc' });
    expect(sliceFill(kept, 'ios')).toBe('var(--viz-cat-2)');
  });

  it('top N folds the rest into a grey Other; the kept slices keep their hue', () => {
    const top = render(PieBlock, 'pie', SERIES_FRAME, { topN: 2 });
    expect([sliceFill(top, 'ios'), sliceFill(top, 'android')]).toEqual(['var(--viz-cat-2)', 'var(--viz-cat-3)']);
    expect(top).toMatch(/fill="var\(--viz-other\)"[^>]*data-slice="lab\.blocks\.otherCount"/);
  });

  it('an interactive filter keeps table-row slices on their slots', () => {
    const filtered = render(PieBlock, 'pie', TABLE_FRAME, {}, [{ key: 'k', target: TARGET, filter: { dim: 'plan', value: 'pro' } }]);
    expect(sliceFill(filtered, '2026-07 / pro')).toBe('var(--viz-cat-2)');
    expect(sliceFill(filtered, '2026-08 / pro')).toBe('var(--viz-cat-5)');
  });
});
