/**
 * The block-level fixes the Wave 2 verify run asked for:
 * - `stat.series` picks the series the figure, delta and spark come from (series frames through
 *   frameOps; value frames through the insight's cache, `statFromSeries`);
 * - tabs buttons carry `data-lab-tab`, filter chips `data-lab-filter-chip="<value>"`, and the
 *   filter row shows the filtered total under `data-lab-filter-total` (count after the filter,
 *   before any limit);
 * - the live html block iframe carries `data-lab-html-block`.
 *
 * Static markup through the dashboard's own React (no DOM harness in this repo), as
 * lab-block-chart-options.test.ts does.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => (key === 'lab.blocks.filter.total' ? '{n} rows, total {v}' : key) }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { StatBlock } = await import('../../dashboard/src/components/lab/blocks/StatBlock.js');
const { FilterBlock } = await import('../../dashboard/src/components/lab/blocks/FilterBlock.js');
const { TabsBlock } = await import('../../dashboard/src/components/lab/blocks/TabsBlock.js');
const { statFromSeries } = await import('../../dashboard/src/components/lab/blocks/frameAdapters.js');
const { shapeBlockFrame } = await import('../../dashboard/src/components/lab/blocks/frameShape.js');

const BLOCKS = join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/blocks');
const html = (el: ReactElement) => renderToStaticMarkup(el);
function render(Component: unknown, b: Block, props: Partial<BlockProps> = {}): string {
  return html(createElement(Component as never, { frame: null, ...props, options: b.options, block: b }));
}

const SERIES = [
  { name: 'web', points: [{ t: '1', v: 10 }, { t: '2', v: 14 }, { t: '3', v: 12 }] },
  { name: 'ios', points: [{ t: '1', v: 4 }, { t: '2', v: 6 }, { t: '3', v: 90 }] },
];
const SERIES_FRAME: Frame = { kind: 'series', insight: 'signups', series: SERIES, unit: null, granularity: 'daily' };

const rows = [
  ['TR', 100], ['TR', 200], ['TR', 300], ['TR', 400], ['US', 10], ['US', 20], ['US', 30], ['US', 40],
  ['DE', 1], ['DE', 2], ['DE', 3], ['DE', 4],
] as const;
const TABLE: Frame = {
  kind: 'table', insight: 'orders', dataset: 'by-country', label: 'Orders',
  dims: [{ key: 'country', label: 'Country' }],
  rows: rows.map(([c, v]) => ({ d: { country: c }, v })),
  sourceTotal: { v: 1110, n: null }, total: { count: 12, v: 1110, n: null }, unit: null,
};

describe('stat.series picks the series', () => {
  it('a series frame is narrowed by frameOps, so the stat shows the picked series', () => {
    const base = { type: 'stat', data: 'signups', options: {} } as Block;
    const picked = { type: 'stat', data: 'signups', options: { series: ['ios'] } } as Block;
    const plain = render(StatBlock, base, { frame: shapeBlockFrame(base, SERIES_FRAME) });
    const withPick = render(StatBlock, picked, { frame: shapeBlockFrame(picked, SERIES_FRAME) });
    expect(plain).toContain('>12<');
    expect(withPick).toContain('>90<');
    expect(withPick).not.toBe(plain);
  });

  it('statFromSeries: the first named series that exists, its latest, previous and spark', () => {
    expect(statFromSeries(SERIES, ['ghost', 'ios'], 'EUR')).toEqual({ value: 90, prev: 6, spark: [4, 6, 90], unit: 'EUR' });
    expect(statFromSeries(SERIES, ['ghost'], null)).toBeNull();
    expect(statFromSeries([], ['web'], null)).toBeNull();
  });

  it('a value frame with a pick reads the insight cache; without a pick it never does', () => {
    const src = readFileSync(join(BLOCKS, 'StatBlock.tsx'), 'utf8');
    expect(src).toMatch(/if \(pick && f\.kind === 'value' && f\.spark\.length > 0\) return <StatFromCache/);
    expect(src).toMatch(/useInsightCache\(frame\.insight\)/);
    expect(src).toMatch(/statFromSeries\(cache\.data\?\.cache\?\.series \?\? \[\], pick, frame\.unit\)/);
    // No pick: rendered without any provider, so no hook ran.
    const value: Frame = { kind: 'value', insight: 'mrr', value: 5, prev: 4, spark: [3, 4, 5], unit: null };
    expect(render(StatBlock, { type: 'stat', data: 'mrr', options: {} }, { frame: value })).toContain('>5<');
  });
});

describe('DOM hooks', () => {
  it('tabs buttons carry data-lab-tab', () => {
    const tabs: Block = { type: 'tabs', options: {}, tabs: [{ label: 'A', blocks: [] }, { label: 'B', blocks: [] }] };
    expect((render(TabsBlock, tabs).match(/data-lab-tab="/g) ?? []).length).toBe(2);
  });

  it('filter chips carry their value; the total counts rows after the filter, before any limit', () => {
    const b: Block = { type: 'filter', data: 'orders/by-country', options: { dim: 'country' } };
    const all = render(FilterBlock, b, { frame: TABLE, filter: null });
    for (const v of ['TR', 'US', 'DE']) expect(all).toContain(`data-lab-filter-chip="${v}"`);
    expect(all).toMatch(/data-lab-filter-total="12"[^>]*>12 rows, total 1,110</);
    const tr = render(FilterBlock, b, { frame: TABLE, filter: { dim: 'country', value: 'TR' } });
    expect(tr).toMatch(/data-lab-filter-total="4"[^>]*>4 rows, total 1,000</);
  });

  it('the live html block iframe carries data-lab-html-block (the torn-down stub does not)', () => {
    const src = readFileSync(join(BLOCKS, 'HtmlBlock.tsx'), 'utf8');
    expect(src).toMatch(/ref=\{frameRef\}\s+className="lab-block-html-frame"\s+data-lab-html-block/);
    expect((src.match(/data-lab-html-block/g) ?? []).length).toBe(1);
  });
});

describe('save-to-library sits above the page overlays', () => {
  it('is portalled to <body> inside a fixed scrim on the popover layer', () => {
    const src = readFileSync(join(BLOCKS, '../board/SaveToLibraryDialog.tsx'), 'utf8');
    const css = readFileSync(join(BLOCKS, '../board/editors.css'), 'utf8');
    expect(src).toMatch(/return createPortal\(\s*<div className="lab-editor-scrim"/);
    expect(src).toMatch(/document\.body,\s*\);/);
    expect(css).toMatch(/\.lab-editor-scrim \{[^}]*position: fixed;[^}]*z-index: 60;/);
  });
});
