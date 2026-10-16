import type { LiveChatWire } from '../handsfree/macContract';
import type { SessionStatusInfo } from './agentStatus';

/**
 * The phone drawer's row rules (AC18), kept apart from the React file so they are tested as
 * plain functions. One conversation is listed ONCE: a chat this phone holds is under Active, a
 * chat the Mac runs is under "Open on Mac", and neither (nor a conversation still draining after
 * a takeover) repeats under Past chats.
 */

export type LiveState = LiveChatWire['state'];

/** The i18n key of a live chat's state label: Working / Waiting for you / Idle. */
export function liveStateKey(state: LiveState): string {
  if (state === 'asking') return 'handsfree.mac.state.asking';
  if (state === 'working') return 'handsfree.mac.state.working';
  return 'handsfree.mac.state.idle';
}

/** The same three words for a session this phone holds; any other state keeps its own label. */
export function activeStateKey(info: Pick<SessionStatusInfo, 'kind'>): string | null {
  if (info.kind === 'asking') return liveStateKey('asking');
  if (info.kind === 'working') return liveStateKey('working');
  if (info.kind === 'ready') return liveStateKey('idle');
  return null;
}

export interface DrawerRowsInput<P extends { id: string }> {
  live: readonly LiveChatWire[];
  draining: readonly string[];
  past: readonly P[];
  /** Conversation ids that already hold a tab on this phone. */
  openClaudeIds: readonly string[];
}

export function drawerRows<P extends { id: string }>(i: DrawerRowsInput<P>): { liveRows: LiveChatWire[]; pastRows: P[] } {
  const liveRows = i.live.filter((c) => c.vault && !i.openClaudeIds.includes(c.conversationId));
  const taken = new Set([...i.openClaudeIds, ...i.live.map((c) => c.conversationId), ...i.draining]);
  const pastRows = i.past.filter((s) => !taken.has(s.id));
  return { liveRows, pastRows };
}

/**
 * A tap on a past row whose conversation turns out to be live (the two lists raced): adopt the
 * running chat, never resume it — a resume would start a second process on one conversation.
 */
export function pastTap(id: string, live: readonly LiveChatWire[]): { adopt: LiveChatWire } | { resume: true } {
  const hit = live.find((c) => c.conversationId === id && c.vault);
  return hit ? { adopt: hit } : { resume: true };
}
