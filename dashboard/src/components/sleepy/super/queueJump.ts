/**
 * The stage tells the Super chat which presentation the owner just stepped to (task
 * super-sahnesinde-sunum-sirasi, AC3): the chat scrolls to the answer that brought it. Only the
 * owner's queue gestures send one (Next, close, Continue), never a push (D4: nothing moves while he
 * reads or writes). Keyed by the Super session, so a member's Super chat never takes main's jump.
 */
type Listener = (cards: readonly string[]) => void;

const listeners = new Map<string, Set<Listener>>();

export function onQueueJump(session: string, fn: Listener): () => void {
  let set = listeners.get(session);
  if (!set) { set = new Set(); listeners.set(session, set); }
  set.add(fn);
  return () => {
    const s = listeners.get(session);
    if (!s) return;
    s.delete(fn);
    if (!s.size) listeners.delete(session);
  };
}

export function sendQueueJump(session: string, cards: readonly string[]): void {
  for (const fn of listeners.get(session) ?? []) fn(cards);
}
