/**
 * The speaking half of J.A.R.V.I.S mode: turn a REPLY THAT IS STILL ARRIVING into continuous
 * speech, in order, starting before the reply has finished.
 *
 * Two pieces, deliberately separable:
 *   • {@link createSpeechChunker} — a pure state machine over the text stream. No DOM, no
 *     network, no clock, so it is unit-testable from plain Node (AC16).
 *   • {@link SpeechQueue} — fetches and plays those chunks strictly in order.
 *
 * ── WHY THE CHUNKER IS FENCE-AWARE, AND WHY THAT IS NOT POLISH ──────────────────────────
 * The mode's briefing tells the agent to put any structured answer on screen as a
 * `dream-html` block, so MOST real replies in this mode contain a fenced block. A chunker
 * that did not know about fences would carve one into "sentences" at every `.` inside a CSS
 * rule and read the tag soup aloud. `speakable()` on the server cannot repair that after the
 * fact: by the time it sees a chunk, the damage — the split — has already happened. So the
 * fence is excluded HERE, whole, before anything is split.
 *
 * ── WHY A FENCE LINE IS HELD BACK CHARACTER BY CHARACTER ────────────────────────────────
 * Deltas arrive in arbitrary pieces: an opening fence can reach us as "`", then "``", then
 * "dream-html\n". A line-buffered chunker that only decided at the newline would be correct
 * but would also stall speech until every line ended, which costs the ~1.5 s start AC6 asks
 * for. So the chunker holds back ONLY a line that could still turn out to be a fence (one
 * that so far is nothing but backticks) and lets ordinary prose flow immediately.
 */

import { voicePrefs } from './voicePrefs';

// ── The chunker ────────────────────────────────────────────────────────────────────────

/**
 * ── WHERE A CHUNK ENDS, AND WHY IT IS NOT "40 CHARACTERS" ───────────────────────────────
 *
 * The rule this replaces broke at the last SPACE once the buffer passed 40 characters, which
 * meant every sentence longer than that was cut mid-clause: the model was handed a fragment
 * with no punctuation, read it with a falling intonation, and the next fragment started cold.
 * That is the "kesik kesik, cümlenin ortasından" the owner heard, and no amount of prefetch
 * fixes it, because the damage is done before the audio is ever requested.
 *
 * Boundaries are now PUNCTUATION, in three tiers:
 *   1. a closed sentence — always, however short ("Tamam." is a legitimate chunk);
 *   2. a clause end (comma, semicolon, colon, dash) once the chunk is long enough to be
 *      worth speaking on its own;
 *   3. a word boundary only past a HARD cap, so an unpunctuated monologue still gets spoken
 *      rather than accumulating in silence.
 *
 * The FIRST chunk of a turn takes tier 2 much earlier than later ones. Time-to-first-word is
 * the number the owner actually feels; after that, playback is the clock and longer chunks
 * read better.
 */

export interface SpeechChunker {
  /** Feed a piece of the reply. Returns the chunks that are now ready to speak, in order. */
  push(delta: string): string[];
  /** End of turn: emit whatever is left, however short. */
  flush(): string[];
  /** Forget everything — a new turn, or a barge-in. */
  reset(): void;
}

/** True while `line` could still become a fence opener — i.e. it is so far only backticks. */
function couldBeFence(line: string): boolean {
  return /^\s*`{0,3}$/.test(line) || /^\s*```/.test(line);
}

/** How much text must be buffered before a CLAUSE break is taken at all, mid-turn. */
export const CLAUSE_CHUNK_CHARS = 80;

/** No chunk shorter than this is worth a network round trip of its own: every chunk costs a
 *  fixed ~1.3s generation whatever its length, so a four-word fragment spends the same as the
 *  sentence it was carved out of. */
export const MIN_SPEAKABLE_CHARS = 24;

/** …and for the FIRST chunk of a turn, where latency beats prosody. */
export const FIRST_CLAUSE_CHUNK_CHARS = 40;

