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
    return { conversationId: p.conversationId, vault: p.vault, title: p.title, busy: p.busy, state: p.state ?? (p.busy ? 'working' : 'idle'), lastLine: typeof p.lastLine === 'string' ? p.lastLine : null, updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : null };
  } catch { return null; }
}

// ─── The phone's one list (hands-free sekmeler W3): a past chat or a Super row of ANOTHER project ──

const OPEN_KEY = 'dc-mac-pending-open';

/** What a tap in the one list asked another project's surface to open once it has mounted. */
export type PendingPhoneOpen =
  | { vault: string; kind: 'resume'; id: string; title: string }
  | { vault: string; kind: 'super'; id: string };

export function setPendingPhoneOpen(p: PendingPhoneOpen): void {
  try { sessionStorage.setItem(OPEN_KEY, JSON.stringify({ ...p, at: Date.now() })); } catch { /* private mode */ }
}

/** The parked open for `vault` (consumed), or null. Stale after a minute. */
export function takePendingPhoneOpen(vault: string): PendingPhoneOpen | null {
  try {
    const raw = sessionStorage.getItem(OPEN_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingPhoneOpen> & { at?: number; title?: unknown };
    if (p.vault !== vault || typeof p.id !== 'string') return null;
    sessionStorage.removeItem(OPEN_KEY);
    if (typeof p.at === 'number' && Date.now() - p.at > 60_000) return null;
    if (p.kind === 'super') return { vault, kind: 'super', id: p.id };
    if (p.kind === 'resume') return { vault, kind: 'resume', id: p.id, title: typeof p.title === 'string' ? p.title : '' };
    return null;
  } catch { return null; }
}
