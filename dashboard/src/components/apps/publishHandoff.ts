import { publishPrompt, superPublishAsk, type PublishHandoff } from './publishPrompt';
import type { SuperPageRefusal, SuperPageSendResult } from '../../lib/superPageBridge';

/**
 * Where a Share press goes (owner 2026-11-13, paylas-prompt). He works on the Super Agent's
 * screen: with the Super on, a publish started in a Window tab ran where he never looked, and
 * each press started one more (four "Publish Günlük" tabs, two agents racing on one app). So:
 *
 * - The Super is on: the job goes to the Super as one message he sees in its chat; the Super runs
 *   it as ONE child on its stage and reuses a running one for the same app. Its screen opens.
 * - The Super is connecting or its chat is closed: nothing starts anywhere, the card says why.
 * - No Super: Chat, as before (a new chat only when none on screen takes it; a running publish
 *   chat of the same app is shown again, never doubled: AgentSurface `reuse`).
 *
 * Pure: the caller hands in the bridge calls, so the routing is tested without a DOM.
 */
export type PublishRoute = { to: 'super' } | { to: 'chat' } | { to: 'refused'; reason: Exclude<SuperPageRefusal, 'off'> };

export function routePublish(h: PublishHandoff, deps: {
  superOn: boolean;
  sendToSuper: (text: string) => SuperPageSendResult;
  showSuper: () => void;
  toChat: (prompt: string) => void;
}): PublishRoute {
  if (deps.superOn) {
    const res = deps.sendToSuper(superPublishAsk(h));
    if (res.accepted) { deps.showSuper(); return { to: 'super' }; }
    // Turned off between the read and the send: the owner's surface is Chat again.
    if (res.reason !== 'off') return { to: 'refused', reason: res.reason };
  }
  deps.toChat(publishPrompt(h));
  return { to: 'chat' };
}