/** Past this, break at a space rather than stay silent. Deliberately far above the clause
 *  threshold: reaching it means the text genuinely has no punctuation. */
export const HARD_CHUNK_CHARS = 240;

/** A sentence terminator, in the shapes real replies use. */
const TERMINATOR = /[.!?…]/;

/** A clause boundary. Includes the em/en dash this project's prose actually uses, and the
 *  Turkish and English comma alike — both are U+002C, which is the point: nothing here is
 *  language-specific except the abbreviation list below. */
const CLAUSE = /[,;:—–]/;

/**
 * Words that end in a period WITHOUT ending a sentence.
 *
 * Turkish first, because Turkish is what the owner speaks and its abbreviations are dense in
 * exactly the register an assistant answers in (`vb.`, `vs.`, `bkz.`, `örn.`). English ones
 * follow. Matched case-insensitively against the last word before the dot.
 */
const ABBREVIATIONS = new Set([
  // Turkish
  'vb', 'vs', 'bkz', 'örn', 'ör', 'dr', 'doç', 'prof', 'sn', 'av', 'mah', 'cad', 'sok', 'apt',
  'no', 'tl', 'sa', 'dk', 'sn', 'yy', 'çev', 'haz', 'ed', 'age', 'agm', 'yak', 'yön', 'md',
  // English
  'mr', 'mrs', 'ms', 'st', 'etc', 'eg', 'ie', 'fig', 'vol', 'approx', 'inc', 'ltd', 'jr', 'sr',
  'min', 'max', 'sec', 'hrs', 'pp', 'ca', 'cf', 'al',
]);

/**
 * Does the terminator at `i` actually close a sentence?
 *
 * Three ways it does not, and all three are ordinary in a real answer:
 *   • a DECIMAL or a Turkish ORDINAL — `3.5`, and `3. görev` (which would otherwise be
 *     spoken as a chunk consisting of the single word "three");
 *   • an ABBREVIATION — `vb.`, `örn.`, `etc.`;
 *   • an INITIAL — `A. Yılmaz`.
 */
function closesSentence(buf: string, i: number): boolean {
  if (buf[i] !== '.') return true;            // ! ? … are never abbreviations
  const before = buf.slice(0, i);
  const lastWord = /([\p{L}\p{N}]+)$/u.exec(before)?.[1] ?? '';
  if (!lastWord) return true;
  // A number immediately before the dot: `3.5`, or the Turkish ordinal `3.`
  if (/^\p{N}+$/u.test(lastWord)) return false;
  // A single capital letter: an initial, not a sentence.
  if (lastWord.length === 1 && lastWord === lastWord.toUpperCase()) return false;
  return !ABBREVIATIONS.has(lastWord.toLocaleLowerCase('tr'));
}

/** Where to cut `buf`, or -1 to keep accumulating. `first` relaxes the clause threshold for
 *  the opening chunk of a turn. */
