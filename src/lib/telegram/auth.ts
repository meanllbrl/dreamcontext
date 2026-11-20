/**
 * Who may talk to a bound bot, and how a bot gets bound.
 *
 * `isAuthorized` is the ONE gate the hub and the tick share (plan "Auth on every update"): the
 * paired private chat, the paired user, not a bot. Everyone else gets nothing and is counted.
 *
 * Pairing (B4, A1, C4): the bind POST mints a 128-bit single-use payload (10 min) and a
 * 128-bit pairingId, both only in that response. The first private, non-bot sender of
 * `/start <payload>` becomes a PENDING user; only the native confirm (Rust, with the owner key)
 * activates it, and only if pairingId, botId and userId still match. A new mint for the target
 * voids the previous pairing. Five wrong payloads from one sender → that sender is ignored for
 * the TTL (per sender, A1). A bare `/start` changes nothing (C4). Comparisons are constant-time.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PAIRING_ID_RE, PAIRING_MAX_WRONG, PAIRING_TTL_MS, type TelegramScope, type TelegramTarget } from './contract.js';

// ─── Update shapes (the fields the gate reads) ──────────────────────────────

export interface TgChat { id: number; type: string; username?: string; first_name?: string; title?: string }
export interface TgFrom { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string }
export interface TgEntity { type: string; offset: number; length: number; user?: TgFrom }
export interface TgMessageLike {
  message_id?: number; chat?: TgChat; from?: TgFrom; text?: string; date?: number;
  /** Set when the message is sent on behalf of a chat (an anonymous admin, a linked channel). */
  sender_chat?: TgChat;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: TgMessageLike;
}
export interface TgUpdateLike {
  update_id: number;
  message?: TgMessageLike;
  callback_query?: { id: string; from?: TgFrom; data?: string; message?: TgMessageLike };
  /** A reaction change (`message_reaction`): `user` is who reacted; an anonymous reaction
   *  (`actor_chat`, no `user`) has no sender and never passes the gate. */
  message_reaction?: { chat?: TgChat; message_id?: number; user?: TgFrom; actor_chat?: TgChat };
}

/** The paired identity the gate checks against. */
export interface PairedIdentity { chatId: number; userId: number }

/** The sender and chat of an update, wherever they sit. */
export function senderOf(update: TgUpdateLike): { from: TgFrom | null; chat: TgChat | null } {
  if (update.message) return { from: update.message.from ?? null, chat: update.message.chat ?? null };
  if (update.callback_query) return { from: update.callback_query.from ?? null, chat: update.callback_query.message?.chat ?? null };
  if (update.message_reaction) return { from: update.message_reaction.user ?? null, chat: update.message_reaction.chat ?? null };
  return { from: null, chat: null };
}

/** THE gate: the paired private chat, the paired user, not a bot. */
export function isAuthorized(update: TgUpdateLike, binding: PairedIdentity): boolean {
  const { from, chat } = senderOf(update);
  if (!from || !chat) return false;
  if (from.is_bot === true) return false;
  if (chat.type !== 'private') return false;
  return Number.isSafeInteger(binding.chatId) && Number.isSafeInteger(binding.userId)
    && chat.id === binding.chatId && from.id === binding.userId;
}

// ─── Rooms: the private chat and the permitted groups (tg-grup C1) ──────────

/** Where an update happened: the paired private chat, or a group the owner permitted. */
export type Room = { kind: 'private' } | { kind: 'group'; chatId: number; title: string };
/** Who sent it (D2): the owner, a member of a permitted group, or nobody we answer. */
export type Actor = 'owner' | 'member' | 'stranger';

/** The binding fields the room gate reads. */
export interface RoomIdentity extends PairedIdentity {
  botId: number;
  botUsername: string;
  groups?: readonly { chatId: number; title: string }[];
}

/** Telegram's service account for channel posts forwarded into a linked group. */
export const TG_SERVICE_USER_ID = 777000;

const isGroupChat = (chat: TgChat | null | undefined): chat is TgChat => !!chat && (chat.type === 'group' || chat.type === 'supergroup');

