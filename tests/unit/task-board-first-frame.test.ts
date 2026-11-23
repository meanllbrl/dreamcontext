/**
 * The task board's first frame (a switch to Tasks): the root cause of the ~110 ms block was a full
 * layout of every card (~600 cards, ~9,700 elements) plus one status query per card; the fix keeps
 * every card in the DOM but lets the browser skip laying out the ones out of view, reads the status
 * model once for the board, and draws a column's first cards before the rest. Rendered parts run
 * directly; the board's wiring is pinned by source text (no DOM harness at the root). The runtime
 * proof is scripts/verify/app-smooth.mjs (apps→tasks).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { BoardColumn } = await import('../../dashboard/src/components/tasks/BoardColumn.js');
const { buildStatusModel, DEFAULT_STATUSES } = await import('../../dashboard/src/lib/statusModel.js');

const DIR = join(import.meta.dirname, '../../dashboard/src/components/tasks');
const src = (f: string) => readFileSync(join(DIR, f), 'utf8');

const task = (i: number) => ({
  id: `task_${i}`, slug: `gorev-${i}`, name: `Görev ${i}`, description: '', status: 'todo', priority: 'medium',
  urgency: 'medium', tags: [], parent_task: null, related_feature: null, version: null, updated_at: '2026-02-01',
  created_at: '2026-01-01',
});

const cardProps = { description: false, tags: false, priority: true, urgency: false, due: false, rice: false, assignee: false, version: false, subtasks: false, attachments: false };
const noop = () => {};

function column(cardLimit?: number) {
  const cards = Array.from({ length: 5 }, (_, i) => task(i));
  return renderToStaticMarkup(createElement(BoardColumn, {
    col: { key: 'todo', label: 'To Do', count: cards.length, color: '#999', collapsed: false, subs: [{ key: '_all', hasHeader: false, cards }] },
    cardProps, sm: buildStatusModel(DEFAULT_STATUSES), cardLimit, dragId: null, draggable: true,
    onToggleCollapse: noop, onAddTask: noop, onCardClick: noop, onCardDragStart: noop, onCardDragEnd: noop,
    onColumnDragOver: noop, onColumnDrop: noop,
  } as never));
}
const cardCount = (html: string) => (html.match(/data-task-slug=/g) ?? []).length;

describe('a column draws its first cards, then all of them', () => {
  it('with a limit it draws only that many cards, and the count still says every one', () => {
    const html = column(2);
    expect(cardCount(html)).toBe(2);
    expect(html).toContain('>5</span>');
  });

  it('without a limit it draws every card', () => {
    expect(cardCount(column())).toBe(5);
  });

  it('the board lifts the limit once, after its first frame, as a transition', () => {
    const board = src('KanbanBoard.tsx');
    expect(board).toContain('cardLimit={allCards ? undefined : FIRST_CARDS}');
    expect(board).toMatch(/requestAnimationFrame\(\(\) => \{ timer = window\.setTimeout\(\(\) => startTransition\(\(\) => setAllCards\(true\)\)/);
  });
});

describe('a card costs no query and no layout while out of view', () => {
  it('the card takes the board\'s status model instead of reading its own', () => {
    const card = src('BoardCard.tsx');
    expect(card).not.toContain('useStatusModel(');
    expect(src('BoardColumn.tsx')).toContain('sm={sm}');
    expect(src('KanbanBoard.tsx')).toContain('sm={sm}');
  });

  it('a card out of view is skipped by layout and paint, with a remembered height', () => {
    expect(src('Board.css')).toMatch(/\.bd-card \{ content-visibility: auto; contain-intrinsic-size: auto \d+px auto \d+px; \}/);
  });
});
