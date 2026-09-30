/**
 * The inspector's `pick` fields (W3-L7): a pick option edits as a select (one
 * name) or a checklist (`multi`) over the names the block's data has, read
 * through `pickChoices` from the block's resolved frame and the insight cache:
 * funnels, client dims, the picked funnel's metrics, the app's pages. An empty
 * list is a disabled control that says to sync; a saved name the data lacks
 * stays listed as "(not in the data)", never dropped.
 *
 * Pure model tests plus static markup of the real BlockInspector (dashboard's
 * own React, i18n and the cache hook mocked). Synthetic Acme vocabulary.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';
import { frameKey, projectFunnelFrame, type FunnelFrame } from '../../dashboard/src/generated/frameOps.js';
import type {
  Block, BlockCatalog, BlockCatalogEntry, BlockOptionSchema, Card, InspectorProps,
} from '../../dashboard/src/components/lab/board/boardTypes.js';
import type { InsightCache } from '../../dashboard/src/hooks/useLab.js';

const COPY: Record<string, string> = {
  'lab.editor.pick.empty': 'Sync the insight to choose from its data',
  'lab.editor.pick.auto': 'Automatic',
  'lab.editor.pick.stale': '{value} (not in the data)',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

/** Caches the board did not seed: the hook answers "nothing loaded" (no network in a unit test). */
vi.mock('../../dashboard/src/hooks/useBoards.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  useInsightCache: () => ({ data: undefined }),
}));

const { fieldsFor, optionAccepts, pickChoices, pickRows, togglePick } = await import(
  '../../dashboard/src/components/lab/board/editorModel.js'
);
const { BlockInspector } = await import('../../dashboard/src/components/lab/board/BlockInspector.js');

const SLUG = 'acme-funnel-explorer';

const metric = (label: string) => ({ v: 40, prev: 35, format: 'pct' as const, label, measured: true, reason: null });

function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: SLUG,
    dimensions: [
      { key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads'] },
      { key: 'language', label: 'Language', values: ['EN', 'ES'] },
    ],
    funnels: [
      {
        id: 'quiz',
        name: 'Quiz checkout (v2)',
        steps: [{ key: 'visit', label: 'Visit', users: 5000 }],
        metrics: { lead_rate: metric('Lead rate'), cost_per_lead: metric('Cost per lead') },
      },
      {
        id: 'activation',
        name: 'Activation ladder',
        steps: [{ key: 'open', label: 'Open', users: 900 }],
        metrics: { day7_active: metric('Day 7 active') },
      },
    ],
  };
}

function cache(): InsightCache {
  return {
    slug: SLUG, fetchedAt: '2026-09-30T00:00:00Z', tweaks: {}, granularity: 'day', unit: null, series: [],
    latest: null, error: null, errorAt: null, scriptHash: null,
    funnel: {
      notices: [],
      range: { fromISO: '2026-09-01', toISO: '2026-09-28' },
      set: {
        kind: 'funnel-set/v1',
        dimensions: [
          { key: 'platform', label: 'Platform', mode: 'client' },
          { key: 'language', label: '', mode: 'client' },
          { key: 'window', label: 'Window', mode: 'refetch' },
        ],
        funnels: [
          { id: 'quiz', name: 'Quiz checkout (v2)', meta: {}, steps: [], metrics: { lead_rate: { v: 1, format: 'pct', label: 'Lead rate' } } },
          { id: 'activation', name: 'Activation ladder', meta: {}, steps: [], metrics: { day7_active: { v: 1, format: 'pct' } } },
        ],
      },
    },
    app: {
      notices: [],
      range: { fromISO: '2026-09-01', toISO: '2026-09-28' },
      spec: { kind: 'app/v1', entry: 'overview', pages: [
        { id: 'overview', title: 'Overview', html: '<p></p>' },
        { id: 'cohorts', title: '', html: '<p></p>' },
      ] },
    },
  };
}

const schema = (from: BlockOptionSchema['from'], multi = false): BlockOptionSchema => ({
  key: from === 'funnels' ? 'funnel' : from === 'metrics' ? 'metrics' : from === 'app-pages' ? 'page' : 'by',
  type: 'pick', from, multi, default: null, labelKey: `lab.block.opt.${from}`, label: { en: String(from), tr: String(from) },
});

