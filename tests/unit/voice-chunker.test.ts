/**
 * The fence-aware chunker (AC7, AC16) and the queue's skip-a-failed-chunk rule (AC10).
 *
 * The chunker is where AC7 is actually won. `speakable()` on the server is a stripper of
 * last resort; it cannot un-split a `dream-html` block that was already carved into
 * "sentences" at every `.` inside a CSS rule. So the fence has to be excluded before
 * anything is split, which is what these tests hold in place.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSpeechChunker, boundaryOf, CLAUSE_CHUNK_CHARS, FIRST_CLAUSE_CHUNK_CHARS,
  HARD_CHUNK_CHARS, MIN_SPEAKABLE_CHARS, SpeechQueue,
} from '../../dashboard/src/lib/voice/speechQueue.js';

/** Feed `text` one character at a time — the worst case a stream can produce, and the one
 *  that catches a chunker which only works when a fence arrives in a single delta. */
function drip(text: string): string[] {
  const c = createSpeechChunker();
  const out: string[] = [];
  for (const ch of text) out.push(...c.push(ch));
  out.push(...c.flush());
  return out;
}

/** Feed `text` in one go — the other extreme. */
function whole(text: string): string[] {
  const c = createSpeechChunker();
  return [...c.push(text), ...c.flush()];
}

