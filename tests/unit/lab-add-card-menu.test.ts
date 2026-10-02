/**
 * The add-card menu (dashboard/src/components/lab/board/AddCardMenu.tsx): unplaced insights come
 * first, library entries are offered by ref, a blank html card is one click, and every card it
 * hands to `onAdd` is placed in a free slot and passes the client strict checks.
 *
 * Pure-function tests over editorModel.ts (this repo runs no DOM harness), plus source checks for
 * the three sections and the shared DOM hooks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import catalogJson from '../../dashboard/src/generated/block-catalog.json';
import { findOverlaps } from '../../dashboard/src/generated/grid';
import type { BlockCatalog, Card, LibraryBlock } from '../../dashboard/src/components/lab/board/boardTypes';
import type { InsightSummary } from '../../dashboard/src/hooks/useLab';
import {
  cardFromBlockType, cardFromHtml, cardFromInsight, cardProblems, insightCardSize, insightChoices, libraryBlockTypes,
  uniqueCardId,
} from '../../dashboard/src/components/lab/board/editorModel';

const catalog = catalogJson as unknown as BlockCatalog;
const SRC = join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/board');
const ctx = { insight: 'daily-signups', tabLabel: 'Tab 1', htmlStarter: '<p>Hi</p>' };

function summary(slug: string, title: string, extra: Partial<InsightSummary> = {}): InsightSummary {
  return {
    slug, title, category: null, group: null, render: 'line', size: null, width: null, height: null, unit: null,
    binding: null, latest: null, fetchedAt: null, granularity: null, error: null, errorAt: null, ttlMinutes: 60,
    staleMinutes: null, stale: null, tweaks: [], ...extra,
  } as InsightSummary;
}

const insights = [summary('daily-signups', 'Signups'), summary('weekly-trials', 'Trials'), summary('mrr', 'MRR'), summary('churn', 'Churn')];
const board = {
  cards: [
    { id: 'c-daily-signups', at: { x: 0, y: 0, w: 4, h: 3 }, insight: 'daily-signups' },
    { id: 'c-mrr', at: { x: 4, y: 0, w: 8, h: 3 }, insight: 'mrr' },
  ] as Card[],
};
const library: LibraryBlock[] = [
  { slug: 'cohort-grid', title: 'Cohort grid', description: 'Retention by week', inputs: [{ name: 'cohorts', kind: 'table' }, { name: 'spark', kind: null }], html: '<div></div>', rev: 'r1' },
  { slug: 'plain-note', title: 'Plain note', description: null, inputs: [], html: '<p>n</p>', rev: 'r2' },
];

const valid = (c: Card) => expect(cardProblems(catalog, c)).toEqual([]);
const placed = (c: Card) => expect(findOverlaps([...board.cards, c])).toEqual([]);

describe('From an insight', () => {
  it('lists unplaced insights first, in the server order, then the rest in list order', () => {
    const choices = insightChoices(insights, ['churn', 'weekly-trials']);
    expect(choices.map((c) => c.slug)).toEqual(['churn', 'weekly-trials', 'daily-signups', 'mrr']);
    expect(choices.map((c) => c.unplaced)).toEqual([true, true, false, false]);
    expect(choices[0].title).toBe('Churn');
  });

  it('an unplaced slug the list does not know still shows (by slug), duplicates once', () => {
    const choices = insightChoices(insights, ['ghost', 'ghost']);
    expect(choices[0]).toEqual({ slug: 'ghost', title: 'ghost', unplaced: true });
    expect(choices.filter((c) => c.slug === 'ghost')).toHaveLength(1);
  });

  it('makes a legacy card (no blocks, drawn as v1) with a fresh id in a free slot', () => {
    const c = cardFromInsight(catalog, board, 'weekly-trials', insights[1]);
    expect(c).toMatchObject({ id: 'c-weekly-trials', insight: 'weekly-trials' });
    expect(c).not.toHaveProperty('blocks');
    placed(c);
    valid(c);
    // A second copy of an insight already on the board gets its own id.
    expect(cardFromInsight(catalog, board, 'daily-signups').id).toBe('c-daily-signups-2');
  });

  it('sizes from the manifest width/height, else the render default span (D2)', () => {
    expect(insightCardSize(catalog, summary('a', 'A', { render: 'line' } as Partial<InsightSummary>))).toEqual({ w: 4, h: 4 });
    expect(insightCardSize(catalog, summary('a', 'A', { render: 'table' } as Partial<InsightSummary>))).toEqual({ w: 8, h: 4 });
    expect(insightCardSize(catalog, summary('a', 'A', { render: 'app' } as Partial<InsightSummary>))).toEqual({ w: 8, h: 6 });
    expect(insightCardSize(catalog, summary('a', 'A', { width: 3, height: 'xl' } as unknown as Partial<InsightSummary>))).toEqual({ w: 12, h: 8 });
    expect(insightCardSize(catalog, undefined)).toEqual({ w: 4, h: 4 });
  });
});

describe('From the library: block types', () => {
  it('offers every catalog type but insight, html (own sections) and filter (added inside a card)', () => {
    const types = libraryBlockTypes(catalog);
    expect(types).not.toContain('insight');
    expect(types).not.toContain('html');
    expect(types).not.toContain('filter');
    expect(types).toEqual(catalog.types.filter((t) => !['insight', 'html', 'filter'].includes(t)));
  });

  it('each makes a valid, placed card at its catalog default size, bound to the chosen insight', () => {
    for (const type of libraryBlockTypes(catalog)) {
      const c = cardFromBlockType(catalog, board, type, ctx);
      const entry = catalog.blocks.find((b) => b.type === type)!;
      expect(c.blocks, type).toHaveLength(1);
      expect(c.blocks![0].type).toBe(type);
      expect({ w: c.at.w, h: c.at.h }, type).toEqual(entry.defaultSize);
      if (entry.data === 'binding') {
        expect(c.blocks![0].data, type).toBe('daily-signups');
        expect(c.insight, type).toBe('daily-signups');
      } else {
        expect(c.blocks![0], type).not.toHaveProperty('data');
      }
      placed(c);
      valid(c);
    }
  });

  it('ids are unique against the board', () => {
    const b2 = { cards: [...board.cards, { id: 'c-daily-signups-line', at: { x: 0, y: 3, w: 1, h: 1 }, insight: 'x' }] };
    expect(cardFromBlockType(catalog, b2, 'line', ctx).id).toBe('c-daily-signups-line-2');
    expect(cardFromBlockType(catalog, board, 'text', ctx).id).toBe('c-text');
    expect(uniqueCardId({ cards: [] }, 'C Weird__ID!')).toBe('c-weird-id');
  });
});

describe('Custom HTML', () => {
  it('a library entry is reused by ref, each declared input bound to the chosen insight', () => {
    const c = cardFromHtml(catalog, board, library[0], ctx);
    expect(c.blocks).toEqual([{ type: 'html', options: { ref: 'cohort-grid', inputs: { cohorts: 'daily-signups', spark: 'daily-signups' } } }]);
    expect(c.id).toBe('c-cohort-grid');
    placed(c);
    valid(c);
  });

  it('an entry with no inputs, or no insight to bind, still makes a valid card', () => {
    valid(cardFromHtml(catalog, board, library[1], ctx));
    const unbound = cardFromHtml(catalog, board, library[0], { ...ctx, insight: null });
    expect(unbound.blocks![0].options).toEqual({ ref: 'cohort-grid', inputs: {} });
    valid(unbound);
  });

  it('blank is an inline block with the starter markup and no inputs', () => {
    const c = cardFromHtml(catalog, board, null, ctx);
    expect(c.blocks).toEqual([{ type: 'html', options: { html: '<p>Hi</p>', inputs: {} } }]);
    expect(c.id).toBe('c-html');
    expect({ w: c.at.w, h: c.at.h }).toEqual(catalog.blocks.find((b) => b.type === 'html')!.defaultSize);
    valid(c);
  });
});

describe('the menu source', () => {
  const src = readFileSync(join(SRC, 'AddCardMenu.tsx'), 'utf8');

  it('has the three sections, the library entries and blank, and the shared DOM hooks', () => {
    for (const hook of ['data-lab-add-card', 'data-lab-add-insight=', 'data-lab-add-type=', 'data-lab-add-html={entry.slug}', 'data-lab-add-html="blank"']) {
      expect(src.includes(hook), hook).toBe(true);
    }
    expect(src).toMatch(/insightChoices\(insights, unplaced\)/);
    expect(src).toMatch(/libraryBlockTypes\(catalog\)/);
    expect(src).not.toMatch(/data-lab-placeholder/);
    expect(src).not.toMatch(/—/);
  });

  it('emits through onAdd only; it never writes a board itself', () => {
    expect(src).toMatch(/onAdd\(cardFromInsight/);
    expect(src).toMatch(/onAdd\(cardFromBlockType/);
    expect(src).toMatch(/onAdd\(cardFromHtml/);
    expect(src).not.toMatch(/\/lab\/boards|api\.put|useSaveBoard/);
  });
});