describe('pickChoices: names from the block frame and the insight cache', () => {
  it('funnels list id + name, from the cache first (a block frame is projected to its pick)', () => {
    const projected = projectFunnelFrame(frame(), 'funnel', { funnel: 'activation' });
    expect(projected.funnels.map((f) => f.id)).toEqual(['activation']);
    expect(pickChoices('funnels', projected, cache(), 'activation')).toEqual([
      { value: 'quiz', label: 'Quiz checkout (v2)' },
      { value: 'activation', label: 'Activation ladder' },
    ]);
    // No cache yet: the frame's own funnels.
    expect(pickChoices('funnels', frame(), null, null).map((c) => c.value)).toEqual(['quiz', 'activation']);
  });

  it('dims list the frame dimensions; without a frame, the cache client dims (refetch dims excluded, blank label = key)', () => {
    expect(pickChoices('dims', frame(), cache(), null)).toEqual([
      { value: 'platform', label: 'Platform' },
      { value: 'language', label: 'Language' },
    ]);
    expect(pickChoices('dims', null, cache(), null)).toEqual([
      { value: 'platform', label: 'Platform' },
      { value: 'language', label: 'language' },
    ]);
  });

  it('metrics are the PICKED funnel keys + labels; no pick or an unknown one = the first funnel, as blocks draw', () => {
    expect(pickChoices('metrics', frame(), cache(), 'activation')).toEqual([{ value: 'day7_active', label: 'Day 7 active' }]);
    expect(pickChoices('metrics', frame(), cache(), null).map((c) => c.value)).toEqual(['lead_rate', 'cost_per_lead']);
    expect(pickChoices('metrics', frame(), cache(), 'gone').map((c) => c.value)).toEqual(['lead_rate', 'cost_per_lead']);
    // A frame stripped of rates (funnel/breakdown projection): the cache answers.
    const stripped = projectFunnelFrame(frame(), 'breakdown', {});
    expect(pickChoices('metrics', stripped, cache(), 'activation')).toEqual([{ value: 'day7_active', label: 'day7_active' }]);
  });

  it('app-pages list the app spec pages id + title (blank title = id)', () => {
    expect(pickChoices('app-pages', null, cache(), null)).toEqual([
      { value: 'overview', label: 'Overview' },
      { value: 'cohorts', label: 'cohorts' },
    ]);
  });

  it('nothing synced = an empty list for every source', () => {
    for (const from of ['funnels', 'dims', 'metrics', 'app-pages'] as const) {
      expect(pickChoices(from, null, null, null), from).toEqual([]);
      expect(pickChoices(from, { kind: 'empty', reason: 'no-cache', ref: SLUG } as never, null, null), from).toEqual([]);
    }
  });
});

describe('pickRows and togglePick', () => {
  const choices = [{ value: 'platform', label: 'Platform' }, { value: 'language', label: 'Language' }];

  it('a saved value the data lacks is kept, after the choices, marked stale', () => {
    expect(pickRows(choices, 'country')).toEqual([
      { value: 'platform', label: 'Platform', stale: false },
      { value: 'language', label: 'Language', stale: false },
      { value: 'country', label: 'country', stale: true },
    ]);
    expect(pickRows(choices, ['language', 'country', 'country']).filter((r) => r.stale).map((r) => r.value)).toEqual(['country']);
    expect(pickRows(choices, undefined).every((r) => !r.stale)).toBe(true);
  });

  it('a tick keeps the rows order; unticking the last one unsets the option', () => {
    const rows = pickRows(choices, ['language']);
    expect(togglePick(rows, ['language'], 'platform', true)).toEqual(['platform', 'language']);
    expect(togglePick(rows, ['language'], 'language', false)).toBeUndefined();
    const withStale = pickRows(choices, ['country']);
    expect(togglePick(withStale, ['country'], 'country', false)).toBeUndefined();
  });
});

