/**
 * The client half of audio focus: ask the server for the speaker, and tell the owner when
 * another pane already has it.
 *
 * The server owns the decision (`src/lib/voice/audioFocus.ts` — that file's header is where
 * the whole design lives). This module is deliberately thin: one request, one fire-and-forget
 * release, and one window event so the composer can say what happened.
 *
 * ── WHY RELEASE IS `keepalive` AND NOT AWAITED ──────────────────────────────────────────
 * The most important release is the one sent while the page is being torn down — a closed
 * window mid-answer is exactly the case that would otherwise leave Spotify paused. A normal
 * `fetch` is cancelled when the document goes away; `keepalive` is not. It is also never
 * awaited, because nothing the caller does next depends on the answer, and a release that
 * blocked barge-in would make the fix slower than the bug.
 *
 * The server's watchdog is the real backstop — `keepalive` is best-effort and a hard crash
 * sends nothing at all.
 */

/** What the server says about a hold. Mirrors `FocusGrant` on the server side. */
export interface FocusGrant {
  granted: boolean;
  holder: string | null;
  ducked: boolean;
  /** The gain that cancels the system-volume duck, or 1. See the server's `duckGain`. */
  gain: number;
  paused: string[];
  denied?: boolean;
}

/**
 * The grant assumed when the request itself fails.
 *
 * FAIL OPEN, TOWARD SPEAKING. A focus route that is down, 403, or slow must cost at most an
 * answer read over music. Treating a failed request as "you may not speak" would turn a
 * cosmetic problem into a silent mode, and a silent mode is indistinguishable from a broken
 * one — there is nothing on screen to tell them apart.
 */
export const OPEN_GRANT: FocusGrant = {
  granted: true, holder: null, ducked: false, gain: 1, paused: [],
};

/** How long to wait for the server to answer a hold before giving up and speaking anyway.
 *  Generous next to a loopback round trip, and well under the ~1.3 s a chunk spends being
 *  generated, so a timeout costs nothing a listener would notice. */
export const HOLD_TIMEOUT_MS = 4000;

export interface FocusClient {
  /** Take or refresh the speaker. Idempotent for the holder, so this doubles as the
   *  heartbeat that keeps the server's watchdog from reclaiming a live turn. */
  hold(session: string): Promise<FocusGrant>;
  /** Hand it back. Fire-and-forget by design — see the module note. */
  release(session: string): void;
}

export function createFocusClient(): FocusClient {
  return {
    async hold(session) {
      try {
        const res = await fetch('/api/agent/voice/focus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session, hold: true }),
          // The play loop AWAITS this, so a request that hangs rather than fails would stall
          // speech indefinitely — a silent mode with nothing on screen to explain it, which is
          // the failure this whole module is written to avoid. An error is fine (it fails open
          // to speaking); an eternity is not.
          signal: AbortSignal.timeout(HOLD_TIMEOUT_MS),
        });
        if (!res.ok) return OPEN_GRANT;
        const body = await res.json() as Partial<FocusGrant>;
        return {
          granted: body.granted !== false,
          holder: typeof body.holder === 'string' ? body.holder : null,
          ducked: body.ducked === true,
          // A gain below 1 would make our own voice QUIETER, which no correct answer from
          // this route ever asks for — so an out-of-range number is read as "no gain".
          gain: typeof body.gain === 'number' && body.gain > 1 ? body.gain : 1,
          paused: Array.isArray(body.paused) ? body.paused.filter((p) => typeof p === 'string') : [],
          denied: body.denied === true,
        };
      } catch {
        return OPEN_GRANT;
      }
    },
    release(session) {
      try {
        void fetch('/api/agent/voice/focus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session, hold: false }),
          keepalive: true,
        }).catch(() => { /* the server's watchdog is the backstop */ });
      } catch { /* ditto */ }
    },
  };
}

// ─── Telling the owner an answer was not read ──────────────────────────────────────────

const MUTED_EVENT = 'dreamcontext:voice-speech-muted';

export interface SpeechMuted {
  /** The session the announcement is about. Carried so the right composer acts on it: the
   *  event is window-wide and there can be several J.A.R.V.I.S panes. */
  session: string;
  /**
   * `true` — this turn was not read aloud. `false` — a later turn IS being read, so take the
   * notice down.
   *
   * The retraction is not tidiness. The notice was only ever cleared by the next MIC PRESS,
   * and speech happens on typed turns too, so a user muted once and then typing saw "this
   * answer was not read aloud" sitting on screen WHILE a new answer was being read aloud —
   * the banner actively lying about the state it exists to report.
   */
  muted: boolean;
}

/**
 * Announce that a turn went unspoken because another pane held the speaker.
 *
 * THIS IS NOT COSMETIC. The alternative — an answer that simply is not read, in a mode whose
 * proposition is that answers are read — is the failure the owner cannot diagnose: the text
 * is on screen, nothing is wrong with it, and the speaker is silent for a reason that exists
 * only in another window. Two voices at once is bad; an unexplained silence is worse.
 */
export function announceSpeechMuted(session: string, muted = true): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<SpeechMuted>(MUTED_EVENT, { detail: { session, muted } }));
}

/** Subscribe to unspoken-answer announcements. Returns the unsubscribe. */
export function onSpeechMuted(fn: (e: SpeechMuted) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => fn((e as CustomEvent<SpeechMuted>).detail);
  window.addEventListener(MUTED_EVENT, handler);
  return () => window.removeEventListener(MUTED_EVENT, handler);
}
