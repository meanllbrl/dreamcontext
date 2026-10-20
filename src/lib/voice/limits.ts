/**
 * Server-side caps for the two money-spending voice routes.
 *
 * WHY THESE ARE HERE AND NOT IN `speechQueue.ts`. Every other limit in this feature is a
 * client-side nicety — the silence gate, the busy lock, the chunk size. These two are not.
 * The dashboard's global guards (`isCrossSiteWrite`, the network token) are process-level
 * booleans, and neither stops an ALREADY-AUTHENTICATED peer on the LAN. The existing threat
 * model was written for read/write FILE operations, which cost nothing; these routes bill a
 * real card. A cap that lives only in the client is not a cap, it is a suggestion, and AC12
 * is the criterion that says so: a direct POST past the cap must be rejected.
 *
 * Two independent limits, because they stop different things:
 *   • CONCURRENCY bounds the damage a burst can do right now (and bounds our own memory,
 *     since each in-flight STT request is holding an audio buffer).
 *   • The RATE WINDOW bounds what a slow, patient loop can spend over an hour.
 */

/** How many requests of one kind may be in flight at once before we start refusing. */
export interface GateLimits {
  concurrency: number;
  perWindow: number;
  windowMs: number;
}

/** STT holds an audio buffer per request, so its concurrency is the tighter of the two. */
export const STT_LIMITS: GateLimits = { concurrency: 2, perWindow: 60, windowMs: 60_000 };

/** TTS runs one chunk at a time per reply, but a reply is many chunks — hence the wider
 *  window. Three concurrent leaves room for the queue's prefetch (chunk N+1 while N plays). */
export const TTS_LIMITS: GateLimits = { concurrency: 3, perWindow: 240, windowMs: 60_000 };

/** Per-call character cap for speech. A chunk is a sentence; anything near this is a bug or
 *  an abuse, and either way we would rather not pay for it. */
export const MAX_TTS_CHARS = 2000;

/**
 * OpenAI's own ceiling, and therefore ours: 25 MB. The route enforces it PER CHUNK while
 * streaming — `agent-drop.ts`'s pattern — so a hostile upload is refused mid-flight instead
 * of being buffered to completion and then measured, which would OOM the Node process.
 */
export const MAX_STT_BYTES = 25 * 1024 * 1024;

export type GateVerdict = 'ok' | 'busy' | 'rate';

/**
 * A tiny two-dimensional gate. Not a general-purpose rate limiter and deliberately not
 * pluggable: the two call sites are in this repo, both are local, and the whole point is
 * that the enforcement is impossible to configure away from the client side.
 */
export class VoiceGate {
  private inFlight = 0;
  private stamps: number[] = [];

  constructor(private readonly limits: GateLimits) {}

  /** Try to take a slot. On `'ok'` the caller MUST call {@link release} in a finally. */
  acquire(now: number = Date.now()): GateVerdict {
    this.stamps = this.stamps.filter((t) => now - t < this.limits.windowMs);
    if (this.inFlight >= this.limits.concurrency) return 'busy';
    if (this.stamps.length >= this.limits.perWindow) return 'rate';
    this.inFlight += 1;
    this.stamps.push(now);
    return 'ok';
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /** Test/diagnostic view. Never rendered to a client. */
  get state(): { inFlight: number; window: number } {
    return { inFlight: this.inFlight, window: this.stamps.length };
  }

  reset(): void {
    this.inFlight = 0;
    this.stamps = [];
  }
}

/**
 * The focus route spends no money — and takes a gate anyway, because "costs nothing" was the
 * wrong axis. It SPAWNS PROCESSES (`osascript`, up to four per hold) and it MUTATES THE
 * OWNER'S MACHINE: pausing their music player, moving their system volume. The threat model
 * this file's header describes — an already-authenticated peer on the LAN, unstopped by the
 * process-level guards — reaches this route exactly as easily as it reaches the paid ones,
 * and a `release`/`hold` loop is a process-spawn and audio-state churn with no ceiling.
 *
 * Wide on purpose: the client heart-beats one hold per spoken chunk, and a long answer across
 * two panes is legitimately hundreds of calls a minute. This is a ceiling on abuse, not a
 * budget — the ceiling on how long the machine may stay silenced is `MAX_SILENCE_MS` in
 * `audioFocus.ts`, because a patient caller stays under any rate limit by definition.
 */
export const FOCUS_LIMITS: GateLimits = { concurrency: 4, perWindow: 600, windowMs: 60_000 };

export const sttGate = new VoiceGate(STT_LIMITS);
export const ttsGate = new VoiceGate(TTS_LIMITS);
export const focusGate = new VoiceGate(FOCUS_LIMITS);

/**
 * THE HANDS-FREE PHONE'S DICTATION, through the tunnel (task the-hands-free-phone-sends-a-voice-
 * message…). `POST /api/agent/voice/stt` is the ONE voice route the phone listener opens, and the
 * request arrives over a public tunnel, so it gets caps of its own ON TOP of the shared gate:
 *   • a body of at most {@link PHONE_MAX_STT_BYTES} (two minutes of 16 kHz mono 16-bit PCM is
 *     ~3.8 MB) instead of the laptop's 25 MB;
 *   • a WAV whose header says at most {@link PHONE_MAX_STT_SECONDS} — read from the bytes, an
 *     unreadable header is refused rather than guessed;
 *   • one take in flight and a dozen a minute: a spoken message, not a transcription service.
 * The take is the owner's own voice on the owner's own Mac; nothing is billed (dictation is local
 * only), but each take runs a whisper inference on this machine, which is the cost capped here.
 */
export const PHONE_STT_LIMITS: GateLimits = { concurrency: 1, perWindow: 12, windowMs: 60_000 };
export const PHONE_MAX_STT_BYTES = 4 * 1024 * 1024;
export const PHONE_MAX_STT_SECONDS = 120;
export const phoneSttGate = new VoiceGate(PHONE_STT_LIMITS);

/** The one format the phone's recorder writes (dashboard `wavEncoder.ts`): PCM, mono, 16 kHz,
 *  16-bit. A phone take in any other shape is refused rather than measured. */
export const PHONE_TAKE_FORMAT = { format: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16 } as const;

/**
 * How long a phone take is, or null when it is not the recorder's format or the header cannot say.
 *
 * The length is DERIVED from the fields whisper decodes with (sample rate × block align), never
 * from the header's own `byteRate`, which the sender writes and whisper ignores: a forged one
 * would let minutes of audio pass as milliseconds. Conservative: the larger of the declared data
 * size and the bytes actually present, so a small declared size cannot smuggle a long take.
 */
export function wavSeconds(buf: Buffer): number | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let bytesPerSecond = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) return null;
      const format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const blockAlign = buf.readUInt16LE(body + 12);
      const bits = buf.readUInt16LE(body + 14);
      const f = PHONE_TAKE_FORMAT;
      if (format !== f.format || channels !== f.channels || sampleRate !== f.sampleRate || bits !== f.bitsPerSample
        || blockAlign !== (f.channels * f.bitsPerSample) / 8) return null;
      bytesPerSecond = sampleRate * blockAlign;
    } else if (id === 'data') {
      if (!bytesPerSecond || size === 0xffffffff) return null;
      return Math.max(size, buf.length - body) / bytesPerSecond;
    }
    off = body + size + (size % 2);
  }
  return null;
}
