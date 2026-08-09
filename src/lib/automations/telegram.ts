/**
 * The Telegram channel — the one that makes review actually work.
 *
 * Every other surface in this feature requires the human to be at the Mac. An
 * automation fires at 18:00 precisely because nobody is at the Mac, so a gate
 * that can only be answered there is a gate that becomes a rubber stamp: you
 * come back the next morning, find seven cards, and approve them all without
 * reading. Tilki's Concierge got this right first and it is the least
 * negotiable thing it teaches — the approval surface has to be where the human
 * already is, which is their phone.
 *
 * THE CREDENTIALS ARE A CAPABILITY, NOT A PREFERENCE. A bot token plus an
 * authorized chat id is the ability to resume a `bypassPermissions` session on
 * this machine. They live in `~/.dreamcontext/telegram.json` at 0600 —
 * machine-local, never the brain, because the brain is synced and a token in a
 * synced repo hands every teammate that ability. Same boundary as the approval
 * registry, and for a strictly stronger reason.
 *
 * Layer 1 of Concierge's hardening is reproduced verbatim: every inbound update
 * is checked against the authorized chat id and silently dropped otherwise. Not
 * answered, not logged back to the sender — dropped. Anyone can message a bot
 * whose token they do not have; without this gate, anyone could answer your
 * cards.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { applySteer, resumeWithVerdict } from './verdict.js';
import {
  allPendingReviewCards,
  listReviewCards,
  pendingReviewCard,
  refreshReviewCard,
  setChannelRef,
} from './review.js';
import { REVIEW_BODY_MAX_CHARS, type ReviewCard, type ReviewVerdict } from './types.js';

// ─── Machine-local config ───────────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string;
  /** The ONE chat allowed to answer cards. Everything else is dropped. */
  chatId: string;
  /** getUpdates offset, persisted so an update is never processed twice — a
   *  replayed callback would be a second verdict on a card already answered. */
  offset: number;
}

export function telegramConfigPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'telegram.json');
}

/** Never throws; a missing or malformed config reads as "Telegram is off",
 *  which is the correct degradation for an optional channel. */
export function readTelegramConfig(home: string = homedir()): TelegramConfig | null {
  const path = telegramConfigPath(home);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const botToken = typeof r.botToken === 'string' ? r.botToken.trim() : '';
    const chatId = typeof r.chatId === 'string' ? r.chatId.trim() : String(r.chatId ?? '').trim();
    if (!botToken || !chatId) return null;
    return { botToken, chatId, offset: typeof r.offset === 'number' ? r.offset : 0 };
  } catch {
    return null;
  }
}

/** Atomic + 0600. The mode is set on the TEMP file before the rename, so the
 *  token is never readable by other users even for the instant between create
 *  and chmod — the same ordering `lab/credentials.ts` uses. */
export function writeTelegramConfig(cfg: TelegramConfig, home: string = homedir()): void {
  const path = telegramConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// ─── Transport (injectable — no test in this repo may reach api.telegram.org) ─

export interface TelegramTransport {
  call(token: string, method: string, payload: unknown): Promise<{ ok: boolean; result?: unknown }>;
}

export const fetchTransport: TelegramTransport = {
  async call(token, method, payload) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { ok?: boolean; result?: unknown };
      return { ok: body.ok === true, result: body.result };
    } catch {
      // A network blip is not an error worth failing a tick over — the card
      // stays unposted and the next tick tries again.
      return { ok: false };
    }
  },
};

// ─── Rendering ──────────────────────────────────────────────────────────────

/** Telegram caps a message at 4096 chars; the body is capped well under that so
 *  the header and footer always survive. */
const TELEGRAM_BODY_MAX = 3_000;

