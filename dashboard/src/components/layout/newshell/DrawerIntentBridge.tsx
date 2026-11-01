import { useLayoutEffect, useRef } from 'react';
import { emitInstance, useVault } from '../../../context/VaultContext';
import { OPEN_SESSION_EVENT, type OpenSessionDetail } from '../../../lib/openSession';
import { DRAWER_INTENT_EVENT, DRAWER_PAGE_EVENT, type PendingDrawerIntent } from '../../../lib/drawerIntents';
import { DRAWER_INTENT_TTL_MS } from './drawerModel';

/**
 * Commands down (D5): the window queued a drawer intent for this project; ring it on THIS
 * instance's bus, once per nonce, and tell the window it was taken. A History pick rides the
 * existing `OPEN_SESSION` path, so it reopens the chat exactly as a `dreamcontext://` link does,
 * in this project and never in the one that happened to be on screen. Renders nothing.
 *
 * A layout effect, and that is the point: what the surface sets from a passive effect is scheduled
 * as a task, so the click paints first with the old chat on screen. From here it lands in the
 * click's own frame.
 */
export function DrawerIntentBridge({ pending, onConsumed }: {
  pending: PendingDrawerIntent | null;
  onConsumed?: (vault: string, nonce: number) => void;
}) {
  const { vault, bus } = useVault();
  const landed = useRef(-1);
  useLayoutEffect(() => {
    if (!pending || !vault || pending.nonce === landed.current) return;
    landed.current = pending.nonce;
    onConsumed?.(vault, pending.nonce);
    if (Date.now() - pending.at > DRAWER_INTENT_TTL_MS) return;
    const { intent } = pending;
    if (intent.kind === 'open-session') {
      // Only History queues `open-session`: it is a pick, guarded on the tunnel.
      emitInstance<OpenSessionDetail>(bus, OPEN_SESSION_EVENT, { claudeId: intent.sessionId, pick: true });
    } else if (intent.kind === 'page') {
      emitInstance(bus, DRAWER_PAGE_EVENT, { page: intent.page, id: intent.id ?? null });
    } else {
      emitInstance(bus, DRAWER_INTENT_EVENT, intent);
    }
  }, [pending, vault, bus, onConsumed]);
  return null;
}
