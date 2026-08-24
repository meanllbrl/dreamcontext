/**
 * Unit tests for `shelfModel.ts` — the shelf's ceiling, its demotion order, its two overflow
 * mechanisms, and the id-keyed fold.
 *
 * The CEILING is the property worth the most here, and it is a safety property, not a
 * cosmetic one: the shelf sits on the composer, so a third row does not merely look wrong —
 * it eats the conversation, which is the single failure mode this placement has. It is
 * therefore tested against an adversarial input (twenty pins all demanding a row) rather
 * than against the happy path, because the criterion is "no sequence of agent blocks,
 * however many pins it sends, produces a third row" and an agent is exactly what sends them.
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveWeight, clampLede, layoutShelf, foldViews,
  SHELF_MAX_ROWS, SHELF_DETAIL_PANE_FRACTION,
  type ShelfEntry, type ShelfFact,
} from '../../dashboard/src/lib/shelfModel.js';
import {
  MAX_PINS_PER_CONVERSATION, MAX_PIN_LEDE_CHARS, MAX_TAG_LABEL_CHARS,
  type ChatViewSpec,
} from '../../dashboard/src/lib/chatViewSpec.js';

function pin(id: string, at: number, extra: Partial<Extract<ShelfEntry, { kind: 'pin' }>> = {}): ShelfEntry {
  return { kind: 'pin', id, weight: 'tag', facts: [{ label: id }], updatedAt: at, ...extra };
}
function progress(task: string, at: number): ShelfEntry {
  return { kind: 'progress', id: `progress:${task}`, task, updatedAt: at };
}
const NO_FACTS: ShelfFact[] = [];

describe('effectiveWeight — weight is a request, not a command', () => {
  it('honours a row that has prose to open', () => {
    expect(effectiveWeight(pin('a', 1, { weight: 'row', detail: 'lots of prose' }))).toBe('row');
  });

  it('honours a row whose lede is too long for a chip', () => {
    const lede = 'x'.repeat(MAX_TAG_LABEL_CHARS + 1);
    expect(effectiveWeight(pin('a', 1, { weight: 'row', lede }))).toBe('row');
  });

  it('DEMOTES a row whose content is tag-sized — a label must not spend the ceiling', () => {
    expect(effectiveWeight(pin('a', 1, { weight: 'row', lede: 'short' }))).toBe('tag');
    expect(effectiveWeight(pin('a', 1, { weight: 'row' }))).toBe('tag');
  });

  it('never promotes a tag, whatever it carries', () => {
    expect(effectiveWeight(pin('a', 1, { weight: 'tag', detail: 'lots of prose' }))).toBe('tag');
  });

  it('always gives progress a row — a track and a live criterion do not fit a chip', () => {
    expect(effectiveWeight(progress('t', 1))).toBe('row');
  });
});

describe('clampLede', () => {
  it('leaves a short single line alone and reports no clamp', () => {
    expect(clampLede('16 tasks deleted.')).toEqual({ lede: '16 tasks deleted.', clamped: false });
  });

  it('cuts at the first line break and MARKS it — the rest is behind the affordance', () => {
    const r = clampLede('Session summary\n\nAll the prose that follows.');
    expect(r.lede).toBe('Session summary');
    expect(r.clamped).toBe(true);
  });

  it(`cuts at ${MAX_PIN_LEDE_CHARS} characters and marks it`, () => {
    const r = clampLede('y'.repeat(MAX_PIN_LEDE_CHARS + 40));
    expect(r.lede.length).toBeLessThanOrEqual(MAX_PIN_LEDE_CHARS);
    expect(r.clamped).toBe(true);
  });
});

describe('layoutShelf — the ceiling', () => {
  it('exposes at most ONE open row for any input', () => {
    const rows = Array.from({ length: 20 }, (_, i) => pin(`p${i}`, i, { weight: 'row', detail: `d${i}` }));
    const layout = layoutShelf(rows, NO_FACTS);
    expect(layout.row).not.toBeNull();
    // One row + the tag line = SHELF_MAX_ROWS. There is no list to overflow.
    expect(1 + 1).toBe(SHELF_MAX_ROWS);
    expect(layout.demotedIds).toHaveLength(19);
  });

  it('gives the row to the NEWEST row-weight pin', () => {
    const layout = layoutShelf(
      [pin('old', 1, { weight: 'row', detail: 'd' }), pin('new', 9, { weight: 'row', detail: 'd' })],
      NO_FACTS,
    );
    expect(layout.row?.id).toBe('new');
  });

  it('gives the row to PROGRESS even when a newer row-pin exists — a live run owns it', () => {
    const layout = layoutShelf(
      [progress('t', 1), pin('newer', 99, { weight: 'row', detail: 'd' })],
      NO_FACTS,
    );
    expect(layout.row?.kind).toBe('progress');
    expect(layout.demotedIds).toEqual(['newer']);
  });

  it('demotes displaced rows OLDEST FIRST — it demoted, it did not close', () => {
    const layout = layoutShelf(
      [pin('c', 3, { weight: 'row', detail: 'd' }),
        pin('a', 1, { weight: 'row', detail: 'd' }),
        pin('b', 2, { weight: 'row', detail: 'd' })],
      NO_FACTS,
    );
    expect(layout.row?.id).toBe('c');
    expect(layout.demotedIds).toEqual(['a', 'b']);
    expect(layout.tags.filter((t) => t.demoted).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('rests as a tag line with no open row when nothing wants one', () => {
    const layout = layoutShelf([pin('a', 1), pin('b', 2)], NO_FACTS);
    expect(layout.row).toBeNull();
    expect(layout.tags.map((t) => t.label)).toEqual(['a', 'b']);
  });

  it('renders nothing at all from an empty shelf', () => {
    const layout = layoutShelf([], NO_FACTS);
    expect(layout).toEqual({ row: null, tags: [], demotedIds: [], notices: [] });
  });
});

describe('layoutShelf — session facts lead and cannot be dismissed', () => {
  const facts: ShelfFact[] = [
    { label: 'feat/pin-surface', icon: 'branch' },
    { label: 'worktree', marker: true },
  ];

  it('puts server facts first, before every agent tag', () => {
    const layout = layoutShelf([pin('agent', 5)], facts);
    expect(layout.tags.map((t) => t.label)).toEqual(['feat/pin-surface', 'worktree', 'agent']);
  });

  it('marks server facts NOT dismissable and agent tags dismissable', () => {
    const layout = layoutShelf([pin('agent', 5)], facts);
    expect(layout.tags.map((t) => t.dismissable)).toEqual([false, false, true]);
  });

  it('keeps agent tags in age order so a new pin appends instead of reshuffling', () => {
    const layout = layoutShelf([pin('third', 3), pin('first', 1), pin('second', 2)], NO_FACTS);
    expect(layout.tags.map((t) => t.label)).toEqual(['first', 'second', 'third']);
  });
});

/**
 * The fold is GONE (owner, 2026-08-23, after live testing) — tags are always visible and the
 * renderer wraps. These tests are the guard against it creeping back: the model must never
 * hold a tag back, at any count, for any reason.
 */
