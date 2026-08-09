/**
 * The Telegram channel.
 *
 * NO test here may reach api.telegram.org: every call goes through an injected
 * transport that records what would have been sent. The point of the channel is
 * that it works when nobody is at the Mac, so its failure modes are the ones
 * nobody is watching — which is exactly why they are pinned here.
 *
 * The auth gate is the first thing tested and the one that would hurt most:
 * anyone can message a bot whose token they do not have, and without the gate,
 * anyone could answer your cards — which resumes a bypassPermissions session on
 * your machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  describeTelegram,
  emitPendingCards,
  pollTelegram,
  readTelegramConfig,
  renderCardText,
  renderKeyboard,
  telegramConfigPath,
  writeTelegramConfig,
  type TelegramTransport,
} from '../../src/lib/automations/telegram.js';
import {
  createReviewCard,
  pendingReviewCard,
  readReviewCard,
  refreshReviewCard,
  reviewCardPath,
} from '../../src/lib/automations/review.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import * as verdict from '../../src/lib/automations/verdict.js';
import type { ReviewCard } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = '2026-08-03T18:00:00.000Z';
const CHAT = '424242';

/** Records every call; answers `getUpdates` from a scripted queue. */
function makeTransport(updates: unknown[] = []) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let messageId = 100;
  const transport: TelegramTransport = {
    async call(_token, method, payload) {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === 'getUpdates') return { ok: true, result: updates };
      if (method === 'sendMessage') return { ok: true, result: { message_id: ++messageId } };
      return { ok: true, result: {} };
    },
  };
  return { transport, calls, sent: () => calls.filter((c) => c.method === 'sendMessage') };
}

