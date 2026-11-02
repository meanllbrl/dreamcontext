import { resolve } from 'node:path';
import { countEvent, newQueueId, pumpSuper, writeSuper } from './inbox.js';
import { mainRootOf, okMember, superOfChild, superOfSession } from './store.js';

/**
 * The owner decided on an automation's approval card in the Super Agent's chat (or in one of its
 * children's): the super hears it as an `automation` event in its next batch, with the
 * automation's live state and next run read at delivery (inbox.ts `automationItemLines`).
 *
 * Only a session of THIS vault's handed-over super counts: a card in any other chat tells its
 * own conversation (the card's report), never a super it does not belong to. Returns whether an
 * event was queued, so the card knows not to report the same decision a second time.
 */
export async function tellSuperAutomationDecision(
  contextRoot: string,
  sessionId: string,
  slug: string,
  decision: 'approved' | 'rejected',
  now = Date.now(),
): Promise<boolean> {
  if (!okMember(slug)) return false;
  const root = mainRootOf(superOfSession(sessionId)) ?? mainRootOf(superOfChild(sessionId));
  if (!root || resolve(root) !== resolve(contextRoot)) return false;
  let added = false;
  await writeSuper(root, (s) => {
    if (!s.enabled || !s.session) return;
    s.queue.push({ id: newQueueId(), sessionId: s.session, kind: 'automation', state: 'pending', createdAt: now, automation: slug, decision });
    countEvent(s);
    added = true;
  });
  if (added) void pumpSuper(root);
  return added;
}
