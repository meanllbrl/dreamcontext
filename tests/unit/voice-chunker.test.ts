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
  HARD_CHUNK_CHARS, MIN_SPEAKABLE_CHARS, SpeechQueue, FOCUS_GRACE_MS, SCHEDULE_LEAD,
  type SpeakFetcher,
} from '../../dashboard/src/lib/voice/speechQueue.js';
import { onSpeechMuted, type FocusClient } from '../../dashboard/src/lib/voice/audioFocus.js';
import { adoptVoicePrefs } from '../../dashboard/src/lib/voice/voicePrefs.js';

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
  /** The rate in force at the moment each chunk actually started playing. */
  static rates: number[] = [];
  muted = false;
  preload = '';
  playbackRate = 1;
  defaultPlaybackRate = 1;
  #src = '';
  /**
   * MODELS THE SPEC, and this is the only reason the test can catch the bug it was written
   * for. The media element load algorithm ends with "set the playbackRate attribute to the
   * value of the defaultPlaybackRate attribute" — unconditionally, on every load — so a rate
   * written to `playbackRate` BEFORE the src is erased by the src. A fake that just stored
   * the field would pass on the broken code and prove nothing.
   */
  get src(): string { return this.#src; }
  set src(v: string) { this.#src = v; this.playbackRate = this.defaultPlaybackRate; }
  private handlers: Record<string, Array<() => void>> = {};
  addEventListener(type: string, fn: () => void) { (this.handlers[type] ||= []).push(fn); }
  removeEventListener(type: string, fn: () => void) {
    this.handlers[type] = (this.handlers[type] || []).filter((h) => h !== fn);
  }
  removeAttribute(_n: string) { this.src = ''; }
  /** The completion this element owes, if it is playing. */
  #finish: (() => void) | null = null;
  /**
   * MODELS THE SPEC'S SILENCE. A paused media element fires NEITHER `ended` NOR `error` — it
   * simply stops, and anything awaiting one of those events waits for good. A fake whose
   * `pause()` did nothing would let the pending `ended` fire anyway and would therefore pass
   * on the deadlocked code, proving the opposite of what it claims.
   */
  pause() {
    if (!this.#finish) return;
    FakeAudio.pending = FakeAudio.pending.filter((p) => p !== this.#finish);
    this.#finish = null;
  }
  play() {
    const src = this.src;
    if (src) {
      FakeAudio.played.push(BLOB_TEXT.get(src) ?? src);
      FakeAudio.rates.push(this.playbackRate);
      // Finish on the next microtask turn, so ordering is genuinely exercised.
      const finish = () => {
        this.#finish = null;
        (this.handlers.ended || []).forEach((h) => h());
      };
      this.#finish = finish;
      FakeAudio.pending.push(finish);
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
  FakeAudio.rates = [];
  adoptVoicePrefs(null);                      // back to the shipped defaults
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

/**
 * A queue under test.
 *
 * The session id and the focus client are explicit here because the queue now asks the server
 * who owns the speaker before it plays. `OPEN_FOCUS` is the "granted, nothing ducked" answer,
 * which is the state every test below was written against — the refusal path has its own
 * tests further down.
 */
const OPEN_FOCUS: FocusClient = {
  hold: async () => ({ granted: true, holder: 's1', ducked: false, gain: 1, paused: [] }),
  release: () => {},
};

function makeQueue(fetcher: SpeakFetcher, focus: FocusClient = OPEN_FOCUS): SpeechQueue {
  return new SpeechQueue('s1', fetcher, focus);
}

/** A fetcher that resolves a labelled fake blob, failing for any text in `failFor`. */
function fetcherThat(failFor: string[] = [], seen?: string[]) {
  return async (text: string) => {
    seen?.push(text);
    if (failFor.some((f) => text.includes(f))) return null;
    // `arrayBuffer` is what makes the Web Audio path reachable. Where a test stubs no
    // AudioContext (most of them), the queue falls back to the element and these assertions
    // read exactly as they did before.
    return { __text: text, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
  };
}

/** Let the queue run WITHOUT finishing the chunk that is playing — which is the state a
 *  barge-in actually interrupts. `settle()` fires `ended`, and that is the one thing this
 *  case must not do. */
async function midPlay(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe('the speech queue', () => {
  it('SPEAKS THE NEXT TURN after a barge-in — a paused element settles nothing by itself', async () => {
    // THE DEADLOCK, and it is the worst shape a bug can have here: permanent silence with
    // nothing on screen to explain it. `stop()` pauses the element and removes its `src`,
    // which fires NEITHER `ended` NOR `error` — so the promise the play loop was awaiting
    // never settled, `running` stayed true for the life of the session, and every chunk of
    // every later turn sat in the queue unplayed.
    const q = makeQueue(fetcherThat());
    q.push('one here. ');
    await midPlay();
    expect(FakeAudio.played).toEqual(['one here.']);
    q.stop();
    q.resume();
    q.push('two here. ');
    await settle();
    expect(FakeAudio.played).toEqual(['one here.', 'two here.']);
  });

  it('plays chunks STRICTLY in order, however the fetches resolve', async () => {
    // The second chunk's fetch resolves LAST. Ordered playback means it is still spoken
    // second — a queue that just played whatever arrived would reverse them.
    const q = makeQueue(async (text) => {
      if (text.includes('two')) await new Promise((r) => setTimeout(r, 15));
      return { __text: text, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
    });
    q.push('one here. two here. three here. ');
    await new Promise((r) => setTimeout(r, 60));
    await settle();
    expect(FakeAudio.played).toEqual(['one here.', 'two here.', 'three here.']);
  });

  it('SKIPS a failed chunk and keeps playing the rest (AC10)', async () => {
    const q = makeQueue(fetcherThat(['two']));
    q.push('one here. two here. three here. ');
    await settle();
    // One 429 costs a sentence. It does not stall the queue and it does not kill the reply.
    expect(FakeAudio.played).toEqual(['one here.', 'three here.']);
  });

  it('survives EVERY chunk failing without hanging', async () => {
    const q = makeQueue(fetcherThat(['here']));
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
    const q = makeQueue(fetcherThat([], seen));
    q.push('one here. two here. ');
    // A handful of turns rather than exactly three: the play loop now awaits the speaker
    // floor (and, when a duck is in force, the audio graph) before the first chunk plays, so
    // counting microtasks pins an implementation detail rather than the overlap this test is
    // about. The assertions below are the actual claim.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    // Both requested while nothing has finished playing yet — that overlap is what removes
    // the gap between chunks.
    expect(seen).toEqual(['one here.', 'two here.']);
    expect(FakeAudio.pending.length).toBeGreaterThan(0);
    await settle();
  });

  it('stop() silences immediately and drops everything queued (AC9)', async () => {
    const q = makeQueue(fetcherThat());
    q.push('one here. two here. three here. ');
    await Promise.resolve();
    q.stop();
    await settle();
    // At most the chunk already in the element, never the rest of the answer.
    expect(FakeAudio.played.length).toBeLessThanOrEqual(1);
  });

  it('stop() then resume() gives a clean queue rather than a dead one', async () => {
    const q = makeQueue(fetcherThat());
    q.push('old turn. ');
    q.stop();
    q.resume();
    FakeAudio.played = [];
    q.push('new turn. ');
    await settle();
    expect(FakeAudio.played).toEqual(['new turn.']);
  });

  it('stop() also forgets a half-open fence, so the next turn is not muted', async () => {
    const q = makeQueue(fetcherThat());
    q.push('```dream-html\n<div>');
    q.stop();
    q.resume();
    q.push('Tamam. ');
    await settle();
    expect(FakeAudio.played).toEqual(['Tamam.']);
  });

  it('flushTurn() speaks the trailing partial chunk', async () => {
    const q = makeQueue(fetcherThat());
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

/**
 * THE SPEAKING SPEED SETTING, which was stored, sent and reported correctly and then erased
 * one line before it could take effect.
 *
 * `play()` used to set `playbackRate` and THEN assign `src`. Assigning `src` runs the media
 * element load algorithm, whose last step resets `playbackRate` to `defaultPlaybackRate` —
 * so every chunk played at 1x whatever Settings said, and nothing anywhere reported a
 * problem. The fake above models that reset, which is what makes these assertions fail on
 * the old code instead of passing on both.
 */
describe('the speaking speed preference', () => {
  it('survives the src assignment that resets playbackRate', async () => {
    adoptVoicePrefs({ speechRate: 1.6 });
    const q = makeQueue(fetcherThat());
    q.push('Birinci cumle. Ikinci cumle. ');
    await settle();
    expect(FakeAudio.played).toEqual(['Birinci cumle.', 'Ikinci cumle.']);
    // EVERY chunk, not just the first: the reset fires on each new src.
    expect(FakeAudio.rates).toEqual([1.6, 1.6]);
  });

  it('takes a rate changed BETWEEN two chunks, not at the next session', async () => {
    adoptVoicePrefs({ speechRate: 1 });
    const q = makeQueue(fetcherThat());
    q.push('Birinci cumle. ');
    await settle();
    adoptVoicePrefs({ speechRate: 1.35 });
    q.push('Ikinci cumle. ');
    await settle();
    expect(FakeAudio.rates).toEqual([1, 1.35]);
  });
});

describe('the speaker floor, from the queue side', () => {
  // The unspoken-answer announcement travels on a window event (the same channel
  // `voicePrefs` uses to reach an already-open chat pane), and this suite runs in plain Node
  // where there is no window. An `EventTarget` is the whole of the surface used.
  beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });

  /** A focus client that records what it was asked and answers however the test says. */
  function focusThat(granted: boolean) {
    const calls: { holds: number; releases: number } = { holds: 0, releases: 0 };
    const client: FocusClient = {
      hold: async () => {
        calls.holds += 1;
        return { granted, holder: granted ? 's1' : 'other-pane', ducked: false, gain: 1, paused: [] };
      },
      release: () => { calls.releases += 1; },
    };
    return { client, calls };
  }

  it('SPEAKS NOTHING when another pane holds the speaker, and says so once', async () => {
    const muted: string[] = [];
    const off = onSpeechMuted((e) => muted.push(e.session));
    const { client } = focusThat(false);
    const q = new SpeechQueue('s1', fetcherThat(), client);
    q.push('one here. two here. three here. ');
    await settle();
    // Not one sentence, not a late half of the answer: by the time the other pane finishes,
    // reading this would be a second conversation over the first.
    expect(FakeAudio.played).toEqual([]);
    // Said EXACTLY once, though three chunks were refused: the refusal is a property of the
    // turn. Three identical notices in a row would read as three separate failures.
    expect(muted).toEqual(['s1']);
    off();
  });

  it('takes the speaker BEFORE the audio is fetched, not when it is played', async () => {
    // The whole reason the pause is free: the ~120 ms `osascript` round trip has to land
    // inside the chunk's ~1.3 s generation rather than in front of the first word.
    const order: string[] = [];
    const client: FocusClient = {
      hold: async () => {
        order.push('hold');
        return { granted: true, holder: 's1', ducked: false, gain: 1, paused: [] };
      },
      release: () => {},
    };
    const q = new SpeechQueue('s1', async (text) => {
      order.push(`fetch:${text}`);
      return { __text: text } as unknown as Blob;
    }, client);
    q.push('one here. ');
    await settle();
    expect(order[0]).toBe('hold');
  });

  it('does NOT release the moment the queue drains — a reply is still arriving', async () => {
    const { client, calls } = focusThat(true);
    const q = new SpeechQueue('s1', fetcherThat(), client);
    q.push('one here. ');
    await settle();
    // Chunks arrive while the reply is still being written, so an empty queue mid-answer is
    // the NORMAL state. Releasing here would pause and resume the music at every sentence.
    expect(calls.releases).toBe(0);
    q.push('two here. ');
    await settle();
    expect(FakeAudio.played).toEqual(['one here.', 'two here.']);
    expect(calls.releases).toBe(0);
  });

  it('releases once the grace window passes with nothing new', async () => {
    const { client, calls } = focusThat(true);
    const q = new SpeechQueue('s1', fetcherThat(), client);
    q.push('one here. ');
    await settle();
    await new Promise((r) => setTimeout(r, FOCUS_GRACE_MS + 40));
    expect(calls.releases).toBe(1);
  });

  it('BARGE-IN releases immediately rather than waiting out the grace', async () => {
    const { client, calls } = focusThat(true);
    const q = new SpeechQueue('s1', fetcherThat(), client);
    q.push('one here. two here. ');
    await Promise.resolve();
    q.stop();
    // The owner just pressed the mic and is about to speak. A release that waited 800 ms
    // would put the music back underneath the start of their sentence.
    expect(calls.releases).toBe(1);
    await settle();
  });

  it('releases on dispose, so a closed pane does not hold the speaker', async () => {
    const { client, calls } = focusThat(true);
    const q = new SpeechQueue('s1', fetcherThat(), client);
    q.push('one here. ');
    await settle();
    q.dispose();
    expect(calls.releases).toBe(1);
  });

  it('REFRESHES the hold as it plays — that is the watchdog heartbeat', async () => {
    const { client, calls } = focusThat(true);
    const q = new SpeechQueue('s1', fetcherThat(), client);
    q.push('one here. two here. three here. ');
    await settle();
    // More than the one hold that opened the turn: the server reclaims a lease nobody
    // refreshes, and a long answer must not have its music restored underneath it.
    expect(calls.holds).toBeGreaterThan(1);
  });
});

/**
 * THE SPEAKING SIGNAL.
 *
 * Speaking was the one state of the mode with nothing on screen: barge-in existed but nothing
 * said there was anything to barge into. The signal that fixed that hangs on the FOCUS HOLD
 * rather than on playback, and these tests are why — a play-time flag looks correct in the
 * simple case and falls apart in the one that actually happens.
 */
describe('the speaking signal', () => {
  it('tells a subscriber the current value IMMEDIATELY', async () => {
    // A composer that mounts mid-answer must not be left believing the room is quiet.
    const q = makeQueue(fetcherThat());
    const seen: boolean[] = [];
    q.onSpeaking((v) => seen.push(v));
    expect(seen).toEqual([false]);
    q.push('Bir cumle. ');
    await settle();
    const late: boolean[] = [];
    q.onSpeaking((v) => late.push(v));
    expect(late).toEqual([true]);
  });

  it('does NOT flicker off between the sentences of one answer', async () => {
    // THE case the whole design turns on. A reply is still being written while it is read, so
    // the queue empties repeatedly mid-answer. A signal tied to playback would drop on every
    // one of those gaps and take the Hush button with it.
    const q = makeQueue(fetcherThat());
    const seen: boolean[] = [];
    q.onSpeaking((v) => seen.push(v));
    q.push('Birinci cumle. ');
    await settle();
    q.push('Ikinci cumle. ');
    await settle();
    q.push('Ucuncu cumle. ');
    await settle();
    // One rise, no fall: the gaps did not produce a single transition.
    expect(seen).toEqual([false, true]);
  });

  it('falls on barge-in, immediately', async () => {
    const q = makeQueue(fetcherThat());
    const seen: boolean[] = [];
    q.onSpeaking((v) => seen.push(v));
    q.push('Bir cumle. ');
    await settle();
    q.stop();
    expect(seen).toEqual([false, true, false]);
  });

  it('falls once the grace window expires on a finished answer', async () => {
    const q = makeQueue(fetcherThat());
    const seen: boolean[] = [];
    q.onSpeaking((v) => seen.push(v));
    q.push('Bir cumle. ');
    q.flushTurn();
    await settle();
    expect(seen).toEqual([false, true]);
    await new Promise((r) => setTimeout(r, FOCUS_GRACE_MS + 40));
    expect(seen).toEqual([false, true, false]);
  });

  it('is edge-triggered — a subscriber never hears the same value twice', async () => {
    const q = makeQueue(fetcherThat());
    const seen: boolean[] = [];
    q.onSpeaking((v) => seen.push(v));
    q.push('Bir cumle. Iki cumle. ');
    await settle();
    q.stop();
    q.stop();
    expect(seen).toEqual([false, true, false]);
  });

  it('unsubscribes, and dispose drops every listener', async () => {
    const q = makeQueue(fetcherThat());
    const seen: boolean[] = [];
    const off = q.onSpeaking((v) => seen.push(v));
    off();
    q.push('Bir cumle. ');
    await settle();
    expect(seen).toEqual([false]);

    const other: boolean[] = [];
    q.onSpeaking((v) => other.push(v));
    q.dispose();
    q.push('Iki cumle. ');
    await settle();
    // `dispose` stops the queue AND drops the listeners: nothing after it.
    expect(other).toEqual([true, false]);
  });
});

/**
 * GAPLESS PLAYBACK — the defect the owner heard as "it cuts at the end of every sentence".
 *
 * The old player assigned each chunk's blob to ONE `<audio>` element's `src` and waited for
 * `ended`. Assigning the next `src` runs the media element load algorithm immediately, which
 * tears down playback and throws away whatever was still in the output buffer — the clipped
 * tail, once per sentence. These tests hold the replacement in place: every chunk is a
 * decoded buffer started at an ABSOLUTE time on the audio clock, and that time is the exact
 * moment the previous chunk ends.
 */
describe('gapless playback', () => {
  /** Every source the queue scheduled, in order, with the time it was told to start. */
  let started: Array<{ at: number; stopped: boolean }>;

  /** The smallest AudioContext that exercises scheduling. `currentTime` is writable so a test
   *  can move the clock the way a real one does. */
  class FakeCtx {
    state: string = 'running';
    currentTime = 0;
    static resumable = true;
    static made = 0;
    static decodes = 0;
    /** Seconds of audio every decoded chunk claims to be. */
    static duration = 1;
    /** Set to make the decoder refuse, i.e. a webview that will not take our WAV. */
    static decodable = true;
    destination = {};
    constructor() { FakeCtx.made += 1; }
    async resume() {
      if (!FakeCtx.resumable) throw new Error('not allowed');
      this.state = 'running';
    }
    async close() { this.state = 'closed'; }
    async decodeAudioData(_bytes: ArrayBuffer) {
      FakeCtx.decodes += 1;
      if (!FakeCtx.decodable) throw new Error('cannot decode');
      return { duration: FakeCtx.duration } as unknown as AudioBuffer;
    }
    createBufferSource() {
      const rec = { at: -1, stopped: false };
      return {
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        connect: () => {},
        disconnect: () => {},
        start: (at: number) => { rec.at = at; started.push(rec); },
        stop: () => { rec.stopped = true; },
      };
    }
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createDynamicsCompressor() {
      const p = () => ({ value: 0 });
      return {
        threshold: p(), knee: p(), ratio: p(), attack: p(), release: p(), connect: () => {},
      };
    }
  }

  beforeEach(() => {
    started = [];
    FakeCtx.made = 0;
    FakeCtx.decodes = 0;
    FakeCtx.resumable = true;
    FakeCtx.decodable = true;
    FakeCtx.duration = 1;
    vi.stubGlobal('window', Object.assign(new EventTarget(), { AudioContext: FakeCtx }));
  });

  const ctxOf = (q: SpeechQueue) => (q as unknown as { ctx: FakeCtx }).ctx;
  const marksOf = (q: SpeechQueue) => (
    q as unknown as { marks: Array<{ text: string; itemId?: string; start: number; end: number }> }
  ).marks;

  it('starts each chunk at the exact sample the previous one ENDS — no gap, no clipped tail', async () => {
    const q = makeQueue(fetcherThat());
    q.push('one here. two here. three here. ');
    await settle();
    expect(started).toHaveLength(3);
    // The first is placed a lead-time ahead of now, because a source started at exactly
    // `currentTime` races the next render quantum and loses the start of the word.
    expect(started[0].at).toBeCloseTo(SCHEDULE_LEAD, 6);
    // And every one after it is butted against the end of the one before.
    expect(started[1].at).toBeCloseTo(started[0].at + FakeCtx.duration, 6);
    expect(started[2].at).toBeCloseTo(started[1].at + FakeCtx.duration, 6);
  });

  it('does not schedule into the PAST when a chunk arrives after the queue ran dry', async () => {
    const q = makeQueue(fetcherThat());
    q.push('one here. ');
    await settle();
    // The listener heard that sentence and then waited: the model was still writing.
    ctxOf(q).currentTime = 30;
    q.push('two here. ');
    await settle();
    // A start time in the past plays immediately AND clipped. The lead is taken from now.
    expect(started[1].at).toBeCloseTo(30 + SCHEDULE_LEAD, 6);
  });

  it('scales the chunk\'s slot by the PLAYBACK RATE, so a faster answer is still gapless', async () => {
    adoptVoicePrefs({ speech: true, speechRate: 2 });
    const q = makeQueue(fetcherThat());
    q.push('one here. two here. ');
    await settle();
    // A one-second buffer at 2x occupies half a second of the schedule.
    expect(started[1].at).toBeCloseTo(started[0].at + FakeCtx.duration / 2, 6);
  });

  it('records WHICH chunk occupies which window of audio time', async () => {
    const q = makeQueue(fetcherThat());
    q.push('one here. two here. ', 'item-7');
    await settle();
    const marks = marksOf(q);
    expect(marks.map((m) => m.text)).toEqual(['one here.', 'two here.']);
    expect(marks.every((m) => m.itemId === 'item-7')).toBe(true);
    // Contiguous: the end of one IS the start of the next, which is the same property the
    // audio has and the reason the on-screen marker cannot fall between two sentences.
    expect(marks[1].start).toBeCloseTo(marks[0].end, 6);
  });

  it('STOPS every scheduled source on barge-in, including ones that have not sounded yet', async () => {
    const q = makeQueue(fetcherThat());
    q.push('one here. two here. three here. ');
    await settle();
    expect(started.every((s) => !s.stopped)).toBe(true);
    q.stop();
    // All three, not just the one that is audible: the rest are already queued on the audio
    // thread and would otherwise play over the owner's next sentence.
    expect(started.every((s) => s.stopped)).toBe(true);
    expect(marksOf(q)).toHaveLength(0);
  });

  it('speaks a chunk on the element when SCHEDULING itself throws, rather than dropping it', async () => {
    // Narrower than a decode failure and the same rule: the hole would be exactly one
    // sentence wide, in the middle of an answer, with nothing on screen to show it.
    const q = makeQueue(fetcherThat());
    const ctor = FakeCtx.prototype.createBufferSource;
    let first = true;
    FakeCtx.prototype.createBufferSource = function throwing(this: FakeCtx) {
      if (first) { first = false; throw new Error('no source for you'); }
      return ctor.call(this);
    } as typeof ctor;
    try {
      q.push('one here. ');
      await settle();
      expect(started).toHaveLength(0);
      expect(FakeAudio.played).toEqual(['one here.']);
    } finally {
      FakeCtx.prototype.createBufferSource = ctor;
    }
  });

  it('falls back to the element when the webview will not DECODE, rather than going silent', async () => {
    FakeCtx.decodable = false;
    const q = makeQueue(fetcherThat());
    q.push('one here. two here. ');
    await settle();
    expect(started).toHaveLength(0);
    expect(FakeAudio.played).toEqual(['one here.', 'two here.']);
    // And it stops trying: one refusal is a property of the engine, not of the chunk.
    expect(FakeCtx.decodes).toBe(1);
  });

  it('WAITS for the scheduled audio before the fallback speaks, so two paths never overlap', async () => {
    // A turn that decoded one chunk and then failed on the next — "the decoder gave up
    // part-way" — would otherwise start the element on top of the tail of the buffer still
    // sounding: two voices out of one queue.
    // A short chunk, so the wait this test is about is a tenth of a second rather than a
    // real sentence's worth.
    FakeCtx.duration = 0.05;
    const q = makeQueue(fetcherThat());
    q.push('one here. ');
    await settle();
    expect(started).toHaveLength(1);
    FakeCtx.decodable = false;
    q.push('two here. ');
    await settle();
    // The scheduled chunk is still sounding, so the element has been handed nothing yet.
    expect(FakeAudio.played).toEqual([]);
    // Once it has finished, the fallback speaks — late, not never and not over the top.
    await new Promise((r) => setTimeout(r, 200));
    await settle();
    expect(FakeAudio.played).toEqual(['two here.']);
  });

  it('falls back to the element when the context cannot be revived', async () => {
    const q = makeQueue(fetcherThat());
    q.push('one here. ');
    await settle();
    ctxOf(q).state = 'suspended';
    FakeCtx.resumable = false;
    // The first chunk has been heard — the clock has moved past it. (A fake context's clock
    // does not run on its own, so a test that skipped this would be measuring the wait from
    // the paragraph above rather than the fallback it is about.)
    ctxOf(q).currentTime = 10;
    q.push('two here. ');
    await settle();
    expect(FakeAudio.played).toEqual(['two here.']);
  });

  it('holds the speaker until the scheduled audio has actually FINISHED', async () => {
    // The two clocks came apart with scheduling: an empty job list means "everything is
    // queued", not "everything has been heard". Releasing on the empty list would hand the
    // music back — and drop the Hush button — seconds before the voice stopped.
    FakeCtx.duration = 5;
    const q = makeQueue(fetcherThat());
    const seen: boolean[] = [];
    q.onSpeaking((v) => seen.push(v));
    q.push('one here. ');
    q.flushTurn();
    await settle();
    await new Promise((r) => setTimeout(r, FOCUS_GRACE_MS + 60));
    // Five seconds of audio are still ahead of the clock, so the hold stands.
    expect(seen).toEqual([false, true]);
  });
});

describe('a refusal must not outlive its turn', () => {
  beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });

  it('RE-ASKS the server on a new turn instead of inheriting the last refusal', async () => {
    // The refusal leaves a settled `granted: false` promise in `focusHold` until the 800 ms
    // grace clears it. A new turn starting inside that window used to read the previous
    // turn's refusal as its own and stay silent WITHOUT ASKING — by which time the other pane
    // may well have finished.
    let answer = false;
    const asked: number[] = [];
    const client: FocusClient = {
      hold: async () => {
        asked.push(Date.now());
        return { granted: answer, holder: answer ? 's1' : 'other', ducked: false, gain: 1, paused: [] };
      },
      release: () => {},
    };
    const q = new SpeechQueue('s1', fetcherThat(), client);
    q.push('one here. ');
    await settle();
    expect(FakeAudio.played).toEqual([]);
    const askedDuringRefusal = asked.length;
    // The other pane finishes. A new turn begins WELL INSIDE the 800 ms grace window.
    answer = true;
    q.push('two here. ');
    await settle();
    expect(asked.length).toBeGreaterThan(askedDuringRefusal);
    expect(FakeAudio.played).toEqual(['two here.']);
  });

  it('TAKES THE NOTICE BACK when it speaks again', async () => {
    const seen: Array<{ session: string; muted: boolean }> = [];
    const off = onSpeechMuted((e) => seen.push(e));
    let answer = false;
    const client: FocusClient = {
      hold: async () => ({ granted: answer, holder: 'x', ducked: false, gain: 1, paused: [] }),
      release: () => {},
    };
    const q = new SpeechQueue('s1', fetcherThat(), client);
    q.push('one here. ');
    await settle();
    answer = true;
    q.push('two here. ');
    await settle();
    // Up, then down. Left up, it sat on screen claiming an answer had not been read aloud
    // while the next one was being read aloud.
    expect(seen.map((e) => e.muted)).toEqual([true, false]);
    off();
  });
});

/**
 * THE SEAM between the speaking signal and the speaker floor.
 *
 * `enqueue` raises the signal before the server has ruled on who owns the speaker — it has to,
 * because the rail must be up before the first chunk plays. So the refusal path is the one
 * place the signal can be left asserting something that turned out to be false.
 */
describe('the speaking signal and a refused speaker', () => {
  beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });

  it('falls IMMEDIATELY when the speaker is refused, not after the grace window', async () => {
    // Without this the refused pane shows a violet rail and a Hush button for ~800 ms, over
    // audio that never played and cannot be silenced.
    const client: FocusClient = {
      hold: async () => ({ granted: false, holder: 'other', ducked: false, gain: 1, paused: [] }),
      release: () => {},
    };
    const q = new SpeechQueue('s1', fetcherThat(), client);
    const seen: boolean[] = [];
    q.onSpeaking((v) => seen.push(v));
    q.push('one here. two here. ');
    await settle();
    expect(FakeAudio.played).toEqual([]);
    // Rose on enqueue (correctly — the ruling had not arrived), then fell on the refusal.
    expect(seen).toEqual([false, true, false]);
  });

  it('still rises normally on the turn AFTER a refusal', async () => {
    // The fall must not latch: the next turn re-asks, and a granted one speaks.
    let answer = false;
    const client: FocusClient = {
      hold: async () => ({ granted: answer, holder: answer ? 's1' : 'other', ducked: false, gain: 1, paused: [] }),
      release: () => {},
    };
    const q = new SpeechQueue('s1', fetcherThat(), client);
    const seen: boolean[] = [];
    q.onSpeaking((v) => seen.push(v));
    q.push('one here. ');
    await settle();
    answer = true;
    q.push('two here. ');
    await settle();
    expect(FakeAudio.played).toEqual(['two here.']);
    expect(seen).toEqual([false, true, false, true]);
  });
});
