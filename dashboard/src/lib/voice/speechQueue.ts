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
import {
  createFocusClient, announceSpeechMuted, OPEN_GRANT,
  type FocusClient, type FocusGrant,
} from './audioFocus';

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

/**
 * How long after the queue drains before the speaker (and the machine's music) is handed back.
 *
 * NOT zero, and the reason is the streaming shape of a turn. Chunks arrive as the reply is
 * still being written, so the queue empties repeatedly MID-ANSWER — between the last sentence
 * that has closed and the next one the model has not finished. Releasing on every one of those
 * gaps would pause and resume the music at every sentence, which is worse than never pausing
 * it: a track that stutters on and off for a paragraph is more distracting than one playing
 * steadily underneath.
 *
 * Counted from when the last SCHEDULED audio actually finishes, not from when the queue
 * emptied — see {@link SpeechQueue.scheduleRelease}. Those are now different moments: chunks
 * are scheduled ahead of their own playback, so an empty job list usually means "everything is
 * queued", not "everything has been heard".
 */
export const FOCUS_GRACE_MS = 800;

/**
 * How far ahead of "now" the first chunk of a run is scheduled.
 *
 * A source started at exactly `currentTime` races the audio thread's next render quantum and
 * loses the first few milliseconds of the word. 60 ms is inaudible as latency and is several
 * quanta of margin.
 */
export const SCHEDULE_LEAD = 0.06;

/** How often the spoken-chunk marker is re-read from the audio clock. ~16 Hz: fast enough that
 *  the highlight lands with the sentence, slow enough to be free. */
const MARK_TICK_MS = 60;

interface Job {
  text: string;
  /** Which transcript item this chunk's words came from, for the on-screen marker. */
  itemId?: string;
  audio?: Promise<Blob | null>;
  controller: AbortController;
}

/** A chunk while it is being SPOKEN — what the transcript marks on screen. */
export interface SpokenChunk {
  text: string;
  itemId?: string;
}

/** One scheduled chunk, on the audio context's own clock. */
interface Mark extends SpokenChunk {
  start: number;
  end: number;
}

