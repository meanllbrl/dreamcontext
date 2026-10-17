import { splitCard } from '../task-card.js';
import {
  appendJournalEntry,
  normalizeEntryText,
  readJournal,
  splitEntryTexts,
  type JournalEntry,
  type JournalKind,
} from '../task-journal.js';

/**
 * A task journal over a remote backend (GitHub issue comments, ClickUp task
 * comments).
 *
 * The ledger remembers, per task, which journal entries this machine has
 * already sent or received (`posted_journal_ids`) and which remote comment is
 * which entry (`comment_entry_ids`). Push sends only the shareable kinds not
 * sent yet, each carrying a hidden `<!-- je:<id> -->` marker; pull recognises a
 * comment by that marker first (only ids this machine posted — a marker it
 * never posted is plain text), then by normalised text (so comments posted
 * before the journal existed match their migrated entries), and writes anything
 * else as a `remote` entry by `remote:<login>`. Evidence and sleep entries never
 * leave the machine: an evidence tail is machine output, and sleep notes are
 * the agent talking to itself.
 */

export const SHARED_KINDS: ReadonlySet<JournalKind> = new Set<JournalKind>(['log', 'status', 'approval']);

const MARKER_RE = /<!--\s*je:([A-Za-z0-9_-]+)\s*-->/;

export interface RemoteComment {
  id: string;
  body: string;
  author: string | null;
  createdAt: string | null;
}

export interface JournalSyncState {
  posted: Set<string>;
  commentMap: Record<string, string>;
}

export function journalSyncState(entry: { posted_journal_ids?: string[]; comment_entry_ids?: Record<string, string> } | undefined | null): JournalSyncState {
  return {
    posted: new Set(entry?.posted_journal_ids ?? []),
    commentMap: { ...(entry?.comment_entry_ids ?? {}) },
  };
}

export function journalSyncPatch(state: JournalSyncState): { posted_journal_ids: string[]; comment_entry_ids: Record<string, string> } {
  return { posted_journal_ids: [...state.posted].sort(), comment_entry_ids: state.commentMap };
}

/** The comment body for an entry: its text plus the identity marker. */
export function commentBodyFor(e: JournalEntry): string {
  return `${e.text}\n\n<!-- je:${e.id} -->`;
}

/** Entries to send, oldest first: shareable kind and not yet posted. */
export function entriesToPost(entries: JournalEntry[], posted: Set<string>): JournalEntry[] {
  return entries.filter((e) => SHARED_KINDS.has(e.kind) && !posted.has(e.id)).reverse();
}

/**
 * Seed `posted` from a pre-journal base snapshot: the old ledger's base was the
 * whole task file, Changelog included, so every entry text in it had been
 * posted. Copy-counted (two identical entries need two identical base texts).
 * Returns the ids it marked.
 */
export function seedPostedFromBase(entries: JournalEntry[], baseBody: string | null | undefined, posted: Set<string>): string[] {
  if (!baseBody) return [];
  const want = new Map<string, number>();
  for (const t of splitEntryTexts(splitCard(baseBody).journal)) {
    const n = normalizeEntryText(t);
    want.set(n, (want.get(n) ?? 0) + 1);
  }
  const marked: string[] = [];
  // Oldest first, so the copies a base holds are the oldest ones.
  for (const e of [...entries].reverse()) {
    const n = normalizeEntryText(e.text);
    const left = want.get(n) ?? 0;
    if (left <= 0) continue;
    want.set(n, left - 1);
    if (!posted.has(e.id)) {
      posted.add(e.id);
      marked.push(e.id);
    }
  }
  return marked;
}

/**
 * A pulled comment can never forge entry structure: `###` lines are demoted and
 * fence lines escaped, so an unclosed fence cannot swallow the older entries.
 */
function asRemoteBody(body: string): string {
  // Trim BEFORE the per-line pass (a trim after it could pull an indented
  // `###` to column 0), and demote a heading however it is indented.
  return body
    .replace(new RegExp(MARKER_RE.source, 'g'), '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((l) => (/^\s*###\s/.test(l) ? `#${l.trimStart()}` : /^\s*(```|~~~)/.test(l) ? `\\${l}` : l))
    .join('\n');
}

/**
 * Fold remote comments (oldest first) into the journal. The caller holds the
 * task's file lock. Mutates `state`; returns how many entries were added.
 */
export function applyRemoteComments(
  stateDir: string,
  slug: string,
  comments: RemoteComment[],
  state: JournalSyncState,
): number {
  const entries = readJournal(stateDir, slug);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const claimed = new Set(Object.values(state.commentMap));
  const pool = new Map<string, JournalEntry[]>();
  for (const e of [...entries].reverse()) {
    if (claimed.has(e.id)) continue;
    const n = normalizeEntryText(e.text);
    const list = pool.get(n) ?? [];
    list.push(e);
    pool.set(n, list);
  }

  let added = 0;
  for (const c of comments) {
    const text = c.body.trim();
    if (!text || state.commentMap[c.id]) continue;
    const marker = MARKER_RE.exec(text);
    if (marker && state.posted.has(marker[1]) && byId.has(marker[1])) {
      state.commentMap[c.id] = marker[1];
      continue;
    }
    const match = pool.get(normalizeEntryText(text))?.shift();
    if (match) {
      state.commentMap[c.id] = match.id;
      state.posted.add(match.id);
      continue;
    }
    const at = c.createdAt ? new Date(c.createdAt) : undefined;
    const written = appendJournalEntry(stateDir, slug, {
      kind: 'remote',
      actor: `remote:${(c.author ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '') || 'unknown'}`,
      body: asRemoteBody(text),
      ...(at && !Number.isNaN(at.getTime()) ? { now: at } : {}),
    });
    state.commentMap[c.id] = written.id;
    state.posted.add(written.id);
    added++;
  }
  return added;
}

/** True when the journal holds shareable entries the remote has not seen. */
export function hasUnpostedEntries(stateDir: string, slug: string, posted: Set<string>): boolean {
  return entriesToPost(readJournal(stateDir, slug), posted).length > 0;
}
