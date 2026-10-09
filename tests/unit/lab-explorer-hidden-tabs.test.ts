/**
 * The funnel explorer card's tabs (blocks/TabsBlock.tsx + explorer/explorerTabs.ts + BoardCard):
 * a page with nothing to show is HIDDEN, never drawn with zeros (the Access page when the snapshot
 * carries no access ladder); a tab with a `labelKey` shows that key's copy in the reader's language
 * (falling back to the spec label) and carries `data-lab-tab-key`; a hidden active tab falls back to
 * the first visible one. A funnel-picker card hands its blocks the reader's funnel; other cards do not.
 * Static markup through the dashboard's own React (no DOM harness at the root).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Block, BlockProps, Card, Frame } from '../../dashboard/src/components/lab/board/boardTypes.js';
import type { FunnelFrame } from '../../dashboard/src/generated/frameOps.js';

const COPY: Record<string, string> = {
  'lab.explorer.tab.daily': 'Günlük',
  'lab.explorer.tab.access': 'Erişim',
  'lab.explorer.tab.dim.country': 'Ülke',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'tr', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/ThemeContext.js', () => ({
  useTheme: () => ({ theme: 'light', resolved: 'light', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));

const { TabsBlock, tabKeyOf, visibleTab } = await import('../../dashboard/src/components/lab/blocks/TabsBlock.js');
const { hiddenTabIndexes, TAB_HIDES_WHEN_EMPTY } = await import('../../dashboard/src/components/lab/explorer/explorerTabs.js');
const { BoardCard } = await import('../../dashboard/src/components/lab/board/BoardCard.js');
const { EMPTY_VIEW, setFunnel, setTab } = await import('../../dashboard/src/components/lab/board/cardViewState.js');

const INS = 'acme-storefront-funnels';

const tabsBlock: Block = {
  type: 'tabs', options: {},
  tabs: [
    { label: 'Daily', labelKey: 'lab.explorer.tab.daily', blocks: [{ type: 'trend', data: INS, options: {} }] },
    { label: 'Access', labelKey: 'lab.explorer.tab.access', blocks: [{ type: 'access', data: INS, options: {} }] },
    { label: 'Country', labelKey: 'lab.explorer.tab.dim.country', blocks: [{ type: 'segments', data: INS, options: { by: 'country' } }] },
    { label: 'Device', blocks: [{ type: 'segments', data: INS, options: { by: 'device' } }] },
  ],
};

const funnels: FunnelFrame['funnels'] = [
  { id: 'quiz', name: 'Quiz', steps: [{ key: 'visit', label: 'Visit', users: 100 }] },
  { id: 'ladder', name: 'Ladder', steps: [{ key: 'visit', label: 'Visit', users: 50 }] },
];
const noAccess: FunnelFrame = { kind: 'funnel', insight: INS, funnels };
const withAccess: FunnelFrame = {
  kind: 'funnel', insight: INS, funnels,
  access: { stages: [{ key: 'paid', label: 'Paid' }, { key: 'app', label: 'App' }], rows: [{ funnel: null, dims: {}, counts: { paid: 120, app: 90 } }], asOf: '2026-10-01' },
};

/** Frames keyed by the full block path, as BoardCard reads them. */
const frameAt = (accessFrame: Frame | null) => (path: number[]): Frame | null => (path[1] === 1 ? accessFrame : noAccess);

describe('hiddenTabIndexes', () => {
  it('hides the Access tab when the snapshot carries no access ladder, shows it when it does', () => {
    expect(hiddenTabIndexes(tabsBlock, frameAt(noAccess), [1])).toEqual([1]);
    expect(hiddenTabIndexes(tabsBlock, frameAt(withAccess), [1])).toEqual([]);
    // No frame at all (an unsynced insight) reads as nothing to show.
    expect(hiddenTabIndexes(tabsBlock, frameAt(null), [1])).toEqual([1]);
  });

  it('only block types that opt in can hide a tab; a tab with any other block stays', () => {
    expect(Object.keys(TAB_HIDES_WHEN_EMPTY)).toEqual(['access']);
    const mixed: Block = { type: 'tabs', options: {}, tabs: [
      { label: 'A', blocks: [{ type: 'access', data: INS, options: {} }, { type: 'text', options: { markdown: 'x' } }] },
      { label: 'B', blocks: [] },
    ] };
    expect(hiddenTabIndexes(mixed, () => noAccess, [0])).toEqual([]);
    expect(hiddenTabIndexes({ type: 'text', options: {} }, () => noAccess, [0])).toEqual([]);
  });

  it('never hides every tab', () => {
    const only: Block = { type: 'tabs', options: {}, tabs: [{ label: 'Access', blocks: [{ type: 'access', data: INS, options: {} }] }] };
    expect(hiddenTabIndexes(only, () => noAccess, [0])).toEqual([]);
  });
});

