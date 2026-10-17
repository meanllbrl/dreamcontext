import type { LiveChatWire } from '../handsfree/macContract';
import type { PastSession } from './ChatHistoryPicker';
import type { ConversationModel } from './chatSession';
import { activeStateKey, drawerRows, liveStateKey } from './drawerRows';
import { heldIds, type StackTab } from './phoneStack';

/**
 * The phone's home, the Sohbetler list (AC21-AC22): every chat of the project in two sections,
 * Açık (this phone's tabs and the Mac's running chats, each once) and Kapalı (past chats), with
 * a search and an Açık / Kapalı filter. Its rules are plain functions, tested without React:
 *
 * - one conversation is one row (the drawer's AC18 rule): a Mac chat held by a tab here is the
 *   tab's row, a running or draining conversation is never a closed row;
 * - Açık sorts by what it needs from you: waiting, then working, then the rest, each group in
 *   its own order;
 * - a tap opens a tab, ADOPTS a Mac chat (never a resume beside it), or resumes a closed one.
 */

export type ListFilter = 'all' | 'open' | 'closed';

export type OpenRow =
  | { kind: 'tab'; key: string; id: string; paneId: string; title: string; dot: string; stateKey: string | null; label: string; waiting: boolean; rank: number }
  | { kind: 'mac'; key: string; id: string; chat: LiveChatWire; title: string | null; dot: string; stateKey: string; waiting: boolean; rank: number; lastLine: string };

export interface ClosedRow { kind: 'past'; key: string; id: string; past: PastSession; title: string; line: string; updatedAt: number }

/** 0 waiting, 1 working, 2 anything else. */
function rankOf(kind: string): number {
  if (kind === 'asking') return 0;
  if (kind === 'working' || kind === 'starting') return 1;
  return 2;
}

export function openRows(i: { tabs: readonly StackTab[]; live: readonly LiveChatWire[]; draining?: readonly string[]; vault: string }): OpenRow[] {
  const tabRows: OpenRow[] = i.tabs.map((t) => ({
    kind: 'tab', key: `tab:${t.id}`, id: t.id, paneId: t.paneId, title: t.title, dot: t.info.kind,
    stateKey: activeStateKey(t.info), label: t.info.label, waiting: t.info.kind === 'asking', rank: rankOf(t.info.kind),
  }));
  const openClaudeIds = heldIds(i.tabs);
  // A draining (or just-closed) conversation is on its way out: never a row to adopt.
  const live = i.live.filter((c) => !(i.draining ?? []).includes(c.conversationId));
  const { liveRows } = drawerRows({ live, draining: i.draining ?? [], past: [], openClaudeIds });
  const macRows: OpenRow[] = liveRows
    .filter((c) => c.vault === i.vault)
    .map((c) => {
      const dot = c.state === 'asking' ? 'asking' : c.state === 'working' ? 'working' : 'ready';
      return {
        kind: 'mac', key: `mac:${c.conversationId}`, id: c.conversationId, chat: c, title: c.title, dot,
        stateKey: liveStateKey(c.state), waiting: c.state === 'asking', rank: rankOf(dot), lastLine: c.lastLine ?? '',
      };
    });
  // Array.prototype.sort is stable: within a rank, tabs keep their order, then the Mac's.
  return [...tabRows, ...macRows].sort((a, b) => a.rank - b.rank);
}

export function closedRows(i: { past: readonly PastSession[]; live: readonly LiveChatWire[]; draining?: readonly string[]; openClaudeIds: readonly string[] }): ClosedRow[] {
  const { pastRows } = drawerRows({ live: i.live, draining: i.draining ?? [], past: i.past, openClaudeIds: i.openClaudeIds });
  return pastRows.map((p) => ({
    kind: 'past', key: `past:${p.id}`, id: p.id, past: p, title: p.title,
    // The hit's line, unless it only repeats the title (which is marked already): then the last message.
    line: (p.match && p.match !== p.title ? p.match : '') || p.preview || '', updatedAt: p.updatedAt,
  }));
}