/** The room of an update: private (the paired chat), a PERMITTED group, or null (any other chat). */
export function roomOf(update: TgUpdateLike, binding: RoomIdentity): Room | null {
  const { chat } = senderOf(update);
  if (!chat || !Number.isSafeInteger(chat.id)) return null;
  if (chat.type === 'private') return chat.id === binding.chatId ? { kind: 'private' } : null;
  if (!isGroupChat(chat)) return null;
  const g = (binding.groups ?? []).find((x) => x.chatId === chat.id);
  return g ? { kind: 'group', chatId: g.chatId, title: g.title } : null;
}

/** By `from.id` only (D2): a message carrying `sender_chat` (an anonymous admin, a linked channel)
 *  and Telegram's service account are strangers; so is any bot. */
export function actorOf(update: TgUpdateLike, binding: PairedIdentity): Actor {
  const { from } = senderOf(update);
  if (!from || !Number.isSafeInteger(from.id) || from.is_bot === true || from.id === TG_SERVICE_USER_ID) return 'stranger';
  if (update.message?.sender_chat) return 'stranger';
  return from.id === binding.userId ? 'owner' : 'member';
}

/** A command word of a message (`/bagla`, `/bagla@bot`): the command and the bot it names, or null. */
export function commandOf(text: string | undefined): { cmd: string; bot: string | null } | null {
  if (typeof text !== 'string') return null;
  const m = /^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(text.trim());
  return m ? { cmd: m[1].toLowerCase(), bot: m[2] ?? null } : null;
}

/**
 * D4: a group message is for the bot only when it @mentions it, replies to one of ITS messages
 * (Telegram's `reply_to_message` is always of the same chat), or is a command addressed to it.
 */
export function addressed(msg: TgMessageLike | undefined, bot: { botId: number; botUsername: string }): boolean {
  if (!msg) return false;
  if (msg.reply_to_message?.from?.id === bot.botId) return true;
  const c = commandOf(msg.text);
  if (c && c.bot !== null && c.bot.toLowerCase() === bot.botUsername.toLowerCase()) return true;
  const name = `@${bot.botUsername}`.toLowerCase();
  for (const [text, ents] of [[msg.text, msg.entities], [msg.caption, msg.caption_entities]] as const) {
    if (typeof text !== 'string') continue;
    for (const e of ents ?? []) {
      if (e.type === 'text_mention' && e.user?.id === bot.botId) return true;
      if (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === name) return true;
    }
    // No entities (a client that sends none): the name as a whole word.
    // (A username is [A-Za-z0-9_] only: `isBinding` checks it, so it is safe inside a pattern.)
    if (!ents?.length && /^[A-Za-z0-9_]{1,64}$/.test(bot.botUsername)
      && new RegExp(`(^|[^A-Za-z0-9_])@${bot.botUsername}(?![A-Za-z0-9_])`, 'i').test(text)) return true;
  }
  return false;
}

/**
 * THE room gate (C1, G1): private needs the owner (`isAuthorized`); a group needs a permitted
 * group, a sender who is not a stranger, and a message addressed to the bot (D4). A callback or a
 * reaction in a group is never admitted (no button ever goes to a group, G4). Null = no effect.
 */
export function admit(update: TgUpdateLike, binding: RoomIdentity): { room: Room; actor: Actor } | null {
  const room = roomOf(update, binding);
  if (!room) return null;
  if (room.kind === 'private') return isAuthorized(update, binding) ? { room, actor: 'owner' } : null;
  if (!update.message || update.callback_query || update.message_reaction) return null;
  const actor = actorOf(update, binding);
  if (actor === 'stranger' || !addressed(update.message, binding)) return null;
  return { room, actor };
}

/** Strangers are counted, never answered. */
export class StrangerCounter {
  private counts = new Map<number, number>();
  total = 0;
  note(update: TgUpdateLike): void {
    const id = senderOf(update).from?.id;
    this.total += 1;
    if (typeof id === 'number') this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }
  of(userId: number): number { return this.counts.get(userId) ?? 0; }
}

// ─── Pairing ────────────────────────────────────────────────────────────────

