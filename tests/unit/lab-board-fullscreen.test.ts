/**
 * Card fullscreen (BoardPage `?card=<id>`) and the view state it keeps. The page holds every card's
 * view (viewReducer: a board switch empties them, a removed card's view dies), the overlay draws the
 * ONE live copy of the card while its grid slot is an empty lifted box, and the fullscreen card has a
 * full header with an exit button. The open tab is controlled by the card, so it survives the switch.
 * Pure parts run directly; the page's DOM wiring is pinned by source text (no DOM harness at the
 * root, the lab-board-sync-ux.test.ts idiom); the runtime proof is scripts/verify/lab-boards.mjs.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Block, BlockProps, Card } from '../../dashboard/src/components/lab/board/boardTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/ThemeContext.js', () => ({
  useTheme: () => ({ theme: 'light', resolved: 'light', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));

const { viewReducer, fullscreenCard } = await import('../../dashboard/src/components/lab/board/BoardPage.js');
const { BoardCard } = await import('../../dashboard/src/components/lab/board/BoardCard.js');
const { TabsBlock } = await import('../../dashboard/src/components/lab/blocks/TabsBlock.js');
const { EMPTY_VIEW, setTab } = await import('../../dashboard/src/components/lab/board/cardViewState.js');

const DIR = join(import.meta.dirname, '../../dashboard/src/components/lab/board');
const pageSrc = readFileSync(join(DIR, 'BoardPage.tsx'), 'utf8');
const menuSrc = readFileSync(join(DIR, 'CardMenu.tsx'), 'utf8');
const css = readFileSync(join(DIR, 'board.css'), 'utf8');

const tabsBlock: Block = {
  type: 'tabs', options: {},
  tabs: [
    { label: 'Daily', blocks: [{ type: 'text', options: { markdown: 'daily' } }] },
    { label: 'Benchmark', blocks: [{ type: 'text', options: { markdown: 'bench' } }] },
    { label: 'Flow', blocks: [{ type: 'text', options: { markdown: 'flow' } }] },
  ],
};
const card: Card = { id: 'c-explorer', at: { x: 0, y: 0, w: 12, h: 12 }, title: 'Acme explorer', blocks: [tabsBlock] };

describe('viewReducer', () => {
  it('a prune for another board empties every view; a same-board prune drops only removed cards', () => {
    let s = viewReducer({ board: null, views: {} }, { type: 'prune', board: 'demo', cards: ['a', 'b'] });
    expect(s).toEqual({ board: 'demo', views: {} });
    s = viewReducer(s, { type: 'update', board: 'demo', card: 'a', fn: (v) => setTab(v, '0', 2) });
    s = viewReducer(s, { type: 'update', board: 'demo', card: 'b', fn: (v) => setTab(v, '0', 1) });
    expect(s.views.a.tabs['0']).toBe(2);
    const same = viewReducer(s, { type: 'prune', board: 'demo', cards: ['a', 'b'] });
    expect(same).toBe(s);
    const pruned = viewReducer(s, { type: 'prune', board: 'demo', cards: ['a'] });
    expect(Object.keys(pruned.views)).toEqual(['a']);
    expect(viewReducer(s, { type: 'prune', board: 'other', cards: ['a'] }).views).toEqual({});
  });

  it('drops an update from a board that is no longer on screen, and a no-op update keeps the state', () => {
    const s = viewReducer({ board: null, views: {} }, { type: 'prune', board: 'demo', cards: ['a'] });
    expect(viewReducer(s, { type: 'update', board: 'old', card: 'a', fn: (v) => setTab(v, '0', 1) })).toBe(s);
    expect(viewReducer(s, { type: 'update', board: 'demo', card: 'a', fn: (v) => v })).toBe(s);
  });
});

describe('fullscreenCard', () => {
  const board = { cards: [card], error: null };
  it('opens only a card on this readable board', () => {
    expect(fullscreenCard(board, 'c-explorer')).toBe(card);
    expect(fullscreenCard(board, 'nope')).toBeNull();
    expect(fullscreenCard(board, null)).toBeNull();
    expect(fullscreenCard(null, 'c-explorer')).toBeNull();
    expect(fullscreenCard({ cards: [card], error: { kind: 'parse', message: 'x' } }, 'c-explorer')).toBeNull();
  });
});

describe('the fullscreen card keeps the view', () => {
  const renderBlock = (block: Block, props: BlockProps) => (block.type === 'tabs'
    ? createElement(TabsBlock, { ...props, block })
    : createElement('p', { 'data-md': String(block.options.markdown) }));

  it('the open tab comes from the held view, in the grid and fullscreen alike', () => {
    const view = setTab(EMPTY_VIEW, '0', 2);
    for (const fullscreen of [false, true]) {
      const html = renderToStaticMarkup(createElement(BoardCard, {
        card, frames: {}, summaries: {}, renderBlock, view, onView: () => {}, fullscreen, onExitFullscreen: () => {},
      }));
      expect(html).toMatch(/aria-selected="true"[^>]*data-lab-tab="2"|data-lab-tab="2"[^>]*aria-selected="true"/);
      expect(html).toContain('data-md="flow"');
    }
  });

  it('fullscreen draws a full header with an exit button; the grid card has none', () => {
    const on = renderToStaticMarkup(createElement(BoardCard, {
      card: { ...card, at: { x: 0, y: 0, w: 4, h: 2 } }, frames: {}, summaries: {}, renderBlock, fullscreen: true, onExitFullscreen: () => {},
    }));
    expect(on).toContain('data-lab-card-exit');
    expect(on).toContain('board-card--fullscreen');
    expect(on).not.toContain('board-card--short');
    const off = renderToStaticMarkup(createElement(BoardCard, { card, frames: {}, summaries: {}, renderBlock }));
    expect(off).not.toContain('data-lab-card-exit');
  });

  it('an untitled heading card fullscreen still gets the header and the exit button', () => {
    const heading: Card = { id: 'h-1', at: { x: 0, y: 0, w: 12, h: 1 }, blocks: [{ type: 'text', options: { markdown: '## Growth' } }] };
    const html = renderToStaticMarkup(createElement(BoardCard, {
      card: heading, frames: {}, summaries: {}, renderBlock, fullscreen: true, onExitFullscreen: () => {},
    }));
    expect(html).not.toContain('board-card--heading');
    expect(html).toContain('data-lab-card-exit');
  });

  it('TabsBlock without a held tab keeps its own (first tab open)', () => {
    const html = renderToStaticMarkup(createElement(TabsBlock, { block: tabsBlock, frame: null, options: {}, renderChild: () => null } as never));
    expect(html).toMatch(/aria-selected="true"[^>]*data-lab-tab="0"|data-lab-tab="0"[^>]*aria-selected="true"/);
  });
});

describe('BoardPage fullscreen wiring', () => {
  it('reads ?card=, pushes a history entry to open, goes Back (or clears the param) to close', () => {
    expect(pageSrc).toContain("fullscreenCard(board, search.get('card'))");
    expect(pageSrc).toMatch(/window\.history\.pushState\([^)]*\);\s*pushedFs\.current = true;\s*updateSearch\(\(p\) => p\.set\('card', id\)\)/);
    expect(pageSrc).toContain('window.history.back()');
    expect(pageSrc).toContain("updateSearch((p) => p.delete('card'))");
  });

  it('draws the overlay as a modal dialog holding the ONE live card, and a lifted empty grid slot', () => {
    expect(pageSrc).toMatch(/className="board-fullscreen"\s+role="dialog"\s+aria-modal="true"/);
    expect(pageSrc).toContain('data-lab-fullscreen={fsCard.id}');
    expect(pageSrc).toContain('{cardNode(fsCard, true)}');
    expect(pageSrc).toMatch(/card\.id === fsId\s+\? <div className="board-card board-card--lifted" data-lab-card-lifted=\{card\.id\} aria-hidden="true" \/>/);
  });

  it('Esc closes through the overlay stack; focus goes into the overlay and back to the card menu', () => {
    expect(pageSrc).toMatch(/e\.key !== 'Escape' \|\| !isTopOverlay\(overlayId\)/);
    expect(pageSrc).toContain("querySelector<HTMLElement>('[data-lab-card-exit]')?.focus()");
    expect(pageSrc).toContain("querySelector<HTMLElement>('[data-lab-card-menu]')?.focus()");
  });

  it('every card menu offers Full screen, the inspector gets frames and caches', () => {
    expect(pageSrc).toContain('onFullscreen={fullscreen ? closeFullscreen : () => openFullscreen(card.id)}');
    expect(menuSrc).toContain('data-lab-card-fullscreen=');
    expect(menuSrc).toContain("'lab.board.card.fullscreen'");
    expect(pageSrc).toMatch(/frames=\{frames\}\s+caches=\{cacheMap\}\s+onChange=/);
  });

  it('the overlay covers the viewport under the menus, tokens only', () => {
    const rule = css.slice(css.indexOf('.board-fullscreen {'), css.indexOf('}', css.indexOf('.board-fullscreen {')));
    expect(rule).toContain('position: fixed');
    expect(rule).toContain('inset: 0');
    expect(rule).toContain('z-index: 50');
    expect(rule).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(/i);
  });
});
