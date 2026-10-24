/**
 * Does a chat's question raise the owner (chime, banner, Dock bounce, badge)? Not when it is a
 * handed-over Super Agent's child (D16, AC6): the Super Agent's queue decides what reaches him.
 *
 * Whether a chat IS a child comes from the project's super record, which a window reads a moment
 * after it restores its tabs. A restored child that was mid-question replays that question on
 * connect, before the record is read, and used to ring (owner, 2026-10-21: "diğer chat'lerden de
 * arada bildirim alıyorum"). So until the record has been read (`set(null)`) an alarm is HELD:
 * the record naming the chat a child drops it, naming it not a child raises it once, and a record
 * that never comes releases it after {@link CHILD_ALARM_HOLD_MS} (a missed question costs more
 * than a late one).
 */

export const CHILD_ALARM_HOLD_MS = 5_000;

export interface ChildAlarmGate<A> {
  /** Is this chat a child right now (no alarm, no badge)? */
  readonly child: boolean;
  /** `true`/`false` from the record; `null` = the record is not read yet (alarms wait). */
  set(on: boolean | null): void;
  /** A fresh ask edge: raised now, held, or dropped. */
  ask(alarm: A): void;
  dispose(): void;
}

export function createChildAlarmGate<A>(opts: {
  /** `deferred` = a held alarm released later, outside the frame that asked. */
  raise: (alarm: A, deferred: boolean) => void;
  /** Is the question still open? A held alarm whose question was answered meanwhile is dropped. */
  stillAsking: () => boolean;
  holdMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): ChildAlarmGate<A> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let child = false;
  let known = true;
  let held: A | null = null;
  let timer: unknown = null;

  const stop = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const release = () => {
    stop();
    known = true;
    const a = held;
    held = null;
    if (a !== null && !child && opts.stillAsking()) opts.raise(a, true);
  };

  return {
    get child() { return child; },
    set(on) {
      if (on === null) {
        if (!known) return;
        known = false;
        timer = setTimer(release, opts.holdMs ?? CHILD_ALARM_HOLD_MS);
        return;
      }
      child = on;
      if (!known) release();
    },
    ask(alarm) {
      if (child) return;
      if (!known) { held = alarm; return; }
      opts.raise(alarm, false);
    },
    dispose() { stop(); held = null; },
  };
}
