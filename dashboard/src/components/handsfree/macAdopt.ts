/**
 * Mac mode, the phone drawer's "Mac'te açık": a tap on a live chat of ANOTHER project opens that
 * project's surface first. The adoption it asked for is parked here and taken by that surface
 * once it has mounted (`takePendingMacAdopt`), so the chat opens there with `reattach=1`.
 */
import type { LiveChatWire } from './macContract';

const KEY = 'dc-mac-pending-adopt';

export function setPendingMacAdopt(chat: LiveChatWire): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...chat, at: Date.now() })); } catch { /* private mode */ }
}

/** The parked adoption for `vault` (consumed), or null. Stale after a minute. */
export function takePendingMacAdopt(vault: string): LiveChatWire | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as LiveChatWire & { at?: number };
    if (p.vault !== vault) return null;
    sessionStorage.removeItem(KEY);
    if (typeof p.at === 'number' && Date.now() - p.at > 60_000) return null;
    return { conversationId: p.conversationId, vault: p.vault, title: p.title, busy: p.busy };
  } catch { return null; }
}