function makeCard(overrides: Partial<Parameters<typeof createReviewCard>[1]> = {}): ReviewCard {
  return createReviewCard(contextRoot, {
    slug: 'digest',
    runFiredAt: NOW,
    sessionId: 'sess-1',
    kind: 'agent',
    title: 'Send the launch mail?',
    body: 'Hi all, we shipped v0.23 today.',
    nowISO: NOW,
    ...overrides,
  });
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-tg-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-tg-home-'));
  createAutomation(contextRoot, {
    slug: 'digest', title: 'Daily digest', days: 'daily', at: '18:00', prompt: 'p', review: 'agent',
  });
  writeTelegramConfig({ botToken: 'tok', chatId: CHAT, offset: 0 }, home);
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── Config ──────────────────────────────────────────────────────────────────

describe('the token is a capability, stored like one', () => {
  it('writes 0600 — a token readable by other users is the whole gate handed away', () => {
    const mode = statSync(telegramConfigPath(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('lives in ~/.dreamcontext, NEVER in the brain', () => {
    // A synced token hands every teammate the ability to resume a
    // bypassPermissions session on THIS machine.
    expect(telegramConfigPath(home)).toBe(join(home, '.dreamcontext', 'telegram.json'));
    expect(telegramConfigPath(home).startsWith(contextRoot)).toBe(false);
  });

  it('a missing or malformed config reads as "off", never as a throw', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dc-tg-empty-'));
    expect(readTelegramConfig(empty)).toBeNull();
    writeFileSync(telegramConfigPath(home), 'not json', 'utf-8');
    expect(readTelegramConfig(home)).toBeNull();
    writeFileSync(telegramConfigPath(home), JSON.stringify({ botToken: 'x' }), 'utf-8');
    expect(readTelegramConfig(home)).toBeNull(); // no chat id ⇒ nothing to authorize
    rmSync(empty, { recursive: true, force: true });
  });

  it('polling is a silent no-op when Telegram is off — the state every machine starts in', async () => {
    const off = mkdtempSync(join(tmpdir(), 'dc-tg-off-'));
    const { transport, calls } = makeTransport();
    const res = await pollTelegram(contextRoot, off, transport);
    expect(res).toEqual({ processed: 0, unauthorized: 0, offset: 0 });
    expect(calls).toHaveLength(0);
    rmSync(off, { recursive: true, force: true });
  });
});

// ─── The auth gate ───────────────────────────────────────────────────────────

describe('LAYER 1 — the chat-id auth gate', () => {
  it('DROPS an approve from a chat that is not yours, and does not answer it', async () => {
    // The load-bearing test in this file. A tap from an unauthorized chat must
    // not resume anything, and must not even reply — replying confirms the bot
    // exists and is listening.
    const card = makeCard();
    const spy = vi.spyOn(verdict, 'resumeWithVerdict');
    const { transport, sent } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb1', data: `approve:${card.id}`, message: { message_id: 5, chat: { id: '999999' } } } },
    ]);

    const res = await pollTelegram(contextRoot, home, transport);

    expect(res.unauthorized).toBe(1);
    expect(res.processed).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(readReviewCard(reviewCardPath(contextRoot, 'digest', card.id))?.state).toBe('pending');
    // nothing was said back to the stranger
    expect(sent().some((c) => String(c.payload.chat_id) === '999999')).toBe(false);
  });

  it('DROPS a steer from an unauthorized chat', async () => {
    makeCard();
    const spy = vi.spyOn(verdict, 'applySteer');
    const { transport } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'rewrite it', chat: { id: '111' } } },
    ]);
    const res = await pollTelegram(contextRoot, home, transport);
    expect(res.unauthorized).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still advances the offset past a dropped update — a stranger cannot wedge the queue', async () => {
    makeCard();
    const { transport } = makeTransport([
      { update_id: 42, message: { message_id: 7, text: 'hi', chat: { id: '111' } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(readTelegramConfig(home)?.offset).toBe(43);
  });
});

// ─── Posting ─────────────────────────────────────────────────────────────────

describe('posting cards', () => {
  it('posts a pending card once and remembers the message id', async () => {
    const card = makeCard();
    const { transport, sent } = makeTransport();
    const cfg = readTelegramConfig(home)!;

    expect(await emitPendingCards(contextRoot, cfg, transport)).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(String(sent()[0].payload.chat_id)).toBe(CHAT);
    expect(readReviewCard(reviewCardPath(contextRoot, 'digest', card.id))?.channelRefs.telegram).toBe('101');

    // the ref is what stops a second copy of a proposal that has not changed
    expect(await emitPendingCards(contextRoot, cfg, transport)).toBe(0);
  });

  it('records NO ref when the post failed, so the next tick retries', async () => {
    const card = makeCard();
    const transport: TelegramTransport = { async call() { return { ok: false }; } };
    const cfg = readTelegramConfig(home)!;
    expect(await emitPendingCards(contextRoot, cfg, transport)).toBe(0);
    expect(readReviewCard(reviewCardPath(contextRoot, 'digest', card.id))?.channelRefs.telegram).toBeUndefined();
  });

  it('the card text says plainly that typing CORRECTS rather than sends', () => {
    // The 2026-07-12 Tilki incident, on every card rather than in a setup doc
    // nobody re-reads.
    const text = renderCardText(makeCard());
    expect(text).toContain('Send the launch mail?');
    expect(text).toMatch(/CORRECT it/);
    expect(text).toMatch(/nothing is sent/);
  });

  it('offers three buttons, with the compounding one on its own row', () => {
    const kb = renderKeyboard('rev_1') as { inline_keyboard: { text: string; callback_data: string }[][] };
    expect(kb.inline_keyboard[0].map((b) => b.callback_data)).toEqual(['approve:rev_1', 'discard:rev_1']);
    expect(kb.inline_keyboard[1][0].callback_data).toBe('drop:rev_1');
  });
});

// ─── Verdicts ────────────────────────────────────────────────────────────────

describe('answering from the phone', () => {
  it('a tap resolves the card and strips the buttons', async () => {
    const card = makeCard();
    // Reads the card back off disk, as the real engine does — `pollTelegram`
    // posts it first, so by the time a verdict lands the card carries the
    // telegram message id, and a mock that dropped it would hide the fact that
    // finalizing needs it.
    vi.spyOn(verdict, 'resumeWithVerdict').mockImplementation(async (root, c) => ({
      card: { ...refreshReviewCard(root, c)!, state: 'discarded', resolvedVia: 'telegram', resolutionNote: 'understood' },
      status: 'ok', error: null, result: null, lesson: null,
    }));
    const { transport, calls } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb', data: `discard:${card.id}`, message: { message_id: 5, chat: { id: CHAT } } } },
    ]);

    const res = await pollTelegram(contextRoot, home, transport);
    expect(res.processed).toBe(1);
    // the callback is acknowledged, or Telegram shows a spinner forever
    expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    // buttons removed — a resolved card that keeps them invites a second tap
    expect(calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
  });

  it('says so when the card was already answered somewhere else', async () => {
    const { transport, sent } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb', data: 'approve:rev_gone', message: { message_id: 5, chat: { id: CHAT } } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(sent().some((c) => String(c.payload.text).includes('answered somewhere else'))).toBe(true);
  });

  it('ignores a callback whose action is not a verdict', async () => {
    const card = makeCard();
    const spy = vi.spyOn(verdict, 'resumeWithVerdict');
    const { transport } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb', data: `delete:${card.id}`, message: { message_id: 5, chat: { id: CHAT } } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── Steering ────────────────────────────────────────────────────────────────

describe('correcting from the phone', () => {
  it('a plain message steers when exactly ONE card is open, and edits it in place', async () => {
    makeCard();
    vi.spyOn(verdict, 'applySteer').mockImplementation(async (root, c) => ({
      card: { ...refreshReviewCard(root, c)!, body: 'Shorter copy.' },
      status: 'ok', error: null, result: 'Shorter copy.', lesson: 'Keep launch mails to two lines.',
    }));
    const { transport, calls, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'make it shorter', chat: { id: CHAT } } },
    ]);

    await pollTelegram(contextRoot, home, transport);

    // immediate ack — a rewrite takes 30-90s and the bot looks dead without it
    expect(sent().some((c) => String(c.payload.text).includes('rewriting'))).toBe(true);
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(true);
    // the Concierge moment: the rule, in words, at the instant it was taught
    expect(sent().some((c) => String(c.payload.text).includes('Keep launch mails to two lines.'))).toBe(true);
  });

  it('REFUSES TO GUESS when several cards are open', async () => {
    // Ported from Concierge, which learned it with 15 cards open: steering the
    // wrong proposal is worse than asking which one.
    makeCard();
    makeCard({ slug: 'digest', title: 'Another', nowISO: '2026-08-03T19:00:00.000Z' });
    const spy = vi.spyOn(verdict, 'applySteer');
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'shorter', chat: { id: CHAT } } },
    ]);

    await pollTelegram(contextRoot, home, transport);

    expect(spy).not.toHaveBeenCalled();
    expect(sent().some((c) => String(c.payload.text).includes('cannot tell which one'))).toBe(true);
  });

  it('a REPLY targets its own card even with several open', async () => {
    const first = makeCard();
    makeCard({ title: 'Another', nowISO: '2026-08-03T19:00:00.000Z' });
    const cfg = readTelegramConfig(home)!;
    const { transport } = makeTransport();
    await emitPendingCards(contextRoot, cfg, transport);
    const posted = readReviewCard(reviewCardPath(contextRoot, 'digest', first.id))!;
    const ref = posted.channelRefs.telegram;

    const spy = vi.spyOn(verdict, 'applySteer').mockResolvedValue({
      card: posted, status: 'ok', error: null, result: 'x', lesson: null,
    });
    const { transport: t2 } = makeTransport([
      { update_id: 1, message: { message_id: 9, text: 'shorter', chat: { id: CHAT }, reply_to_message: { message_id: Number(ref) } } },
    ]);
    await pollTelegram(contextRoot, home, t2);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1].id).toBe(first.id);
  });

  it('says so when nothing is waiting', async () => {
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'hello?', chat: { id: CHAT } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(sent().some((c) => String(c.payload.text).includes('Nothing is waiting'))).toBe(true);
  });

  it('leaves the card alone and says so when the rewrite failed', async () => {
    const card = makeCard();
    vi.spyOn(verdict, 'applySteer').mockResolvedValue({
      card, status: 'failed', error: 'unparseable CLI output', result: null, lesson: null,
    });
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'shorter', chat: { id: CHAT } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(sent().some((c) => String(c.payload.text).includes('the card is unchanged'))).toBe(true);
    expect(pendingReviewCard(contextRoot, 'digest')?.id).toBe(card.id);
  });
});

