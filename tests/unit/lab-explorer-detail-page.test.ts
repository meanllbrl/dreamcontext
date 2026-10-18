/**
 * A `preset: funnel-explorer` insight's detail page (`/lab/<slug>`, `/lab/<slug>/f/<id>`) is its
 * explorer card, full page, not the pre-explorer comparison table: the server says the insight is
 * a preset (public manifest), the explorer route speaks the insight's own language, the routed
 * page draws the card the board draws (same blocks, same `v.<cardId>` view) with no range
 * control, and the old table lives on as the card's last tab, without a range. An insight with no
 * preset keeps its table page and its range control. Synthetic Acme vocabulary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { handleLabShow } from '../../src/server/routes/lab.js';
import { handleLabExplorer } from '../../src/server/routes/lab-boards.js';
import { funnelExplorerBlocks } from '../../src/lib/lab/presets.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

const state = vi.hoisted(() => ({
  insight: null as unknown,
  explorer: null as unknown,
  search: '',
  explorerLocale: [] as unknown[],
  replaced: [] as unknown[][],
}));

vi.mock('../../dashboard/src/context/ThemeContext.js', () => ({
  useTheme: () => ({ theme: 'light', resolved: 'light', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useVault: () => ({ bus: new EventTarget(), isActive: true }),
  useInstanceEvent: () => {},
}));
vi.mock('../../dashboard/src/hooks/useLab.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLabInsight: () => state.insight,
  useSyncInsight: () => ({ mutate: () => {}, isPending: false }),
  useApplyTweaks: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock('../../dashboard/src/hooks/useLabPrefs.js', () => ({
  useLabPrefs: () => ({ prefs: { columns: {} }, setColumnKeys: () => {} }),
}));
vi.mock('../../dashboard/src/hooks/useBoards.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLabExplorer: (_slug: string, locale: unknown) => { state.explorerLocale.push(locale); return state.explorer; },
  useBoardCaches: () => ({ data: {} }),
}));
vi.mock('../../dashboard/src/components/lab/funnel/labRoute.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLabSearchParams: () => [new URLSearchParams(state.search), () => {}],
  replaceLabPath: (...args: unknown[]) => { state.replaced.push(args); },
}));

const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
const { LabRoutedInsight } = await import('../../dashboard/src/components/lab/LabRoutedInsight.js');
const { boardFromWire } = await import('../../dashboard/src/hooks/useBoards.js');
const { encodeCardView } = await import('../../dashboard/src/components/lab/board/cardViewUrl.js');
const { EMPTY_VIEW, setFunnel, setTab } = await import('../../dashboard/src/components/lab/board/cardViewState.js');

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let code = 0;
  let body: unknown = null;
  const res = {
    writeHead(c: number) { code = c; },
    end(data: string) { try { body = JSON.parse(data); } catch { body = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => code, body: () => body as any };
}

function makeReq(url: string): IncomingMessage {
  return Object.assign(Readable.from([]), { method: 'GET', url, headers: {} }) as unknown as IncomingMessage;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-explorer-page-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  state.insight = null;
  state.explorer = null;
  state.search = '';
  state.explorerLocale = [];
  state.replaced = [];
  seeded = false;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PRESET = 'acme-explorer';
const PLAIN = 'acme-plain';

function cacheOf(slug: string): InsightCache {
  const steps = (a: number, b: number, c: number) => [
    { key: 'land', label: 'Landed', users: a }, { key: 'start', label: 'Started', users: b }, { key: 'pay', label: 'Paid', users: c },
  ];
  return {
    slug, fetchedAt: '2026-10-01T00:00:00Z', tweaks: {}, granularity: 'daily', unit: 'users',
    series: [], latest: null, error: null, errorAt: null, scriptHash: null,
    funnel: {
      notices: [],
      range: { fromISO: '2026-09-01', toISO: '2026-09-30' },
      set: {
        kind: 'funnel-set/v1',
        dimensions: [{ key: 'platform', label: 'Platform', mode: 'client', values: ['ios', 'android'] }],
        funnels: [
          { id: 'quiz', name: 'Acme quiz', meta: {}, metrics: { cr: { v: 4.2, format: 'pct', label: 'CR' } }, steps: steps(1000, 400, 42) },
          { id: 'trial', name: 'Acme trial', meta: {}, metrics: { cr: { v: 2.5, format: 'pct', label: 'CR' } }, steps: steps(800, 300, 20) },
        ],
      },
    },
  } as unknown as InsightCache;
}

let seeded = false;
function seed(): void {
  if (seeded) return;
  seeded = true;
  createInsight(root, { slug: PRESET, title: 'Acme explorer', render: 'funnel', adapter: 'script', preset: 'funnel-explorer', locale: 'tr' });
  writeCache(root, PRESET, cacheOf(PRESET));
  createInsight(root, { slug: PLAIN, title: 'Acme plain funnels', render: 'funnel', adapter: 'script' });
  writeCache(root, PLAIN, cacheOf(PLAIN));
}

async function show(slug: string): Promise<any> {
  const { res, status, body } = makeRes();
  await handleLabShow(makeReq(`/api/lab/${slug}`), res, { slug }, root);
  expect(status()).toBe(200);
  return body();
}

async function explorer(slug: string, query = ''): Promise<{ status: number; body: any }> {
  const { res, status, body } = makeRes();
  await handleLabExplorer(makeReq(`/api/lab/explorer/${slug}${query}`), res, { slug }, root);
  return { status: status(), body: body() };
}

function render(slug: string, funnelId: string | null = null): string {
  return renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(LabRoutedInsight, { slug, funnelId, onBack: () => {}, onBackToInsight: () => {}, onToast: () => {} })));
}

const loaded = (data: unknown) => ({ data, isLoading: false, isError: false, error: null });

describe('the server tells the detail page what the insight is', () => {
  it('the public manifest carries preset and locale (null when the insight has none)', async () => {
    seed();
    expect((await show(PRESET)).insight).toMatchObject({ preset: 'funnel-explorer', locale: 'tr' });
    expect((await show(PLAIN)).insight).toMatchObject({ preset: null, locale: null });
  });

  it('the explorer route speaks the insight\'s own language unless asked for one', async () => {
    seed();
    const own = await explorer(PRESET);
    expect(own.status).toBe(200);
    expect(own.body.board.cards[0].blocks).toEqual(funnelExplorerBlocks(PRESET, [{ key: 'platform', label: 'Platform' }], 'tr'));
    const asked = await explorer(PRESET, '?locale=en');
    expect(asked.body.board.cards[0].blocks[1].tabs.map((t: { label: string }) => t.label).at(-1)).toBe('Table');
    // The card id is the derived board's (`c-<slug>`), so a `v.<cardId>` view moves between them.
    expect(own.body.board.cards[0].id).toBe(`c-${PRESET}`);
  });
});

describe('a funnel-explorer insight\'s detail page is its explorer card', () => {
  async function seedPage(view?: Parameters<typeof encodeCardView>[0]): Promise<void> {
    seed();
    state.insight = loaded(await show(PRESET));
    state.explorer = loaded(boardFromWire((await explorer(PRESET)).body));
    const encoded = view ? encodeCardView(view) : null;
    state.search = encoded ? `v.c-${PRESET}=${encodeURIComponent(encoded)}` : '';
  }

  it('draws the card full page in the insight\'s language, with no range control', async () => {
    await seedPage();
    const html = render(PRESET);
    expect(html).toContain(`data-lab-explorer-page="${PRESET}"`);
    expect(html).toContain('board-card--fullscreen');
    expect(html).not.toContain('data-lab-card-exit');
    for (const label of ['Günlük', 'Benchmark', 'Sıralama', 'Akış', 'Adımlar', 'Karşılaştır', 'Ödeme', 'Tablo']) expect(html).toContain(label);
    expect(html).not.toMatch(/lab-range|Last 30 days/);
    expect(html).not.toContain('funnel-ovw-table');
    expect(state.explorerLocale).toEqual([null]);
  });

  it('/f/<funnelId> opens the card on that funnel; the URL view wins over the path', async () => {
    await seedPage();
    const html = render(PRESET, 'trial');
    expect(html).toContain(`data-lab-explorer-page="${PRESET}"`);
    expect(html).not.toContain('data-lab-funnel-explorer-detail');
    // The picker's selected option is the path's funnel.
    expect(html).toMatch(/<option[^>]*value="trial"[^>]*selected|<option[^>]*selected[^>]*value="trial"/);

    await seedPage(setFunnel(EMPTY_VIEW, PRESET, 'quiz'));
    expect(render(PRESET, 'trial')).toMatch(/<option[^>]*value="quiz"[^>]*selected|<option[^>]*selected[^>]*value="quiz"/);
  });

  it('the Table tab is the old comparison table with column choice, search and Copy MD, and no range', async () => {
    seed();
    const card = boardFromWire((await explorer(PRESET)).body).board.cards[0];
    const tableTab = card.blocks![1].tabs!.length - 1;
    await seedPage(setTab(EMPTY_VIEW, '1', tableTab));
    const html = render(PRESET);
    expect(html).toContain('data-lab-funnel-table=""');
    expect(html).toContain('funnel-ovw-table');
    expect(html).toContain('data-funnel-row="quiz"');
    expect(html).toContain('data-funnel-row="trial"');
    expect(html).toContain('funnel-ovw-search');
    expect(html).toContain('funnel-ovw-colbtn');
    expect(html).toContain('data-lab-copy-md');
    expect(html).toContain('MD kopyala');
    expect(html).not.toMatch(/lab-range|Last 30 days/);
    // The card's first funnel is the current row until the reader picks one.
    expect(html).toMatch(/<tr[^>]*funnel-ovw-row--picked[^>]*aria-current="true"[^>]*data-funnel-row="quiz"/);
    expect(html).not.toMatch(/<tr[^>]*funnel-ovw-row--picked[^>]*data-funnel-row="trial"/);
  });
});

describe('a funnel insight without a preset keeps its pages', () => {
  it('/lab/<slug> is the comparison table with its range control', async () => {
    seed();
    state.insight = loaded(await show(PLAIN));
    const html = render(PLAIN);
    expect(html).toContain('funnel-ovw-table');
    expect(html).toContain('lab-range');
    expect(html).not.toContain('data-lab-explorer-page');
    expect(state.explorerLocale).toEqual([]);
  });

  it('/lab/<slug>/f/<id> is still the funnel detail page', async () => {
    seed();
    state.insight = loaded(await show(PLAIN));
    const html = render(PLAIN, 'quiz');
    expect(html).not.toContain('data-lab-explorer-page');
    expect(html).not.toContain('funnel-ovw-table');
    expect(html).toContain('Acme quiz');
  });

  it('while the insight loads, each address draws what it always drew', () => {
    state.insight = { data: undefined, isLoading: true, isError: false, error: null };
    expect(render(PLAIN)).toContain('Loading funnel data');
    expect(render(PLAIN)).not.toContain('data-lab-explorer-page');
  });
});
