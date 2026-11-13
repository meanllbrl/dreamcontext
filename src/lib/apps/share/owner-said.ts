/**
 * "He already said yes, here" (owner 2026-11-13, app-kurulum-claude ek-3): an install the owner
 * asked for or approved in his OWN words, in the chat that asks, needs no second click.
 *
 * The proof is the owner-words ledger (src/lib/owner-words.ts), which only the server writes, from
 * what he typed in the composer, the phone or Telegram: never a child's text, a page, an app or a
 * forwarded quote. The agent passes his words; this finds them in a turn of THIS conversation (a
 * shared id with the caller's chat), typed in the last {@link OWNER_SAID_WINDOW_MS}. The agent's
 * own claim decides nothing: no turn, no approval (the card is shown instead).
 *
 * A short "onaylıyorum" or "kur" must count, so the test is containment of the normalized words in
 * the normalized turn, on word boundaries; not the 2-term quote test `learn` uses.
 */
import { readOwnerTurns, sameConversation, type OwnerTurnLine } from '../../owner-words.js';

export const OWNER_SAID_WINDOW_MS = 30 * 60_000;
/** Shorter than this proves nothing ("e", "ok" would sit inside anything). */
const MIN_CHARS = 3;

export function normalizeWords(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** His words, word-bounded, inside one turn's text. */
export function wordsIn(words: string, own: string): boolean {
  const w = normalizeWords(words);
  if (w.length < MIN_CHARS) return false;
  return ` ${normalizeWords(own)} `.includes(` ${w} `);
}

export interface OwnerSaidQuery {
  home?: string;
  /** Realpath of the project root the chat runs in (the ledger's `vault`). */
  projectRoot: string;
  /** The caller's chat ids (tab pin id, agent session id), from the request headers. */
  sessions: readonly string[];
  words: string;
  now?: number;
}

/** The turn of this conversation, in the window, whose own text holds the words; else null. */
export function ownerSaidHere(q: OwnerSaidQuery): OwnerTurnLine | null {
  if (!q.sessions.length || !q.words.trim()) return null;
  const now = q.now ?? Date.now();
  const since = new Date(now - OWNER_SAID_WINDOW_MS).toISOString();
  const turns = readOwnerTurns({ home: q.home, since, vault: q.projectRoot });
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (Date.parse(t.at) > now + 60_000) continue;
    if (!sameConversation(q.sessions, t.keys)) continue;
    if (wordsIn(q.words, t.own)) return t;
  }
  return null;
}