/**
 * Case folding for search, Turkish-aware and LENGTH-PRESERVING: İ, I and ı all fold to i, so
 * "istanbul" finds "İstanbul" and "ışık" finds "IŞIK" (a default toLowerCase turns İ into i plus
 * a combining dot, which then matches nothing). Same length, so an index into the folded text
 * cuts the original. Mirrored in src/lib/transcript-sessions.ts (drift test in phone-chat-list).
 */
export function foldCase(s: string): string {
  return s.replace(/[İIı]/g, 'i').toLowerCase();
}

/** The query's words, folded; every one must appear (AND), as on the Mac. */
export function queryTokens(q: string): string[] {
  return foldCase(q).split(/\s+/).filter(Boolean);
}

/** Does an open row match? Its title, its last line and (for a tab here) its loaded text. */
export function openMatches(tokens: readonly string[], ...texts: string[]): boolean {
  if (!tokens.length) return true;
  const hay = foldCase(texts.join('\n'));
  return tokens.every((t) => hay.includes(t));
}

/**
 * What the chips show and what the list holds. `closedTotal` is the Mac's count of matching
 * past chats; the ones open here or running there are not closed, so they come off it.
 */
export function listView<O, C>(i: { open: readonly O[]; closed: readonly C[]; closedTotal: number; closedDropped: number; filter: ListFilter }): {
  open: readonly O[]; closed: readonly C[]; counts: Record<ListFilter, number>;
} {
  const closedCount = Math.max(i.closed.length, i.closedTotal - i.closedDropped);
  return {
    open: i.filter === 'closed' ? [] : i.open,
    closed: i.filter === 'open' ? [] : i.closed,
    counts: { all: i.open.length + closedCount, open: i.open.length, closed: closedCount },
  };
}

/** `text` cut into runs, the query's (folded) words marked wherever the folded text holds them. */
export function highlight(text: string, tokens: readonly string[]): Array<{ text: string; hit: boolean }> {
  const words = tokens.map(foldCase).filter(Boolean);
  const folded = foldCase(text);
  // foldCase keeps the length for every script a title is written in; if it ever does not, mark nothing.
  if (!words.length || !text || folded.length !== text.length) return [{ text, hit: false }];
  const hit = new Uint8Array(text.length);
  for (const w of words) {
    for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length)) hit.fill(1, at, at + w.length);
  }
  const runs: Array<{ text: string; hit: boolean }> = [];
  let from = 0;
  for (let k = 1; k <= text.length; k++) {
    if (k === text.length || hit[k] !== hit[from]) { runs.push({ text: text.slice(from, k), hit: hit[from] === 1 }); from = k; }
  }
  return runs;
}

/** What a tap on a row does. */
export function listTap(row: OpenRow | ClosedRow):
  | { select: { paneId: string; id: string } } | { adopt: LiveChatWire } | { resume: PastSession } {
  if (row.kind === 'tab') return { select: { paneId: row.paneId, id: row.id } };
  if (row.kind === 'mac') return { adopt: row.chat };
  return { resume: row.past };
}

/** The time of a loaded conversation's newest item (epoch ms), or null. */
export function chatLastTs(m: Pick<ConversationModel, 'items' | 'history'>): number | null {
  const all = m.items.length ? m.items : m.history;
  for (let k = all.length - 1; k >= 0; k--) {
    const ts = (all[k] as { ts?: number }).ts;
    if (typeof ts === 'number' && ts > 0) return ts;
  }
  return null;
}

/** A loaded conversation's searchable text: every message and answer, bounded. */
export function chatSearchText(m: Pick<ConversationModel, 'items' | 'history'>, max = 60_000): string {
  let out = '';
  for (const it of [...m.history, ...m.items]) {
    if (it.kind === 'user' || it.kind === 'text') out += `${it.text}\n`;
    if (out.length > max) break;
  }
  return out.slice(0, max);
}

/** "now", "5m", "2h", "3d" — in the units the list reads at a glance. */
export function ageLabel(ms: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - ms) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`;
}
