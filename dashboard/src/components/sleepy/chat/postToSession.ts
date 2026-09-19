import type { ChatSession } from '../chatSession';

/**
 * Post a message into a live chat session the way the COMPOSER's ⏎ does — the one
 * behaviour every in-transcript card that talks back to the agent has to share.
 *
 * Mid-turn it STEERS: the CLI folds the text in at its next tool boundary, in the same
 * turn (measured on 2.1.220), so a secret's receipt or a finished command's exit code
 * reaches a working agent in seconds. Only when steering cannot land does it queue, marked
 * `steerWhenPossible` so the queue drains it at the first opening rather than at the end of
 * the turn — the exact fallback chain `Composer.commit` and `handleChecklistSubmit` already
 * use, extracted here so a third and fourth caller cannot invent a fifth variant.
 *
 * Idle, it is a plain `send`: a normal user turn, which is what "the agent continues on its
 * own" means when nothing is running.
 */
export function postToSession(session: ChatSession, text: string): void {
  if (!text.trim()) return;
  if (session.busy) {
    if (!session.steer(text)) session.enqueue(text, { steerWhenPossible: true });
    return;
  }
  session.send(text);
}
