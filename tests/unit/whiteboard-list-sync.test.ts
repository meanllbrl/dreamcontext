/**
 * A16: a deleted board disappears everywhere at once. The page's rules (whiteboardListSync.ts):
 * when the poll's board set says the cached list is out of date, and when the open board is
 * gone with nothing of the owner's to lose (its tab then closes).
 */
import { describe, it, expect } from 'vitest';
import { boardIsGone, listIsStale } from '../../dashboard/src/hooks/whiteboardListSync';

const rows = (...slugs: string[]) => slugs.map((slug) => ({ slug }));

describe('listIsStale', () => {
  it('a board deleted or made elsewhere makes the list stale', () => {
    expect(listIsStale(rows('a', 'b', 'c'), ['a', 'c'])).toBe(true);
    expect(listIsStale(rows('a'), ['a', 'new'])).toBe(true);
    expect(listIsStale(rows('a', 'b'), ['a', 'x'])).toBe(true);
  });

  it('the same set, in any order, is not', () => {
    expect(listIsStale(rows('a', 'b'), ['b', 'a'])).toBe(false);
    expect(listIsStale(rows(), [])).toBe(false);
  });

  it('no list yet, or a server that sends no set, never re-pulls', () => {
    expect(listIsStale(undefined, ['a'])).toBe(false);
    expect(listIsStale(rows('a'), undefined)).toBe(false);
  });
});

describe('boardIsGone', () => {
  const ready = { kind: 'ready' };
  it('missing at open is gone', () => {
    expect(boardIsGone({ kind: 'missing' }, { kind: 'saved' })).toBe(true);
  });

  it('deleted while open with everything on disk is gone; with unsaved changes it stays', () => {
    expect(boardIsGone(ready, { kind: 'deleted', unsaved: false })).toBe(true);
    expect(boardIsGone(ready, { kind: 'deleted', unsaved: true })).toBe(false);
  });

  it('nothing else is: saving, failing, corrupt, a load error, still loading', () => {
    for (const save of [{ kind: 'saved' }, { kind: 'saving' }, { kind: 'failed' }, { kind: 'retrying' }]) {
      expect(boardIsGone(ready, save)).toBe(false);
    }
    for (const kind of ['loading', 'corrupt', 'error']) expect(boardIsGone({ kind }, { kind: 'deleted', unsaved: false })).toBe(false);
  });
});
