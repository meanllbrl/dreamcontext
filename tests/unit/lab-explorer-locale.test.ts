/**
 * The funnel explorer carries its OWN locale (the dashboard has no language
 * setting): the manifest's `locale` (lab create --locale) is written into the
 * preset card's picker breakdown (`options.locale`), a derived explorer card
 * uses it, `lab board add-card --preset` defaults to it, and BoardCard scopes
 * the card's blocks to it (ScopedLocale), so tabs and header copy speak the
 * insight's language while the rest of the dashboard stays English.
 * Synthetic names only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { createProgram } from '../../src/cli/program.js';
import { presetCardLocale } from '../../src/cli/commands/lab.js';
import { createInsight, getInsight } from '../../src/lib/lab/store.js';
import { deriveBoardsFromLegacy, getBoard } from '../../src/lib/lab/boards.js';
import { BLOCK_CATALOG } from '../../src/lib/lab/blocks.js';
import { funnelExplorerBlocks } from '../../src/lib/lab/presets.js';
import { LabError } from '../../src/lib/lab/types.js';
import { explorerSet } from '../fixtures/lab/explorer-set.js';
import type { Block, BlockProps, Card } from '../../dashboard/src/components/lab/board/boardTypes.js';
import type { FunnelFrame } from '../../dashboard/src/generated/frameOps.js';

vi.mock('../../dashboard/src/context/ThemeContext.js', () => ({
  useTheme: () => ({ theme: 'light', resolved: 'light', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));

const { I18nProvider, ScopedLocale, useI18n } = await import('../../dashboard/src/context/I18nContext.js');
const { BoardCard, cardLocale } = await import('../../dashboard/src/components/lab/board/BoardCard.js');
const { TabsBlock } = await import('../../dashboard/src/components/lab/blocks/TabsBlock.js');
const { ExplorerHeader } = await import('../../dashboard/src/components/lab/explorer/ExplorerHeader.js');

const SLUG = 'acme-storefront-funnels';

let projectRoot: string;
let root: string;
let cwd: string;

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const push = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')); };
  const log = vi.spyOn(console, 'log').mockImplementation(push);
  const err = vi.spyOn(console, 'error').mockImplementation(push);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(push);
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
    warnSpy.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  // eslint-disable-next-line no-control-regex
  return { code, out: lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '') };
}

const manifestPath = (slug = SLUG) => join(root, 'lab', 'insights', `${slug}.md`);

beforeEach(() => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lab-explorer-locale-')));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  process.chdir(projectRoot);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('manifest locale', () => {
  it('createInsight writes it when given; a manifest without it has no locale key at all', () => {
    createInsight(root, { slug: SLUG, title: 'Acme funnels', preset: 'funnel-explorer', locale: 'tr' });
    expect(readFileSync(manifestPath(), 'utf-8')).toMatch(/^locale: tr$/m);
    expect(getInsight(root, SLUG)?.locale).toBe('tr');

    createInsight(root, { slug: 'acme-plain', title: 'Acme plain' });
    expect(readFileSync(manifestPath('acme-plain'), 'utf-8')).not.toMatch(/^locale:/m);
    expect(getInsight(root, 'acme-plain')).not.toHaveProperty('locale');
  });

  it('reads leniently: an unknown value reads as no locale, never throws', () => {
    createInsight(root, { slug: SLUG, title: 'Acme funnels', preset: 'funnel-explorer', locale: 'tr' });
    writeFileSync(manifestPath(), readFileSync(manifestPath(), 'utf-8').replace(/^locale: tr$/m, 'locale: fr'), 'utf-8');
    const m = getInsight(root, SLUG);
    expect(m).not.toBeNull();
    expect(m).not.toHaveProperty('locale');
  });

  it('refuses an unknown value on write', () => {
    expect(() => createInsight(root, { slug: SLUG, title: 'X', locale: 'fr' as never })).toThrow(LabError);
    expect(() => createInsight(root, { slug: SLUG, title: 'X', locale: 'fr' as never })).toThrow(/locale must be one of: en, tr/);
  });
});

describe('lab create --locale and add-card --preset', () => {
  it('lab create --preset funnel-explorer --locale tr writes the manifest locale; an unknown one exits 1', async () => {
    const ok = await run(['lab', 'create', SLUG, '--preset', 'funnel-explorer', '--locale', 'tr', '--title', 'Acme funnels', '--no-board']);
    expect(ok.code).toBe(0);
    expect(getInsight(root, SLUG)?.locale).toBe('tr');
    const bad = await run(['lab', 'create', 'acme-other', '--preset', 'funnel-explorer', '--locale', 'fr', '--title', 'X', '--no-board']);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/locale must be one of/);
    expect(getInsight(root, 'acme-other')).toBeNull();
  });

  it('presetCardLocale: --locale wins, else the manifest locale, else en', () => {
    createInsight(root, { slug: SLUG, title: 'Acme funnels', preset: 'funnel-explorer', locale: 'tr' });
    createInsight(root, { slug: 'acme-plain', title: 'Acme plain', preset: 'funnel-explorer' });
    expect(presetCardLocale(root, SLUG, undefined)).toBe('tr');
    expect(presetCardLocale(root, SLUG, 'en')).toBe('en');
    expect(presetCardLocale(root, 'acme-plain', undefined)).toBe('en');
    expect(presetCardLocale(root, 'acme-missing', undefined)).toBe('en');
  });

  it('add-card --preset without --locale writes the card in the manifest locale', async () => {
    expect((await run(['lab', 'create', SLUG, '--preset', 'funnel-explorer', '--locale', 'tr', '--title', 'Acme funnels', '--no-board'])).code).toBe(0);
    const snap = join(projectRoot, 'snap.json');
    writeFileSync(snap, JSON.stringify({
      source: {
        pulled_at: '2026-10-08T14:33:48Z',
        applied_filters: [
          { field: 'product', op: '=', value: 'Acme', source: 'request' },
          { field: 'event_date', op: 'between', values: ['2026-09-07', '2026-10-04'], source: 'request' },
        ],
      },
      data: explorerSet(),
    }), 'utf-8');
    expect((await run(['lab', 'data', 'write', SLUG, '--file', snap])).code).toBe(0);
    expect((await run(['lab', 'board', 'create', 'acme-board', '--title', 'Acme board'])).code).toBe(0);
    const added = await run(['lab', 'board', 'add-card', 'acme-board', '--insight', SLUG, '--preset', 'funnel-explorer']);
    expect(added.code, added.out).toBe(0);
    const card = getBoard(root, 'acme-board')!.cards.find((c) => c.insight === SLUG)!;
    const [breakdown, tabs] = card.blocks!;
    expect(breakdown.options).toEqual({ picker: true, counts: true, locale: 'tr' });
    expect(tabs.tabs![0].label).toBe('Günlük');
  });
});

describe('preset and derived card locale', () => {
  it('funnelExplorerBlocks writes locale into the picker breakdown, everything else as before', () => {
    expect(funnelExplorerBlocks(SLUG, [], 'tr')[0]).toEqual({ type: 'breakdown', data: SLUG, options: { picker: true, counts: true, locale: 'tr' } });
    expect(funnelExplorerBlocks(SLUG, [], 'en')[0].options).toEqual({ picker: true, counts: true, locale: 'en' });
    expect(BLOCK_CATALOG.breakdown.options.find((o) => o.key === 'locale')).toMatchObject({ type: 'enum', enum: ['en', 'tr'], default: 'en' });
  });

  it('a derived explorer card speaks the manifest locale (else English)', () => {
    const base = { category: 'Acme Funnel', group: null, render: 'funnel' as const, size: null, width: null, height: null };
    const dims = [{ key: 'country', label: 'Country' }];
    const [b] = deriveBoardsFromLegacy([
      { ...base, slug: 'acme-a', title: 'A', preset: 'funnel-explorer', locale: 'tr', presetDims: dims },
      { ...base, slug: 'acme-b', title: 'B', preset: 'funnel-explorer', presetDims: dims },
    ]);
    const [tr, en] = b.spec.cards;
    expect(tr.blocks).toEqual(funnelExplorerBlocks('acme-a', dims, 'tr'));
    expect(en.blocks).toEqual(funnelExplorerBlocks('acme-b', dims, 'en'));
  });
});

describe('ScopedLocale: the card speaks its own language', () => {
  const tabsBlock: Block = {
    type: 'tabs', options: {},
    tabs: [
      { label: 'Daily', labelKey: 'lab.explorer.tab.daily', blocks: [] },
      { label: 'Country', labelKey: 'lab.explorer.tab.dim.country', blocks: [] },
    ],
  };
  const frame: FunnelFrame = {
    kind: 'funnel', insight: SLUG,
    funnels: [{
      id: 'quiz', name: 'Quiz', steps: [{ key: 'visit', label: 'Visit', users: 500 }],
      notes: [{ code: 'C1', text: 'No checkout step', level: 'trap', keys: [], scope: 'funnel' }],
    }],
  };

  function Outer() {
    const { t, locale } = useI18n();
    return createElement('p', { 'data-outer': locale }, t('lab.explorer.notes'));
  }

  it('cardLocale: only a funnel-picker card with a locale option is scoped', () => {
    expect(cardLocale([{ type: 'breakdown', data: SLUG, options: { picker: true, locale: 'tr' } }])).toBe('tr');
    expect(cardLocale([{ type: 'breakdown', data: SLUG, options: { picker: true } }])).toBeNull();
    expect(cardLocale([{ type: 'breakdown', data: SLUG, options: { locale: 'tr' } }])).toBeNull();
  });

  it('inside ScopedLocale tr: Turkish tab labels and header copy, while the outer provider stays English', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(Outer),
      createElement(ScopedLocale, { locale: 'tr' },
        createElement(TabsBlock, { block: tabsBlock, frame: null, options: {} } as never),
        createElement(ExplorerHeader, { frame, funnelId: 'quiz', selection: {} } as never),
      ),
    ));
    expect(html).toContain('data-outer="en"');
    expect(html).toContain('>Reading traps</p>');
    expect(html).toMatch(/data-lab-tab-key="daily"[^>]*>Günlük</);
    expect(html).toMatch(/data-lab-tab-key="dim.country"[^>]*>Ülke</);
    expect(html).toContain('Okuma tuzakları');
  });

  it('BoardCard scopes an explorer card with options.locale; a plain card follows the dashboard', () => {
    const renderBlock = (block: Block, props: BlockProps) =>
      block.type === 'tabs' ? createElement(TabsBlock, { ...props, block }) : null;
    const scopedCard: Card = {
      id: 'x', at: { x: 0, y: 0, w: 12, h: 12 }, insight: SLUG,
      blocks: [{ type: 'breakdown', data: SLUG, options: { picker: true, counts: true, locale: 'tr' } }, tabsBlock],
    };
    const plainCard: Card = { id: 'y', at: { x: 0, y: 0, w: 12, h: 12 }, insight: SLUG, blocks: [tabsBlock] };
    const scoped = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(BoardCard, { card: scopedCard, frames: {}, summaries: {}, renderBlock })));
    expect(scoped).toContain('data-lab-card-locale="tr"');
    expect(scoped).toMatch(/data-lab-tab-key="daily"[^>]*>Günlük</);
    const plain = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(BoardCard, { card: plainCard, frames: {}, summaries: {}, renderBlock })));
    expect(plain).not.toContain('data-lab-card-locale');
    expect(plain).toMatch(/data-lab-tab-key="daily"[^>]*>Daily</);
  });
});