export function boundaryOf(buf: string, first = false): number {
  // ── Tier 1: a closed sentence ─────────────────────────────────────────────────────────
  // A terminator followed by WHITESPACE. The whitespace is what makes it a sentence rather
  // than a decimal point, and it is why the end of the buffer is not a boundary: mid-stream
  // the next character has not arrived, so "It took 1." would split `1.5` the instant the
  // dot did. `flush()` handles the true end of turn, the only moment we know nothing follows.
  for (let i = buf.length - 2; i >= 0; i--) {
    if (!TERMINATOR.test(buf[i])) continue;
    if (!/\s/.test(buf[i + 1])) continue;
    if (!closesSentence(buf, i)) continue;
    return i + 1;
  }

  // ── Tier 2: a clause, once there is enough text to be worth speaking ──────────────────
  // Two numbers, and they answer different questions. `trigger` is WHEN to start looking —
  // below it, keep accumulating, because a sentence that is about to close reads better
  // whole. `MIN_SPEAKABLE_CHARS` is WHERE the cut may fall, and the search runs FORWARDS from
  // it: the earliest clause boundary makes the shortest chunk, which both starts sooner and
  // lets the next one generate while it plays.
  const trigger = first ? FIRST_CLAUSE_CHUNK_CHARS : CLAUSE_CHUNK_CHARS;
  if (buf.length >= trigger) {
    // `- 1` because cutting AT index `i` yields a chunk of `i + 1` characters: the bound is
    // on the chunk, not on the index.
    for (let i = MIN_SPEAKABLE_CHARS - 1; i <= buf.length - 2; i++) {
      if (CLAUSE.test(buf[i]) && /\s/.test(buf[i + 1])) return i + 1;
    }
  }

  // ── Tier 3: no punctuation at all ─────────────────────────────────────────────────────
  if (buf.length >= HARD_CHUNK_CHARS) {
    const at = buf.lastIndexOf(' ');
    if (at > 0) return at;
  }
  return -1;
}

export function createSpeechChunker(): SpeechChunker {
  /** The current, possibly incomplete, line. */
  let line = '';
  /** How much of `line` has already been moved into `pending`. */
  let taken = 0;
  /** Speakable prose accumulated but not yet long enough (or closed) to emit. */
  let pending = '';
  /** Inside a fenced block — everything is discarded until the closing fence. */
  let inFence = false;
  /** Nothing has been spoken yet this turn, so the first clause break is taken early —
   *  time-to-first-word is the latency the owner actually feels. */
  let first = true;

  const drain = (out: string[]): void => {
    for (;;) {
      const at = boundaryOf(pending, first);
      if (at < 0) return;
      const chunk = pending.slice(0, at).trim();
      pending = pending.slice(at);
      if (chunk) { out.push(chunk); first = false; }
    }
  };

  /** A newline arrived: settle the line, then treat the newline as a hard boundary. */
  const endLine = (out: string[]): void => {
    if (/^\s*```/.test(line)) {
      // The fence marker line itself is never spoken, opening or closing.
      inFence = !inFence;
    } else if (!inFence) {
      pending += `${line.slice(taken)} `;
    }
    line = '';
    taken = 0;
    if (!inFence) {
      drain(out);
      // A newline closes a sentence even without punctuation — a heading, a one-line answer.
      const rest = pending.trim();
      if (rest) { out.push(rest); first = false; }
      pending = '';
    }
  };

  return {
    push(delta: string): string[] {
      const out: string[] = [];
      for (const ch of delta) {
        if (ch === '\n') { endLine(out); continue; }
        line += ch;
        // Hold a line back only while it might still be a fence. Everything else flows
        // straight through, which is what lets speech start mid-line.
        if (!inFence && !couldBeFence(line)) {
          pending += line.slice(taken);
          taken = line.length;
          drain(out);
        }
      }
      return out;
    },

    flush(): string[] {
      const out: string[] = [];
      if (!inFence && !/^\s*```/.test(line)) {
        pending += line.slice(taken);
      }
      line = '';
      taken = 0;
      const rest = pending.trim();
      pending = '';
      // A FENCE CANNOT SPAN TURNS, so end of turn clears it — and forgetting to clear it here
      // was a silent, permanent mute. One chunker instance lives for the whole session, and
      // only `stop()` (barge-in / interrupt / steer) used to reset the flag. So a turn that
      // ended NORMALLY while still inside an unterminated block — a max-tokens cutoff or an
      // error part-way through a `dream-html` block, neither of which is a user interrupt —
      // left `inFence` true, and every later turn's prose was dropped from speech with the
      // transcript and the UI looking entirely normal. Found in review.
      inFence = false;
      first = true;
      if (rest) out.push(rest);
      return out;
    },

    reset(): void {
      line = '';
      taken = 0;
      pending = '';
      inFence = false;
      first = true;
    },
  };
}

