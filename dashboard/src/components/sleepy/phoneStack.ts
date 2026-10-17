import type { LiveChatWire } from '../handsfree/macContract';
import type { SessionStatusInfo } from './agentStatus';
import type { ConversationModel } from './chatSession';
import { activeStateKey, drawerRows, liveStateKey } from './drawerRows';

/**
 * The phone's chat STACK (AC19): the desktop shows open chats side by side, the phone shows one
 * focused chat and every other open chat as a one-line row above it. These are its rules, kept
 * apart from the React file so they are tested as plain functions:
 *
 * - a row is either another tab this phone holds, or a chat the Mac runs in THIS project that
 *   holds no tab here; one conversation is one row (the drawer's AC18 rule, reused);
 * - a chat waiting for you (question or permission) sorts first, the rest keep their order;
 * - tapping a tab row switches to it, tapping a Mac row adopts the running chat (never a resume
 *   beside it, which would start a second process on one conversation).
 */

export interface StackTab {
  id: string;
  paneId: string;
  title: string;
  info: SessionStatusInfo;
  /** The conversation this tab holds, once known (the live session's). */
  claudeId?: string;
  /** The roster's id for it, when that differs (a dormant tab, or a pin the server replaced):
   *  either one means "held here", so neither is stacked again as a Mac chat. */
  altClaudeId?: string;
  attention: boolean;
}

export type StackRow =
  | { kind: 'tab'; key: string; id: string; paneId: string; title: string; dot: string; stateKey: string | null; label: string; waiting: boolean }
  | { kind: 'mac'; key: string; id: string; chat: LiveChatWire; title: string | null; dot: string; stateKey: string; waiting: boolean; lastLine: string };

export function stackRows(i: {
  tabs: readonly StackTab[];
  activeId: string;
  live: readonly LiveChatWire[];
  draining?: readonly string[];
  /** The project this surface shows: a Mac chat of another chosen project is not stacked here. */
  vault: string;
}): StackRow[] {
  const tabRows: StackRow[] = i.tabs
    .filter((t) => t.id !== i.activeId)
    .map((t) => ({
      kind: 'tab', key: `tab:${t.id}`, id: t.id, paneId: t.paneId, title: t.title,
      dot: t.info.kind, stateKey: activeStateKey(t.info), label: t.info.label,
      waiting: t.info.kind === 'asking',
    }));
  const openClaudeIds = heldIds(i.tabs);
  // A draining (or just-closed) conversation is on its way out: never a row to adopt.
  const live = i.live.filter((c) => !(i.draining ?? []).includes(c.conversationId));
  const { liveRows } = drawerRows({ live, draining: i.draining ?? [], past: [], openClaudeIds });
  const macRows: StackRow[] = liveRows
    .filter((c) => c.vault === i.vault)
    .map((c) => ({
      kind: 'mac', key: `mac:${c.conversationId}`, id: c.conversationId, chat: c, title: c.title,
      dot: c.state === 'asking' ? 'asking' : c.state === 'working' ? 'working' : 'ready',
      stateKey: liveStateKey(c.state), waiting: c.state === 'asking', lastLine: c.lastLine ?? '',
    }));
  const all = [...tabRows, ...macRows];
  // Waiting first; Array.prototype.sort is stable, so the rest keep tab order, then Mac order.
  return all.sort((a, b) => Number(b.waiting) - Number(a.waiting));
}

/** Every conversation id a tab holds, live or roster. */
export function heldIds(tabs: readonly StackTab[]): string[] {
  return tabs.flatMap((t) => [t.claudeId, t.altClaudeId]).filter((x): x is string => !!x);
}

/** What a tap on a row does. */
export function stackTap(row: StackRow): { select: { paneId: string; id: string } } | { adopt: LiveChatWire } {
  return row.kind === 'tab' ? { select: { paneId: row.paneId, id: row.id } } : { adopt: row.chat };
}

const clip = (t: string, max = 140): string => {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * The one line a phone tab's row shows: what it waits on (the question, or the tool asking
 * permission), else the last line of the newest assistant text, else the newest message you sent.
 */
export function chatLastLine(m: Pick<ConversationModel, 'items' | 'history' | 'pending'>): string {
  const ask = m.pending[0];
  if (ask) {
    if (ask.kind === 'question') return clip(ask.questions[0]?.question ?? ask.title ?? '');
    if (ask.kind === 'permission') return clip(ask.displayName || ask.toolName);
    return clip(ask.toolName);
  }
  const all = m.items.length ? m.items : m.history;
  for (let k = all.length - 1; k >= 0; k--) {
    const it = all[k];
    if (it.kind === 'text' || it.kind === 'user') {
      const lines = it.text.split('\n').map((l) => l.trim()).filter(Boolean);
      const line = lines[lines.length - 1];
      if (line) return clip(line);
    }
  }
  return '';
}
