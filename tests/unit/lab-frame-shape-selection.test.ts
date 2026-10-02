/**
 * A card's breakdown SELECTION narrows its same-insight table frames (frameShape): every selected
 * dim the table carries is ANDed into `where`, so the total follows; a dim it does not carry leaves
 * it whole and BoardCard prints "Not split by X". A table of ANOTHER insight is never touched, and
 * the filter block keeps its chips. Rendered to static markup with the dashboard's own React.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { Block, BlockProps, Card, Frame } from '../../dashboard/src/components/lab/board/boardTypes.js';
import type { TableFrame } from '../../dashboard/src/generated/frameOps.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const { selectionIgnored, shapeBlockFrame } = await import('../../dashboard/src/components/lab/blocks/frameShape.js');
const { BoardCard, blockInsight } = await import('../../dashboard/src/components/lab/board/BoardCard.js');
const { EMPTY_VIEW, setSelection } = await import('../../dashboard/src/components/lab/board/cardViewState.js');
const { frameKey } = await import('../../dashboard/src/generated/frameOps.js');

const INS = 'acme-funnel-explorer';

const declines: TableFrame = {
  kind: 'table', insight: INS, dataset: 'declines', label: null, unit: null,
  dims: [{ key: 'reason', label: 'Reason' }, { key: 'platform', label: 'Platform' }] as TableFrame['dims'],
  rows: [
    { d: { reason: 'Card declined', platform: 'Meta Ads' }, v: 40 },
    { d: { reason: 'Card declined', platform: 'TikTok Ads' }, v: 10 },
    { d: { reason: 'Expired', platform: 'Meta Ads' }, v: 5 },
    { d: { reason: 'Expired', platform: 'TikTok Ads' }, v: 20 },
  ],
  sourceTotal: { v: 75 },
  total: { count: 4, v: 75, n: null },
};

const block: Block = { type: 'table', data: `${INS}/declines`, options: {} };

describe('shapeBlockFrame with a selection', () => {
  it('narrows a table by a selected dim it carries and the total follows', () => {
    const out = shapeBlockFrame(block, declines, [], { platform: 'TikTok Ads' }) as TableFrame;
    expect(out.rows.map((r) => r.d.reason)).toEqual(['Card declined', 'Expired']);
    expect(out.total.count).toBe(2);
    expect(out.total.v).toBe(30);
  });

  it('ignores a selected dim the table does not carry, and reports it', () => {
    const sel = { platform: 'Meta Ads', language: 'EN' };
    const out = shapeBlockFrame(block, declines, [], sel) as TableFrame;
    expect(out.total.v).toBe(45);
    expect(selectionIgnored(declines, sel)).toEqual(['language']);
    expect(selectionIgnored(declines, { platform: 'Meta Ads' })).toEqual([]);
    expect(selectionIgnored(declines, null)).toEqual([]);
  });

  it('ANDs with a static where (a value outside it leaves nothing)', () => {
    const narrowed: Block = { ...block, options: { where: { platform: ['Meta Ads'] } } };
    expect((shapeBlockFrame(narrowed, declines, [], { platform: 'TikTok Ads' }) as TableFrame).rows).toHaveLength(0);
    expect((shapeBlockFrame(narrowed, declines, [], { platform: 'Meta Ads' }) as TableFrame).rows).toHaveLength(2);
  });

  it('never narrows a filter block or a non-table frame; no selection = today', () => {
    const filter: Block = { type: 'filter', data: `${INS}/declines`, options: {} };
    expect((shapeBlockFrame(filter, declines, [], { platform: 'Meta Ads' }) as TableFrame).rows).toHaveLength(4);
    expect((shapeBlockFrame(block, declines, []) as TableFrame).rows).toHaveLength(4);
    expect(selectionIgnored({ kind: 'empty', insight: INS, reason: 'no-cache' } as unknown as Frame, { a: 'b' })).toEqual([]);
  });
});

describe('BoardCard hands the selection to same-insight tables', () => {
  const seen: Array<{ path: string; frame: Frame | null; selection: unknown }> = [];
  const renderBlock = (b: Block, props: BlockProps) => {
    seen.push({ path: String(b.data), frame: props.frame, selection: props.selection });
    return createElement('i', { 'data-rows': props.frame && props.frame.kind === 'table' ? props.frame.rows.length : -1 });
  };

  it('blockInsight is the binding before "/", else the card insight', () => {
    expect(blockInsight({ type: 'table', data: 'a/b', options: {} }, { insight: 'c' })).toBe('a');
    expect(blockInsight({ type: 'text', options: {} }, { insight: 'c' })).toBe('c');
    expect(blockInsight({ type: 'text', options: {} }, {})).toBeNull();
  });

  it('narrows its own insight, leaves another insight alone, and notes the dims a table is not split by', () => {
    const other: TableFrame = { ...declines, insight: 'acme-other' };
    const card: Card = {
      id: 'c1', at: { x: 0, y: 0, w: 6, h: 6 }, insight: INS,
      blocks: [block, { type: 'table', data: 'acme-other/declines', options: {} }],
    };
    const frames = { [frameKey('c1', [0])]: declines, [frameKey('c1', [1])]: other };
    const view = setSelection(EMPTY_VIEW, INS, { platform: 'Meta Ads', language: 'EN' });
    seen.length = 0;
    const html = renderToStaticMarkup(createElement(BoardCard, { card, frames, summaries: {}, renderBlock, view, onView: () => {} }));
    expect(seen[0].selection).toEqual({ platform: 'Meta Ads', language: 'EN' });
    expect((seen[0].frame as TableFrame).rows).toHaveLength(2);
    expect((seen[1].frame as TableFrame).rows).toHaveLength(4);
    expect(seen[1].selection).toEqual({});
    expect(html).toContain('data-lab-not-split="language"');
    expect(html.match(/data-lab-not-split/g)).toHaveLength(1);
    expect(html).toContain('lab.board.card.notSplit');
  });

  it('with no selection draws exactly as before (no note, whole table)', () => {
    const card: Card = { id: 'c1', at: { x: 0, y: 0, w: 6, h: 6 }, insight: INS, blocks: [block] };
    seen.length = 0;
    const html = renderToStaticMarkup(createElement(BoardCard, { card, frames: { [frameKey('c1', [0])]: declines }, summaries: {}, renderBlock }));
    expect((seen[0].frame as TableFrame).rows).toHaveLength(4);
    expect(html).not.toContain('data-lab-not-split');
  });
});