describe('layoutShelf — every tag is returned, nothing is ever held back', () => {
  it('returns all of them well past the old per-line cap, in one list', () => {
    const many = Array.from({ length: 40 }, (_, i) => pin(`p${i}`, i));
    const layout = layoutShelf(many, NO_FACTS);
    expect(layout.tags).toHaveLength(40);
    expect(layout.tags.map((t) => t.label)).toEqual(many.map((_, i) => `p${i}`));
  });

  it('adds no notice for a long tag line — there is nothing to apologise for', () => {
    const many = Array.from({ length: 40 }, (_, i) => pin(`p${i}`, i));
    expect(layoutShelf(many, NO_FACTS).notices).toEqual([]);
    expect(layoutShelf([pin('a', 1)], NO_FACTS).notices).toEqual([]);
  });

  it('exposes no overflow bucket at all — a second list is how a fold comes back', () => {
    const layout = layoutShelf(Array.from({ length: 40 }, (_, i) => pin(`p${i}`, i)), NO_FACTS);
    expect(Object.keys(layout).sort()).toEqual(['demotedIds', 'notices', 'row', 'tags']);
  });

  it('gives every tag a unique key, even across pins with several facts', () => {
    const layout = layoutShelf([
      pin('a', 1, { facts: [{ label: 'x' }, { label: 'y' }] }),
      pin('b', 2, { facts: [{ label: 'x' }] }),
    ], NO_FACTS);
    const ids = layout.tags.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('foldViews — id-keyed, update in place, loud eviction', () => {
  const pinView = (id: string, label: string): ChatViewSpec =>
    ({ type: 'pin', id, weight: 'tag', facts: [{ label }] });

  it('appends a new pin', () => {
    const { entries, evicted } = foldViews([], [pinView('a', 'one')], 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('a');
    expect(entries[0].updatedAt).toBe(10);
    expect(evicted).toBe(0);
  });

  it('UPDATES the same id in place and never produces a second', () => {
    const first = foldViews([], [pinView('a', 'one')], 10).entries;
    const { entries } = foldViews(first, [pinView('a', 'two')], 20);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind === 'pin' && entries[0].facts[0].label).toBe('two');
    expect(entries[0].updatedAt).toBe(20);
  });

  it('keeps an updated pin in its ORIGINAL position so the tag line does not reshuffle', () => {
    const seeded = foldViews([], [pinView('a', 'A'), pinView('b', 'B'), pinView('c', 'C')], 1).entries;
    const { entries } = foldViews(seeded, [pinView('a', 'A2')], 5);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('keys progress by its task, so re-reporting a run updates one row', () => {
    const one = foldViews([], [{ type: 'progress', task: 't' }], 1).entries;
    const { entries } = foldViews(one, [{ type: 'progress', task: 't' }], 2);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('progress:t');
  });

  it('ignores view types that are not shelf types', () => {
    const { entries } = foldViews([], [{ type: 'chart', render: 'line', series: [] } as ChatViewSpec], 1);
    expect(entries).toEqual([]);
  });

  it('builds a lede from detail and MARKS it clamped — a cut line is never shown as complete', () => {
    const { entries } = foldViews([], [{
      type: 'pin', id: 'p', weight: 'row', facts: [], detail: 'Session summary\n\nlots more prose',
    }], 1);
    const entry = entries[0];
    expect(entry.kind === 'pin' && entry.lede).toBe('Session summary');
    expect(entry.kind === 'pin' && entry.ledeClamped).toBe(true);
  });

  it('does NOT mark an author-written lede as clamped', () => {
    const { entries } = foldViews([], [{
      type: 'pin', id: 'p', weight: 'row', facts: [], lede: 'Short and whole.', detail: 'more',
    }], 1);
    expect(entries[0].kind === 'pin' && entries[0].ledeClamped).toBeUndefined();
  });

  it(`evicts the OLDEST past ${MAX_PINS_PER_CONVERSATION} and REPORTS how many`, () => {
    const views = Array.from({ length: MAX_PINS_PER_CONVERSATION + 3 },
      (_, i) => pinView(`p${i}`, `l${i}`));
    const { entries, evicted } = foldViews([], views, 1);
    expect(entries).toHaveLength(MAX_PINS_PER_CONVERSATION);
    expect(evicted).toBe(3);
    expect(entries[0].id).toBe('p3'); // p0..p2 were the oldest
  });

  it('reports nothing evicted while under the cap', () => {
    expect(foldViews([], [pinView('a', 'x')], 1).evicted).toBe(0);
  });
});

describe('constants', () => {
  it('caps a user-opened detail near 40% of the pane', () => {
    expect(SHELF_DETAIL_PANE_FRACTION).toBeCloseTo(0.4);
  });
});
