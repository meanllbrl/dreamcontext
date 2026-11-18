import { describe, it, expect } from 'vitest';
import { decideBoardPath } from '../../src/lib/git-sync/board-exchange.js';

const B = (s: string) => Buffer.from(s, 'utf-8');
const PIC = '_dream_context/whiteboards/plan/files/abc.png';

describe('decideBoardPath: the 3-way rule of the board exchange', () => {
  it('an agreed base (what the exchange last left equal) applies a team deletion; a merge base never does (review r1)', () => {
    expect(decideBoardPath(PIC, B('x'), B('x'), null, true)).toEqual({ kind: 'drop' });
    expect(decideBoardPath(PIC, B('x'), B('x'), null, false)).toEqual({ kind: 'none' });
    // Changed here since the agreement: ours goes out, never trashed.
    expect(decideBoardPath(PIC, B('x'), B('o'), null, true)).toEqual({ kind: 'send', bytes: B('o') });
    // Deleted here after it came in: not taken back.
    expect(decideBoardPath(PIC, B('x'), null, B('x'), true)).toEqual({ kind: 'none' });
    // Absent on both at the agreement, new from the team: taken.
    expect(decideBoardPath(PIC, null, null, B('t'), true)).toEqual({ kind: 'take', bytes: B('t') });
  });

  it('same bytes on both sides: nothing to do', () => {
    expect(decideBoardPath(PIC, B('x'), B('y'), B('y')).kind).toBe('none');
  });

  it('changed on one side only: that side wins', () => {
    expect(decideBoardPath(PIC, B('x'), B('x'), B('t'))).toEqual({ kind: 'take', bytes: B('t') });
    expect(decideBoardPath(PIC, B('x'), B('o'), B('x'))).toEqual({ kind: 'send', bytes: B('o') });
  });

  it('a deletion is never inferred from absence: an unchanged copy deleted on one side is left alone', () => {
    expect(decideBoardPath(PIC, B('x'), null, B('x')).kind).toBe('none');
    expect(decideBoardPath(PIC, B('x'), B('x'), null).kind).toBe('none');
  });

  it('new or changed on the side that still has it: that copy travels', () => {
    expect(decideBoardPath(PIC, null, null, B('t'))).toEqual({ kind: 'take', bytes: B('t') });
    expect(decideBoardPath(PIC, null, B('o'), null)).toEqual({ kind: 'send', bytes: B('o') });
    expect(decideBoardPath(PIC, B('x'), null, B('t'))).toEqual({ kind: 'take', bytes: B('t') });
  });

  it('a picture changed on both sides waits for the normal sync', () => {
    expect(decideBoardPath(PIC, B('x'), B('o'), B('t')).kind).toBe('wait');
  });

  it('a board that does not parse on one side waits, never written over', () => {
    const md = '_dream_context/whiteboards/plan/plan.excalidraw.md';
    expect(decideBoardPath(md, B('base'), B('not a board'), B('also not')).kind).toBe('wait');
  });
});
