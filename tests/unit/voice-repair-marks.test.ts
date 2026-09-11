/**
 * THE REPAIRS, DRAWN ON THE WORDS.
 *
 * The confirmation step is the voice mode's safety control: a machine-altered sentence never
 * goes without the owner seeing what changed. It used to ask for arithmetic — a list of
 * `X → Y` chips beside a sentence, which the reader had to map back onto it. These tests pin
 * the replacement: the position of the mark IS the mapping, and it has to be RIGHT, because
 * a confirmation pointing at the wrong word is worse than one pointing at nothing.
 */

import { describe, it, expect } from 'vitest';
import { alignTranscripts, changedOps } from '../../src/lib/voice/align.js';
import {
  repairMarks, applyRepairSegments, heardWords, droppedWords, tokenSpans,
} from '../../dashboard/src/lib/voice/repairMarks.js';

/** The whole round trip: align, strip the equals exactly as the route does, mark. */
function marksFor(raw: string, corrected: string, draft = corrected) {
  return repairMarks(draft, corrected, changedOps(alignTranscripts(raw, corrected)));
}

describe('the alignment carries a position', () => {
  it('indexes every op against the CORRECTED text, equals included', () => {
    const ops = alignTranscripts('Dremontext taskini ac', 'dreamcontext taskini ac');
    expect(ops.map((o) => o.at)).toEqual([0, 1, 2]);
  });

  it('keeps the index usable after the equals are stripped', () => {
    // This is the whole point: `changedOps` destroys every other positional clue, so the
    // index has to survive it or the client cannot locate anything.
    const ops = changedOps(alignTranscripts('bir Sirip iki', 'bir uyku iki'));
    expect(ops).toHaveLength(1);
    expect(ops[0].at).toBe(1);
  });
});

describe('repairMarks', () => {
  it('marks the repaired word where it actually sits', () => {
    const corrected = 'dreamcontext taskini guncelle';
    const marks = marksFor('Dremontext taskini guncelle', corrected);
    expect(marks).toHaveLength(1);
    expect(corrected.slice(marks[0].start, marks[0].end)).toBe('dreamcontext');
  });

  it('picks the RIGHT occurrence when the sentence repeats a word', () => {
    // The case that kills a client-side indexOf: both tokens read "taskini" after the
    // repair, and only the alignment knows the SECOND one is the one that changed.
    const corrected = 'taskini ac sonra taskini kapat';
    const marks = marksFor('taskini ac sonra tasgini kapat', corrected);
    expect(marks).toHaveLength(1);
    expect(marks[0].start).toBe(corrected.indexOf('taskini', 1));
  });

  it('offsets the marks when the transcript was APPENDED to typed text', () => {
    // A take that lands while the owner is typing is appended, so the corrected sentence
    // sits at an offset — the marks have to move with it.
    const corrected = 'uyku dongusunu baslat';
    const draft = `bunu not al ${corrected}`;
    const marks = marksFor('Sirip dongusunu baslat', corrected, draft);
    expect(marks).toHaveLength(1);
    expect(draft.slice(marks[0].start, marks[0].end)).toBe('uyku');
  });

  it('returns NOTHING once the owner has edited the sentence away', () => {
    // Not a fallback — the correct answer. Marks computed against text that has moved would
    // underline the wrong words.
    const ops = changedOps(alignTranscripts('Dremontext ac', 'dreamcontext ac'));
    expect(repairMarks('something else entirely', 'dreamcontext ac', ops)).toEqual([]);
  });

  it('does NOT mark a deletion — there is nothing on screen to underline', () => {
    // Marking the gap, or the neighbouring word, would say a word the owner CAN see was
    // touched. Deletions are reported in words instead.
    const ops = changedOps(alignTranscripts('sey taskini ac', 'taskini ac'));
    expect(ops.some((o) => o.kind === 'delete')).toBe(true);
    expect(repairMarks('taskini ac', 'taskini ac', ops)).toEqual([]);
    expect(droppedWords(ops)).toEqual(['sey']);
  });

  it('draws a FAR replacement harder, and still only that', () => {
    const ops = changedOps(alignTranscripts('baslat', 'durdur'));
    const marks = repairMarks('durdur', 'durdur', ops);
    expect(marks).toHaveLength(1);
    expect(marks[0].far).toBe(true);
    // The distance decides loudness and nothing else — the mark exists either way.
    const near = repairMarks('dreamcontext', 'dreamcontext', changedOps(alignTranscripts('Dremontext', 'dreamcontext')));
    expect(near).toHaveLength(1);
    expect(near[0].far).toBe(false);
  });

  it('reports what was HEARD for substitutions only', () => {
    const ops = changedOps(alignTranscripts('Dremontext sey ac', 'dreamcontext ac'));
    expect(heardWords(ops)).toEqual(['Dremontext']);
  });
});

describe('applyRepairSegments', () => {
  it('splits a plain segment into before / mark / after', () => {
    const segs = applyRepairSegments(
      [{ text: 'bir uyku iki', mention: false }],
      [{ start: 4, end: 8, from: 'Sirip', far: false }],
    );
    expect(segs.map((s) => s.text)).toEqual(['bir ', 'uyku', ' iki']);
    expect(segs.map((s) => !!s.repair)).toEqual([false, true, false]);
  });

  it('rebuilds the draft EXACTLY — the mirror must not drop or duplicate a character', () => {
    // The overlay sits glyph-for-glyph under the textarea. One lost space and every mark
    // after it points at the wrong word.
    const text = 'dreamcontext taskini guncelle ve uyku dongusunu baslat';
    const segs = applyRepairSegments(
      [{ text, mention: false }],
      [{ start: 0, end: 12, from: 'Dremontext', far: false }, { start: 33, end: 37, from: 'Sirip', far: true }],
    );
    expect(segs.map((s) => s.text).join('')).toBe(text);
  });

  it('keeps a mention that is ALSO a repair as both', () => {
    const segs = applyRepairSegments(
      [{ text: '@kerem', mention: true }],
      [{ start: 0, end: 6, from: '@kerim', far: false }],
    );
    expect(segs).toHaveLength(1);
    expect(segs[0].mention).toBe(true);
    expect(segs[0].repair).toBe(true);
  });

  it('passes segments through untouched when there is nothing to mark', () => {
    const segs = applyRepairSegments([{ text: 'hello @kerem', mention: false }], []);
    expect(segs).toEqual([{ text: 'hello @kerem', mention: false }]);
  });
});

describe('tokenSpans', () => {
  it('records where each whitespace-separated token starts', () => {
    expect(tokenSpans('  ab  cde ')).toEqual([{ text: 'ab', index: 2 }, { text: 'cde', index: 6 }]);
  });
});
