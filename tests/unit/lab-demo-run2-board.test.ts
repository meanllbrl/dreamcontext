/**
 * Insights v2 demo run 2 findings, the board/editor/detail lane (owner, 2026-09-30):
 * (1) a move or resize compacts the grid AND fills the holes gravity alone leaves;
 * (2) the "Board updated / Undo" toast goes away on its own, held while pointed at or focused;
 * (3) an untitled card's floating menu never sits over the markup in view mode;
 * (4) the detail panel reads a dataset/table insight as its rows;
 * (5) the inspector is headed by a name, never the raw card id;
 * (6) add-card library entries show their whole title.
 * Fixtures name a fictional product (Northwind Notes).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';
import { compact, findOverlaps } from '../../dashboard/src/generated/grid.js';
import type { Board, BlockCatalog, Card, LibraryBlock } from '../../dashboard/src/components/lab/board/boardTypes.js';
import type { InsightCache } from '../../dashboard/src/hooks/useLab.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

/** AddCardMenu reads the bound insight's cache (the funnel explorer preset); no QueryClient here, so nothing is loaded. */
vi.mock('../../dashboard/src/hooks/useBoards.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  useInsightCache: () => ({ data: undefined }),
}));

const { coveredHoles, fillHoles, placeCard } = await import('../../dashboard/src/components/lab/board/BoardGrid.js');
const { toastDelay, TOAST_MS } = await import('../../dashboard/src/components/lab/board/BoardPage.js');
const { inspectorTitle } = await import('../../dashboard/src/components/lab/board/BlockInspector.js');
const { AddCardMenu } = await import('../../dashboard/src/components/lab/board/AddCardMenu.js');
const { detailTable } = await import('../../dashboard/src/components/lab/InsightDetailPanel.js');

const catalog = catalogJson as unknown as BlockCatalog;
const root = join(import.meta.dirname, '../../dashboard/src/components/lab');
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');

const c = (id: string, x: number, y: number, w: number, h: number): Card => ({ id, insight: id, at: { x, y, w, h } });

/** The demo board before "resize Daily active users to 9 wide". */
const demo = (): Card[] => [
  c('mrr', 0, 0, 3, 5), c('dau', 3, 0, 6, 5), c('plan-mix', 9, 0, 3, 5),
  c('signups', 0, 5, 4, 5), c('funnel', 4, 5, 4, 5), c('top-countries', 8, 5, 4, 5),
  c('retention', 0, 10, 12, 5),
];

describe('(1) a move or resize leaves no holes', () => {
  it('coveredHoles counts empty cells with a card below them, not the open space at the end', () => {
    expect(coveredHoles(demo())).toBe(0);
    expect(coveredHoles([c('a', 0, 0, 4, 2), c('b', 0, 4, 12, 2)])).toBe(2 * 4 + 4 * 8); // gap under a + two empty rows beside it
    expect(coveredHoles([c('a', 0, 0, 4, 2)])).toBe(0);
  });

  it('gravity alone leaves the demo hole; placeCard fills it, with the resized card where it was put', () => {
    const cards = demo();
    const target = { x: 3, y: 0, w: 9, h: 5 };
    // What the old placeCard (push down + compact only) produced: a 40+ cell hole left of Top countries.
    const pushed = cards.map((k) => (k.id === 'dau' ? { ...k, at: target } : k));
    const gravityOnly = compact([pushed[1], pushed[0], ...pushed.slice(2)]);
    expect(coveredHoles(gravityOnly)).toBeGreaterThan(0);

    const next = placeCard(cards, 'dau', target);
    expect(coveredHoles(next)).toBe(0);
    expect(findOverlaps(next)).toEqual([]);
    expect(next.find((k) => k.id === 'dau')?.at).toEqual(target);
    expect(next.map((k) => k.id)).toEqual(cards.map((k) => k.id)); // input order kept (a clean save diff)
  });

  it('a board with no holes after the gesture is exactly the compacted board (nothing moves sideways)', () => {
    const cards = demo();
    const next = placeCard(cards, 'signups', { x: 0, y: 5, w: 4, h: 5 });
    expect(next).toEqual(compact(cards));
  });

  it('the pinned card is never relocated to fill a hole', () => {
    const cards = [c('a', 0, 0, 6, 3), c('b', 6, 0, 6, 1), c('wide', 0, 3, 12, 2)];
    // `b` pinned: its hole below cannot be filled by moving b itself.
    const kept = fillHoles(cards, 'b');
    expect(kept.find((k) => k.id === 'b')?.at).toEqual({ x: 6, y: 0, w: 6, h: 1 });
  });
});

