/**
 * The add-card "Funnel explorer" preset (W3-L7): when the "Bind to" insight's
 * cache carries a funnel set, the menu offers one card holding the whole
 * explorer (breakdown chips over Daily, Benchmark, Flow, Steps and one
 * Segments tab per client dim), 12x12, titled with the insight title. Its
 * blocks come from the same `funnelExplorerBlocks` the CLI's
 * `add-card --preset funnel-explorer` calls, with the dims the engine's funnel
 * frame carries, so the UI preset deep-equals the CLI preset.
 *
 * Synthetic Acme vocabulary.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';
import { FUNNEL_EXPLORER_SIZE } from '../../dashboard/src/generated/presets.js';
import { funnelExplorerBlocks } from '../../src/lib/lab/presets.js';
import { newFrameReadMemo, resolveFrame } from '../../src/lib/lab/frames.js';
import type { FunnelFrame } from '../../src/lib/lab/frameOps.js';
import type { InsightCache as EngineCache, InsightManifest } from '../../src/lib/lab/types.js';
import type { AddCardMenuProps, BlockCatalog, Card } from '../../dashboard/src/components/lab/board/boardTypes.js';
import type { InsightCache } from '../../dashboard/src/hooks/useLab.js';

let LOCALE = 'en';
vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: LOCALE, setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

let BOUND: InsightCache | null = null;
vi.mock('../../dashboard/src/hooks/useBoards.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  useInsightCache: (slug: string | null) => ({ data: slug ? { summary: null, cache: BOUND } : undefined }),
}));

const { cardFromPreset, presetDims } = await import('../../dashboard/src/components/lab/board/editorModel.js');
const { AddCardMenu } = await import('../../dashboard/src/components/lab/board/AddCardMenu.js');

const SLUG = 'acme-funnel-explorer';
const TITLE = 'Acme Storefront funnel';
const catalog = catalogJson as unknown as BlockCatalog;

const DIMENSIONS = [
  { key: 'platform', label: 'Platform', mode: 'client' as const },
  { key: 'language', label: 'Language', mode: 'client' as const },
  { key: 'country', label: '', mode: 'client' as const },
  { key: 'window', label: 'Window', mode: 'refetch' as const, tweak: 'range' },
  { key: 'device', label: 'Device', mode: 'client' as const },
  { key: 'cohort', label: 'Cohort', mode: 'client' as const },
];

function cache(): InsightCache {
  return {
    slug: SLUG, fetchedAt: '2026-09-30T00:00:00Z', tweaks: {}, granularity: 'day', unit: null, series: [],
    latest: null, error: null, errorAt: null, scriptHash: null,
    funnel: {
      notices: [],
      range: { fromISO: '2026-09-01', toISO: '2026-09-28' },
      set: {
        kind: 'funnel-set/v1',
        dimensions: DIMENSIONS,
        funnels: [{
          id: 'quiz', name: 'Quiz checkout (v2)', meta: {}, metrics: {},
          steps: [{ key: 'visit', label: 'Visit', users: 5000 }, { key: 'buy', label: 'Buy', users: 400 }],
          segments: [{ dims: { platform: 'Meta Ads', language: 'EN', country: 'Spain', device: 'iOS', cohort: 'new' }, users: 100, steps: [{ key: 'visit', users: 100 }] }],
        }],
      },
    },
  };
}

/** The dims the CLI hands the preset: the engine's funnel frame for the same cache. */
function engineDims(): { key: string; label: string }[] {
  const memo = newFrameReadMemo();
  memo.manifests.set(SLUG, { slug: SLUG, title: TITLE } as unknown as InsightManifest);
  memo.caches.set(SLUG, cache() as unknown as EngineCache);
  const frame = resolveFrame('/nonexistent-vault', SLUG, ['funnel'], memo) as FunnelFrame;
  expect(frame.kind).toBe('funnel');
  return (frame.dimensions ?? []).map((d) => ({ key: d.key, label: d.label }));
}

const board = (cards: Card[] = []) => ({ cards });