/**
 * Strictly ordered, GAPLESS playback.
 *
 * ── WHY THIS IS WEB AUDIO AND NOT AN <audio> ELEMENT ANY MORE ───────────────────────────
 * The owner's report, 2026-09-12: "it cuts at the end of every sentence — probably the next
 * one clipping the one before it". They were reading the symptom correctly. The old player
 * owned ONE `HTMLAudioElement` and played each chunk by assigning a fresh blob URL to its
 * `src`, waiting for `ended`, then assigning the next. Three things are wrong with that, and
 * all three are audible at exactly the place they said:
 *
 *   • `ended` is the decoder's verdict, not the speaker's. Assigning the next `src` runs the
 *     media element load algorithm IMMEDIATELY, which tears down the current playback — so
 *     whatever was still in the output buffer when `ended` fired is discarded. That is the
 *     clipped tail, once per sentence, every sentence.
 *   • Between `ended` and the next `play()` there is a full JavaScript turn plus a media load:
 *     a gap the listener hears as a stutter even when nothing is clipped.
 *   • `stop()` paused the element and removed its `src`, which fires NEITHER `ended` NOR
 *     `error` — so the promise the play loop was awaiting never settled, `running` stayed
 *     true forever, and every chunk after a barge-in sat in the queue unplayed. A silent mode
 *     with nothing on screen to explain it, which is the failure this whole feature is
 *     written to avoid.
 *
 * Web Audio answers all three at once. Each chunk is decoded to an `AudioBuffer` and started
 * at an ABSOLUTE time on the audio clock — the exact sample at which the previous chunk ends —
 * so consecutive sentences butt together with no gap and no chunk is ever torn down early. The
 * schedule runs AHEAD of playback: chunk N+1 is already queued while chunk N is sounding,
 * which is also what makes "no gap between chunks" a property of the clock rather than a race
 * the event loop usually wins.
 *
 * The `<audio>` element survives as a FALLBACK for a webview that will not decode or will not
 * give us a running context — degraded (stop-start, no marker timing), never silent.
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
  private readonly chunker = createSpeechChunker();

  // ── The audio graph ──────────────────────────────────────────────────────────────────
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  /** Set once Web Audio has proved unusable on this machine — a context that will not run, or
   *  a decoder that refuses our WAV. Nothing tries it again after that; the element path is
   *  worse but it is not silent. */
  private fallback = false;
  /** Every source scheduled and not yet finished, so a barge-in can stop all of them. */
  private readonly sources = new Set<AudioBufferSourceNode>();
  /** The context time at which the last scheduled chunk ends. The next chunk starts HERE —
   *  this single number is what makes playback gapless. */
  private tail = 0;

  // ── The <audio> fallback ─────────────────────────────────────────────────────────────
  private audio: HTMLAudioElement | null = null;
  /** Resolves the fallback's in-flight `play`. Held so {@link stop} can settle it: pausing an
   *  element fires no event, and an unsettled promise here froze the whole queue. */
  private pendingPlay: (() => void) | null = null;

  // ── Focus ────────────────────────────────────────────────────────────────────────────
  /**
   * The hold in flight or held for THIS turn, or null between turns.
   *
   * One promise per turn, started at the first `enqueue` rather than at the first `play`, is
   * what makes the pause free: the first chunk spends ~1.3 s being generated, and the ~120 ms
   * `osascript` round trip disappears inside it.
   */
  private focusHold: Promise<FocusGrant> | null = null;
  /** Cleared on release; set while a drained queue is waiting out {@link FOCUS_GRACE_MS}. */
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once this turn has been refused the speaker — checked before every chunk so the
   *  refusal is decided once and not re-asked per sentence. */
  private muted = false;
  /** Whether THIS queue has told the composer an answer went unread, so it can take it back
   *  when it speaks again. */
  private noticeUp = false;

  // ── What is being spoken right now ───────────────────────────────────────────────────
  /**
   * Who wants to know whether this turn is speaking.
   *
   * ── IT FOLLOWS THE FOCUS HOLD, NOT PLAYBACK, AND THAT IS THE WHOLE DESIGN ─────────────
   * The obvious signal — true while audio is playing — is WRONG here. A reply is still being
   * WRITTEN while it is being read, so the queue empties repeatedly MID-ANSWER: between the
   * sentence that just closed and the next one the model has not finished. A play-time flag
   * would flicker off in every one of those gaps and take a Stop button with it. The focus
   * hold already answers exactly the question being asked — "is this turn holding the
   * speaker?" — including the gaps, and it already carries {@link FOCUS_GRACE_MS} of
   * hysteresis that was reasoned out for the music duck.
   */
  private readonly speakingSubs = new Set<(speaking: boolean) => void>();
  private speaking = false;
  /** Scheduled chunks with the window of audio time each one occupies. */
  private marks: Mark[] = [];
  private markTimer: ReturnType<typeof setInterval> | null = null;
  private readonly chunkSubs = new Set<(chunk: SpokenChunk | null) => void>();
  private spoken: SpokenChunk | null = null;
  /** Tagged onto every chunk the current `push` produces — see {@link push}. */
  private pushItemId: string | undefined;

  /**
   * @param sessionId  Identifies this pane to the server's focus ledger. Two J.A.R.V.I.S panes
   *   are two queues and two ids, and the ledger grants the speaker to exactly one of them.
   */
  constructor(
    private readonly sessionId: string,
    private readonly fetcher: SpeakFetcher = createSpeakFetcher(),
    private readonly focus: FocusClient = createFocusClient(),
  ) {}

  /** Subscribe to "is this turn speaking". Fires IMMEDIATELY with the current value, so a
   *  composer that mounts mid-answer is not left believing the room is quiet. */
  onSpeaking(fn: (speaking: boolean) => void): () => void {
    this.speakingSubs.add(fn);
    fn(this.speaking);
    return () => { this.speakingSubs.delete(fn); };
  }

  /**
   * Subscribe to WHICH chunk is being spoken — the transcript's marker.
   *
   * Fires with the chunk when its audio starts sounding and with `null` when nothing is being
   * spoken. Read from the audio clock rather than from a timer started at `play()`, so the
   * marker cannot drift away from the voice over a long answer.
   */
  onChunk(fn: (chunk: SpokenChunk | null) => void): () => void {
    this.chunkSubs.add(fn);
    fn(this.spoken);
    return () => { this.chunkSubs.delete(fn); };
  }

  /** Edge-triggered: subscribers hear transitions, never a repeat of what they already know. */
  private setSpeaking(next: boolean): void {
    if (this.speaking === next) return;
    this.speaking = next;
    for (const fn of this.speakingSubs) fn(next);
  }

  private setSpoken(next: SpokenChunk | null): void {
    if (this.spoken === next) return;
    if (this.spoken && next && this.spoken.text === next.text && this.spoken.itemId === next.itemId) return;
    this.spoken = next;
    for (const fn of this.chunkSubs) fn(next);
  }

  /**
   * Satisfy WebKit's user-activation rules, for BOTH paths.
   *
   * Autoplay is only permitted from inside a handler for a real gesture, and an AudioContext
   * created outside one comes back `suspended` — the same trap `useVoiceCapture.ts`
   * documents. By the time the agent's first sentence arrives we are several async hops from
   * a gesture, so the mic-press handler calls this SYNCHRONOUSLY.
   */
  unlock(): void {
    this.openContext();
    void this.ctx?.resume().catch(() => { /* `ensureContext` tries again at play time */ });
    const el = this.element();
    el.muted = true;
    void el.play().then(() => { el.pause(); el.muted = false; }).catch(() => { el.muted = false; });
  }

  /**
   * Feed streamed reply text. Chunks are enqueued as they close.
   *
   * The "speak answers" preference is read HERE, per push, rather than at construction: the
   * owner switching speech off mid-answer means the next sentence is silent, not the next
   * session. The chunker is still fed, so switching back mid-turn resumes cleanly instead of
   * replaying the paragraph it missed.
   *
   * `itemId` is the transcript item these words belong to, carried so the on-screen marker
   * knows WHERE to mark. A chunk that straddles two items is tagged with the later one — the
   * chunker holds no item boundary and inventing one would be a lie about where the sentence
   * came from; the marker simply fails to find it and stays where it was.
   */
  push(text: string, itemId?: string): void {
    if (this.stopped) return;
    const speak = voicePrefs().speech;
    this.pushItemId = itemId;
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
    // IMMEDIATELY, not after the grace window. This is the barge-in path: the owner pressed
    // the mic (or Stop, or steered) and is about to speak, so the music has to be back now —
    // a release that waited 800 ms would put the music under the start of their sentence.
    this.releaseFocus();
    for (const job of this.jobs) job.controller.abort();
    this.jobs = [];
    this.chunker.reset();
    this.silenceSources();
    this.clearMarks();
    if (this.audio) {
      this.audio.pause();
      if (this.audio.src) URL.revokeObjectURL(this.audio.src);
      this.audio.removeAttribute('src');
    }
    // THE DEADLOCK, CLOSED. Pausing an element and removing its `src` fires neither `ended`
    // nor `error`, so the fallback's play promise would never settle: `running` stayed true,
    // and the next turn's `run()` returned at its own guard without playing a thing. Found by
    // reading the barge-in path while moving playback to Web Audio.
    const done = this.pendingPlay;
    this.pendingPlay = null;
    done?.();
  }

  /** Ready for the next turn after a {@link stop}. */
  resume(): void {
    this.stopped = false;
  }

  /** Everything gone, for good — the session is being disposed. */
  dispose(): void {
    this.stop();
    this.audio = null;
    void this.ctx?.close().catch(() => { /* already closing */ });
    this.ctx = null;
    this.gainNode = null;
    this.fallback = true;
    // `stop()` already dropped the signals; this drops the listeners, so a disposed pane
    // cannot keep a composer subscribed to a queue that will never speak.
    this.speakingSubs.clear();
    this.chunkSubs.clear();
  }

  private enqueue(text: string): void {
    // A chunk arriving during the grace window means the turn is not over after all: keep the
    // speaker (and keep the music paused) rather than releasing and immediately re-taking it.
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    // Started HERE, before the fetch below, so the ~120 ms pause lands inside the chunk's
    // ~1.3 s generation instead of in front of the first word.
    // `this.muted` is part of the condition, not just `focusHold`: a REFUSED turn leaves a
    // settled `granted: false` promise sitting here until the 800 ms grace clears it, so a new
    // turn that began inside that window would read the old pane's refusal as its own — and
    // stay silent without ever asking the server, which by then may well have said yes.
    if (!this.focusHold || this.muted) {
      this.muted = false;
      this.focusHold = this.takeFocus();
    }
    // Rises with the HOLD, not with playback — see `speakingSubs`. A chunk has been accepted,
    // so this turn is going to be heard.
    this.setSpeaking(true);
    this.jobs.push({ text, itemId: this.pushItemId, controller: new AbortController() });
    // Start the look-ahead HERE, not only inside the play loop. A chunk enqueued while an
    // earlier one is already playing arrives after the loop has passed its own prefetch
    // point, so without this the fetch for chunk N+1 would not begin until chunk N finished.
    this.prefetch();
    void this.run();
  }

  /** Ask for the speaker, and never let that ask cost the answer. */
  private takeFocus(): Promise<FocusGrant> {
    return this.focus.hold(this.sessionId).catch(() => OPEN_GRANT);
  }

  /**
   * Hand the speaker back once the SCHEDULED audio has finished, plus the grace window.
   *
   * The two clocks came apart when playback moved to Web Audio: an empty job list now means
   * "every chunk is queued", not "every chunk has been heard", because chunk N+1 is scheduled
   * while chunk N is still sounding. Releasing on the empty list alone would resume the
   * owner's music — and drop the Stop button — several seconds before the voice actually
   * stopped. So the wait starts at {@link tail}, the audio time the last chunk ends.
   */
  private scheduleRelease(): void {
    if (!this.focusHold || this.releaseTimer) return;
    const remainingMs = this.ctx
      ? Math.max(0, this.tail - this.ctx.currentTime) * 1000
      : 0;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.releaseFocus();
    }, remainingMs + FOCUS_GRACE_MS);
  }

  /** Hand it back NOW — barge-in, disposal, or the grace window expiring. */
  private releaseFocus(): void {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    if (!this.focusHold) return;
    // ONE place for the fall, and it is why the signal hangs on the hold: every path that
    // ends a turn's audio — barge-in, interrupt, steer, disposal, and the grace window simply
    // expiring — already arrives here.
    this.setSpeaking(false);
    this.focusHold = null;
    this.muted = false;
    void this.setGain(1);
    this.focus.release(this.sessionId);
  }

  /**
   * Open the playback AudioContext. Called from {@link unlock}, i.e. inside a real gesture.
   *
   * It is opened there rather than at first use because a context created outside a gesture
   * comes back `suspended` on WebKit — the same trap `useVoiceCapture.ts` documents, where a
   * context built after an `await` returned an analyser full of zeroes.
   */
  private openContext(): void {
    if (this.ctx || this.fallback) return;
    try {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) { this.fallback = true; return; }
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
      this.fallback = true;
    }
  }

  /**
   * Make sure a context exists, is RUNNING, and has its output chain built.
   *
   * Called from the play loop, not only from {@link unlock}, for a reason review caught: the
   * context used to be opened ONLY by the mic-press handler, and J.A.R.V.I.S reads every
   * answer aloud whether the question was spoken or TYPED. A user who never touches the mic
   * therefore had no context at all. Creating it here is safe because a webview that is
   * playing audio has long since had a user gesture, and `resume()` covers the case where it
   * nevertheless came back suspended.
   */
  private async ensureContext(): Promise<AudioContext | null> {
    if (this.fallback) return null;
    this.openContext();
    const ctx = this.ctx;
    if (!ctx) return null;
    if (ctx.state === 'closed') { this.fallback = true; return null; }
    if (ctx.state !== 'running') {
      // `suspended` is the power-saving one; `interrupted` is WebKit's, and it is the
      // realistic case on a laptop — a phone call, or another app taking the audio session.
      try { await ctx.resume(); } catch { /* the verdict below decides */ }
      const after: string = ctx.state;
      if (after !== 'running') return null;
    }
    if (!this.gainNode) {
      try {
        const gain = ctx.createGain();
        // A LIMITER, not decoration. A speech chunk already near full scale multiplied by 2-3
        // clips, and clipping on a voice is more objectionable than music under it. The
        // threshold sits just below 0 dBFS so it only engages on the peaks the gain creates.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -2;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.1;
        gain.connect(limiter);
        limiter.connect(ctx.destination);
        this.gainNode = gain;
      } catch {
        this.fallback = true;
        return null;
      }
    }
    return ctx;
  }

  /**
   * Give our own voice back what a system-volume duck took from it.
   *
   * Ducking is OFF by default now (`src/lib/voice/config.ts` holds the argument: the master
   * volume is the one our own voice leaves through, so a deep duck makes the ANSWER quieter),
   * and this is what serves the owner who switches it on anyway. A gain of 1 costs nothing:
   * on the Web Audio path the graph is the playback path either way.
   *
   * The ELEMENT FALLBACK gets no compensation — it plays on the plain path, as it always did.
   * That is a real loss and a small one: it is reached only by an engine that will not decode
   * or will not keep a context running, and only matters at all to someone who turned the
   * duck on by hand.
   */
  private async setGain(gain: number): Promise<void> {
    if (!this.gainNode && gain <= 1) return;
    const ctx = await this.ensureContext();
    if (!ctx || !this.gainNode) return;
    // Ramped rather than stepped: a jump in gain between two sentences is a click.
    const target = Math.max(1, gain);
    try {
      this.gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.01);
    } catch {
      this.gainNode.gain.value = target;
    }
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
        // ── The speaker floor, consulted per chunk and decided once ───────────────────────
        // Per chunk because this is also the heartbeat that keeps the server's watchdog off a
        // live turn; decided once because a refusal is a property of the turn, not of the
        // sentence — re-asking per chunk would announce it repeatedly and could let half an
        // answer through if another pane finished mid-way.
        const grant = this.focusHold ? await this.focusHold : OPEN_GRANT;
        if (this.stopped || gen !== this.generation) return;
        if (!grant.granted) {
          // NOT SPEAKING, and say so at once. The signal rises in `enqueue`, before the
          // server has ruled on who owns the speaker — which is right, because it has to be
          // up before the first chunk plays. When the ruling comes back a refusal, this turn
          // will never be heard, so the composer must stop offering to silence it. Left to
          // `releaseFocus`, the fall waits out the 800 ms grace and the refused pane shows a
          // violet rail and a Hush button for most of a second, over silence.
          this.setSpeaking(false);
          if (!this.muted) {
            this.muted = true;
            // Say it. An answer that is simply not read, in the mode whose whole proposition
            // is that answers are read, is a silence the owner cannot account for.
            this.noticeUp = true;
            announceSpeechMuted(this.sessionId);
          }
          // Drop the rest of the turn's audio rather than queueing it: by the time the other
          // pane finishes, this answer has been on screen for a paragraph and reading it then
          // is not a late delivery, it is a second conversation over the first.
          for (const job of this.jobs) job.controller.abort();
          this.jobs = [];
          return;
        }
        await this.setGain(grant.gain);
        if (this.stopped || gen !== this.generation) return;
        // Speaking again, so take the notice down. Left up, it sat on screen claiming an
        // answer had not been read aloud WHILE the next one was being read aloud.
        if (this.noticeUp) {
          this.noticeUp = false;
          announceSpeechMuted(this.sessionId, false);
        }
        // The heartbeat: replace the settled promise so the NEXT chunk refreshes the lease
        // rather than re-reading a 120-second-old answer.
        this.focusHold = this.takeFocus();
        await this.speak(blob, job);
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
      // makes "barge in, then immediately say something else" work.
      if (!this.stopped && this.jobs.length > 0) void this.run();
      // Drained and nothing restarted the loop: start the grace clock, measured from the end
      // of the audio rather than from now. `enqueue` cancels it if the reply is merely
      // mid-sentence rather than finished.
      else if (!this.stopped) this.scheduleRelease();
    }
  }

  /**
   * Put one chunk on the speaker.
   *
   * Returns as soon as the chunk is SCHEDULED, not when it has finished sounding — which is
   * the point. The loop moves straight on to the next chunk and schedules it butted against
   * this one, so the seam between two sentences is a sample boundary rather than a race
   * between an `ended` event and a media load. Only the fallback path waits.
   */
  private async speak(blob: Blob, job: Job): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx && this.gainNode) {
      try {
        const bytes = await blob.arrayBuffer();
        if (this.stopped) return;
        const buffer = await ctx.decodeAudioData(bytes);
        if (this.stopped) return;
        // The return value is NOT decoration. `schedule` can fail on its own — a Web Audio
        // call that throws — and an earlier version returned unconditionally here, which
        // dropped that one chunk in silence while contradicting this file's whole premise
        // that a degraded path beats a missing sentence. Every later chunk was correctly
        // routed to the element (`fallback` is set inside), so the hole was exactly one
        // sentence wide and invisible. Found in review.
        if (this.schedule(ctx, buffer, job)) return;
      } catch (err) {
        // A webview that cannot decode our WAV is not a webview that should be silent.
        console.warn('[voice] decode failed — falling back to element playback', err);
        this.fallback = true;
      }
    }
    // ── THE SEAM BETWEEN THE TWO PATHS ────────────────────────────────────────────────
    // The element plays IMMEDIATELY; a scheduled buffer is still sounding for as long as
    // `tail` says. A turn that decoded chunk N and then failed on chunk N+1 — which is
    // exactly the shape of "the decoder gave up part-way" — would otherwise start the
    // fallback on top of the tail of the one before it: two voices, from one queue.
    await this.waitForTail();
    if (this.stopped) return;
    await this.playElement(blob, job);
  }

  /** Resolve when the last SCHEDULED chunk has finished sounding. Immediate when nothing is
   *  scheduled, which is the ordinary case on a machine that never used Web Audio at all. */
  private waitForTail(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve();
    const remainingMs = Math.max(0, this.tail - ctx.currentTime) * 1000;
    if (remainingMs <= 0) return Promise.resolve();
    return new Promise((resolve) => { setTimeout(resolve, remainingMs); });
  }

  /** Start `buffer` at the exact sample the previous chunk ends on. `false` means it could
   *  not be scheduled at all and the caller must speak this chunk some other way. */
  private schedule(ctx: AudioContext, buffer: AudioBuffer, job: Job): boolean {
    const rate = voicePrefs().speechRate;
    let src: AudioBufferSourceNode;
    try {
      src = ctx.createBufferSource();
      src.buffer = buffer;
      // The rate is read PER CHUNK from the live preference, so a speed changed between two
      // sentences takes effect on the next one. Client-side rather than a `speed` sent
      // upstream: a rate we own cannot be a request that fails, and it costs nothing.
      src.playbackRate.value = rate;
      src.connect(this.gainNode!);
    } catch {
      this.fallback = true;
      return false;
    }
    const now = ctx.currentTime;
    // The seam. `tail` is where the previous chunk ends; a chunk that arrives after a gap in
    // generation starts a lead-time from now instead, because a start time in the PAST plays
    // immediately and clipped.
    const start = Math.max(now + SCHEDULE_LEAD, this.tail);
    const duration = buffer.duration / rate;
    try {
      src.start(start);
    } catch {
      this.fallback = true;
      try { src.disconnect(); } catch { /* never connected */ }
      return false;
    }
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      try { src.disconnect(); } catch { /* already torn down */ }
    };
    this.tail = start + duration;
    this.marks.push({ text: job.text, itemId: job.itemId, start, end: this.tail });
    this.startMarkTicker();
    return true;
  }

  /** Stop and drop every scheduled source. */
  private silenceSources(): void {
    for (const src of this.sources) {
      src.onended = null;
      try { src.stop(); } catch { /* never started, or already stopped */ }
      try { src.disconnect(); } catch { /* already torn down */ }
    }
    this.sources.clear();
    this.tail = 0;
  }

  /**
   * Follow the audio clock and say which chunk is sounding.
   *
   * Read from `ctx.currentTime` rather than from a timer started when each chunk began: the
   * two agree for one sentence and drift apart over a paragraph, and a marker that lags the
   * voice is worse than no marker — it points at the wrong sentence with total confidence.
   */
  private startMarkTicker(): void {
    if (this.markTimer) return;
    this.markTimer = setInterval(() => {
      const ctx = this.ctx;
      if (!ctx) { this.clearMarks(); return; }
      const now = ctx.currentTime;
      // Anything that finished before now is gone; the marks are in schedule order.
      while (this.marks.length > 0 && this.marks[0].end <= now) this.marks.shift();
      if (this.marks.length === 0) {
        this.setSpoken(null);
        this.stopMarkTicker();
        return;
      }
      const current = this.marks[0];
      // Between chunks (the lead before the first one) nothing is being spoken yet, and the
      // marker stays where it was rather than flickering off for 60 ms.
      if (current.start <= now) this.setSpoken({ text: current.text, itemId: current.itemId });
    }, MARK_TICK_MS);
  }

  private stopMarkTicker(): void {
    if (!this.markTimer) return;
    clearInterval(this.markTimer);
    this.markTimer = null;
  }

  private clearMarks(): void {
    this.marks = [];
    this.stopMarkTicker();
    this.setSpoken(null);
  }

  /**
   * The playback element, built on demand. FALLBACK ONLY — see the class note.
   */
  private element(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
    }
    return this.audio;
  }

  /**
   * The degraded path: one element, one chunk at a time.
   *
   * Kept because a webview that will not give us a running context or will not decode a WAV
   * must still SPEAK. It has the stop-start seam this class was rewritten to remove, and it
   * marks the chunk from the element's own events rather than from the audio clock — both are
   * losses, and both are smaller than silence.
   */
  private playElement(blob: Blob, job: Job): Promise<void> {
    return new Promise((resolve) => {
      const el = this.element();
      const url = URL.createObjectURL(blob);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        el.removeEventListener('ended', done);
        el.removeEventListener('error', done);
        URL.revokeObjectURL(url);
        if (this.pendingPlay === done) this.pendingPlay = null;
        this.setSpoken(null);
        resolve();
      };
      // Held so `stop()` can settle this promise: pausing an element and clearing its `src`
      // fires neither `ended` nor `error`.
      this.pendingPlay = done;
      el.addEventListener('ended', done);
      el.addEventListener('error', done);
      // WHY `defaultPlaybackRate` AND NOT JUST `playbackRate`: assigning `src` runs the media
      // element load algorithm, whose last step is "set the playbackRate attribute to the
      // value of the defaultPlaybackRate attribute" — unconditionally, on every load. So a
      // rate written to `playbackRate` and THEN followed by `el.src = url` was reset to 1 by
      // the very next line.
      const rate = voicePrefs().speechRate;
      el.defaultPlaybackRate = rate;
      el.src = url;
      el.playbackRate = rate;
      this.setSpoken({ text: job.text, itemId: job.itemId });
      void el.play().catch(() => done());
    });
  }
}
