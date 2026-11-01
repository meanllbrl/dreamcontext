import type { LiveChatWire, LiveChatsWire, SuperChatWire } from '../handsfree/macContract';
import { openRows, superRowFor, type OpenRow } from './phoneList';
import type { StackTab } from './phoneStack';

/**
 * Every chat row over the chosen projects, for a device shell's drawer and the phone's chat
 * screen (swipe, waiting toast, the drawer toggle's count). Pure: every rule here is tested without
 * React (phone-home.test.ts, device-shell.test.ts).
 *
 * - The project the phone is in contributes its open tabs and the Mac's running chats, each once.
 * - Every other chosen project contributes the Mac's running chats (from the one `live-chats`
 *   answer, which already spans the chosen projects) and the tabs this window has mounted there.
 * - A handed-over project also contributes its ONE Super row (`superRowFor`): the Super Agent and
 *   the owner's chats live side by side. A tab holding the Super's conversation or one of its
 *   children's is the Super's, never one of the owner's rows.
 *
 * Past chats are not rows: History lists them.
 */

export const HOME_SECTIONS = ['waiting', 'working', 'idle'] as const;
export type HomeSection = typeof HOME_SECTIONS[number];

export type HomeRow =
  | { key: string; vault: string; section: HomeSection; title: string; line: string; updatedAt: number | null; kind: 'open'; row: OpenRow }
  | { key: string; vault: string; section: HomeSection; title: string; line: string; updatedAt: number | null; kind: 'super'; row: SuperChatWire };

const sectionOf = (dot: string): HomeSection => (dot === 'asking' ? 'waiting' : dot === 'working' || dot === 'starting' ? 'working' : 'idle');
const liveSection = (state: LiveChatWire['state']): HomeSection => (state === 'asking' ? 'waiting' : state === 'working' ? 'working' : 'idle');

export interface HomeInput {
  /** The project this phone is in, and its open tabs. */
  vault: string;
  tabs: readonly StackTab[];
  /** Other projects this window has mounted, and their open tabs (the new shell's drawer). */
  otherTabs?: Readonly<Record<string, readonly StackTab[] | undefined>>;
  /** The chosen projects, in their order. */
  projects: readonly string[];
  live: LiveChatsWire | undefined;
}

/** Every row of every chosen project, in section order (waiting → working → idle);
 *  within a section the active project's rows first, then each project in its order. */
export function homeRows(i: HomeInput): HomeRow[] {
  const chats = i.live?.chats ?? [];
  const draining = i.live?.draining ?? [];
  const rows: HomeRow[] = [];
  const order = [i.vault, ...i.projects.filter((p) => p !== i.vault)];
  for (const vault of order) {
    const superRow = superRowFor(i.live, vault);
    if (superRow) {
      rows.push({
        key: `super:${vault}`, vault, kind: 'super', row: superRow, title: '', line: superRow.lastLine ?? '',
        section: superRow.live ? liveSection(superRow.state) : 'idle', updatedAt: superRow.updatedAt,
      });
    }
    const theirs = new Set(superRow ? [superRow.conversationId, ...superRow.childIds] : []);
    const held = (t: StackTab) => theirs.has(t.claudeId ?? '') || (!!t.altClaudeId && theirs.has(t.altClaudeId));
    const tabs = (vault === i.vault ? i.tabs : (i.otherTabs?.[vault] ?? [])).filter((t) => !held(t));
    for (const r of openRows({ tabs, live: chats, draining, vault })) {
      rows.push({
        key: `${vault}:${r.key}`, vault, kind: 'open', row: r, title: r.title ?? '',
        line: r.kind === 'mac' ? r.lastLine : '', section: sectionOf(r.dot),
        updatedAt: r.kind === 'mac' ? r.chat.updatedAt : null,
      });
    }
  }
  // Stable: within a section the projects keep their order and each project its own.
  return rows.sort((a, b) => HOME_SECTIONS.indexOf(a.section) - HOME_SECTIONS.indexOf(b.section));
}

/** The OPEN rows a swipe moves through, in the list's order across projects. */
export function swipeRows(rows: readonly HomeRow[]): HomeRow[] {
  return rows.filter((r) => !(r.kind === 'super' && !r.row.live));
}

/**
 * The open chat next to `currentKey` in the list's order: `1` the next (a swipe left), `-1` the
 * previous (a swipe right). Null at either end, or when the current chat is not in the list.
 */
export function swipeTarget(rows: readonly HomeRow[], currentKey: string | null, dir: 1 | -1): HomeRow | null {
  const open = swipeRows(rows);
  const at = open.findIndex((r) => r.key === currentKey);
  if (at < 0) return null;
  return open[at + dir] ?? null;
}

/**
 * The one-line toast: the newest chat that STARTED waiting since the last look (`seen`: the keys
 * that were waiting then), never the one on screen. Null when none did.
 */
export function newlyWaiting(rows: readonly HomeRow[], seen: ReadonlySet<string>, currentKey: string | null): HomeRow | null {
  const fresh = rows.filter((r) => r.section === 'waiting' && r.key !== currentKey && !seen.has(r.key));
  return fresh.length ? fresh[fresh.length - 1] : null;
}
