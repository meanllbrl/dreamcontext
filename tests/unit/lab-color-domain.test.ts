/**
 * AC "colour follows the entity; a filter never repaints survivors", end to end
 * for the static series pick and the interactive filter: the colour identity is
 * taken from the RAW frame (frameColorDomain), carried on BlockProps.colorDomain
 * next to the SHAPED frame, and line/stacked build their scale over it. The
 * "without the domain" cases pin the bug this fixes (a survivor took slot 1).
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
const { LineBlock } = await import('../../dashboard/src/components/lab/blocks/LineBlock.js');
const { StackedBlock } = await import('../../dashboard/src/components/lab/blocks/StackedBlock.js');
const { entityDomain } = await import('../../dashboard/src/components/lab/LineChart.js');

const SERIES_FRAME: Frame = {
  kind: 'series', insight: 'sessions', unit: null, granularity: 'day',
  series: ['web', 'ios', 'android'].map((name, s) => ({ name, points: ['2026-09-01', '2026-09-02', '2026-09-03'].map((t, i) => ({ t, v: 10 + s + i })) })),
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

type Opts = Record<string, unknown>;
function renderBlock(Component: unknown, type: 'line' | 'stacked', raw: Frame, options: Opts, active: unknown[] = [], withDomain = true): string {
  const block = { type, data: 'x', options };
  const props = {
    frame: shapeBlockFrame(block as never, raw, active as never),
    colorDomain: withDomain ? frameColorDomain(raw) : null,
    options, block,
  };
  return renderToStaticMarkup(createElement(Component as never, props));
}
const strokeOf = (html: string, series: string) =>
  new RegExp(`<path d="[^"]*" fill="none" stroke="([^"]+)"[^>]*data-series="${series}"`).exec(html)?.[1];
const fillOf = (html: string, series: string) =>
  new RegExp(`<path data-segment="" data-series="${series}" d="[^"]*" fill="([^"]+)"`).exec(html)?.[1];

describe('frameColorDomain: the raw frame names its entities in source order', () => {
  it('series frames: series names (both lists)', () => {
    expect(frameColorDomain(SERIES_FRAME)).toEqual({ series: ['web', 'ios', 'android'], rows: ['web', 'ios', 'android'] });
  });
  it('two-dim tables: the pivoted series (second dim) and the row labels', () => {
    const d = frameColorDomain(TABLE_FRAME)!;
    expect(d.series).toEqual(['free', 'pro', 'team']);
    expect(d.rows).toEqual(['2026-07 / free', '2026-07 / pro', '2026-07 / team', '2026-08 / free', '2026-08 / pro', '2026-08 / team']);
  });
  it('one-dim tables: one entity per row; value frames: the insight; none: null', () => {
    const one = { ...TABLE_FRAME, dims: [{ key: 'plan', label: 'Plan' }] } as Frame;
    expect(frameColorDomain(one)!.series).toEqual(['free', 'pro', 'team']);
    expect(frameColorDomain({ kind: 'value', insight: 'mrr', value: 1, prev: null, spark: [], unit: null } as Frame)).toEqual({ series: ['mrr'], rows: ['mrr'] });
    expect(frameColorDomain(null)).toBeNull();
    expect(frameColorDomain({ kind: 'empty', reason: 'no-cache', ref: 'x' } as Frame)).toBeNull();
  });
  it('entityDomain: the domain first, then any drawn name it lacks', () => {
    expect(entityDomain(['a', 'b', 'c'], ['c', 'Other'])).toEqual(['a', 'b', 'c', 'Other']);
    expect(entityDomain(null, ['c', 'a'])).toEqual(['c', 'a']);
  });
});

describe('a pick or a filter never repaints a survivor', () => {
  it('line: the static series pick keeps android in its own slot', () => {
    const all = renderBlock(LineBlock, 'line', SERIES_FRAME, {});
    const picked = renderBlock(LineBlock, 'line', SERIES_FRAME, { series: ['android'] });
    expect(strokeOf(all, 'android')).toBe('var(--viz-cat-3)');
    expect(strokeOf(picked, 'android')).toBe('var(--viz-cat-3)');
    expect(picked).not.toContain('data-series="web"');
    // Without the raw domain the survivor would take slot 1 (the bug).
    expect(strokeOf(renderBlock(LineBlock, 'line', SERIES_FRAME, { series: ['android'] }, [], false), 'android')).toBe('var(--viz-cat-1)');
  });

  it('line: the colour start still shifts every entity', () => {
    expect(strokeOf(renderBlock(LineBlock, 'line', SERIES_FRAME, { series: ['ios'], color: 4 }), 'ios')).toBe('var(--viz-cat-5)');
  });

  it('stacked: the interactive filter drops a plan; pro and team keep their colours', () => {
    const all = renderBlock(StackedBlock, 'stacked', TABLE_FRAME, {});
    const target = { insight: 'orders', dataset: 'by-plan' };
    const filtered = renderBlock(StackedBlock, 'stacked', TABLE_FRAME, { where: { plan: ['pro', 'team'] } }, [
      { key: 'k', target, filter: { dim: 'plan', value: 'team' } },
    ]);
    expect([fillOf(all, 'free'), fillOf(all, 'pro'), fillOf(all, 'team')]).toEqual(['var(--viz-cat-1)', 'var(--viz-cat-2)', 'var(--viz-cat-3)']);
    expect(fillOf(filtered, 'free')).toBeUndefined();
    expect(fillOf(filtered, 'team')).toBe('var(--viz-cat-3)');
  });

  it('stacked: a static where keeps the survivors on their slots too', () => {
    const kept = renderBlock(StackedBlock, 'stacked', TABLE_FRAME, { where: { plan: ['team', 'pro'] } });
    expect(fillOf(kept, 'pro')).toBe('var(--viz-cat-2)');
    expect(fillOf(kept, 'team')).toBe('var(--viz-cat-3)');
    const bare = renderBlock(StackedBlock, 'stacked', TABLE_FRAME, { where: { plan: ['team', 'pro'] } }, [], false);
    expect(fillOf(bare, 'pro')).toBe('var(--viz-cat-1)');
  });
});