/** 128 bits, base64url, 22 chars. */
export function mintPairingSecret(): string {
  return randomBytes(16).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `/start <payload>` → the payload, or null for a bare /start or anything else. */
export function startPayloadOf(text: string | undefined): string | null {
  if (typeof text !== 'string') return null;
  const m = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!m) return null;
  return m[1] ?? '';
}

export interface Pairing {
  pairingId: string;
  payload: string;
  scope: TelegramScope;
  target: TelegramTarget;
  botId: number;
  botUsername: string;
  expiresAt: number;
  /** Set once a valid payload arrived; never active until `confirm`. */
  pendingUser: { userId: number; chatId: number; label: string } | null;
}

export type StartOutcome =
  | { result: 'pending'; pairing: Pairing }
  | { result: 'ignored' }      // not a private human chat, a bare /start, no live pairing, already used
  | { result: 'wrong'; left: number }
  | { result: 'locked' };

/** Control, bidi and zero-width characters removed (the label is shown in a native alert). */
export function cleanLabel(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').trim().slice(0, 64);
}

/**
 * The hub's pairing book for ONE bot token (the pairing is served by polling that token).
 * In memory only: a server restart voids every pairing (the owner re-mints with one tap).
 */
export class PairingBook {
  private live: Pairing | null = null;
  private wrong = new Map<number, { count: number; until: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** A new pairing for the target; voids the previous one (B4). */
  mint(input: { scope: TelegramScope; target: TelegramTarget; botId: number; botUsername: string }): Pairing {
    this.live = {
      pairingId: mintPairingSecret(),
      payload: mintPairingSecret(),
      ...input,
      expiresAt: this.now() + PAIRING_TTL_MS,
      pendingUser: null,
    };
    return this.live;
  }

  current(): Pairing | null {
    if (this.live && this.now() > this.live.expiresAt) this.live = null;
    return this.live;
  }

  /** A `/start …` message from Telegram. */
  onStart(update: TgUpdateLike): StartOutcome {
    const msg = update.message;
    const from = msg?.from;
    const chat = msg?.chat;
    if (!msg || !from || !chat || from.is_bot === true || chat.type !== 'private') return { result: 'ignored' };
    const payload = startPayloadOf(msg.text);
    if (!payload) return { result: 'ignored' };
    const t = this.now();
    const w = this.wrong.get(from.id);
    if (w && w.count >= PAIRING_MAX_WRONG && t < w.until) return { result: 'locked' };
    if (w && t >= w.until) this.wrong.delete(from.id);
    const live = this.current();
    if (!live) return { result: 'ignored' };
    if (!PAIRING_ID_RE.test(payload) || !safeEqual(payload, live.payload)) {
      const cur = this.wrong.get(from.id) ?? { count: 0, until: t + PAIRING_TTL_MS };
      cur.count += 1;
      cur.until = t + PAIRING_TTL_MS;
      this.wrong.set(from.id, cur);
      return cur.count >= PAIRING_MAX_WRONG ? { result: 'locked' } : { result: 'wrong', left: PAIRING_MAX_WRONG - cur.count };
    }
    // Single use: the payload is spent; a later /start with it (even the same user) changes nothing.
    live.payload = `used:${mintPairingSecret()}`;
    live.pendingUser = { userId: from.id, chatId: chat.id, label: cleanLabel(from.username ? `@${from.username}` : from.first_name ?? '') };
    return { result: 'pending', pairing: live };
  }

  /** What Rust is shown (B4); null when the id is wrong, expired, voided or nobody answered yet. */
  preview(pairingId: string): Pairing | null {
    const live = this.current();
    if (!live || !PAIRING_ID_RE.test(pairingId) || !safeEqual(pairingId, live.pairingId) || !live.pendingUser) return null;
    return live;
  }

  /** The owner's click: activates only if everything shown still matches; consumes the pairing. */
  confirm(pairingId: string, shown: { botId: number; userId: number }): { result: 'ok'; pairing: Pairing } | { result: 'gone' | 'mismatch' } {
    const live = this.preview(pairingId);
    if (!live) return { result: 'gone' };
    if (shown.botId !== live.botId || shown.userId !== live.pendingUser!.userId) return { result: 'mismatch' };
    this.live = null;
    return { result: 'ok', pairing: live };
  }

  void(): void { this.live = null; }
}
