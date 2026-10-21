/**
 * A chat pane nobody can see re-renders at most once a second, and at once when it is shown.
 *
 * Measured (task super-agent-ekrani-kasmaz…, scripts/verify/super-jank.mjs): with the Super
 * Agent handed over, every child chat lives in the garage (`display:none`) and still re-rendered
 * its whole transcript on every streamed token — ChatPane, the markdown parse and DOMPurify, and a
 * layout effect whose `clientHeight` read forced a style recalc of the WHOLE document each time.
 * Three streaming children cost ~1 s of main thread per 10 s at full speed (~3 s under a 4x CPU
 * throttle), all of it for panes drawn nowhere.
 *
 * Not skipped outright: a hidden pane still derives state other surfaces read off its session
 * (`agentsWorking`, the Super stage tile's status), so it keeps a slow trailing render — at most
 * one per {@link HIDDEN_RENDER_MS}, never later than that after the last event. Shown again, its
 * session fires once (chatSession's `minimized` setter) and `notify` renders at once, before
 * paint, so the owner never sees a stale frame.
 *
 * Framework-free and clock-injectable, like notifyCoalescer.ts.
 */

/** The slowest a hidden pane falls behind its session. */
export const HIDDEN_RENDER_MS = 1000;

export interface GateClock {
  now: () => number;
  timeout: (cb: () => void, ms: number) => number;
  cancelTimeout: (handle: number) => void;
}

export const realGateClock: GateClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  timeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  cancelTimeout: (h) => { if (h) clearTimeout(h); },
};

export interface HiddenRenderGate {
  /** The session changed: render now when visible (dropping a pending trailing render), else
   *  at most once per HIDDEN_RENDER_MS. */
  notify: () => void;
  /** Teardown: drop a pending trailing render. */
  dispose: () => void;
}

export function createHiddenRenderGate(
  render: () => void,
  isHidden: () => boolean,
  clock: GateClock = realGateClock,
  intervalMs = HIDDEN_RENDER_MS,
): HiddenRenderGate {
  let last = Number.NEGATIVE_INFINITY;
  let timer = 0;

  const fire = (): void => {
    if (timer) { clock.cancelTimeout(timer); timer = 0; }
    last = clock.now();
    render();
  };

  return {
    notify: () => {
      if (!isHidden()) { fire(); return; }
      if (timer) return;
      const wait = last + intervalMs - clock.now();
      if (wait <= 0) fire();
      else timer = clock.timeout(fire, wait);
    },
    dispose: () => {
      if (timer) { clock.cancelTimeout(timer); timer = 0; }
    },
  };
}
