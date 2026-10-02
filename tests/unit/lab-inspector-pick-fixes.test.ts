/**
 * Inspector pick minors (W5): a stale single pick stays resettable to
 * Automatic even when the data offers no choices (nothing synced), and a
 * multi pick saved as one comma string (`a,b`, the form blocks and the CLI
 * read) shows as ticked items, not one stale row; ticking writes a real list.
 * Pure model tests plus static markup of the real BlockInspector (i18n and the
 * cache hook mocked). Synthetic Acme vocabulary.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';
import { frameKey, type FunnelFrame } from '../../dashboard/src/generated/frameOps.js';
import type {
  Block, BlockCatalog, BlockCatalogEntry, BlockOptionSchema, Card, InspectorProps,
} from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.editor.pick.empty': 'Sync the insight to choose from its data',
  'lab.editor.pick.auto': 'Automatic',
  'lab.editor.pick.stale': '{value} (not in the data)',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/hooks/useBoards.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  useInsightCache: () => ({ data: undefined }),
}));

const { optionAccepts, pickRows, pickValues, togglePick } = await import('../../dashboard/src/components/lab/board/editorModel.js');
const { BlockInspector } = await import('../../dashboard/src/components/lab/board/BlockInspector.js');

const SLUG = 'acme-funnel-explorer';
const metric = (label: string) => ({ v: 40, prev: 35, format: 'pct' as const, label, measured: true, reason: null });
const FRAME: FunnelFrame = {
  kind: 'funnel',
  insight: SLUG,
  dimensions: [{ key: 'platform', label: 'Platform', values: ['Meta Ads'] }],
  funnels: [{
    id: 'quiz', name: 'Quiz checkout (v2)', steps: [{ key: 'visit', label: 'Visit', users: 5000 }],
    metrics: { lead_rate: metric('Lead rate'), cost_per_lead: metric('Cost per lead'), conversion: metric('Conversion') },
  }],
};

const schema = (key: string, from: BlockOptionSchema['from'], multi = false): BlockOptionSchema => ({
  key, type: 'pick', from, multi, default: null, labelKey: `lab.block.opt.${key}`, label: { en: key, tr: key },
});
const funnelEntry = catalogJson.blocks.find((b) => b.type === 'funnel') as unknown as BlockCatalogEntry;
const catalog: BlockCatalog = {
  ...(catalogJson as unknown as BlockCatalog),
  blocks: (catalogJson as unknown as BlockCatalog).blocks.map((b) => (b.type === 'funnel'
    ? { ...funnelEntry, options: [schema('funnel', 'funnels'), schema('metrics', 'metrics', true)] }
    : b)),
};

function render(block: Block, synced: boolean): string {
  const card: Card = { id: 'c-explorer', at: { x: 0, y: 0, w: 8, h: 6 }, insight: SLUG, blocks: [block] };
  const props: InspectorProps = {
    board: { slug: 'acme', title: 'Acme', cards: [card], warnings: [] } as unknown as InspectorProps['board'],
    card,
    blockPath: [0],
    catalog,
    library: [],
    insights: [{ slug: SLUG, title: 'Acme funnel explorer' }] as InspectorProps['insights'],
    frames: synced ? { [frameKey(card.id, [0])]: FRAME } : {},
    caches: {},
    onChange: () => {},
    onSelectBlock: () => {},
    onClose: () => {},
  };
  return renderToStaticMarkup(createElement(BlockInspector as never, props as never));
}
const selectOf = (html: string, key: string) => {
  const start = html.lastIndexOf('<select', html.indexOf(`data-lab-field="${key}"`));
  return html.slice(start, html.indexOf('</select>', start));
};

describe('a stale single pick is always resettable to Automatic', () => {
  it('nothing synced but a saved name: the select stays live, lists the name as stale, and offers Automatic', () => {
    const sel = selectOf(render({ type: 'funnel', data: SLUG, options: { funnel: 'gone' } }, false), 'funnel');
    expect(sel).not.toContain('disabled');
    expect(sel).toContain('<option value="">Automatic</option>');
    expect(sel).toContain('<option value="gone" data-lab-pick-stale="" selected="">gone (not in the data)</option>');
  });

  it('nothing synced and nothing saved: still disabled (nothing to choose, nothing to reset)', () => {
    expect(selectOf(render({ type: 'funnel', data: SLUG, options: {} }, false), 'funnel')).toContain('disabled=""');
  });
});

describe('a multi pick saved as a comma string reads as ticked items', () => {
  it('pickValues splits, trims and dedups; lists pass through', () => {
    expect(pickValues('lead_rate, conversion,,lead_rate')).toEqual(['lead_rate', 'conversion']);
    expect(pickValues(['a', ' b ', 3])).toEqual(['a', 'b']);
    expect(pickValues(undefined)).toEqual([]);
  });

  it('the rows are the choices, none stale; ticking writes a real list in row order', () => {
    const choices = [{ value: 'lead_rate', label: 'Lead rate' }, { value: 'cost_per_lead', label: 'Cost per lead' }, { value: 'conversion', label: 'Conversion' }];
    const rows = pickRows(choices, 'conversion,lead_rate');
    expect(rows.some((r) => r.stale)).toBe(false);
    expect(togglePick(rows, 'conversion,lead_rate', 'cost_per_lead', true)).toEqual(['lead_rate', 'cost_per_lead', 'conversion']);
    expect(togglePick(rows, 'conversion,lead_rate', 'conversion', false)).toEqual(['lead_rate']);
    expect(togglePick(rows, 'lead_rate', 'lead_rate', false)).toBeUndefined();
  });

  it('the checklist ticks each saved name, with no "a,b" stale row', () => {
    const html = render({ type: 'funnel', data: SLUG, options: { metrics: 'lead_rate,conversion' } }, true);
    expect(html).toContain('<input type="checkbox" checked="" value="lead_rate"/>');
    expect(html).toContain('<input type="checkbox" checked="" value="conversion"/>');
    expect(html).toContain('<input type="checkbox" value="cost_per_lead"/>');
    expect(html).not.toContain('lead_rate,conversion (not in the data)');
    expect(html).not.toContain('data-lab-pick-stale');
  });

  it('validation still agrees with the engine: a multi pick is a list (ticking once rewrites the string as one)', () => {
    const multi = schema('metrics', 'metrics', true);
    expect(optionAccepts(multi, ['lead_rate'])).toBe(true);
    expect(optionAccepts(multi, 'lead_rate,conversion')).toBe(false);
    expect(optionAccepts(schema('funnel', 'funnels'), 'quiz')).toBe(true);
  });
});