describe('fieldsFor: a pick is a select, a multi pick a checklist', () => {
  it('maps the control from the schema', () => {
    const entry = { ...(catalogJson.blocks.find((b) => b.type === 'funnel') as unknown as BlockCatalogEntry), options: [schema('funnels'), schema('metrics', true)] };
    expect(fieldsFor(entry).map((f) => f.control)).toEqual(['pick', 'pick-list']);
    expect(optionAccepts(schema('funnels'), 'quiz')).toBe(true);
    expect(optionAccepts(schema('metrics', true), ['lead_rate'])).toBe(true);
  });

  it('every catalog pick option (when the catalog carries them) names its source and gets a pick control', () => {
    for (const entry of catalogJson.blocks as unknown as BlockCatalogEntry[]) {
      for (const f of fieldsFor(entry)) {
        if (f.schema.type !== 'pick') continue;
        expect(['funnels', 'dims', 'metrics', 'app-pages'], `${entry.type}.${f.key}`).toContain(f.schema.from);
        expect(f.control, `${entry.type}.${f.key}`).toBe(f.schema.multi ? 'pick-list' : 'pick');
      }
    }
  });
});

describe('the inspector renders pick fields from the frame and the caches', () => {
  const funnelEntry = catalogJson.blocks.find((b) => b.type === 'funnel') as unknown as BlockCatalogEntry;
  // A local schema: the pick options the plan pins, independent of the catalog's progress.
  const catalog: BlockCatalog = {
    ...(catalogJson as unknown as BlockCatalog),
    blocks: (catalogJson as unknown as BlockCatalog).blocks.map((b) => (b.type === 'funnel'
      ? { ...funnelEntry, options: [schema('funnels'), schema('metrics', true), { ...schema('dims'), key: 'by' }] }
      : b)),
  };

  function render(block: Block, opts: { frames?: boolean; caches?: boolean } = {}): string {
    const card: Card = { id: 'c-explorer', at: { x: 0, y: 0, w: 8, h: 6 }, insight: SLUG, blocks: [block] };
    const props: InspectorProps = {
      board: { slug: 'acme', title: 'Acme', cards: [card], warnings: [] } as unknown as InspectorProps['board'],
      card,
      blockPath: [0],
      catalog,
      library: [],
      insights: [{ slug: SLUG, title: 'Acme funnel explorer' }] as InspectorProps['insights'],
      frames: opts.frames === false ? {} : { [frameKey(card.id, [0])]: frame() },
      caches: opts.caches === false ? {} : { [SLUG]: cache() },
      onChange: () => {},
      onSelectBlock: () => {},
      onClose: () => {},
    };
    return renderToStaticMarkup(createElement(BlockInspector as never, props as never));
  }
  const field = (html: string, key: string) => {
    const start = html.indexOf(`data-lab-field="${key}"`);
    expect(start, key).toBeGreaterThan(-1);
    const end = html.indexOf(html.slice(html.lastIndexOf('<', start), start).startsWith('<select') ? '</select>' : '</div>', start);
    return html.slice(start, end);
  };

  it('a single pick is a select of the data names with Automatic first; the saved one selected', () => {
    const html = render({ type: 'funnel', data: SLUG, options: { funnel: 'activation' } });
    const sel = field(html, 'funnel');
    expect(sel).toContain('data-lab-pick="funnels"');
    expect(sel.indexOf('Automatic')).toBeLessThan(sel.indexOf('Quiz checkout (v2)'));
    expect(sel).toContain('<option value="activation" selected="">Activation ladder</option>');
    expect(sel).not.toContain('disabled');
  });

  it('a multi pick is a checklist of the picked funnel metrics', () => {
    const html = render({ type: 'funnel', data: SLUG, options: { funnel: 'quiz', metrics: ['cost_per_lead'] } });
    const list = field(html, 'metrics');
    expect(html).toMatch(/role="group"[^>]*data-lab-field="metrics"/);
    expect(list).toContain('<input type="checkbox" checked="" value="cost_per_lead"/>');
    expect(list).toContain('<input type="checkbox" value="lead_rate"/>');
    expect(list).toContain('Cost per lead');
  });

  it('a saved name the data lacks stays listed as "(not in the data)"', () => {
    const html = render({ type: 'funnel', data: SLUG, options: { by: 'country' } });
    const sel = field(html, 'by');
    expect(sel).toContain('<option value="country" data-lab-pick-stale="" selected="">country (not in the data)</option>');
    expect(sel).toContain('Platform');
  });

  it('nothing synced: the control is disabled and says to sync', () => {
    const html = render({ type: 'funnel', data: SLUG, options: {} }, { frames: false, caches: false });
    const sel = field(html, 'funnel');
    expect(sel).toContain('disabled=""');
    expect(html).toContain('Sync the insight to choose from its data');
  });
});
