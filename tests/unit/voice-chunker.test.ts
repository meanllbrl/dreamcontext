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
  HARD_CHUNK_CHARS, MIN_SPEAKABLE_CHARS, SpeechQueue, FOCUS_GRACE_MS,
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
  pause() {}
  play() {
    const src = this.src;
    if (src) {
      FakeAudio.played.push(BLOB_TEXT.get(src) ?? src);
      FakeAudio.rates.push(this.playbackRate);
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
    return { __text: text } as unknown as Blob;
  };
}

describe('the speech queue', () => {
  it('plays chunks STRICTLY in order, however the fetches resolve', async () => {
    // The second chunk's fetch resolves LAST. Ordered playback means it is still spoken
    // second — a queue that just played whatever arrived would reverse them.
    const q = makeQueue(async (text) => {
      if (text.includes('two')) await new Promise((r) => setTimeout(r, 15));
      return { __text: text } as unknown as Blob;
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

describe('the compensation graph, and what happens when its context dies', () => {
  /** The smallest AudioContext that exercises the routing path. `state` is writable so a test
   *  can do what a real browser does to a quiet context: suspend it behind our back. */
  class FakeCtx {
    state: string = 'running';
    /** Whether `resume()` is allowed to work. A context WebKit has interrupted for another
     *  app's audio session is the realistic case where it is not. */
    static resumable = true;
    static made = 0;
    destination = {};
    constructor() { FakeCtx.made += 1; }
    async resume() {
      if (!FakeCtx.resumable) throw new Error('not allowed');
      this.state = 'running';
    }
    async close() { this.state = 'closed'; }
    createMediaElementSource() { return { connect: () => {} }; }
    createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    createDynamicsCompressor() {
      const p = () => ({ value: 0 });
      return {
        threshold: p(), knee: p(), ratio: p(), attack: p(), release: p(), connect: () => {},
      };
    }
  }

  /** Counts how many audio elements the queue built — the only way to see the fallback swap,
   *  since a fake element plays happily whether or not it is routed through a dead graph. */
  let elementsMade = 0;

  beforeEach(() => {
    FakeCtx.made = 0;
    FakeCtx.resumable = true;
    elementsMade = 0;
    class CountingAudio extends FakeAudio {
      constructor() { super(); elementsMade += 1; }
    }
    vi.stubGlobal('Audio', CountingAudio);
    vi.stubGlobal('window', Object.assign(new EventTarget(), { AudioContext: FakeCtx }));
  });

  function duckingFocus(gain: number): FocusClient {
    return {
      hold: async () => ({ granted: true, holder: 's1', ducked: gain > 1, gain, paused: [] }),
      release: () => {},
    };
  }

  it('OPENS A CONTEXT WITHOUT A MIC PRESS, so a typed turn still gets its boost', async () => {
    // The context used to be opened only by the mic-press handler, while J.A.R.V.I.S reads
    // EVERY answer aloud — typed ones included. A user who never touched the mic therefore
    // got the duck with no compensation, which leaves the answer quieter than it would have
    // been with no feature at all.
    const q = new SpeechQueue('s1', fetcherThat(), duckingFocus(2));
    q.push('one here. ');            // no unlock(), i.e. nobody pressed the mic
    await settle();
    expect(FakeCtx.made).toBe(1);
    expect(FakeAudio.played).toEqual(['one here.']);
  });

  it('RESUMES a context that suspended between turns rather than going silent', async () => {
    const q = new SpeechQueue('s1', fetcherThat(), duckingFocus(2));
    q.push('one here. ');
    await settle();
    const elementsAfterFirst = elementsMade;
    // What a browser does to a context that has been quiet — and this queue is quiet through
    // every "thinking" gap. Once routed, the element reaches the speakers ONLY through it.
    (q as unknown as { ctx: FakeCtx }).ctx.state = 'suspended';
    q.push('two here. ');
    await settle();
    expect(FakeAudio.played).toEqual(['one here.', 'two here.']);
    // Revived, not abandoned: the boost survives.
    expect((q as unknown as { ctx: FakeCtx }).ctx.state).toBe('running');
    expect(elementsMade).toBe(elementsAfterFirst);
  });

  it('FALLS BACK to a fresh un-routed element when the context cannot be revived', async () => {
    const q = new SpeechQueue('s1', fetcherThat(), duckingFocus(2));
    q.push('one here. ');
    await settle();
    const elementsAfterFirst = elementsMade;
    (q as unknown as { ctx: FakeCtx }).ctx.state = 'suspended';
    FakeCtx.resumable = false;
    q.push('two here. ');
    await settle();
    // The element was swapped for one on the plain path. Losing the boost is a cost; losing
    // the voice with `ended` still firing and the UI looking normal is the failure this
    // whole fallback exists to prevent.
    expect(elementsMade).toBe(elementsAfterFirst + 1);
    expect(FakeAudio.played).toEqual(['one here.', 'two here.']);
    expect((q as unknown as { routed: boolean }).routed).toBe(false);
  });

  it('never routes at all when nothing was ducked', async () => {
    const q = new SpeechQueue('s1', fetcherThat(), duckingFocus(1));
    q.push('one here. two here. ');
    await settle();
    // `musicDuck: 1` (or a turn that paused Spotify instead) must leave playback on exactly
    // the path it used before this feature existed.
    expect((q as unknown as { routed: boolean }).routed).toBe(false);
    expect(FakeAudio.played).toEqual(['one here.', 'two here.']);
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