describe('the preset card equals the CLI preset', () => {
  it('presetDims is the frame client dims (refetch dims out, blank label = key)', () => {
    expect(presetDims(cache())).toEqual(engineDims());
    expect(presetDims(cache()).map((d) => d.key)).toEqual(['platform', 'language', 'country', 'device', 'cohort']);
    expect(presetDims(cache())[2]).toEqual({ key: 'country', label: 'country' });
    expect(presetDims(null)).toEqual([]);
  });

  for (const locale of ['en', 'tr'] as const) {
    it(`UI blocks deep-equal funnelExplorerBlocks for the same dims (${locale})`, () => {
      const card = cardFromPreset(board(), SLUG, TITLE, presetDims(cache()), locale);
      expect(card.blocks).toEqual(funnelExplorerBlocks(SLUG, engineDims(), locale));
    });
  }

  it('one 12x12 card on the insight, titled with its title, in a free slot, with a unique id', () => {
    const taken: Card = { id: `c-${SLUG}-explorer`, at: { x: 0, y: 0, w: 12, h: 4 } };
    const card = cardFromPreset(board([taken]), SLUG, TITLE, presetDims(cache()), 'en');
    expect(card.at.w).toBe(FUNNEL_EXPLORER_SIZE.w);
    expect(card.at.h).toBe(FUNNEL_EXPLORER_SIZE.h);
    expect(card.at.y).toBeGreaterThanOrEqual(4);
    expect(card.id).toBe(`c-${SLUG}-explorer-2`);
    expect(card.title).toBe(TITLE);
    expect(card.insight).toBe(SLUG);
    const [breakdown, tabs] = card.blocks!;
    expect(breakdown).toEqual({ type: 'breakdown', data: SLUG, options: {} });
    expect(tabs.tabs!.map((t) => t.label)).toEqual(['Daily', 'Benchmark', 'Flow', 'Steps', 'Platform', 'Language', 'country', 'Device']);
    expect(tabs.tabs![2].blocks[0]).toEqual({ type: 'funnel', data: SLUG, options: { layout: 'flow', markWorst: true } });
  });

  it('an unknown locale writes English labels, tr writes Turkish', () => {
    const labels = (locale: string) => cardFromPreset(board(), SLUG, TITLE, [], locale).blocks![1].tabs!.map((t) => t.label);
    expect(labels('de')).toEqual(['Daily', 'Benchmark', 'Flow', 'Steps']);
    expect(labels('tr')).toEqual(['Günlük', 'Kıyas', 'Akış', 'Adımlar']);
  });
});

describe('the add-card menu offers the preset only for a funnel insight', () => {
  function render(): string {
    const props: AddCardMenuProps = {
      board: { slug: 'acme', title: 'Acme', cards: [], warnings: [] } as unknown as AddCardMenuProps['board'],
      unplaced: [],
      insights: [{ slug: SLUG, title: TITLE }] as AddCardMenuProps['insights'],
      catalog,
      library: [],
      onAdd: () => {},
      onClose: () => {},
    };
    return renderToStaticMarkup(createElement(AddCardMenu as never, props as never));
  }

  it('a funnel cache shows the "Funnel explorer" tile first in the library, in the UI locale', () => {
    BOUND = cache();
    LOCALE = 'en';
    const html = render();
    expect(html).toContain('data-lab-add-preset="funnel-explorer"');
    expect(html).toMatch(/data-lab-add-preset="funnel-explorer"><span class="lab-editor-item-name">Funnel explorer<\/span><span class="lab-editor-item-detail">Acme Storefront funnel<\/span>/);
    expect(html.indexOf('data-lab-add-preset')).toBeLessThan(html.indexOf('data-lab-add-type='));
    LOCALE = 'tr';
    expect(render()).toContain('Huni gezgini');
    LOCALE = 'en';
  });

  it('no funnel in the cache (or no cache): no preset tile', () => {
    BOUND = { ...cache(), funnel: undefined };
    expect(render()).not.toContain('data-lab-add-preset');
    BOUND = null;
    expect(render()).not.toContain('data-lab-add-preset');
  });
});
