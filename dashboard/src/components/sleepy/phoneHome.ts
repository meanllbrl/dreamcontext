import type { LiveChatWire, LiveChatsWire, SuperChatWire } from '../handsfree/macContract';
import type { PastSession } from './ChatHistoryPicker';
import { closedRows, openRows, superRowFor, type ClosedRow, type OpenRow } from './phoneList';
import { heldIds, type StackTab } from './phoneStack';

/**
 * The phone's ONE list over every chosen project (hands-free sekmeler W3, owner D1: direction B):
 * Seni bekliyor / Çalışıyor / Boşta / Kapalı, each row tagged with its project, a search over all
 * of them, "Proje ▾" narrowing. No new home page and no bottom tab bar: it is the Sohbetler list,
 * widened. Pure: every rule here is tested without React (phone-home.test.ts).
 *
 * - The project the phone is in contributes its rows as today (`openRows`, `closedRows`): its own
 *   tabs and the Mac's running chats, each once, and its past chats.
 * - Every other chosen project contributes the Mac's running chats (from the one `live-chats`
 *   answer, which already spans the chosen projects) and its past chats.
 * - A handed-over project contributes its ONE Super row and nothing else (`superRowFor`).
 */

export const HOME_SECTIONS = ['waiting', 'working', 'idle', 'closed'] as const;
export type HomeSection = typeof HOME_SECTIONS[number];

export type HomeRow =
  | { key: string; vault: string; section: HomeSection; title: string; line: string; updatedAt: number | null; kind: 'open'; row: OpenRow }
  | { key: string; vault: string; section: 'closed'; title: string; line: string; updatedAt: number | null; kind: 'closed'; row: ClosedRow }
  | { key: string; vault: string; section: HomeSection; title: string; line: string; updatedAt: number | null; kind: 'super'; row: SuperChatWire };

const sectionOf = (dot: string): HomeSection => (dot === 'asking' ? 'waiting' : dot === 'working' || dot === 'starting' ? 'working' : 'idle');
const liveSection = (state: LiveChatWire['state']): HomeSection => (state === 'asking' ? 'waiting' : state === 'working' ? 'working' : 'idle');

export interface HomeInput {
  /** The project this phone is in, and its open tabs. */
  vault: string;
  tabs: readonly StackTab[];
  /** The chosen projects, in their order. */
  projects: readonly string[];
  live: LiveChatsWire | undefined;
  /** Each project's past chats (its own `chat-sessions` answer). */
  pastByVault: Readonly<Record<string, readonly PastSession[] | undefined>>;
}

/** Every row of every chosen project, in section order (waiting → working → idle → closed);
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
      continue;
    }
    const tabs = vault === i.vault ? i.tabs : [];
    for (const r of openRows({ tabs, live: chats, draining, vault })) {
      rows.push({
        key: `${vault}:${r.key}`, vault, kind: 'open', row: r, title: r.title ?? '',
        line: r.kind === 'mac' ? r.lastLine : '', section: sectionOf(r.dot),
        updatedAt: r.kind === 'mac' ? r.chat.updatedAt : null,
      });
    }
    const held = heldIds(tabs);
    for (const r of closedRows({ past: i.pastByVault[vault] ?? [], live: chats, draining, openClaudeIds: held })) {
      rows.push({ key: `${vault}:${r.key}`, vault, kind: 'closed', row: r, title: r.title, line: r.line, section: 'closed', updatedAt: r.updatedAt });
    }
  }
  // Stable: within a section the projects keep their order and each project its own.
  return rows.sort((a, b) => HOME_SECTIONS.indexOf(a.section) - HOME_SECTIONS.indexOf(b.section));
}

/** The rows grouped by section, empty sections left out. */
export function homeSections(rows: readonly HomeRow[]): Array<{ section: HomeSection; rows: HomeRow[] }> {
  return HOME_SECTIONS.map((section) => ({ section, rows: rows.filter((r) => r.section === section) })).filter((s) => s.rows.length > 0);
}

/** "Proje ▾": only this project's rows (null: every project). */
export function narrowTo(rows: readonly HomeRow[], project: string | null): HomeRow[] {
  return project ? rows.filter((r) => r.vault === project) : [...rows];
}

/** The conversation a row stands for (a tab's or the Mac's chat, a past chat, the Super). */
export function rowConversation(r: HomeRow): string {
  if (r.kind === 'super') return r.row.conversationId;
  if (r.kind === 'closed') return r.row.id;
  return r.row.kind === 'tab' ? r.row.id : r.row.chat.conversationId;
}

/** The OPEN rows a swipe moves through, in the list's order across projects. */
export function swipeRows(rows: readonly HomeRow[]): HomeRow[] {
  return rows.filter((r) => r.kind !== 'closed' && !(r.kind === 'super' && !r.row.live));
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

/** The back button's badge: chats waiting on the owner other than the one on screen. */
export function waitingElsewhere(rows: readonly HomeRow[], currentKey: string | null): number {
  return rows.filter((r) => r.section === 'waiting' && r.key !== currentKey).length;
}

/**
 * The one-line toast: the newest chat that STARTED waiting since the last look (`seen`: the keys
 * that were waiting then), never the one on screen. Null when none did.
 */
export function newlyWaiting(rows: readonly HomeRow[], seen: ReadonlySet<string>, currentKey: string | null): HomeRow | null {
  const fresh = rows.filter((r) => r.section === 'waiting' && r.key !== currentKey && !seen.has(r.key));
  return fresh.length ? fresh[fresh.length - 1] : null;
}
