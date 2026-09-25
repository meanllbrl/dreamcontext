import { describe, it, expect } from 'vitest';
import { segmentToolRuns, type RunSegment } from '../../dashboard/src/components/sleepy/chat/chatEntities';

/**
 * `segmentToolRuns`' `weightless` predicate: quest-map bookkeeping may ride inside a run the
 * real steps formed, but it must never be what lifts two real steps into a run.
 */

type Item = { id: string; kind: 'read' | 'grep' | 'quest' | 'text' };
const read = (id: string): Item => ({ id, kind: 'read' });
const grep = (id: string): Item => ({ id, kind: 'grep' });
const quest = (id: string): Item => ({ id, kind: 'quest' });
const text = (id: string): Item => ({ id, kind: 'text' });

const groupable = (i: Item) => i.kind !== 'text';
const nothing = () => false;
const isQuest = (i: Item) => i.kind === 'quest';

const shape = (segs: RunSegment<Item>[]) =>
  segs.map((s) => (s.kind === 'run' ? s.items.map((i) => i.id) : s.item.id));

describe('segmentToolRuns weightless', () => {
  it('two real steps plus a quest item do not form a run', () => {
    const segs = segmentToolRuns([read('a'), read('b'), quest('q')], groupable, 3, nothing, isQuest);
    expect(segs.every((s) => s.kind === 'single')).toBe(true);
    expect(shape(segs)).toEqual(['a', 'b', 'q']);
  });

  it('three real steps form a run, and the quest item between them stays inside it', () => {
    const segs = segmentToolRuns([read('a'), read('b'), quest('q'), grep('c')], groupable, 3, nothing, isQuest);
    expect(segs).toHaveLength(1);
    expect(shape(segs)).toEqual([['a', 'b', 'q', 'c']]);
  });

  it('a visible item still breaks the run, whatever weighs what', () => {
    const segs = segmentToolRuns(
      [read('a'), quest('q'), read('b'), text('t'), read('c'), read('d'), grep('e')],
      groupable, 3, nothing, isQuest,
    );
    expect(shape(segs)).toEqual(['a', 'q', 'b', 't', ['c', 'd', 'e']]);
  });

  it('without a weightless argument the output is unchanged', () => {
    const items = [read('a'), read('b'), quest('q'), text('t'), read('c'), grep('d')];
    const before = segmentToolRuns(items, groupable, 3, nothing);
    const after = segmentToolRuns(items, groupable, 3, nothing, undefined);
    expect(after).toEqual(before);
    // Every groupable item weighs one when nothing says otherwise: a, b and q make a run.
    expect(shape(before)).toEqual([['a', 'b', 'q'], 't', 'c', 'd']);
  });
});