// ─── The offset ──────────────────────────────────────────────────────────────

describe('the offset is persisted', () => {
  it('advances past processed updates so a verdict is never replayed', async () => {
    // A replayed callback would be a second verdict on a card already answered.
    const card = makeCard();
    vi.spyOn(verdict, 'resumeWithVerdict').mockResolvedValue({
      card: { ...card, state: 'approved' }, status: 'ok', error: null, result: null, lesson: null,
    });
    const { transport } = makeTransport([
      { update_id: 10, callback_query: { id: 'a', data: `approve:${card.id}`, message: { message_id: 5, chat: { id: CHAT } } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(readTelegramConfig(home)?.offset).toBe(11);
  });

  it('a poisonous update is skipped, not retried forever', async () => {
    makeCard();
    vi.spyOn(verdict, 'applySteer').mockRejectedValue(new Error('boom'));
    const { transport } = makeTransport([
      { update_id: 5, message: { message_id: 7, text: 'x', chat: { id: CHAT } } },
    ]);
    await expect(pollTelegram(contextRoot, home, transport)).resolves.toBeDefined();
    expect(readTelegramConfig(home)?.offset).toBe(6);
  });
});

describe('describeTelegram', () => {
  it('reports what the channel can see without sending anything', () => {
    makeCard();
    const state = describeTelegram(contextRoot, home);
    expect(state).toMatchObject({ configured: true, chatId: CHAT, pending: 1, posted: 0 });
  });
});
