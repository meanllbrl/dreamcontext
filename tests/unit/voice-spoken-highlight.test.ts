/**
 * The spoken-sentence marker's arithmetic.
 *
 * The owner, 2026-09-12: "you could highlight whichever sentence it is reading, so people can
 * follow it." The hard part is not the paint — it is finding the sentence. The chunk that is
 * being SPOKEN is a slice of the raw markdown; what is on screen is the RENDERED text, with
 * the emphasis markers gone, entities substituted and whitespace collapsed. An exact search
 * finds nothing on any sentence that carries formatting, which on this surface is most of
 * them.
 *
 * The DOM half (a TreeWalker and a Range) is not testable in this suite's Node environment
 * and is deliberately thin; everything that can be got WRONG lives in the two pure functions
 * below.
 */

import { describe, it, expect } from 'vitest';
import {
  matchSpan, locate, MIN_MATCH_CHARS, SPOKEN_HIGHLIGHT,
} from '../../dashboard/src/components/sleepy/chat/useSpokenHighlight.js';

describe('finding the spoken sentence in what is on screen', () => {
  it('finds a plain sentence and reports its span in the ORIGINAL text', () => {
    const all = 'Bak, ekrana koyuyorum. Üç seçenek var. Hangisi?';
    const span = matchSpan(all, 'Üç seçenek var.')!;
    expect(all.slice(span.from, span.to)).toBe('Üç seçenek var');
  });

  it('finds a sentence whose MARKDOWN markers are not in the rendered text', () => {
    // This is the case that makes an exact search useless: the queue speaks the raw chunk.
    const rendered = 'Bak, ekrana koyuyorum. Üç seçenek var.';
    const spoken = '**Bak**, ekrana `koyuyorum`.';
    const span = matchSpan(rendered, spoken)!;
    expect(rendered.slice(span.from, span.to)).toBe('Bak, ekrana koyuyorum');
  });

  it('survives whitespace the renderer collapsed and line breaks the markdown had', () => {
    const rendered = 'Three options here. Which one?';
    const span = matchSpan(rendered, 'Three\n   options\nhere.')!;
    expect(rendered.slice(span.from, span.to)).toBe('Three options here');
  });

  it('is case-insensitive, because a renderer may not be', () => {
    expect(matchSpan('Three options here.', 'THREE OPTIONS HERE.')).not.toBeNull();
  });

  it('answers null rather than guessing when the sentence is not on screen', () => {
    // A chunk can straddle two transcript items, or cover words a `dream-html` block
    // swallowed. The caller LEAVES the marker where it was for exactly this answer.
    expect(matchSpan('Three options here.', 'Something else entirely.')).toBeNull();
  });

  it('refuses a chunk too short to locate honestly', () => {
    expect('ok'.length).toBeLessThan(MIN_MATCH_CHARS);
    expect(matchSpan('Ok. Ok. Ok. Ok.', 'Ok.')).toBeNull();
  });

  it('does not match across the punctuation it dropped — the words still have to be in order', () => {
    expect(matchSpan('Alpha. Beta.', 'Beta Alpha')).toBeNull();
  });
});

describe('mapping an offset back to the run that holds it', () => {
  // Three text nodes — what a rendered sentence with a bolded word actually is.
  const starts = [0, 5, 9];
  const lengths = [5, 4, 6];

  it('lands inside the right run, at the right offset', () => {
    expect(locate(starts, lengths, 0)).toEqual({ index: 0, offset: 0 });
    expect(locate(starts, lengths, 4)).toEqual({ index: 0, offset: 4 });
    expect(locate(starts, lengths, 5)).toEqual({ index: 1, offset: 0 });
    expect(locate(starts, lengths, 12)).toEqual({ index: 2, offset: 3 });
  });

  it('clamps an END that sits one past the last character of a run', () => {
    // The end of a match is exclusive, so it legitimately addresses "just past" the run —
    // which is a valid Range boundary and an invalid index. Clamped rather than refused: the
    // alternative is no highlight on every sentence that ends a bolded phrase.
    expect(locate(starts, lengths, 15)).toEqual({ index: 2, offset: 6 });
  });

  it('answers null for an offset before anything', () => {
    expect(locate([], [], 0)).toBeNull();
  });
});

describe('the registry name', () => {
  it('matches the ::highlight() rule the stylesheet declares', async () => {
    // Two halves in two files, and a rename in one of them is invisible: the API silently
    // paints nothing for a name no rule targets.
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('dashboard/src/components/sleepy/chat/cards.css', 'utf-8');
    expect(css).toContain(`::highlight(${SPOKEN_HIGHLIGHT})`);
  });
});
