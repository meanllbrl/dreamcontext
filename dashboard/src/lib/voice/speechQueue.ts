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
 */
export const FOCUS_GRACE_MS = 800;

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

  /**
   * The hold in flight or held for THIS turn, or null between turns.
   *
   * One promise per turn, started at the first `enqueue` rather than at the first `play`, is
   * what makes the pause free: the first chunk spends ~1.3 s being generated, and the ~120 ms
   * `osascript` round trip disappears inside it. Asking at play time would put it in front of
   * the first word instead.
   */
  private focusHold: Promise<FocusGrant> | null = null;
  /** Cleared on release; set while a drained queue is waiting out {@link FOCUS_GRACE_MS}. */
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once this turn has been refused the speaker — checked before every chunk so the
   *  refusal is decided once and not re-asked per sentence. */
  private muted = false;
  /** The WebAudio compensation chain, built ONLY if a duck actually happens. */
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private routed = false;
  /** Set once a context could not be revived. Nothing is ever routed again after that: the
   *  boost is worth having, and it is not worth risking a second silent element for. */
  private contextDead = false;
  /** Whether THIS queue has told the composer an answer went unread, so it can take it back
   *  when it speaks again. */
  private noticeUp = false;

  /**
   * @param sessionId  Identifies this pane to the server's focus ledger. Two J.A.R.V.I.S panes
   *   are two queues and two ids, and the ledger grants the speaker to exactly one of them.
   */
  /**
   * Who wants to know whether this turn is speaking.
   *
   * WHY THE QUEUE HAS TO SAY THIS. Speaking was the one state of the mode with no
   * representation on screen: barge-in existed — the mic press silences the queue — but
   * nothing said there was anything to barge INTO, so the only way to discover the gesture
   * was to press a microphone in the middle of an answer and find out.
   *
   * ── IT FOLLOWS THE FOCUS HOLD, NOT PLAYBACK, AND THAT IS THE WHOLE DESIGN ─────────────
   * The obvious signal — true while an audio element is playing — is WRONG here, and wrong
   * in a way that shows. A reply is still being WRITTEN while it is being read, so the queue
   * empties repeatedly MID-ANSWER: between the sentence that just closed and the next one
   * the model has not finished. A play-time flag would flicker off in every one of those
   * gaps and take a Stop button with it. The focus hold already answers exactly the question
   * being asked — "is this turn holding the speaker?" — including the gaps, and it already
   * carries {@link FOCUS_GRACE_MS} of hysteresis that was reasoned out for the music duck.
   * Two windows meaning the same thing would be two things to keep in sync, and one would
   * drift.
   */
  private readonly speakingSubs = new Set<(speaking: boolean) => void>();
  private speaking = false;

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

  /** Edge-triggered: subscribers hear transitions, never a repeat of what they already know. */
  private setSpeaking(next: boolean): void {
    if (this.speaking === next) return;
    this.speaking = next;
    for (const fn of this.speakingSubs) fn(next);
  }

  /**
   * Satisfy WebKit's user-activation rule.
   *
   * Autoplay is only permitted from inside a handler for a real gesture, and by the time the
   * agent's first sentence arrives we are several async hops away from one. So the mic-press
   * handler calls this SYNCHRONOUSLY: a silent play on a reused element banks the activation,
   * and every later chunk plays on the same element. Without it the first chunk of the first
   * answer is silently blocked and the mode looks broken exactly once per launch.
   */
  /**
   * The playback element, built on demand.
   *
   * Centralised because the routing fix needs it EARLIER than playback does: the gain has to
   * be wired to the element, and `setGain` used to run before anything had created one. On a
   * turn where nobody pressed the mic, `this.audio` was still null at that moment and the
   * whole compensation was skipped for the first chunk — silently, since the element then
   * appeared a line later inside `play`.
   */
  private element(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
    }
    return this.audio;
  }

  unlock(): void {
    this.element();
    // The compensation graph's context is OPENED HERE for the same reason the element's
    // activation is banked here — see `useVoiceCapture.ts`, where a context created after an
    // `await` came back `suspended` and its analyser returned zeroes. It is opened but NOT
    // connected: routing the element through WebAudio is only done if a duck actually
    // happens, so a turn that ducks nothing never touches the path that plays the audio.
    this.openContext();
    const el = this.element();
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
    // IMMEDIATELY, not after the grace window. This is the barge-in path: the owner pressed
    // the mic (or Stop, or steered) and is about to speak, so the music has to be back now —
    // a release that waited 800 ms would put the music under the start of their sentence.
    this.releaseFocus();
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
    // The context, if one was opened. Closing it is what stops a disposed pane from holding a
    // hardware audio stream open for the life of the app.
    void this.ctx?.close().catch(() => { /* already closing */ });
    this.ctx = null;
    this.gainNode = null;
    this.routed = false;
    this.contextDead = true;
    // `stop()` already dropped the signal through `releaseFocus`; this drops the listeners,
    // so a disposed pane cannot keep a composer subscribed to a queue that will never speak.
    this.speakingSubs.clear();
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
  /** Ask for the speaker, and never let that ask cost the answer. */
  private takeFocus(): Promise<FocusGrant> {
    return this.focus.hold(this.sessionId).catch(() => OPEN_GRANT);
  }

  /**
   * Hand the speaker back after {@link FOCUS_GRACE_MS} of an empty queue.
   *
   * Scheduled rather than immediate because a drained queue mid-answer is the NORMAL state —
   * see the constant's own note. `enqueue` cancels this, so a turn that is still writing keeps
   * what it holds.
   */
  private scheduleRelease(): void {
    if (!this.focusHold || this.releaseTimer) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.releaseFocus();
    }, FOCUS_GRACE_MS);
  }

  /** Hand it back NOW — barge-in, disposal, or the grace window expiring. */
  private releaseFocus(): void {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    if (!this.focusHold) return;
    // ONE place for the fall, and it is why the signal hangs on the hold: every path that
    // ends a turn's audio — barge-in, interrupt, steer, disposal, and the grace window simply
    // expiring — already arrives here. A second flag would have needed all five wired again.
    this.setSpeaking(false);
    this.focusHold = null;
    this.muted = false;
    this.setGain(1);
    this.focus.release(this.sessionId);
  }

  /**
   * Open the playback AudioContext. Called from {@link unlock}, i.e. inside a real gesture.
   *
   * OPENED, NOT CONNECTED — and the distinction is the whole safety argument. An idle context
   * costs nothing and changes nothing about how the element plays; {@link setGain} is what
   * actually re-routes the element through WebAudio, and it only does so when a duck really
   * happened. So a machine whose duck depth is `1` (or whose answer paused Spotify instead)
   * plays its audio down exactly the path it did before this feature existed.
   *
   * It is opened here rather than at first use because a context created outside a gesture
   * comes back `suspended` on WebKit — the same trap `useVoiceCapture.ts` documents, where a
   * context built after an `await` returned an analyser full of zeroes.
   */
  private openContext(): void {
    if (this.ctx || this.contextDead) return;
    try {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
    }
  }

  /**
   * Make sure a context exists and is RUNNING, before anything is routed through it.
   *
   * Called from the play loop, not only from {@link unlock}, for a reason review caught: the
   * context used to be opened ONLY by the mic-press handler, and J.A.R.V.I.S reads every
   * answer aloud whether the question was spoken or TYPED. A user who never touches the mic
   * therefore had no context at all, the compensation was skipped on every duck, and the
   * system volume came down on the agent's own voice with nothing giving it back — leaving
   * the answer QUIETER than it would have been without the feature at all. Creating it here
   * is safe because a webview that is playing audio has long since had a user gesture, and
   * `resume()` covers the case where it nevertheless came back suspended.
   */
  private async ensureContext(): Promise<boolean> {
    if (this.contextDead) return false;
    this.openContext();
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state === 'running') return true;
    if (ctx.state === 'closed') { this.contextDead = true; return false; }
    // `suspended` is the power-saving one; `interrupted` is WebKit's, and it is the realistic
    // case on a laptop — a phone call, or another app taking the audio session. Both are
    // answered the same way, and both are why this check cannot live only at wiring time.
    try { await ctx.resume(); } catch { /* fall through to the verdict below */ }
    // Widened deliberately: the compiler narrowed `state` from the two checks above and has
    // no way to know `resume()` can change it, so a direct comparison reads as unreachable.
    const after: string = ctx.state;
    return after === 'running';
  }

  /**
   * KEEP THE ELEMENT AUDIBLE, whatever has happened to the context since it was wired.
   *
   * `createMediaElementSource` is irreversible: once the element is routed, its audio reaches
   * the speakers ONLY through the graph. A context that suspends LATER — which browsers do to
   * save power on a context that has gone quiet, and this queue is quiet through every
   * "thinking" gap between chunks — therefore turns every later chunk into silence that still
   * fires `ended` and still looks entirely normal on screen. The original guard checked the
   * context only at WIRING time, which is the one moment it was certain to be fine.
   *
   * So: revive it if we can, and if we cannot, ABANDON the routed element and play on a fresh
   * one. The abandoned element keeps the dead graph; the new one is on the plain path, exactly
   * where this audio was before any of this existed. Losing the boost is a cost. Losing the
   * voice, silently, is the thing this whole module exists to not do.
   */
  private async ensureAudible(): Promise<void> {
    if (!this.routed) return;
    if (await this.ensureContext()) return;
    this.audio = null;
    this.element();
    this.gainNode = null;
    this.routed = false;
    this.contextDead = true;
    console.warn('[voice] audio context could not be resumed — falling back to plain playback');
  }

  /**
   * Give our own voice back what the system-volume duck took from it.
   *
   * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────────────────
   * macOS gives a non-sandboxed app exactly one lever over audio it does not own: the SYSTEM
   * output volume. That lever is indiscriminate — it lowers this element too — so ducking
   * without compensating makes the answer exactly as quiet as the music it was meant to rise
   * above. The compensation is what turns a pointless gesture into the feature.
   *
   * ── AND WHY IT FAILS OPEN, LOUDLY ───────────────────────────────────────────────────────
   * `createMediaElementSource` RE-ROUTES the element: from then on its audio reaches the
   * speakers only through this graph, so a context that is suspended means SILENCE, not
   * merely an un-boosted voice. That is a far worse failure than the one being fixed. So the
   * element is routed only while the context is genuinely `running`, and anything unexpected
   * leaves the audio on the plain path at gain 1.
   */
  private async setGain(gain: number): Promise<void> {
    if (gain <= 1 && !this.routed) return;
    const el = this.element();
    if (!this.routed) {
      if (!(await this.ensureContext())) return;     // fail open: plain path, no boost
      const ctx = this.ctx!;
      try {
        const src = ctx.createMediaElementSource(el);
        const node = ctx.createGain();
        // A LIMITER, not decoration. A speech chunk already near full scale multiplied by 2-3
        // clips, and clipping on a voice is more objectionable than music under it. The
        // threshold sits just below 0 dBFS so it only engages on the peaks the gain creates.
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -2;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.1;
        src.connect(node);
        node.connect(limiter);
        limiter.connect(ctx.destination);
        this.gainNode = node;
        this.routed = true;
      } catch {
        this.gainNode = null;
        this.routed = false;
        return;
      }
    }
    if (this.gainNode) this.gainNode.gain.value = Math.max(1, gain);
  }

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
        // BEFORE the gain and before the element is read: this may swap the element out.
        await this.ensureAudible();
        if (this.stopped || gen !== this.generation) return;
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
      // Drained and nothing restarted the loop: start the grace clock. `enqueue` cancels it
      // if the reply is merely mid-sentence rather than finished.
      else if (!this.stopped) this.scheduleRelease();
    }
  }

  private play(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      const el = this.element();
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
      //
      // WHY `defaultPlaybackRate` AND NOT JUST `playbackRate`, and why the order below is
      // the whole fix: assigning `src` runs the media element load algorithm, whose last
      // step is "set the playbackRate attribute to the value of the defaultPlaybackRate
      // attribute" — unconditionally, on every load. So a rate written to `playbackRate`
      // and THEN followed by `el.src = url` (which is what this did) was reset to 1 by the
      // very next line, and every chunk played at normal speed however the Settings row
      // read. The setting was stored, sent and reported correctly the whole time; it was
      // erased one line before it could take effect. `defaultPlaybackRate` is the one the
      // load algorithm preserves, and the direct write after the src covers the element
      // that is already loaded.
      const rate = voicePrefs().speechRate;
      el.defaultPlaybackRate = rate;
      el.src = url;
      el.playbackRate = rate;
      void el.play().catch(() => done());
    });
  }
}
