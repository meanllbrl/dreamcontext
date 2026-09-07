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

export const sttGate = new VoiceGate(STT_LIMITS);
export const ttsGate = new VoiceGate(TTS_LIMITS);
