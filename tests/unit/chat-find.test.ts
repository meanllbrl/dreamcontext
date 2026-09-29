/**
 * Unit tests for ⌘F in the Chat view (`dashboard/src/components/sleepy/chat/findInChat.ts`):
 * the chord, and where a query lands across the transcript's text nodes.
 */
import { describe, it, expect } from 'vitest';
import { isFindChord, findStepOf, locateMatches } from '../../dashboard/src/components/sleepy/chat/findInChat.js';

const key = (k: string, over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe('find chord', () => {
  it('⌘F and Ctrl+F open, plain f and ⌥⌘F do not', () => {
    expect(isFindChord(key('f', { metaKey: true }))).toBe(true);
    expect(isFindChord(key('F', { ctrlKey: true }))).toBe(true);
    expect(isFindChord(key('f'))).toBe(false);
    expect(isFindChord(key('f', { metaKey: true, altKey: true }))).toBe(false);
  });
  it('⌘G steps forward, ⇧⌘G back', () => {
    expect(findStepOf(key('g', { metaKey: true }))).toBe(1);
    expect(findStepOf(key('G', { metaKey: true, shiftKey: true }))).toBe(-1);
    expect(findStepOf(key('g'))).toBe(0);
  });
});

describe('locateMatches', () => {
  it('finds every hit, case-insensitively', () => {
    expect(locateMatches(['Foo bar foo'], 'FOO')).toEqual([
      { start: [0, 0], end: [0, 3] },
      { start: [0, 8], end: [0, 11] },
    ]);
  });
  it('matches across a node boundary (foo **bar**)', () => {
    expect(locateMatches(['say foo ', 'bar now'], 'foo bar')).toEqual([{ start: [0, 4], end: [1, 3] }]);
  });
  it('a match ending at a boundary stays on its node; one starting there moves to the next', () => {
    expect(locateMatches(['ab', 'cd'], 'ab')).toEqual([{ start: [0, 0], end: [0, 2] }]);
    expect(locateMatches(['ab', 'cd'], 'cd')).toEqual([{ start: [1, 0], end: [1, 2] }]);
  });
  it('folds the Turkish i family without shifting offsets after İ', () => {
    expect(locateMatches(['İstanbul sıfır'], 'sifir')).toEqual([{ start: [0, 9], end: [0, 14] }]);
    expect(locateMatches(['İİ x'], 'X')).toEqual([{ start: [0, 3], end: [0, 4] }]);
  });
  it('an empty query finds nothing and the cap holds', () => {
    expect(locateMatches(['aaa'], '  ')).toEqual([]);
    expect(locateMatches(['aaaaa'], 'a', 3)).toHaveLength(3);
  });
});
