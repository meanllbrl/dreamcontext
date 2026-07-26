/**
 * The message queue's pure algebra — every decision the Chat composer's "⏎ while busy" feature
 * rests on, with no session, socket or DOM in sight.
 *
 * It lives outside chatSession.ts because that module cannot be unit-tested without standing up
 * a WebSocket, a `document` and a vault, while the rules WORTH pinning are all here: which
 * moment counts as drainable (the "Stop didn't stop" hazard), and that an emptied edit deletes
 * the row rather than queueing a frame the CLI would reject.
 *
 * Zero imports on purpose — chatSession.ts imports this, so the reverse must never be true.
 */

/** One message submitted while a turn was in flight, awaiting its own turn. */
export interface QueuedMessage { id: string; text: string; ts: number }

/** Append a message. Whitespace-only text is not a message — `send` refuses it too, so
 *  queueing it would only produce a row that can never leave. */
export function appendQueued(
  queue: QueuedMessage[], text: string, id: string, ts: number,
): QueuedMessage[] {
  const clean = text.trim();
  if (!clean) return queue;
  return [...queue, { id, text: clean, ts }];
}

/**
 * Rewrite one queued message. Emptying it DELETES the row: "select all, delete, save" is how
 * anyone expects to drop a message they no longer want, and the alternative — keeping an empty
 * entry — is a row that either sends nothing or blocks the ones behind it.
 */
export function editQueued(queue: QueuedMessage[], id: string, text: string): QueuedMessage[] {
  const clean = text.trim();
  if (!clean) return removeQueued(queue, id);
  return queue.map((q) => (q.id === id ? { ...q, text: clean } : q));
}

/** Drop one queued message, or all of them when `id` is omitted. */
export function removeQueued(queue: QueuedMessage[], id?: string): QueuedMessage[] {
  if (id === undefined) return [];
  return queue.filter((q) => q.id !== id);
}

/** Everything {@link shouldDrainQueue} needs to know about the session, flattened. */
export interface DrainProbe {
  /** A turn is in flight — the queue exists precisely to wait for this. */
  busy: boolean;
  /** A permission/question/plan card is open. The user is being asked something; sending the
   *  next instruction on top of that is not "waiting your turn", it is talking over the card. */
  asking: boolean;
  /** Held by an explicit interrupt (see {@link ChatSession.interrupt}). */
  paused?: boolean;
  /** The CLI process exited, or has no credentials. Either way the queue must survive rather
   *  than be spent into a dead session — the rows are the user's only copy of that text. */
  ended?: boolean;
  socketOpen: boolean;
  queueLength: number;
}

/**
 * Whether THIS is the moment to send the next queued message.
 *
 * The `paused` clause is the load-bearing one: an interrupt's own `result` frame is a
 * busy→idle edge like any other, so without it, pressing Stop would fire the next queued
 * message in the same breath as the interrupt — the user's own words, sent as the visible
 * consequence of asking for everything to stop.
 */
export function shouldDrainQueue(p: DrainProbe): boolean {
  if (p.queueLength <= 0) return false;
  if (p.busy || p.asking) return false;
  if (p.paused || p.ended) return false;
  return p.socketOpen;
}