describe('TabsBlock', () => {
  const render = (props: Partial<BlockProps>) => renderToStaticMarkup(createElement(TabsBlock, {
    block: tabsBlock, frame: null, options: {}, renderChild: (child: Block) => createElement('p', { 'data-child': child.type }), ...props,
  } as never));

  it('every visible tab carries data-lab-tab and data-lab-tab-key; a tab without a labelKey has no key', () => {
    const html = render({});
    expect(html).toContain('data-lab-tab="0"');
    expect(html).toContain('data-lab-tab-key="daily"');
    expect(html).toContain('data-lab-tab-key="access"');
    expect(html).toContain('data-lab-tab-key="dim.country"');
    expect(html).toMatch(/data-lab-tab="3"(?![^>]*data-lab-tab-key)[^>]*>Device</);
    expect(tabKeyOf('lab.explorer.tab.dim.language')).toBe('dim.language');
    expect(tabKeyOf('lab.other.key')).toBeNull();
    expect(tabKeyOf(undefined)).toBeNull();
  });

  it('the label is the labelKey copy in the reader language, else the spec label', () => {
    const html = render({});
    expect(html).toContain('>Günlük<');
    expect(html).toContain('>Ülke<');
    expect(html).toContain('>Device<');
    expect(html).not.toContain('>Daily<');
  });

  it('a hidden tab renders neither its button nor its key, and a hidden active tab falls back to the first visible', () => {
    const html = render({ hiddenTabs: [1], activeTab: 1, onTab: () => {} });
    expect(html).not.toContain('data-lab-tab="1"');
    expect(html).not.toContain('data-lab-tab-key="access"');
    expect(html).toMatch(/aria-selected="true"[^>]*data-lab-tab="0"|data-lab-tab="0"[^>]*aria-selected="true"/);
    expect(html).toContain('data-child="trend"');
    expect(visibleTab(1, 4, [1])).toBe(0);
    expect(visibleTab(2, 4, [0, 1])).toBe(2);
    expect(visibleTab(9, 4, [])).toBe(3);
  });
});

describe('BoardCard: hidden tabs and the reader funnel', () => {
  const seen: { block: Block; props: BlockProps }[] = [];
  const renderBlock = (block: Block, props: BlockProps) => {
    seen.push({ block, props });
    return block.type === 'tabs' ? createElement(TabsBlock, { ...props, block }) : createElement('p', { 'data-block': block.type });
  };
  const picker: Card = {
    id: 'c-x', at: { x: 0, y: 0, w: 12, h: 12 }, insight: INS,
    blocks: [{ type: 'breakdown', data: INS, options: { picker: true } }, tabsBlock],
  };
  const frames = { 'c-x:1.1.0': noAccess as Frame, 'c-x:1.0.0': noAccess as Frame };

  it('hides the Access tab of a card whose access frame is empty', () => {
    const html = renderToStaticMarkup(createElement(BoardCard, { card: picker, frames, summaries: {}, renderBlock }));
    expect(html).toContain('data-lab-tab-key="daily"');
    expect(html).not.toContain('data-lab-tab-key="access"');
  });

  it('a picker card hands the picked funnel to blocks without their own funnel option', () => {
    seen.length = 0;
    const view = setTab(setFunnel(EMPTY_VIEW, INS, 'ladder'), '1', 0);
    renderToStaticMarkup(createElement(BoardCard, { card: picker, frames, summaries: {}, renderBlock, view, onView: () => {} }));
    const breakdown = seen.find((s) => s.block.type === 'breakdown')!;
    expect(breakdown.props.funnel).toBe('ladder');
    expect(typeof breakdown.props.onFunnel).toBe('function');
    expect(breakdown.props.options.funnel).toBe('ladder');
    expect(breakdown.block.options.funnel).toBe('ladder');
    // The board file is never edited: the card's own spec keeps no funnel.
    expect(picker.blocks![0].options.funnel).toBeUndefined();
  });

  it('a block naming its own funnel keeps it; a card without a picker gets no funnel props', () => {
    seen.length = 0;
    const own: Card = { ...picker, blocks: [{ type: 'breakdown', data: INS, options: { picker: true, funnel: 'quiz' } }] };
    renderToStaticMarkup(createElement(BoardCard, { card: own, frames, summaries: {}, renderBlock, view: setFunnel(EMPTY_VIEW, INS, 'ladder'), onView: () => {} }));
    expect(seen[0].props.options.funnel).toBe('quiz');
    seen.length = 0;
    const plain: Card = { ...picker, blocks: [{ type: 'breakdown', data: INS, options: {} }] };
    renderToStaticMarkup(createElement(BoardCard, { card: plain, frames, summaries: {}, renderBlock, view: setFunnel(EMPTY_VIEW, INS, 'ladder'), onView: () => {} }));
    expect(seen[0].props.funnel).toBeUndefined();
    expect(seen[0].props.onFunnel).toBeUndefined();
    expect(seen[0].props.options.funnel).toBeUndefined();
  });
});