// ── The player ─────────────────────────────────────────────────────────────────────────

/** Fetch one chunk's audio. Injectable so the queue is testable without a network. */
export type SpeakFetcher = (text: string, signal: AbortSignal) => Promise<Blob | null>;

/** POST one chunk to the TTS route. `null` means "skip this chunk" — a 204 (nothing
 *  speakable survived the stripper) or a failure, which the queue treats identically. */
export function createSpeakFetcher(): SpeakFetcher {
  return async (text, signal) => {
    try {
      const res = await fetch('/api/agent/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });
      if (res.status === 204) return null;
      if (!res.ok) {
        // The body carries one of OUR codes; the upstream text never leaves the server.
        console.warn('[voice] chunk not spoken', res.status);
        return null;
      }
      return await res.blob();
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return null;
      console.warn('[voice] chunk request failed', err);
      return null;
    }
  };
}

/** How many chunks may be generating at once. See {@link SpeechQueue.prefetch}. */
export const LOOK_AHEAD = 3;

interface Job {
  text: string;
  audio?: Promise<Blob | null>;
  controller: AbortController;
}

/**
 * Strictly ordered playback with one chunk of look-ahead: while chunk N plays, chunk N+1 is
 * already being fetched. That overlap is the whole reason speech sounds continuous rather
 * than arriving in stop-start bursts, and it is why AC6 asks for "no gap between chunks"
 * rather than just "starts quickly".
 */
export class SpeechQueue {
  private jobs: Job[] = [];
  private running = false;
  private stopped = false;
  /**
   * Bumped by every {@link stop}. The play loop captures it before each `await` and bails if
   * it changed, which is what makes barge-in correct rather than merely usually-correct: a
   * `stopped` boolean alone loses the race where the owner presses the mic and immediately
   * starts a new turn, because `resume()` clears the flag while the ABANDONED turn's fetch is
   * still in flight — and it then plays into the new turn.
   */
  private generation = 0;
  private audio: HTMLAudioElement | null = null;
  private readonly chunker = createSpeechChunker();

  constructor(private readonly fetcher: SpeakFetcher = createSpeakFetcher()) {}

  /**
   * Satisfy WebKit's user-activation rule.
   *
   * Autoplay is only permitted from inside a handler for a real gesture, and by the time the
   * agent's first sentence arrives we are several async hops away from one. So the mic-press
   * handler calls this SYNCHRONOUSLY: a silent play on a reused element banks the activation,
   * and every later chunk plays on the same element. Without it the first chunk of the first
   * answer is silently blocked and the mode looks broken exactly once per launch.
   */
  unlock(): void {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
    }
    const el = this.audio;
    el.muted = true;
    void el.play().then(() => { el.pause(); el.muted = false; }).catch(() => { el.muted = false; });
  }

  /** Feed streamed reply text. Chunks are enqueued as they close.
   *
   *  The "speak answers" preference is read HERE, per push, rather than at construction: the
   *  owner switching speech off mid-answer means the next sentence is silent, not the next
   *  session. The chunker is still fed, so switching back mid-turn resumes cleanly instead of
   *  replaying the paragraph it missed. */
  push(text: string): void {
    if (this.stopped) return;
    const speak = voicePrefs().speech;
    for (const chunk of this.chunker.push(text)) if (speak) this.enqueue(chunk);
  }

  /** End of turn — speak the trailing partial chunk (`result`, chatSession.ts). */
  flushTurn(): void {
    if (this.stopped) return;
    const speak = voicePrefs().speech;
    for (const chunk of this.chunker.flush()) if (speak) this.enqueue(chunk);
  }

  /**
   * THE stop-and-clear entry point, and deliberately the only one.
   *
   * Called from three places — the mic press (barge-in), `interrupt()` and `steer()`. The
   * last two are the ones that get forgotten: without them, pressing Stop or steering
   * mid-turn leaves the now-abandoned answer playing to the end, which is worse than no
   * barge-in at all because the agent audibly keeps arguing a point the owner just retracted.
   */
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    for (const job of this.jobs) job.controller.abort();
    this.jobs = [];
    this.chunker.reset();
    if (this.audio) {
      this.audio.pause();
      if (this.audio.src) URL.revokeObjectURL(this.audio.src);
      this.audio.removeAttribute('src');
    }
  }

  /** Ready for the next turn after a {@link stop}. */
  resume(): void {
    this.stopped = false;
  }

  /** Everything gone, for good — the session is being disposed. */
  dispose(): void {
    this.stop();
    this.audio = null;
  }

  private enqueue(text: string): void {
    this.jobs.push({ text, controller: new AbortController() });
    // Start the look-ahead HERE, not only inside the play loop. A chunk enqueued while an
    // earlier one is already playing arrives after the loop has passed its own prefetch
    // point, so without this the fetch for chunk N+1 would not begin until chunk N finished
    // — precisely the gap between chunks AC6 rules out.
    this.prefetch();
    void this.run();
  }

  /**
   * Keep the next {@link LOOK_AHEAD} chunks generating.
   *
   * ONE chunk of look-ahead was not enough, and the arithmetic says why: generation runs at
   * roughly 0.4x realtime but every chunk also pays a fixed round trip (the model is a chat
   * completion, and the server drains the whole stream before answering). A short chunk —
   * exactly what the opening of a turn now produces, deliberately — is therefore dominated by
   * that fixed cost, and one chunk of cover is not enough to hide it. Three requests in
   * flight cost nothing extra: the audio is paid for either way, and it is the SAME audio.
   */
  private prefetch(): void {
    for (let i = 0; i < LOOK_AHEAD && i < this.jobs.length; i++) {
      const job = this.jobs[i];
      if (job && !job.audio) job.audio = this.fetcher(job.text, job.controller.signal);
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.jobs.length > 0) {
        const gen = this.generation;
        this.prefetch();
        const job = this.jobs.shift()!;
        // The look-ahead: the chunks behind this one generate while it plays.
        this.prefetch();
        let blob: Blob | null = null;
        try {
          blob = await job.audio!;
        } catch (err) {
          console.warn('[voice] chunk failed, skipping', err);
        }
        if (this.stopped || gen !== this.generation) return;
        // A DROPPED CHUNK IS SKIPPED, NOT RETRIED AND NOT FATAL (AC10). One 429 costs a
        // sentence; stalling the queue on it would cost the rest of the answer.
        if (!blob) continue;
        await this.play(blob);
        if (gen !== this.generation) return;
      }
    } finally {
      this.running = false;
      // IN the finally, not after it: the loop above exits by `return` on a generation
      // change, and a `return` inside a `try` skips everything past the `finally`.
      //
      // Why the restart is needed at all: a loop that bailed may have left the NEXT turn's
      // chunks sitting in the queue with nobody draining them, because `enqueue`'s `run()`
      // returned immediately while the abandoned loop still held `running`. This is what
      // makes "barge in, then immediately say something else" work — without it the new
      // answer is silent, which is a worse failure than the stale audio it replaced.
      if (!this.stopped && this.jobs.length > 0) void this.run();
    }
  }

  private play(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      if (!this.audio) this.audio = new Audio();
      const el = this.audio;
      const url = URL.createObjectURL(blob);
      const done = () => {
        el.removeEventListener('ended', done);
        el.removeEventListener('error', done);
        URL.revokeObjectURL(url);
        resolve();
      };
      el.addEventListener('ended', done);
      el.addEventListener('error', done);
      // Set per chunk, from the live preference — a rate changed between two sentences takes
      // effect on the next one. Client-side rather than a `speed` sent upstream: a rate we
      // own cannot be a request that fails, and it costs nothing.
      el.playbackRate = voicePrefs().speechRate;
      el.src = url;
      void el.play().catch(() => done());
    });
  }
}
