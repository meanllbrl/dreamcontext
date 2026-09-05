/**
 * A bounded, in-memory trace of every chat RESPAWN, plus the detector for the state a
 * respawn can leave behind.
 *
 * WHY THIS EXISTS. Three surface paths — `resumeChatSession`, `changeChatMode` and
 * `openAgentInChat` — replace a live conversation in place by disposing the old session,
 * deleting it from `sessions.current`, spawning a replacement, and then remapping the
 * roster entry and every pane from the old id to the new one. Between the delete and the
 * remap the tab's id points at nothing, and each of the three later steps can fail
 * INDEPENDENTLY and SILENTLY:
 *
 *   • `spawn` throws           → the old session is already gone; nothing replaces it.
 *   • the roster remap misses  → `prev.map(m => m.id === cs.id ? … : m)` is a no-op when no
 *                                entry carries `cs.id` any more (a racing respawn remapped
 *                                it first). `Array.map` cannot report that it matched
 *                                nothing, so the roster keeps the DEAD id forever.
 *   • the pane remap misses    → same shape, same silence, for `panes`.
 *
 * Any of the three ends in one observable state: a roster entry that is not dormant and
 * has no object in `sessions.current`. That tab still draws (the strip renders from the
 * roster), reads as `starting` (`deriveSessionStatus` maps an undefined status there), and
 * renders an EMPTY pane — no portal is created for it and the layout effect appends no
 * container into its slot. Clicking it is a no-op, and the defensive reconcile never
 * notices it, because that reconcile compares roster ids against pane ids and never asks
 * whether a live session exists. So the tab is unusable and unrecoverable until it is
 * closed.
 *
 * WHAT THIS MODULE DOES. It stays quiet through the healthy path — every step lands in a
 * ring buffer at `console.debug` — and goes loud exactly once, when {@link traceOrphan}
 * observes the broken state: it prints the whole preceding history at `console.error`, so
 * the failing step names itself instead of having to be guessed at from the end state.
 *
 * The buffer also outlives the moment. A user who notices a dead tab minutes later can
 * open devtools and read `__dcRespawnTrace.dump()` — the history is still there, which a
 * console line alone would not be if devtools was closed when it happened.
 */

/** One step of a respawn, or the failure that ended it. */
export type RespawnPhase =
  /** A respawn path was entered: the old session is about to be disposed. */
  | 'begin'
  /** `spawn` returned — a replacement session exists and is registered. */
  | 'spawned'
  /** The roster remap ran. `matched` says whether it actually rewrote an entry. */
  | 'roster'
  /** The pane remap ran. `matched` says whether it actually rewrote a tab. */
  | 'panes'
  /** `spawn` threw. The old session is gone and nothing replaced it. */
  | 'failed'
  /** A watcher decided to restart a session (auto-switch / auth change). */
  | 'armed'
  /** The broken end state: a live roster entry with no session object. */
  | 'orphan';

export interface RespawnTraceEntry {
  /** Wall clock, so two entries can be told apart in a paste. */
  at: string;
  /** Which surface path produced this step (`resumeChatSession`, `armAccountSwitch`, …). */
  path: string;
  phase: RespawnPhase;
  /** The outgoing session id (the one being replaced). */
  from?: string;
  /** The incoming session id, once `spawn` has returned one. */
  to?: string;
  /** The conversation UUID, which survives a respawn and is what a recovery would resume. */
  claudeId?: string;
  /** Whatever else the call site knows: the account being moved to, the new mode, the
   *  error, whether a remap matched anything. */
  detail?: Record<string, unknown>;
}

/** How many steps to keep. A respawn is ~4 entries, so this holds roughly the last fifty —
 *  far more history than any single failure needs, and still a trivial amount of memory. */
const LIMIT = 200;

const buffer: RespawnTraceEntry[] = [];

/** Ids already reported as orphaned. An orphan persists across every subsequent render, so
 *  without this the detector would reprint the full history on each one. Cleared per id the
 *  moment it recovers, so a genuine second failure on the same id still reports. */
const reported = new Set<string>();

function push(entry: RespawnTraceEntry): void {
  buffer.push(entry);
  if (buffer.length > LIMIT) buffer.splice(0, buffer.length - LIMIT);
}

/**
 * Record one step of a respawn. Quiet by design — `console.debug` sits under devtools'
 * Verbose level, so the healthy path costs the user nothing to have switched on.
 */
export function traceRespawn(
  path: string,
  phase: RespawnPhase,
  fields: Omit<RespawnTraceEntry, 'at' | 'path' | 'phase'> = {},
): void {
  const entry: RespawnTraceEntry = { at: new Date().toISOString(), path, phase, ...fields };
  push(entry);
  if (phase === 'failed') {
    // The one step that is unambiguously broken on its own — it does not need the detector's
    // corroboration to be worth shouting about, and the stack is only here.
    console.error(`[respawn] ${path} — spawn threw; the tab it was replacing is now dead`, entry, dumpRespawnTrace());
    return;
  }
  console.debug(`[respawn] ${path} · ${phase}`, entry);
}

/**
 * Report a roster entry that is live (not dormant) but has no session object — the end
 * state every failure above collapses into.
 *
 * Prints ONCE per id, with the whole preceding trace, because the useful information is not
 * that the tab is dead now but which step killed it. Returns whether it printed, so a caller
 * can tell a fresh orphan from one it has already seen.
 */
export function traceOrphan(id: string, detail?: Record<string, unknown>): boolean {
  if (reported.has(id)) return false;
  reported.add(id);
  const entry: RespawnTraceEntry = { at: new Date().toISOString(), path: 'detector', phase: 'orphan', from: id, detail };
  push(entry);
  console.error(
    `[respawn] ORPHANED TAB — roster entry ${id} is live but has no session object.\n` +
    'The tab draws as "starting", renders an empty pane, and cannot be clicked back to life.\n' +
    'The trace below ends with the step that killed it.',
    entry,
    dumpRespawnTrace(),
  );
  return true;
}

/** Forget an id's orphan report — it has a session object again (or the tab is gone). */
export function clearOrphan(id: string): void {
  reported.delete(id);
}

/** A copy of the trace, oldest first. Copied so a caller cannot mutate the buffer. */
export function dumpRespawnTrace(): RespawnTraceEntry[] {
  return buffer.slice();
}

/**
 * Publish the trace on `window` so it can be read from devtools AFTER the fact — the case
 * that matters, since a user notices a dead tab well after the step that broke it, and the
 * console is only recording when devtools happens to be open.
 */
export function installRespawnTraceGlobal(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__dcRespawnTrace = {
    dump: dumpRespawnTrace,
    /** Pretty-printed, for pasting into a bug report. */
    print: () => console.table(dumpRespawnTrace()),
    clear: () => { buffer.length = 0; reported.clear(); },
  };
}
