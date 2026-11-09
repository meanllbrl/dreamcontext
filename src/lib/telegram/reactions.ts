/**
 * Telegram reactions (owner 2026-11-09): a reaction the OWNER puts on a bot's message reaches
 * that bot's agent as a NOTE, never as an answer to a question and never as an approval.
 *
 * - The hub asks Telegram for `message_reaction` (TG_ALLOWED_UPDATES) and passes every update
 *   through the same `isAuthorized` gate as a message: only the paired owner's reactions count.
 * - A note never opens a turn, never owes a reply, never answers a card: it waits here, in
 *   memory, and rides the agent's NEXT turn as one server-written block (the Super: a
 *   `<telegram-reactions>` block beside his words or on an event turn; a member: lines in front
 *   of his next Telegram message). A block starting with `<` never shows in his replay.
 * - Collapsing: one note per reacted message, the latest reaction wins; a removed reaction
 *   (empty `new_reaction`) drops that message's note. At most MAX_NOTES per agent, oldest out.
 *   A note older than NOTE_TTL_MS is old news and is dropped.
 * - The quote is what we sent (the hub's reply map), as JSON-quoted DATA; unmapped → no quote.
 */
import { stripSentinels } from './contract.js';
import { neutraliseHeaders } from './inbound.js';

export const REACTION_QUOTE_MAX = 80;
export const MAX_NOTES = 8;
export const NOTE_TTL_MS = 24 * 60 * 60 * 1000;
export const REACTION_BLOCK_OPEN = '<telegram-reactions>';
export const REACTION_BLOCK_CLOSE = '</telegram-reactions>';

/** What a reaction note means, said once in the Super briefing and inside every note. */
export const REACTION_MEANING = 'A `[telegram reaction]` line is the owner reacting with an emoji to one of your Telegram messages: he saw it (and liked it, for a positive emoji). It is a note, never an answer to a question, never an approval of anything; no reply is needed unless it changes something.';

export interface ParsedReaction {
  chatId: number;
  userId: number;
  messageId: number;
  /** The new reaction's emojis; empty = removed. */
  emojis: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

/** One emoji as Telegram sends it, kept only when it is short and pictographic (data, never text). */
const EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️❤]{1,16}$/u;

function emojiOf(r: unknown): string | null {
  const o = obj(r);
  if (!o) return null;
  if (o.type === 'emoji' && typeof o.emoji === 'string') return EMOJI_RE.test(o.emoji) ? o.emoji : '⭐';
  if (o.type === 'custom_emoji' || o.type === 'paid') return '⭐';
  return null;
}

/** A `message_reaction` update, normalised; null for anything else or a malformed one. */
export function parseReaction(update: Obj): ParsedReaction | null {
  const r = obj(update.message_reaction);
  if (!r) return null;
  const chat = obj(r.chat);
  const user = obj(r.user);
  const chatId = chat?.id;
  const userId = user?.id;
  const messageId = r.message_id;
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(userId) || !Number.isSafeInteger(messageId)) return null;
  const list = Array.isArray(r.new_reaction) ? r.new_reaction : [];
  const emojis = list.map(emojiOf).filter((e): e is string => !!e).slice(0, 3);
  return { chatId: chatId as number, userId: userId as number, messageId: messageId as number, emojis };
}

interface Note { messageId: number; emojis: string[]; quote: string | null; at: number }

/** A short, safe quote of what we sent: one line, at most REACTION_QUOTE_MAX characters. */
export function shortQuote(text: string): string {
  const one = neutraliseHeaders(stripSentinels(text)).replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > REACTION_QUOTE_MAX ? `${one.slice(0, REACTION_QUOTE_MAX - 1)}…` : one;
}

/** One line per note: `[telegram reaction] 👍 on: "<quote>"` (no quote when unmapped). */
export function reactionLine(n: Pick<Note, 'emojis' | 'quote'>): string {
  // `<` escaped: a quote can never close the block it rides in.
  const q = n.quote ? JSON.stringify(n.quote).replace(/</g, '\\u003c') : null;
  return `[telegram reaction] ${n.emojis.join('')}${q ? ` on: ${q}` : ' on one of your messages'}`;
}

/** Notes waiting for an agent's next turn, keyed by the agent (a Super session id, a member binding). */
export class ReactionNotes {
  private byKey = new Map<string, Note[]>();

  /** A reaction (or its removal) on one message. */
  add(key: string, messageId: number, emojis: readonly string[], quote: string | null, now: number = Date.now()): void {
    const list = (this.byKey.get(key) ?? []).filter((n) => n.messageId !== messageId && now - n.at < NOTE_TTL_MS);
    if (emojis.length) list.push({ messageId, emojis: [...emojis], quote: quote ? shortQuote(quote) || null : null, at: now });
    if (list.length) this.byKey.set(key, list.slice(-MAX_NOTES));
    else this.byKey.delete(key);
    if (this.byKey.size > 200) this.byKey.delete(this.byKey.keys().next().value as string);
  }

  has(key: string): boolean { return (this.byKey.get(key)?.length ?? 0) > 0; }

  /** The waiting lines, removed; empty when none. */
  take(key: string, now: number = Date.now()): string[] {
    const list = this.byKey.get(key) ?? [];
    this.byKey.delete(key);
    return list.filter((n) => now - n.at < NOTE_TTL_MS).map(reactionLine);
  }

  clear(): void { this.byKey.clear(); }
}

/** The process-wide store: the hub adds, the Super's turn writer and the member path take. */
export const telegramReactionNotes = new ReactionNotes();

/** The Super's block for its next turn, or null: taken (each note told once). */
export function takeSuperReactionBlock(sessionId: string, now: number = Date.now()): string | null {
  const lines = telegramReactionNotes.take(`super:${sessionId}`, now);
  if (!lines.length) return null;
  return [REACTION_BLOCK_OPEN, ...lines, REACTION_BLOCK_CLOSE].join('\n');
}

/** A member's lines for its next Telegram message (the meaning said inline: members get no Super briefing), or null. */
export function takeMemberReactionText(bindingKey: string, now: number = Date.now()): string | null {
  const lines = telegramReactionNotes.take(`member:${bindingKey}`, now);
  if (!lines.length) return null;
  return [...lines, `(${REACTION_MEANING})`].join('\n');
}
