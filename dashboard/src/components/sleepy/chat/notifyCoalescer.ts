/**
 * One React commit per FRAME instead of one per NDJSON frame.
 *
 * A streaming turn emits a `text-delta` per token — dozens a second — and every one of them
 * used to reach `fireSubscribers()` directly, so the pane re-rendered dozens of times a
 * second while the browser only ever painted 60. The extra commits are pure waste: nobody
 * can see a frame that is overwritten before it paints.
 *
 * So a NON-urgent event schedules a single trailing flush and returns; any further events in
 * the same frame ride along on it. An URGENT one (a permission card, a question, the turn's
 * result — anything the user is waiting to act on) cancels the pending flush and fires
 * synchronously, so coalescing can never add latency to something interactive.
 *
 * Why the timeout backstop and not rAF alone: a minimized/garaged chat pane's container is
 * detached from the document, and a backgrounded WKWebView throttles `requestAnimationFrame`
 * to nothing at all. A transcript that only ever repainted on a frame callback would sit
 * frozen for the whole time the window was in the background and then land all at once.
 * Whichever of the two fires first cancels the other.
 *
 * Framework-free and clock-injectable, matching chatSession.ts's own no-React rule — the
 * scheduling policy is what the tests need to pin down, and it is testable only if the clock
 * can be faked.
 */

/** How long a trailing flush may wait when no animation frame arrives (a garaged pane, a
 *  backgrounded window). Short enough that a throttled surface still feels live. */
export const NOTIFY_BACKSTOP_MS = 50;

export interface CoalescerClock {
  frame: (cb: () => void) => number;
  cancelFrame: (handle: number) => void;
  timeout: (cb: () => void, ms: number) => number;
  cancelTimeout: (handle: number) => void;
}

export interface NotifyCoalescer {
  /** Fire NOW, dropping any pending trailing flush (which this render supersedes). */
  flush: () => void;
  /** Ask for one trailing flush. Repeat calls before it lands are absorbed into it. */
  schedule: () => void;
  /** Drop a pending flush WITHOUT firing it — teardown only. */
  cancel: () => void;
  /** Whether a trailing flush is currently scheduled (tests + assertions). */
  isPending: () => boolean;
}

/** The real clock, degrading to timers alone where `requestAnimationFrame` doesn't exist
 *  (jsdom, SSR, a headless test run). */
export const realClock: CoalescerClock = {
  frame: (cb) => (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(() => cb())
    : 0),
  cancelFrame: (h) => { if (h && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h); },
  timeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  cancelTimeout: (h) => { if (h) clearTimeout(h); },
};

export function createNotifyCoalescer(
  fire: () => void,
  clock: CoalescerClock = realClock,
): NotifyCoalescer {
  let frameHandle = 0;
  let timerHandle = 0;
  let pending = false;

  const cancel = (): void => {
    if (frameHandle) { clock.cancelFrame(frameHandle); frameHandle = 0; }
    if (timerHandle) { clock.cancelTimeout(timerHandle); timerHandle = 0; }
    pending = false;
  };

  const flush = (): void => {
    cancel();
    fire();
  };

  return {
    flush,
    schedule: () => {
      if (pending) return;
      pending = true;
      // Both are armed, and whichever wins cancels the loser inside `flush`. Arming only one
      // means picking, per event, whether this pane is currently being painted — which is
      // exactly the thing the caller cannot know.
      frameHandle = clock.frame(flush);
      timerHandle = clock.timeout(flush, NOTIFY_BACKSTOP_MS);
    },
    cancel,
    isPending: () => pending,
  };
}