describe('(2) the toast leaves on its own unless held', () => {
  it('6 s for a toast, never while held, nothing without one', () => {
    expect(TOAST_MS).toBe(6000);
    expect(toastDelay({ id: 1 }, false)).toBe(6000);
    expect(toastDelay({ id: 1 }, true)).toBeNull();
    expect(toastDelay(null, false)).toBeNull();
  });

  it('the toast holds on pointer and focus and releases on leave (source)', () => {
    const src = read('board/BoardPage.tsx');
    expect(src).toMatch(/onPointerEnter=\{\(\) => onHold\?\.\(true\)\}/);
    expect(src).toMatch(/onPointerLeave=\{\(\) => onHold\?\.\(false\)\}/);
    expect(src).toMatch(/onFocus=\{\(\) => onHold\?\.\(true\)\}/);
    expect(src).toMatch(/const delay = toastDelay\(toast, toastHeld\)/);
    expect((src.match(/onHold=\{setToastHeld\}/g) ?? []).length).toBe(2);
  });
});

describe('(3) the untitled card menu never covers the markup in view mode', () => {
  const css = read('board/board.css');
  const rule = (sel: RegExp) => css.match(sel)?.[0] ?? '';

  it('hidden and click-through by default; shown in edit mode, on keyboard focus and while open', () => {
    const base = rule(/\.board-card-float-menu \{[^}]*\}/);
    expect(base).toMatch(/opacity: 0/);
    expect(base).toMatch(/pointer-events: none/);
    const shown = rule(/\.board-grid--editing \.board-card-float-menu,[^{]*\{[^}]*\}/);
    expect(shown).toMatch(/:focus-within/);
    expect(shown).toMatch(/\[aria-expanded='true'\]/);
    expect(shown).toMatch(/opacity: 1/);
    expect(shown).toMatch(/pointer-events: auto/);
  });

  it('no hover rule brings it back over the content', () => {
    expect(css).not.toMatch(/:hover[^{]*\.board-card-float-menu/);
    expect(css).not.toMatch(/@media \(hover: none\)[^}]*\.board-card-float-menu/);
  });
});

