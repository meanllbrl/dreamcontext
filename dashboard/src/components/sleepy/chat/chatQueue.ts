/**
 * The message queue's pure algebra — every decision the Chat composer's "⏎ while busy" feature
 * rests on, with no session, socket or DOM in sight.
 *
 * It lives outside chatSession.ts because that module cannot be unit-tested without standing up
 * a WebSocket, a `document` and a vault, while the rules WORTH pinning are all here: which
 * moment counts as drainable (the "Stop didn't stop" hazard), which moment counts as
 * STEERABLE, and that an emptied edit deletes the row rather than queueing a frame the CLI
 * would reject.
 *
 * Two deliveries, not one — the distinction the whole module turns on:
 *   • STEER  ({@link canSteer})        — hand the message to the running turn NOW. The CLI
 *                                        picks it up at its next tool boundary.
 *   • QUEUE  ({@link shouldDrainQueue}) — hold it client-side until this turn has settled.
 *
 * Zero imports on purpose — chatSession.ts imports this, so the reverse must never be true.
 */

/** One message submitted while a turn was in flight, awaiting its own turn. */
export interface QueuedMessage {
  id: string;
  text: string;
  ts: number;
  /** This row is here as a FALLBACK, not a choice: ⏎ meant to steer it into the running turn
   *  and could not (a card was open, the socket was down), so it was parked rather than
   *  dropped. It still wants the first opening it can get — see {@link nextAutoSteer}. Without
   *  this, ⏎ would silently degrade into "waits for the turn to end", which is the exact
   *  behaviour steering exists to replace. */
  steerWhenPossible?: true;
}

/** Append a message. Whitespace-only text is not a message — `send` refuses it too, so
 *  queueing it would only produce a row that can never leave. */
export function appendQueued(
  queue: QueuedMessage[], text: string, id: string, ts: number,
  opts?: { steerWhenPossible?: boolean },
): QueuedMessage[] {
  const clean = text.trim();
  if (!clean) return queue;
  return [...queue, {
    id, text: clean, ts,
    ...(opts?.steerWhenPossible ? { steerWhenPossible: true as const } : {}),
  }];
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

/** Everything {@link canSteer} needs to know about the session, flattened. */
export interface SteerProbe {
  /** A turn is in flight. Steering is defined only here — with nothing running there is no
   *  turn to steer, and the message is an ordinary `send`. */
  busy: boolean;
  /** A permission/question/plan card is open. The CLI is parked on that answer, so a user
   *  frame written now is not "cutting in", it is talking over the card — and the thing the
   *  user actually wants (deny with a message) is the card's own affordance. */
  asking: boolean;
  /** The CLI process exited, or has no credentials — nothing is listening on that stdin. */
  ended?: boolean;
  socketOpen: boolean;
}

/**
 * Whether a message written RIGHT NOW would reach the turn already in flight.
 *
 * Measured against CLI 2.1.220 through this route's own stdin: a `user` frame written
 * mid-turn is delivered at the very next tool boundary, in the SAME turn (`num_turns: 2`,
 * one `result`) — everything still pending at that boundary arrives together. That is the
 * "first gap" delivery the terminal pane gets from the CLI's readline, and the reason this
 * predicate exists at all: the Chat client used to hold every queued message until the
 * busy→idle edge, turning a ten-second correction into a five-minute one.
 *
 * Deliberately NOT blocked by `paused`: the pause is a statement about the QUEUE draining by
 * itself, and a steer is the user acting by hand this instant. (The two barely overlap —
 * after Stop the turn settles and ⏎ is an ordinary send again.)
 */
export function canSteer(p: SteerProbe): boolean {
  if (!p.busy) return false;
  if (p.asking || p.ended) return false;
  return p.socketOpen;
}

/**
 * The row an AUTOMATIC steer should take next, or null.
 *
 * Only ever a `steerWhenPossible` row — one ⏎ tried to steer and could not. Those are owed the
 * first opening that comes along; a deliberately-held row (the ⇡ button) is not, and keeps its
 * place until the turn settles. So a fallback row legitimately overtakes a held one: they were
 * asking for different things, and order within the strip only ranks equals.
 *
 * Respects `paused` even though {@link canSteer} does not, and the difference is the point:
 * this fires by itself, and "Stop" has to mean the session stops doing things by itself. The
 * row's own Send now is a hand on a button and is not bound by it.
 */
export function nextAutoSteer(
  queue: QueuedMessage[], p: SteerProbe & { paused?: boolean },
): QueuedMessage | null {
  if (p.paused || !canSteer(p)) return null;
  return queue.find((q) => q.steerWhenPossible) ?? null;
}
