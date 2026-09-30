/**
 * The section heading card (BoardCard `isHeadingCard`): ONLY an untitled card whose one text
 * block is a one-line heading gets the heading chrome (no box, no scrolling body). A derived
 * `h-*` group heading is one; an untitled multi-paragraph note card is NOT, it keeps the card
 * box and the scrolling body. Rendered to static markup with the dashboard's own React.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { deriveBoardsFromLegacy } from '../../src/lib/lab/boards.js';
import type { Block, Card } from '../../dashboard/src/components/lab/board/boardTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
// A note renders through MarkdownPreview, which reads the theme.
vi.mock('../../dashboard/src/context/ThemeContext.js', () => ({
  useTheme: () => ({ theme: 'light', resolved: 'light', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));

const { BoardCard, isHeadingCard } = await import('../../dashboard/src/components/lab/board/BoardCard.js');
const { renderBlock } = await import('../../dashboard/src/components/lab/blocks/blockRegistry.js');

const NOTE = [
  'Weekly notes for the fictional Atlantis team.',
  '',
  'Signups rose after the onboarding change. Retention held.',
  '',
  '- follow up on the pricing page',
  '- check the referral source',
].join('\n');

const derivedHeading = (): Card => {
  const [board] = deriveBoardsFromLegacy([
    { slug: 'sessions', title: 'Sessions', render: 'line', category: 'Growth', group: 'Acquisition' },
  ] as Parameters<typeof deriveBoardsFromLegacy>[0]);
  const card = board.spec.cards.find((c) => c.id.startsWith('h-'));
  if (!card) throw new Error('no derived heading card');
  return card as unknown as Card;
};

const noteCard: Card = { id: 'c-notes', at: { x: 0, y: 0, w: 6, h: 4 }, blocks: [{ type: 'text', options: { markdown: NOTE } }] };

const html = (card: Card) => renderToStaticMarkup(createElement(BoardCard, {
  card, frames: {}, summaries: {}, renderBlock, menu: createElement('button', { type: 'button' }, 'menu'),
}));

describe('heading card chrome is for one-line headings only', () => {
  it('a derived h-* card is a heading card and renders its text as the section heading', () => {
    const card = derivedHeading();
    expect(isHeadingCard(card.blocks as Block[], '', false)).toBe(true);
    const out = html(card);
    expect(out).toContain('board-card--heading');
    expect(out).toMatch(/data-lab-heading[^>]*>Acquisition</);
  });

  it('an untitled multi-paragraph note card is NOT a heading card: it keeps the card box and the scrolling body', () => {
    expect(isHeadingCard(noteCard.blocks as Block[], '', false)).toBe(false);
    const out = html(noteCard);
    expect(out).not.toContain('board-card--heading');
    expect(out).toContain('board-card-body');
    expect(out).toContain('lab-block-scroll lab-block-text');
  });

  it('a title, a status line, a second block, or a non-heading line each rule the heading chrome out', () => {
    const one: Block[] = [{ type: 'text', options: { markdown: '### Retention' } }];
    expect(isHeadingCard(one, '', false)).toBe(true);
    expect(isHeadingCard(one, 'Notes', false)).toBe(false);
    expect(isHeadingCard(one, '', true)).toBe(false);
    expect(isHeadingCard([...one, { type: 'text', options: { markdown: '### More' } }], '', false)).toBe(false);
    expect(isHeadingCard([{ type: 'text', options: { markdown: 'Just a sentence.' } }], '', false)).toBe(false);
    expect(isHeadingCard([{ type: 'text', options: { markdown: '### Title\n\nThen a paragraph.' } }], '', false)).toBe(false);
    expect(isHeadingCard([{ type: 'callout', options: { markdown: '### Retention' } }], '', false)).toBe(false);
  });
});
