/**
 * Push-to-talk edges that do NOT come from this window's keyboard: the dreamcontext Assistant's
 * global hotkey, which Rust owns (`assistant://hotkey`) so it fires while another app is
 * focused. The notch forwards each edge here and the composer that owns the chord
 * (`pushToTalkScope.ts`) turns it into a take — the same `startTake`/`endTake` the keyboard and
 * the mic button drive, so a hotkey take is corrected, held for review and sent exactly like
 * any other.
 *
 * A bus rather than a prop because the notch does not render the composer: it portals a
 * `ChatPaneHost` into the session's container, and the composer sits several layers down.
 */

export type PushToTalkEdge = 'pressed' | 'released';

export interface PushToTalkSignal {
  edge: PushToTalkEdge;
  /** `hold`: pressed opens the mic, released closes it. `toggle`: each press flips it. */
  mode: 'hold' | 'toggle';
  /** This press is the one that summoned the surface (it was collapsed until now). */
  summon: boolean;
}

/** Returns true when it acted on the signal. */
type Listener = (signal: PushToTalkSignal) => boolean;

const listeners = new Set<Listener>();

export function onExternalPushToTalk(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Deliver one edge. True when some composer acted on it — in toggle mode, a press nobody
 *  acted on is the owner dismissing the surface. */
export function emitExternalPushToTalk(signal: PushToTalkSignal): boolean {
  let acted = false;
  for (const fn of listeners) if (fn(signal)) acted = true;
  return acted;
}

/**
 * What a composer does with one edge, given whether it owns the chord and is recording.
 * Pure, so the whole table is unit-tested without a microphone.
 *
 * - hold:   pressed → start (if it owns the chord); released → stop (always — a take that began
 *           here must be closeable even if ownership moved while the key was down, and one
 *           still opening must be cancelled).
 * - toggle: pressed while recording → stop; pressed on the summoning press → start; any other
 *           press → nothing (the notch reads that as "dismiss").
 */
export function pushToTalkAction(
  signal: PushToTalkSignal,
  owns: boolean,
  recording: boolean,
): 'start' | 'stop' | null {
  if (signal.mode === 'hold') {
    // Always stop: a release while the mic is still OPENING must cancel it, and `stop` is a
    // no-op when nothing is recording.
    if (signal.edge === 'released') return 'stop';
    return owns ? 'start' : null;
  }
  if (signal.edge !== 'pressed') return null;
  if (recording) return 'stop';
  return signal.summon && owns ? 'start' : null;
}

/**
 * The summoning press reaches the composer only AFTER the panel has opened, never in the same
 * tick. Opening the mic is synchronous WebKit audio work (the barge-in's autoplay banking, the
 * meter's `new AudioContext`), and WebKit's audio-session activation can hold the notch
 * webview's thread for seconds (1.6 s measured on 2026-09-28, longer while the screen is being
 * recorded). Done first, it stalled the resize behind it: the hotkey looked dead, the notch
 * stayed a pill. So the panel lands first, then this decides whether the press still becomes a
 * take:
 * - the panel was closed again meanwhile, or a newer press came → no;
 * - hold: only if the key is still down (a tap just opens the panel, and never touches audio);
 * - toggle: yes (the next press sends).
 */
export function summonTakeDue(mode: PushToTalkSignal['mode'], stillHeld: boolean, stillOpen: boolean, latestPress: boolean): boolean {
  if (!stillOpen || !latestPress) return false;
  return mode === 'toggle' || stillHeld;
}