describe('the fence-aware chunker', () => {
  it('splits prose on closed sentences', () => {
    expect(whole('Bak, ekrana koyuyorum. Üç seçenek var. Hangisi?'))
      .toEqual(['Bak, ekrana koyuyorum.', 'Üç seçenek var.', 'Hangisi?']);
  });

  it('gives the SAME answer whether the text arrives whole or one character at a time', () => {
    const text = 'First sentence. Second one!\nAnd a third?';
    expect(drip(text)).toEqual(whole(text));
  });

  it('EXCLUDES a dream-html block entirely — none of its contents are ever emitted (AC7)', () => {
    const reply = [
      'Bak, ekrana koyuyorum.',
      '```dream-html',
      '<div class="dc-doc"><h2 class="dc-h2">Two ways</h2>',
      '<p class="dc-p">The first. The second. The third.</p></div>',
      '```',
      'Hangisini istersin?',
    ].join('\n');
    const chunks = drip(reply);
    expect(chunks).toEqual(['Bak, ekrana koyuyorum.', 'Hangisini istersin?']);
    // Not "no tags" — NOTHING from inside the block, including the prose sentences that
    // would otherwise look perfectly speakable.
    expect(chunks.join(' ')).not.toMatch(/dc-doc|The first|The second|<|>/);
  });

  it('excludes dream-view, dream-actions and ordinary code fences the same way', () => {
    for (const info of ['dream-view', 'dream-actions', 'ts', '']) {
      const chunks = drip(`Before.\n\`\`\`${info}\nsecret payload here. And more.\n\`\`\`\nAfter.`);
      expect(chunks, info).toEqual(['Before.', 'After.']);
    }
  });

  it('never leaks a fence that arrives BACKTICK BY BACKTICK across deltas', () => {
    const c = createSpeechChunker();
    const out: string[] = [];
    for (const delta of ['Bir bakayım.\n', '`', '`', '`', 'dream-html\n', '<b>x. y.</b>\n', '``', '`\n', 'Tamam.']) {
      out.push(...c.push(delta));
    }
    out.push(...c.flush());
    expect(out).toEqual(['Bir bakayım.', 'Tamam.']);
  });

  it('drops an UNTERMINATED fence — a turn can end mid-block', () => {
    expect(drip('Çiziyorum.\n```dream-html\n<div class="dc-doc">unfinished'))
      .toEqual(['Çiziyorum.']);
  });

  it('does not mistake INLINE backticks for a fence — they are mid-line, not at one', () => {
    expect(whole('Use the `sleep start` command now.')).toEqual(['Use the `sleep start` command now.']);
  });

  it('treats a newline as a boundary even with no punctuation', () => {
    expect(whole('Findings\nThree of them')).toEqual(['Findings', 'Three of them']);
  });

  it('breaks unpunctuated text at a WORD boundary only past the HARD cap', () => {
    // Reaching this means the text genuinely has no punctuation to break on. Below it, an
    // ordinary long sentence is left WHOLE — cutting one at a space is what made speech read
    // as a series of fragments with the intonation falling in the wrong places.
    const long = `${'bir iki uc dort bes alti yedi sekiz dokuz on '.repeat(6)}son`;
    expect(long.length).toBeGreaterThan(HARD_CHUNK_CHARS);
    const chunks = whole(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(long);            // nothing lost
    for (const c of chunks) expect(c).not.toMatch(/^\S*$|\s{2}/); // no mid-word cut artefacts
  });

  it('emits a short first sentence IMMEDIATELY rather than waiting for 40 characters (AC6)', () => {
    const c = createSpeechChunker();
    expect(c.push('Tamam. ')).toEqual(['Tamam.']);
  });

  it('does not split a decimal or an abbreviation into a chunk boundary mid-number', () => {
    // The terminator must be followed by whitespace or the end, so `1.5` stays whole.
    expect(whole('It took 1.5 seconds.')).toEqual(['It took 1.5 seconds.']);
  });

  it('flush() emits the trailing partial chunk — the `result` frame\'s job', () => {
    const c = createSpeechChunker();
    expect(c.push('No terminator here')).toEqual([]);
    expect(c.flush()).toEqual(['No terminator here']);
  });

  it('flush() ALSO forgets an open fence — a truncated block must not mute the next turn', () => {
    // The regression this pins, found in review: one chunker instance lives for the whole
    // session, and only `reset()` (barge-in / interrupt / steer) used to clear `inFence`. A
    // turn that ended NORMALLY inside an unterminated block — a max-tokens cutoff, or an
    // error part-way through a `dream-html` block — therefore carried the flag into the next
    // turn, and every later reply was silently dropped from speech while the transcript and
    // the UI looked completely normal. The existing "drops an UNTERMINATED fence" case above
    // could not catch it: it inspects one flush on a FRESH chunker and never pushes again.
    const c = createSpeechChunker();
    // The sentence before the fence is emitted by `push` (its newline closes it), and the
    // truncated block yields nothing — that much already worked.
    expect(c.push('Çiziyorum.\n```dream-html\n<div class="dc-doc">cut off here'))
      .toEqual(['Çiziyorum.']);
    expect(c.flush()).toEqual([]);
    // THIS is the line that used to fail: the next turn is heard, rather than swallowed by a
    // fence flag that outlived the turn it belonged to.
    expect(c.push('Tamam, bitti. ')).toEqual(['Tamam, bitti.']);
  });

  it('reset() forgets an open fence, so a barge-in cannot leave the next turn muted', () => {
    const c = createSpeechChunker();
    c.push('```dream-html\n<div>');
    c.reset();
    expect(c.push('Yeni tur. ')).toEqual(['Yeni tur.']);
  });

  it('loses no prose across a fence — the words before and after both survive', () => {
    const chunks = drip('Önce bu. \n```ts\nconst a = 1;\n```\nSonra bu.');
    expect(chunks).toEqual(['Önce bu.', 'Sonra bu.']);
  });
});

// ── The player ─────────────────────────────────────────────────────────────────────────

/**
 * A fake `Audio` element. Root vitest runs under plain Node, so playback is stubbed rather
 * than mocked out of the design: the queue's ORDERING and its skip-on-failure rule are the
 * properties under test, and both are visible from here.
 */
class FakeAudio {
  static played: string[] = [];
  static pending: Array<() => void> = [];
  src = '';
  muted = false;
  preload = '';
  private handlers: Record<string, Array<() => void>> = {};
  addEventListener(type: string, fn: () => void) { (this.handlers[type] ||= []).push(fn); }
  removeEventListener(type: string, fn: () => void) {
    this.handlers[type] = (this.handlers[type] || []).filter((h) => h !== fn);
  }
  removeAttribute(_n: string) { this.src = ''; }
  pause() {}
  play() {
    const src = this.src;
    if (src) {
      FakeAudio.played.push(BLOB_TEXT.get(src) ?? src);
      // Finish on the next microtask turn, so ordering is genuinely exercised.
      FakeAudio.pending.push(() => { (this.handlers.ended || []).forEach((h) => h()); });
    }
    return Promise.resolve();
  }
}

/** object-URL → the text the chunk carried, so assertions read in words not blob ids. */
const BLOB_TEXT = new Map<string, string>();
let urlSeq = 0;

/** Let every queued `ended` fire until the queue settles. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
    const next = FakeAudio.pending.shift();
    if (next) next();
    await Promise.resolve();
  }
}

beforeEach(() => {
  FakeAudio.played = [];
  FakeAudio.pending = [];
  BLOB_TEXT.clear();
  urlSeq = 0;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('URL', {
    createObjectURL: (b: Blob & { __text?: string }) => {
      const url = `blob:${++urlSeq}`;
      BLOB_TEXT.set(url, b.__text ?? '');
      return url;
    },
    revokeObjectURL: () => {},
  });
});

afterEach(() => { vi.unstubAllGlobals(); });

/** A fetcher that resolves a labelled fake blob, failing for any text in `failFor`. */
function fetcherThat(failFor: string[] = [], seen?: string[]) {
  return async (text: string) => {
    seen?.push(text);
    if (failFor.some((f) => text.includes(f))) return null;
    return { __text: text } as unknown as Blob;
  };
}

describe('the speech queue', () => {
  it('plays chunks STRICTLY in order, however the fetches resolve', async () => {
    // The second chunk's fetch resolves LAST. Ordered playback means it is still spoken
    // second — a queue that just played whatever arrived would reverse them.
    const q = new SpeechQueue(async (text) => {
      if (text.includes('two')) await new Promise((r) => setTimeout(r, 15));
      return { __text: text } as unknown as Blob;
    });
    q.push('one here. two here. three here. ');
    await new Promise((r) => setTimeout(r, 60));
    await settle();
    expect(FakeAudio.played).toEqual(['one here.', 'two here.', 'three here.']);
  });

  it('SKIPS a failed chunk and keeps playing the rest (AC10)', async () => {
    const q = new SpeechQueue(fetcherThat(['two']));
    q.push('one here. two here. three here. ');
    await settle();
    // One 429 costs a sentence. It does not stall the queue and it does not kill the reply.
    expect(FakeAudio.played).toEqual(['one here.', 'three here.']);
  });

  it('survives EVERY chunk failing without hanging', async () => {
    const q = new SpeechQueue(fetcherThat(['here']));
    q.push('one here. two here. ');
    await settle();
    expect(FakeAudio.played).toEqual([]);
    // And the next turn still works.
    q.push('four ok. ');
    await settle();
    expect(FakeAudio.played).toEqual(['four ok.']);
  });

  it('FETCHES AHEAD — chunk N+1 is requested before chunk N has finished playing (AC6)', async () => {
    const seen: string[] = [];
    const q = new SpeechQueue(fetcherThat([], seen));
    q.push('one here. two here. ');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Both requested while nothing has finished playing yet — that overlap is what removes
    // the gap between chunks.
    expect(seen).toEqual(['one here.', 'two here.']);
    expect(FakeAudio.pending.length).toBeGreaterThan(0);
    await settle();
  });

  it('stop() silences immediately and drops everything queued (AC9)', async () => {
    const q = new SpeechQueue(fetcherThat());
    q.push('one here. two here. three here. ');
    await Promise.resolve();
    q.stop();
    await settle();
    // At most the chunk already in the element, never the rest of the answer.
    expect(FakeAudio.played.length).toBeLessThanOrEqual(1);
  });

  it('stop() then resume() gives a clean queue rather than a dead one', async () => {
    const q = new SpeechQueue(fetcherThat());
    q.push('old turn. ');
    q.stop();
    q.resume();
    FakeAudio.played = [];
    q.push('new turn. ');
    await settle();
    expect(FakeAudio.played).toEqual(['new turn.']);
  });

  it('stop() also forgets a half-open fence, so the next turn is not muted', async () => {
    const q = new SpeechQueue(fetcherThat());
    q.push('```dream-html\n<div>');
    q.stop();
    q.resume();
    q.push('Tamam. ');
    await settle();
    expect(FakeAudio.played).toEqual(['Tamam.']);
  });

  it('flushTurn() speaks the trailing partial chunk', async () => {
    const q = new SpeechQueue(fetcherThat());
    q.push('no terminator');
    await settle();
    expect(FakeAudio.played).toEqual([]);
    q.flushTurn();
    await settle();
    expect(FakeAudio.played).toEqual(['no terminator']);
  });
});

// ── Where a chunk ends ──────────────────────────────────────────────────────────────────

describe('chunk boundaries follow PUNCTUATION, in Turkish and English alike', () => {
  const whole = (text: string) => {
    const c = createSpeechChunker();
    return [...c.push(text), ...c.flush()];
  };

  it('never cuts an ordinary long sentence mid-clause', () => {
    // The reported failure, in one line: 96 characters, one sentence, one chunk. The old rule
    // broke at the last space past 40 and handed the model a fragment.
    const sentence = 'Uyku dongusu tamamlandi ve gorevlerin tamami guncellendi bu yuzden simdi ozet cikarabilirim.';
    expect(sentence.length).toBeGreaterThan(80);
    expect(whole(sentence)).toEqual([sentence]);
  });

  it('takes a CLAUSE break in a long sentence, so a paragraph is not one enormous chunk', () => {
    const long = 'Uyku dongusu tamamlandi ve butun gorevler guncellendi, ardindan iki karar kaydedildi ve rapor hazir.';
    const chunks = whole(long);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith(',')).toBe(true);     // cut AT the comma, not before a word
    expect(chunks.join(' ')).toBe(long);
  });

  it('lets the FIRST chunk go early — time-to-first-word is the latency that is felt', () => {
    expect(FIRST_CLAUSE_CHUNK_CHARS).toBeLessThan(CLAUSE_CHUNK_CHARS);
    const c = createSpeechChunker();
    const first = c.push('Uyku dongusu tamamlandi, ardindan iki karar kaydedildi ve rapor hazir ');
    expect(first.length).toBe(1);
    expect(first[0]).toBe('Uyku dongusu tamamlandi,');
  });

  it('will NOT carve out a fragment too small to be worth a round trip', () => {
    // Every chunk costs the same fixed generation time whatever its length, so a four-word
    // fragment spends a whole request to buy a second of audio — and short addressed lines
    // are also the ones the speech model is likeliest to answer instead of read.
    const c = createSpeechChunker();
    const out = c.push('Tamamdir efendim, uyku dongusunu simdi baslatiyorum ve sonra ozet cikaracagim ');
    expect(out[0]).not.toBe('Tamamdir efendim,');
    expect(MIN_SPEAKABLE_CHARS).toBeGreaterThan('Tamamdir efendim,'.length);
  });

  it('does not split a Turkish ORDINAL — "3. gorev" is not a sentence called "3."', () => {
    // The one that would have been unmissable: a chunk consisting of the word "three".
    expect(whole('3. gorev guncellendi. Bitti.')).toEqual(['3. gorev guncellendi.', 'Bitti.']);
    expect(boundaryOf('3. gorev')).toBe(-1);
  });

  it('does not split a decimal or an abbreviation', () => {
    expect(whole('Toplam 3.5 saat surdu.')).toEqual(['Toplam 3.5 saat surdu.']);
    expect(whole('Gorevler, kararlar vb. seyler guncellendi.')).toEqual(['Gorevler, kararlar vb. seyler guncellendi.']);
    expect(whole('Ask Dr. Ahmet about it.')).toEqual(['Ask Dr. Ahmet about it.']);
    expect(whole('Tests, docs, etc. all pass.')).toEqual(['Tests, docs, etc. all pass.']);
  });

  it('does not split an initial', () => {
    expect(whole('Rapor A. Yilmaz tarafindan yazildi.')).toEqual(['Rapor A. Yilmaz tarafindan yazildi.']);
  });

  it('still ends a real sentence immediately, however short', () => {
    const c = createSpeechChunker();
    expect(c.push('Tamam. ')).toEqual(['Tamam.']);
  });

  it('breaks on an em dash — the punctuation this project\'s own prose actually uses', () => {
    const long = 'Uyku dongusu tamamlandi ve her sey guncel — geriye yalnizca ozet kaldi.';
    const chunks = whole(long);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith('—')).toBe(true);
  });
});
