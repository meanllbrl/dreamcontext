/**
 * "When every account is out → Continue at reset" (Settings → Models → a tool → Limit rules).
 *
 * A chat that hit the wall on every account of its tool is told when the earliest window
 * reopens (`all_exhausted`, `earliestResetAt`). Under the tool's `continue` rule
 * (`account-rules.ts`, never the default) the pane arms ONE timer for that reset plus a minute;
 * when it fires the chat goes on by itself, but only if the pane is still alive, idle, and the
 * owner has not written since it was armed. Any owner message cancels it, and so does closing
 * the pane. Under `stop` nothing is ever armed.
 *
 * Kept free of the route so its three guarantees (arm, cancel, fire) are tested on their own.
 */

/** The margin after the reported reset: a window reported as reopening at T is not always open at T. */
export const RESUME_GRACE_MS = 60_000;

/** What the chat is told when it goes on by itself. */
export const RESET_CONTINUE_TEXT =
  'The usage limit that stopped this chat has reset. '
  + 'Continue exactly where you stopped; do not redo finished work.';

export interface ResumeAtResetDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** The pane's child is still running. */
  alive: () => boolean;
  /** No turn is running and no account switch is pending. */
  idle: () => boolean;
  /** Increases with every owner message the pane sends. */
  ownerSeq: () => number;
}

export interface ResumeAtReset {
  /** Arm for `until` (epoch ms). Replaces an earlier arming. False when `until` is unusable. */
  arm: (until: number, fire: () => void) => boolean;
  cancel: () => void;
  armed: () => boolean;
}

export function createResumeAtReset(deps: ResumeAtResetDeps): ResumeAtReset {
  let handle: unknown = null;
  const cancel = (): void => {
    if (handle !== null) deps.clearTimer(handle);
    handle = null;
  };
  return {
    arm(until, fire) {
      cancel();
      if (!Number.isFinite(until) || until <= 0) return false;
      const seq = deps.ownerSeq();
      const delay = Math.max(0, until + RESUME_GRACE_MS - deps.now());
      handle = deps.setTimer(() => {
        handle = null;
        if (!deps.alive() || !deps.idle() || deps.ownerSeq() !== seq) return;
        fire();
      }, delay);
      return true;
    },
    cancel,
    armed: () => handle !== null,
  };
}
