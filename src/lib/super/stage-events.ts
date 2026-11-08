/**
 * A stage change the SUPER made (its own `open`, `half`, `present`, `shape` verb, accepted by the
 * verb route). Owner arrangements go through the owner's layout door and never fire this, so a
 * listener can mirror the Super's presentations without ever sending one the owner made (plan L1).
 * In-process only; no payload beyond ids.
 */
export interface StageVerbEvent {
  vault: string;
  contextRoot: string;
  /** The Super chat that ran the verb. */
  sessionId: string;
  superId: string;
  verb: 'open' | 'half' | 'present' | 'shape';
  /** The cards that verb touched (the route's cue ids). */
  ids: string[];
}

export const STAGE_VERBS: ReadonlySet<string> = new Set(['open', 'half', 'present', 'shape']);

type Listener = (e: StageVerbEvent) => void;
const listeners = new Set<Listener>();

export function onStageVerb(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function noteStageVerb(e: StageVerbEvent): void {
  for (const fn of [...listeners]) {
    try { fn(e); } catch { /* a listener never breaks the verb */ }
  }
}
