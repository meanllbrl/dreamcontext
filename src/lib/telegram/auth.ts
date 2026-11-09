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

export interface TgChat { id: number; type: string; username?: string; first_name?: string }
export interface TgFrom { id: number; is_bot?: boolean; username?: string; first_name?: string }
export interface TgMessageLike { message_id?: number; chat?: TgChat; from?: TgFrom; text?: string; date?: number }
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
