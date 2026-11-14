/**
 * A poll that can also be POKED: read now, then every `delay()` ms, and read at once whenever
 * `poke()` is called (an event says the answer moved). The side menu's Ekip row reads the member
 * summary this way: a timer alone left a member red for up to two minutes after the owner had
 * answered it (owner 2026-11-14); a pushed Super record now pokes it.
 *
 * Reads may overlap (a poke mid-read): only the newest read's answer counts (`current()` is false
 * for an older one) and only the newest schedules the next tick, so a late answer never paints
 * over a newer one and the loop never doubles. `delay()` null = no next tick (read on poke only).
 */
export interface PulsedPoll {
  /** Read now (any pending tick is dropped; the read reschedules it). */
  poke(): void;
  /** Stop: no tick, no answer applied after this. */
  stop(): void;
}

export function startPulsedPoll(
  read: (current: () => boolean) => Promise<unknown>,
  delay: () => number | null,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): PulsedPoll {
  let gone = false;
  let seq = 0;
  let timer: unknown;
  const drop = () => { if (timer !== undefined) { timers.clear(timer); timer = undefined; } };
  const run = () => {
    if (gone) return;
    drop();
    const mine = ++seq;
    const current = () => !gone && mine === seq;
    void Promise.resolve()
      .then(() => read(current))
      .catch(() => { /* a failed read keeps the last answer */ })
      .finally(() => {
        if (!current()) return;
        const ms = delay();
        if (ms !== null) timer = timers.set(run, ms);
      });
  };
  run();
  return { poke: run, stop: () => { gone = true; drop(); } };
}