describe('(4) the detail panel reads a dataset table as its rows', () => {
  const COUNTRIES = ['United States', 'Germany', 'United Kingdom', 'Brazil', 'Japan', 'India', 'France', 'Canada', 'Spain', 'Mexico'];
  const base = {
    slug: 'top-countries', fetchedAt: '2026-09-30T00:00:00Z', tweaks: {}, granularity: 'daily', unit: 'users',
    series: [{ name: 'Country', points: [{ t: '2026-09-29', v: 2100 }, { t: '2026-09-30', v: 2700 }] }], latest: 2700,
    error: null, errorAt: null, history: [],
  } as unknown as InsightCache;

  it('a dataset bundle: the primary dataset, every row, the source total', () => {
    const cache = {
      ...base,
      datasets: {
        bundle: {
          kind: 'dataset/v1', primary: 'by-country',
          datasets: [
            { key: 'other', dims: [{ key: 'x' }], rows: [{ d: { x: 'a' }, v: 1 }] },
            { key: 'by-country', label: 'By country', dims: [{ key: 'country', label: 'Country' }], rows: COUNTRIES.map((k, i) => ({ d: { country: k }, v: 1000 - i * 50 })), total: { v: 39800 } },
          ],
        },
        notices: [], range: { fromISO: '2026-09-01', toISO: '2026-09-30' },
      },
    } as unknown as InsightCache;
    const table = detailTable(cache);
    expect(table?.rows.map((r) => r.d.country)).toEqual(COUNTRIES);
    expect(table?.dims).toEqual([{ key: 'country', label: 'Country' }]);
    expect(table?.total).toMatchObject({ count: 10, v: 39800 });
    expect(table?.unit).toBe('users');
  });

  it('a matrix set when there is no bundle; nothing for a series-only insight', () => {
    const cache = {
      ...base,
      matrix: { set: { kind: 'matrix/v1', dims: [{ key: 'plan' }], rows: [{ d: { plan: 'Free' }, v: 5 }, { d: { plan: 'Pro' }, v: 2 }] }, notices: [], range: { fromISO: '', toISO: '' } },
    } as unknown as InsightCache;
    expect(detailTable(cache)?.rows.map((r) => r.d.plan)).toEqual(['Free', 'Pro']);
    expect(detailTable(cache)?.dims).toEqual([{ key: 'plan', label: 'plan' }]);
    expect(detailTable(base)).toBeNull();
    expect(detailTable(null)).toBeNull();
  });

  it('the panel draws the table with the board table component for a table render (source)', () => {
    const src = read('InsightDetailPanel.tsx');
    expect(src).toMatch(/const table = summary\.render === 'table' \? detailTable\(cache\) : null;/);
    expect(src).toMatch(/\{table \? \([\s\S]*?<FrameTable[\s\S]*?rows=\{table\.rows\}/);
  });
});

describe('(5) the inspector is headed by a name, never the card id', () => {
  const t = (k: string) => ({ 'lab.block.html': 'Custom HTML', 'lab.editor.untitledCard': 'Untitled card' } as Record<string, string>)[k] ?? k;
  const insights = [{ slug: 'top-countries', title: 'Top countries by active users' }];
  const library = [{ slug: 'channel-bars', title: 'Channel bars with a toggle' }];
  const html = { type: 'html' as const, options: { html: '<p>x</p>' } };

  it('title, then insight name, then library title, then block type, then Untitled card', () => {
    expect(inspectorTitle({ id: 'c-html', title: 'Notes', at: { x: 0, y: 0, w: 1, h: 1 } }, [html], insights, library, t)).toBe('Notes');
    expect(inspectorTitle({ id: 'c-1', insight: 'top-countries', at: { x: 0, y: 0, w: 1, h: 1 } }, [], insights, library, t)).toBe('Top countries by active users');
    expect(inspectorTitle({ id: 'c-html', at: { x: 0, y: 0, w: 1, h: 1 } }, [{ type: 'html', options: { ref: 'channel-bars' } }], insights, library, t)).toBe('Channel bars with a toggle');
    expect(inspectorTitle({ id: 'c-html', at: { x: 0, y: 0, w: 1, h: 1 } }, [html], insights, library, t)).toBe('Custom HTML');
    expect(inspectorTitle({ id: 'c-html', at: { x: 0, y: 0, w: 1, h: 1 } }, [], insights, library, t)).toBe('Untitled card');
    expect(inspectorTitle({ id: 'c-html', title: '  ', at: { x: 0, y: 0, w: 1, h: 1 } }, [html], insights, library, t)).not.toBe('c-html');
  });
});

describe('(6) add-card library entries show their whole title', () => {
  const long = 'Channel bars with a now / previous / change toggle for Northwind Notes';
  const library: LibraryBlock[] = [{ slug: 'channel-bars', title: long, description: 'Horizontal bars of any one-dimension table.', inputs: [{ name: 'rows', kind: 'table' }], html: '<p></p>' } as unknown as LibraryBlock];
  const board = { slug: 'growth', title: 'Growth', order: 0, cards: [], rev: 'r', derived: false } as unknown as Board;

  it('each entry stacks its name above the description, and carries both as its tooltip', () => {
    const out = renderToStaticMarkup(createElement(AddCardMenu, {
      board, unplaced: [], insights: [], catalog, library, onAdd: () => {}, onClose: () => {},
    }));
    const button = out.match(/<button[^>]*data-lab-add-html="channel-bars"[^>]*>/)?.[0] ?? '';
    expect(button).toContain('lab-editor-item--stack');
    expect(button).toContain(`title="${long}\nHorizontal bars of any one-dimension table."`);
    expect(out).toContain(`<span class="lab-editor-item-name">${long}</span>`);
  });

  it('the name wraps to two lines instead of one ellipsized row', () => {
    const css = read('board/editors.css');
    const rule = css.match(/\.lab-editor-item--stack > \.lab-editor-item-name,[^{]*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/-webkit-line-clamp: 2/);
    expect(rule).toMatch(/white-space: normal/);
    expect(css).toMatch(/\.lab-editor-item--stack \{[^}]*flex-direction: column/);
  });
});
