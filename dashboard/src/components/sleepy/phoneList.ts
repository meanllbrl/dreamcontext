import type { LiveChatWire, LiveChatsWire, SuperChatWire } from '../handsfree/macContract';
import { activeStateKey, drawerRows, liveStateKey } from './drawerRows';
import { heldIds, type StackTab } from './phoneStack';

/**
 * The open chat rows of one project (a device shell's drawer, through `homeRows`): this phone's
 * tabs and the Mac's running chats, each once (the drawer's AC18 rule: a Mac chat held by a tab here
 * is the tab's row, a draining conversation is never a row), waiting first, then working, then the
 * rest, each group in its own order. Plus the search folding History uses and the Super row.
 */

export type OpenRow =
  | { kind: 'tab'; key: string; id: string; paneId: string; title: string; dot: string; stateKey: string | null; label: string; waiting: boolean; rank: number }
  | { kind: 'mac'; key: string; id: string; chat: LiveChatWire; title: string | null; dot: string; stateKey: string; waiting: boolean; rank: number; lastLine: string };

/** 0 waiting, 1 working, 2 anything else. */
function rankOf(kind: string): number {
  if (kind === 'asking') return 0;
  if (kind === 'working' || kind === 'starting') return 1;
  return 2;
}

export function openRows(i: { tabs: readonly StackTab[]; live: readonly LiveChatWire[]; draining?: readonly string[]; vault: string }): OpenRow[] {
  const tabRows: OpenRow[] = i.tabs.map((t) => {
    // A tab whose chat another screen holds (the Mac's window, 4409) says what the Mac says: a
    // question waiting there waits on the owner here too (hands-free sekmeler W3).
    const there = i.live.find((c) => c.conversationId === t.claudeId || (!!t.altClaudeId && c.conversationId === t.altClaudeId));
    const asksThere = there?.state === 'asking' && t.info.kind !== 'asking' && t.info.kind !== 'working';
    const kind = asksThere ? 'asking' : t.info.kind;
    return {
      kind: 'tab', key: `tab:${t.id}`, id: t.id, paneId: t.paneId, title: t.title, dot: kind,
      stateKey: asksThere ? liveStateKey('asking') : activeStateKey(t.info), label: t.info.label, waiting: kind === 'asking', rank: rankOf(kind),
    };
  });
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

/**
 * The handed-over Super Agent's row for THIS project, or null. It stands beside the project's own
 * chats, never in their place.
 */
export function superRowFor(live: Pick<LiveChatsWire, 'supers'> | undefined, vault: string): SuperChatWire | null {
  return live?.supers?.find((x) => x.vault === vault) ?? null;
}

/**
 * A tap on the Super Agent's row: a tab of this phone already holding its conversation is
 * selected; else it is opened (as a mirror, never adopted) while the Mac runs it; a row the Mac
 * runs no super chat for does nothing.
 */
export function superTap(row: SuperChatWire, tabs: readonly StackTab[]):
  | { select: { paneId: string; id: string } } | { open: SuperChatWire } | null {
  const held = tabs.find((x) => x.claudeId === row.conversationId || x.altClaudeId === row.conversationId);
  if (held) return { select: { paneId: held.paneId, id: held.id } };
  return row.live ? { open: row } : null;
}