export function renderCardText(card: ReviewCard): string {
  const body = card.body.length > TELEGRAM_BODY_MAX
    ? `${card.body.slice(0, TELEGRAM_BODY_MAX - 1).trimEnd()}…`
    : card.body;
  const lines = [`🤖 ${card.slug} · ${card.title}`, '', body];
  if (card.steers.length > 0) {
    lines.push('', `✍️ ${card.steers.length} correction(s) so far — latest: "${card.steers[card.steers.length - 1].text}"`);
  }
  lines.push(
    '',
    // Stated on every card, not in a setup doc nobody re-reads. The one thing a
    // person must know here is that typing at this card CHANGES it rather than
    // sending it — the 2026-07-12 Tilki incident was exactly that confusion.
    'Reply with text to CORRECT it (it gets rewritten and comes back to you — nothing is sent).',
  );
  return lines.join('\n');
}

/** Three buttons, because the third is the one that makes review compound: it
 *  does not judge this proposal, it teaches the automation never to make this
 *  kind again. */
export function renderKeyboard(cardId: string): unknown {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${cardId}` },
        { text: '🚫 Reject', callback_data: `discard:${cardId}` },
      ],
      [{ text: '🗑 Never propose this again', callback_data: `drop:${cardId}` }],
    ],
  };
}

// ─── Posting ────────────────────────────────────────────────────────────────

/**
 * Post every pending card that has not been posted yet, and record its message
 * id on the card so a later steer EDITS it rather than posting a second copy of
 * a proposal that is still the same proposal.
 */
export async function emitPendingCards(
  contextRoot: string,
  cfg: TelegramConfig,
  transport: TelegramTransport = fetchTransport,
): Promise<number> {
  let posted = 0;
  for (const card of allPendingReviewCards(contextRoot)) {
    if (card.channelRefs.telegram) continue;
    const res = await transport.call(cfg.botToken, 'sendMessage', {
      chat_id: cfg.chatId,
      text: renderCardText(card),
      reply_markup: renderKeyboard(card.id),
    });
    if (!res.ok) continue; // no ref recorded ⇒ the next tick retries; never lost
    const messageId = (res.result as { message_id?: number } | undefined)?.message_id;
    if (typeof messageId !== 'number') continue;
    setChannelRef(contextRoot, card, 'telegram', String(messageId));
    posted += 1;
  }
  return posted;
}

async function editCardInPlace(
  cfg: TelegramConfig,
  card: ReviewCard,
  transport: TelegramTransport,
): Promise<void> {
  const messageId = card.channelRefs.telegram;
  if (!messageId) return;
  await transport.call(cfg.botToken, 'editMessageText', {
    chat_id: cfg.chatId,
    message_id: Number(messageId),
    text: renderCardText(card),
    reply_markup: renderKeyboard(card.id),
  });
}

/** Strip the buttons and say what happened. A resolved card that keeps its
 *  buttons invites a second tap on a decision already made. */
async function finalizeCardMessage(
  cfg: TelegramConfig,
  card: ReviewCard,
  note: string,
  transport: TelegramTransport,
): Promise<void> {
  const messageId = card.channelRefs.telegram;
  if (messageId) {
    await transport.call(cfg.botToken, 'editMessageReplyMarkup', {
      chat_id: cfg.chatId,
      message_id: Number(messageId),
      reply_markup: { inline_keyboard: [] },
    });
  }
  await transport.call(cfg.botToken, 'sendMessage', {
    chat_id: cfg.chatId,
    text: note,
    ...(messageId ? { reply_to_message_id: Number(messageId) } : {}),
  });
}

export async function notifyTelegram(
  cfg: TelegramConfig,
  text: string,
  transport: TelegramTransport = fetchTransport,
  replyTo?: string,
): Promise<void> {
  await transport.call(cfg.botToken, 'sendMessage', {
    chat_id: cfg.chatId,
    text,
    ...(replyTo ? { reply_to_message_id: Number(replyTo) } : {}),
  });
}

// ─── Polling ────────────────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number | string };
    reply_to_message?: { message_id?: number };
  };
  callback_query?: {
    id?: string;
    data?: string;
    message?: { message_id?: number; chat?: { id?: number | string } };
  };
}

export interface PollResult {
  processed: number;
  /** Updates dropped because they came from a chat that is not the authorized
   *  one. Surfaced so `telegram test` can say "your bot is being messaged by
   *  someone else", never acted on. */
  unauthorized: number;
  offset: number;
}

function chatIdOf(u: TelegramUpdate): string | null {
  const raw = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
  return raw === undefined ? null : String(raw);
}

function findCardById(contextRoot: string, cardId: string): ReviewCard | null {
  for (const card of allPendingReviewCards(contextRoot)) {
    if (card.id === cardId) return card;
  }
  return null;
}

/**
 * Drain Telegram's update queue and act on it.
 *
 * Runs inside the dispatcher tick, so it works with the app closed — which is
 * the whole point, since that is when automations fire. A verdict therefore
 * lands within one tick (5 minutes), which is right for a scheduler and wrong
 * for a chat; the server polls faster while it is up.
 */
export async function pollTelegram(
  contextRoot: string,
  home: string = homedir(),
  transport: TelegramTransport = fetchTransport,
): Promise<PollResult> {
  const cfg = readTelegramConfig(home);
  if (!cfg) return { processed: 0, unauthorized: 0, offset: 0 };

  // Post anything new BEFORE reading: a card that appeared since the last tick
  // should be answerable in this same round trip.
  await emitPendingCards(contextRoot, cfg, transport);

  const res = await transport.call(cfg.botToken, 'getUpdates', {
    offset: cfg.offset,
    timeout: 0,
    allowed_updates: ['message', 'callback_query'],
  });
  if (!res.ok || !Array.isArray(res.result)) return { processed: 0, unauthorized: 0, offset: cfg.offset };

  const updates = res.result as TelegramUpdate[];
  let processed = 0;
  let unauthorized = 0;
  let offset = cfg.offset;

  for (const update of updates) {
    if (typeof update.update_id === 'number') offset = Math.max(offset, update.update_id + 1);

    // LAYER 1 — the auth gate. Anyone can message a bot; only the authorized
    // chat may answer cards. Dropped silently: replying would confirm the bot
    // exists and is listening.
    if (chatIdOf(update) !== cfg.chatId) {
      unauthorized += 1;
      continue;
    }

    try {
      if (update.callback_query) {
        await handleCallback(contextRoot, cfg, update, transport, home);
        processed += 1;
      } else if (update.message?.text) {
        await handleSteerMessage(contextRoot, cfg, update, transport, home);
        processed += 1;
      }
    } catch {
      // One bad update must not wedge the queue — the offset still advances
      // below, so a poisonous update is skipped rather than retried forever.
    }
  }

  // Persist the offset LAST and unconditionally: an update processed twice
  // would be a second verdict on a card already answered.
  if (offset !== cfg.offset) writeTelegramConfig({ ...cfg, offset }, home);
  return { processed, unauthorized, offset };
}

async function handleCallback(
  contextRoot: string,
  cfg: TelegramConfig,
  update: TelegramUpdate,
  transport: TelegramTransport,
  home: string,
): Promise<void> {
  const cb = update.callback_query as NonNullable<TelegramUpdate['callback_query']>;
  if (cb.id) await transport.call(cfg.botToken, 'answerCallbackQuery', { callback_query_id: cb.id });

  const [action, cardId] = (cb.data ?? '').split(':');
  if (!action || !cardId) return;
  if (action !== 'approve' && action !== 'discard' && action !== 'drop') return;

  const card = findCardById(contextRoot, cardId);
  if (!card) {
    // Answered elsewhere (the dashboard, the CLI) between the post and the tap.
    // Saying so is the difference between "nothing happened" and "someone else
    // already dealt with it".
    await notifyTelegram(cfg, 'That card is no longer open — it was answered somewhere else.', transport);
    return;
  }

  const outcome = await resumeWithVerdict(contextRoot, card, action as ReviewVerdict, 'telegram', { home });
  if (outcome.status === 'refused' || outcome.status === 'not-spawned') {
    await notifyTelegram(cfg, `⚠️ ${outcome.error ?? 'could not answer that card'}`, transport, card.channelRefs.telegram);
    return;
  }
  const verb = outcome.card.state;
  const detail = outcome.card.resolutionError
    ? `⚠️ ${verb}, but it did not finish cleanly: ${outcome.card.resolutionError}`
    : `${action === 'approve' ? '✅' : action === 'discard' ? '🚫' : '🗑'} ${verb}${outcome.card.resolutionNote ? ` — ${outcome.card.resolutionNote}` : ''}`;
  await finalizeCardMessage(cfg, outcome.card, detail, transport);
  if (outcome.lesson) await notifyTelegram(cfg, `🧠 Learned: «${outcome.lesson}»`, transport);
}

async function handleSteerMessage(
  contextRoot: string,
  cfg: TelegramConfig,
  update: TelegramUpdate,
  transport: TelegramTransport,
  home: string,
): Promise<void> {
  const msg = update.message as NonNullable<TelegramUpdate['message']>;
  const text = (msg.text ?? '').trim();
  if (!text) return;

  const open = allPendingReviewCards(contextRoot);
  if (open.length === 0) {
    await notifyTelegram(cfg, 'Nothing is waiting for a verdict, so there was nothing to correct.', transport);
    return;
  }

  // AMBIGUITY REFUSES TO GUESS. With several cards open, "the newest" is a
  // guess, and steering the wrong proposal is worse than asking which one —
  // ported straight from Concierge, which learned it with 15 cards open.
  let card: ReviewCard | null = null;
  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo !== undefined) {
    card = open.find((c) => c.channelRefs.telegram === String(replyTo)) ?? null;
    if (!card) {
      await notifyTelegram(cfg, 'That card is no longer open, so the correction was not applied.', transport);
      return;
    }
  } else if (open.length === 1) {
    card = open[0];
  } else {
    await notifyTelegram(
      cfg,
      `⚠️ ${open.length} cards are open, so I cannot tell which one you mean. Reply to the card you want to change.`,
      transport,
    );
    return;
  }

  // Immediate ack. A rewrite takes 30-90s and the bot looks dead without this —
  // Concierge shipped without it and the owner reported the bot as broken.
  await notifyTelegram(cfg, `✍️ Got it — rewriting ${card.slug}…`, transport, card.channelRefs.telegram);

  const outcome = await applySteer(contextRoot, card, text, 'telegram', { home });
  if (outcome.status !== 'ok') {
    await notifyTelegram(cfg, `⚠️ ${outcome.error ?? 'the rewrite failed'} — the card is unchanged.`, transport, card.channelRefs.telegram);
    return;
  }
  await editCardInPlace(cfg, outcome.card, transport);
  await notifyTelegram(cfg, '✅ Rewritten — have another look 👆', transport, card.channelRefs.telegram);
  // The Concierge moment: the human sees the rule they just created, in words,
  // at the instant they created it. Without it, steering feels like correcting
  // the same thing forever.
  if (outcome.lesson) {
    await notifyTelegram(cfg, `🧠 Learned, I'll apply this from now on:\n« ${outcome.lesson} »`, transport);
  }
}

/** Everything a `telegram test` needs to say without sending anything. */
export function describeTelegram(contextRoot: string, home: string = homedir()): {
  configured: boolean;
  chatId: string | null;
  pending: number;
  posted: number;
} {
  const cfg = readTelegramConfig(home);
  const pending = allPendingReviewCards(contextRoot);
  return {
    configured: cfg !== null,
    chatId: cfg?.chatId ?? null,
    pending: pending.length,
    posted: pending.filter((c) => c.channelRefs.telegram).length,
  };
}

/** Re-exported so the CLI can render a card the same way Telegram does without
 *  reaching into this module's internals. */
export { REVIEW_BODY_MAX_CHARS, listReviewCards, pendingReviewCard, refreshReviewCard };
