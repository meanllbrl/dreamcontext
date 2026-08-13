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
 * anyone could answer your questions — which resumes a bypassPermissions
 * session on your machine.
 *
 * DEVIATION FROM THE OLD `ReviewCard` SUITE THIS FILE REPLACES: the old model's
 * "typing CORRECTS rather than sends" behaviour (free text was ALWAYS a steer,
 * never a resolution — only the approve/discard/drop buttons could resolve a
 * card) does NOT carry over to `AutomationQuestion`. Two things changed the
 * ground it stood on:
 *   1. `runner.ts`'s actual `flow-hitl` question creation (1255–1264) always
 *      passes `choices: []` — an open, free-text question with no buttons at
 *      all. If free text only steered and never resolved, Telegram could never
 *      answer a real HITL question — the channel would be answerable in name
 *      only, defeating D8's whole point.
 *   2. `resumeWithAnswer`'s own contract treats the answer text as final ("A
 *      human answered the question you stopped to ask... That text is their
 *      ANSWER"), not as a redraft.
 * So every reply here — a button tap or free text — answers directly. What IS
 * preserved, because nothing about it depended on the old steer/verdict split:
 * post-once-and-remember-the-message-id, the button layout (now one row per
 * offered choice), resolve-and-strip-buttons on finish, "already answered
 * elsewhere", "several are open, don't guess", "a reply targets its own
 * question", "nothing is waiting", and "a failed attempt says so plainly".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  describeTelegram,
  emitPendingCards,
  pollTelegram,
  readTelegramConfig,
  renderQuestionKeyboard,
  renderQuestionText,
  telegramConfigPath,
  writeTelegramConfig,
  type TelegramTransport,
  adoptGlobalTelegramConfig,
  forgetTelegramConfigForSlug,
  listTelegramSlugs,
  readTelegramConfigForSlug,
  telegramConfigPathForSlug,
  writeTelegramConfigForSlug,
} from '../../src/lib/automations/telegram.js';
import { createQuestion, refreshQuestion } from '../../src/lib/automations/hitl.js';
import { createAutomation, writeAutomationCache } from '../../src/lib/automations/store.js';
import { recordAutomationSession } from '../../src/lib/automations/session-registry.js';
import * as verdict from '../../src/lib/automations/verdict.js';
import type { AutomationQuestion, CreateAutomationInput } from '../../src/lib/automations/types.js';

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

function makeAutomation(overrides: Partial<CreateAutomationInput> = {}): void {
  createAutomation(contextRoot, {
    slug: 'digest',
    title: 'Daily digest',
    days: 'daily',
    at: '18:00',
    prompt: 'p',
    ...overrides,
  });
}

function makeQuestion(overrides: Partial<Parameters<typeof createQuestion>[1]> = {}): AutomationQuestion {
  return createQuestion(contextRoot, {
    slug: 'digest',
    runFiredAt: NOW,
    kind: 'flow-hitl',
    sessionId: 'sess-1',
    channel: 'telegram',
    question: 'Send the launch mail?',
    nowISO: NOW,
    ...overrides,
  });
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-tg-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-tg-home-'));
  makeAutomation();
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
  it('DROPS a callback from a chat that is not yours, and does not answer it', async () => {
    // The load-bearing test in this file. A tap from an unauthorized chat must
    // not resume anything, and must not even reply — replying confirms the bot
    // exists and is listening.
    recordAutomationSession('digest', 'sess-1', home);
    const q = makeQuestion({ choices: ['Yes', 'No'] });
    const spy = vi.spyOn(verdict, 'resumeWithAnswer');
    const { transport, sent } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb1', data: `answer:${q.id}:0`, message: { message_id: 5, chat: { id: '999999' } } } },
    ]);

    const res = await pollTelegram(contextRoot, home, transport);

    expect(res.unauthorized).toBeGreaterThanOrEqual(1);
    expect(spy).not.toHaveBeenCalled();
    expect(refreshQuestion(contextRoot, q)?.state).toBe('pending');
    // nothing was said back to the stranger
    expect(sent().some((c) => String(c.payload.chat_id) === '999999')).toBe(false);
  });

  it('DROPS a free-text answer from an unauthorized chat', async () => {
    makeQuestion();
    const spy = vi.spyOn(verdict, 'resumeWithAnswer');
    const { transport } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'send it', chat: { id: '111' } } },
    ]);
    const res = await pollTelegram(contextRoot, home, transport);
    expect(res.unauthorized).toBeGreaterThanOrEqual(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still advances the offset past a dropped update — a stranger cannot wedge the queue', async () => {
    makeQuestion();
    const { transport } = makeTransport([
      { update_id: 42, message: { message_id: 7, text: 'hi', chat: { id: '111' } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(readTelegramConfig(home)?.offset).toBe(43);
  });
});

// ─── Posting ─────────────────────────────────────────────────────────────────

describe('posting questions', () => {
  it('posts a pending question once and remembers the message id', async () => {
    const q = makeQuestion();
    const { transport, sent } = makeTransport();
    const cfg = readTelegramConfig(home)!;

    expect(await emitPendingCards(contextRoot, cfg, transport)).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(String(sent()[0].payload.chat_id)).toBe(CHAT);
    expect(refreshQuestion(contextRoot, q)?.channelRefs.telegram).toBe('101');

    // the ref is what stops a second copy of a question that is still the
    // same question — a re-emit now EDITS the existing message instead.
    expect(await emitPendingCards(contextRoot, cfg, transport)).toBe(0);
  });

  it('records NO ref when the post failed, so the next tick retries', async () => {
    const q = makeQuestion();
    const transport: TelegramTransport = { async call() { return { ok: false }; } };
    const cfg = readTelegramConfig(home)!;
    expect(await emitPendingCards(contextRoot, cfg, transport)).toBe(0);
    expect(refreshQuestion(contextRoot, q)?.channelRefs.telegram).toBeUndefined();
  });

  it('the question text says plainly that replying is the answer, not a draft', () => {
    const text = renderQuestionText(makeQuestion());
    expect(text).toContain('Send the launch mail?');
    expect(text).toMatch(/Reply with your answer/);
  });

  it('offers one button per choice, each on its own row', () => {
    const q = makeQuestion({ choices: ['Approve', 'Reject', 'Never propose this again'] });
    const kb = renderQuestionKeyboard(q) as { inline_keyboard: { text: string; callback_data: string }[][] };
    expect(kb.inline_keyboard).toEqual([
      [{ text: 'Approve', callback_data: `answer:${q.id}:0` }],
      [{ text: 'Reject', callback_data: `answer:${q.id}:1` }],
      [{ text: 'Never propose this again', callback_data: `answer:${q.id}:2` }],
    ]);
  });

  it('renders no keyboard at all for a free-text-only question', () => {
    const q = makeQuestion({ choices: [] });
    expect(renderQuestionKeyboard(q)).toBeUndefined();
  });
});

// ─── Answering ───────────────────────────────────────────────────────────────

describe('answering from the phone', () => {
  it('a tap resolves the question and strips the buttons', async () => {
    recordAutomationSession('digest', 'sess-1', home);
    const q = makeQuestion({ choices: ['Approve', 'Reject'] });
    // Reads the question back off disk, as the real engine does — `pollTelegram`
    // posts it first, so by the time an answer lands the question carries the
    // telegram message id, and a mock that dropped it would hide the fact that
    // finalizing needs it.
    vi.spyOn(verdict, 'resumeWithAnswer').mockImplementation(async (root, question) => ({
      question: { ...refreshQuestion(root, question)!, state: 'answered', resolutionNote: 'sent' },
      status: 'ok', error: null, result: 'sent',
    }));
    const { transport, calls } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb', data: `answer:${q.id}:0`, message: { message_id: 5, chat: { id: CHAT } } } },
    ]);

    const res = await pollTelegram(contextRoot, home, transport);
    expect(res.processed).toBe(1);
    // the callback is acknowledged, or Telegram shows a spinner forever
    expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    // buttons removed — a resolved question that keeps them invites a second tap
    expect(calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
  });

  it('says so when the question was already answered somewhere else', async () => {
    const { transport, sent } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb', data: 'answer:q_gone:0', message: { message_id: 5, chat: { id: CHAT } } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(sent().some((c) => String(c.payload.text).includes('answered somewhere else'))).toBe(true);
  });

  it('ignores a callback whose action is not "answer"', async () => {
    const q = makeQuestion({ choices: ['Approve'] });
    const spy = vi.spyOn(verdict, 'resumeWithAnswer');
    const { transport } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb', data: `delete:${q.id}:0`, message: { message_id: 5, chat: { id: CHAT } } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores a callback whose choice index is malformed, without answering with "undefined"', async () => {
    const q = makeQuestion({ choices: ['Approve'] });
    const spy = vi.spyOn(verdict, 'resumeWithAnswer');
    const { transport } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb', data: `answer:${q.id}:notanumber`, message: { message_id: 5, chat: { id: CHAT } } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── Free-text answers ───────────────────────────────────────────────────────

describe('answering with free text', () => {
  it('a plain message answers directly when exactly ONE question is open', async () => {
    makeQuestion();
    vi.spyOn(verdict, 'resumeWithAnswer').mockImplementation(async (root, question, answer) => ({
      question: { ...refreshQuestion(root, question)!, state: 'answered', resolutionNote: `did: ${answer}` },
      status: 'ok', error: null, result: `did: ${answer}`,
    }));
    const { transport, calls, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'yes, send it', chat: { id: CHAT } } },
    ]);

    await pollTelegram(contextRoot, home, transport);

    expect(calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
    expect(sent().some((c) => String(c.payload.text).includes('did: yes, send it'))).toBe(true);
  });

  it('REFUSES TO GUESS when several automations have a question open on the shared legacy bot', async () => {
    // Ported from Concierge, which learned it with 15 cards open: answering
    // the wrong one is worse than asking which. Two DIFFERENT automations
    // sharing the one legacy bot — each may have at most one pending question
    // of its own (hitl.ts's own invariant), so ambiguity is a cross-slug
    // property under the new model, not a same-slug one.
    makeAutomation({ slug: 'weekly-report', title: 'Weekly report', days: 'daily', at: '09:00', prompt: 'p' });
    makeQuestion();
    makeQuestion({ slug: 'weekly-report', question: 'Publish this week too?' });
    const spy = vi.spyOn(verdict, 'resumeWithAnswer');
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'yes', chat: { id: CHAT } } },
    ]);

    await pollTelegram(contextRoot, home, transport);

    expect(spy).not.toHaveBeenCalled();
    expect(sent().some((c) => String(c.payload.text).includes('cannot tell which one'))).toBe(true);
  });

  it('a REPLY targets its own question even with several open', async () => {
    makeAutomation({ slug: 'weekly-report', title: 'Weekly report', days: 'daily', at: '09:00', prompt: 'p' });
    const first = makeQuestion();
    makeQuestion({ slug: 'weekly-report', question: 'Publish this week too?' });
    const cfg = readTelegramConfig(home)!;
    const { transport } = makeTransport();
    await emitPendingCards(contextRoot, cfg, transport);
    const posted = refreshQuestion(contextRoot, first)!;
    const ref = posted.channelRefs.telegram;

    const spy = vi.spyOn(verdict, 'resumeWithAnswer').mockResolvedValue({
      question: posted, status: 'ok', error: null, result: 'x',
    });
    const { transport: t2 } = makeTransport([
      { update_id: 1, message: { message_id: 9, text: 'go ahead', chat: { id: CHAT }, reply_to_message: { message_id: Number(ref) } } },
    ]);
    await pollTelegram(contextRoot, home, t2);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1].id).toBe(first.id);
  });

  it('says nothing is waiting when a session exists but no question is pending', async () => {
    recordAutomationSession('digest', 'sess-1', home);
    writeAutomationCache(contextRoot, 'digest', {
      slug: 'digest', lastRunAt: NOW, lastFireAt: NOW, status: 'ok', durationMs: 10,
      outputPath: null, error: null, exitCode: 0,
      history: [{
        firedAt: NOW, startedAt: NOW, finishedAt: NOW, status: 'ok', durationMs: 10,
        outputPath: null, error: null, exitCode: 0, sessionId: 'sess-1', costUsd: null,
        numTurns: null, permissionDenials: 0,
      }],
    });
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'hello?', chat: { id: CHAT } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(sent().some((c) => String(c.payload.text).includes('Nothing is waiting'))).toBe(true);
  });

  it('a failed answer attempt says so plainly, rather than silently doing nothing', async () => {
    const q = makeQuestion();
    vi.spyOn(verdict, 'resumeWithAnswer').mockResolvedValue({
      question: { ...q, state: 'answered', resolutionError: 'unparseable CLI output' },
      status: 'failed', error: 'unparseable CLI output', result: null,
    });
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'go ahead', chat: { id: CHAT } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(sent().some((c) => String(c.payload.text).includes('unparseable CLI output'))).toBe(true);
  });
});

// ─── The offset ──────────────────────────────────────────────────────────────

describe('the offset is persisted', () => {
  it('advances past processed updates so an answer is never replayed', async () => {
    // A replayed callback would be a second answer to a question already
    // resolved.
    const q = makeQuestion({ choices: ['Approve'] });
    vi.spyOn(verdict, 'resumeWithAnswer').mockResolvedValue({
      question: { ...q, state: 'answered' }, status: 'ok', error: null, result: null,
    });
    const { transport } = makeTransport([
      { update_id: 10, callback_query: { id: 'a', data: `answer:${q.id}:0`, message: { message_id: 5, chat: { id: CHAT } } } },
    ]);
    await pollTelegram(contextRoot, home, transport);
    expect(readTelegramConfig(home)?.offset).toBe(11);
  });

  it('a poisonous update is skipped, not retried forever', async () => {
    makeQuestion();
    vi.spyOn(verdict, 'resumeWithAnswer').mockRejectedValue(new Error('boom'));
    const { transport } = makeTransport([
      { update_id: 5, message: { message_id: 7, text: 'x', chat: { id: CHAT } } },
    ]);
    await expect(pollTelegram(contextRoot, home, transport)).resolves.toBeDefined();
    expect(readTelegramConfig(home)?.offset).toBe(6);
  });
});

describe('describeTelegram', () => {
  it('reports what the channel can see without sending anything', () => {
    makeQuestion();
    const state = describeTelegram(contextRoot, home);
    expect(state).toMatchObject({ configured: true, chatId: CHAT, pending: 1, posted: 0 });
  });
});

// ─── S5 — per-bot scoping: never a project-wide lookup ─────────────────────
//
// A leaked or compromised per-automation bot token must not be able to answer
// or even discover a DIFFERENT automation's question. Every per-bot lookup in
// this file resolves through `pendingQuestion(contextRoot, slug)` for slugs
// the bot was explicitly handed — `allPendingQuestions` is reachable only
// from the two legacy, whole-project entry points (`emitPendingCards`,
// `describeTelegram`), never from `pollTelegram`'s per-bot fan-out.

describe('S5 — per-automation bot scoping', () => {
  it("a per-slug bot handed a callback carrying a DIFFERENT slug's question id refuses it, untouched", async () => {
    makeAutomation({ slug: 'other-job', title: 'Other job', days: 'daily', at: '19:00', prompt: 'p' });
    writeTelegramConfigForSlug('digest', { botToken: 'digest-tok', chatId: 'DIGEST_CHAT', offset: 0 }, home);
    writeTelegramConfigForSlug('other-job', { botToken: 'other-tok', chatId: 'OTHER_CHAT', offset: 0 }, home);
    recordAutomationSession('other-job', 'sess-other', home);
    const otherQ = createQuestion(contextRoot, {
      slug: 'other-job', runFiredAt: NOW, kind: 'flow-hitl', sessionId: 'sess-other',
      channel: 'telegram', question: 'Ship the other job?', choices: ['Yes'], nowISO: NOW,
    });

    const spy = vi.spyOn(verdict, 'resumeWithAnswer');
    // A callback naming OTHER-JOB's question, sent to DIGEST's authorized chat —
    // as if digest's leaked token were used to try to answer a sibling's
    // question.
    const { transport, sent } = makeTransport([
      { update_id: 1, callback_query: { id: 'cb', data: `answer:${otherQ.id}:0`, message: { message_id: 5, chat: { id: 'DIGEST_CHAT' } } } },
    ]);

    await pollTelegram(contextRoot, home, transport);

    expect(spy).not.toHaveBeenCalled();
    expect(refreshQuestion(contextRoot, otherQ)?.state).toBe('pending');
    // Reads identically to "answered elsewhere" — a leaked token learns
    // nothing about whether the id exists for a different slug.
    expect(sent().some((c) => String(c.payload.text).includes('answered somewhere else'))).toBe(true);
  });

  it('a per-slug bot never returns a question belonging to a different slug from a bare reply either', async () => {
    makeAutomation({ slug: 'other-job', title: 'Other job', days: 'daily', at: '19:00', prompt: 'p' });
    writeTelegramConfigForSlug('digest', { botToken: 'digest-tok', chatId: 'DIGEST_CHAT', offset: 0 }, home);
    writeTelegramConfigForSlug('other-job', { botToken: 'other-tok', chatId: 'OTHER_CHAT', offset: 0 }, home);
    recordAutomationSession('other-job', 'sess-other', home);
    createQuestion(contextRoot, {
      slug: 'other-job', runFiredAt: NOW, kind: 'flow-hitl', sessionId: 'sess-other',
      channel: 'telegram', question: 'Ship the other job?', nowISO: NOW,
    });

    const spy = vi.spyOn(verdict, 'resumeWithAnswer');
    // digest's bot has NOTHING of its own pending — a bare reply to IT must
    // never resolve to other-job's question just because one exists somewhere
    // in the project.
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'yes', chat: { id: 'DIGEST_CHAT' } } },
    ]);

    await pollTelegram(contextRoot, home, transport);

    expect(spy).not.toHaveBeenCalled();
    expect(sent().some((c) => String(c.payload.text).includes('no session to talk to yet'))).toBe(true);
  });
});

// ─── R1 — an 'approval' question is never resumed, whatever channel asks ───

describe("R1 — an 'approval' question answered from Telegram", () => {
  it("surfaces resumeWithAnswer's refusal as a plain reply, rather than silence", async () => {
    // Real (unmocked) resumeWithAnswer — this proves the actual security
    // boundary lives in verdict.ts, not merely that telegram.ts routes to it.
    const q = createQuestion(contextRoot, {
      slug: 'digest', runFiredAt: NOW, kind: 'approval', sessionId: null,
      channel: 'telegram', question: 'The manifest changed — go ahead?', nowISO: NOW,
    });
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'yes', chat: { id: CHAT } } },
    ]);

    await pollTelegram(contextRoot, home, transport);

    expect(sent().some((c) => String(c.payload.text).includes('answered by approving the manifest'))).toBe(true);
    // Untouched — refused before any claim/spawn attempt.
    expect(refreshQuestion(contextRoot, q)?.state).toBe('pending');
  });
});

// ─── D-E — session resolution never falls back to an unverified claim ──────

describe('D-E — "does this automation even have a session to talk to?"', () => {
  it('has never run: refuses plainly and never spawns', async () => {
    const spy = vi.spyOn(verdict, 'resumeWithAnswer');
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'hello?', chat: { id: CHAT } } },
    ]);

    await pollTelegram(contextRoot, home, transport);

    expect(spy).not.toHaveBeenCalled();
    expect(sent().some((c) => String(c.payload.text).includes('has no session to talk to yet'))).toBe(true);
  });

  it('the cache CLAIMS a session, but it was never bound on this machine — refuses, never trusts the claim', async () => {
    // `automations/cache/<slug>.json` is brain-synced and therefore
    // teammate-writable. A session id appearing there must never be enough,
    // on its own, to become resumable from an inbound Telegram message.
    writeAutomationCache(contextRoot, 'digest', {
      slug: 'digest', lastRunAt: NOW, lastFireAt: NOW, status: 'ok', durationMs: 10,
      outputPath: null, error: null, exitCode: 0,
      history: [{
        firedAt: NOW, startedAt: NOW, finishedAt: NOW, status: 'ok', durationMs: 10,
        outputPath: null, error: null, exitCode: 0, sessionId: 'unbound-session', costUsd: null,
        numTurns: null, permissionDenials: 0,
      }],
    });
    // Deliberately NOT calling recordAutomationSession — the claim is unverified.
    const spy = vi.spyOn(verdict, 'resumeWithAnswer');
    const { transport, sent } = makeTransport([
      { update_id: 1, message: { message_id: 7, text: 'hello?', chat: { id: CHAT } } },
    ]);

    await pollTelegram(contextRoot, home, transport);

    expect(spy).not.toHaveBeenCalled();
    expect(sent().some((c) => String(c.payload.text).includes('has no session to talk to yet'))).toBe(true);
  });
});

// ─── Per-automation credentials ─────────────────────────────────────────────
//
// A bot token plus an authorized chat id is the ability to resume a
// `bypassPermissions` session on this machine. One global token meant one leak
// handed over every automation at once; per-slug makes the blast radius one job.
// The slug is a PATH SEGMENT now, which the single-filename design never had to
// think about — so it is validated rather than trusted.

describe('per-automation credentials', () => {
  const CFG = { botToken: '123:abc', chatId: '4242', offset: 0 };

  it('lives at ~/.dreamcontext/telegram/<slug>.json', () => {
    expect(telegramConfigPathForSlug('eod-digest', home)).toBe(
      join(home, '.dreamcontext', 'telegram', 'eod-digest.json'),
    );
  });

  it('round-trips a config', () => {
    writeTelegramConfigForSlug('eod-digest', CFG, home);
    expect(readTelegramConfigForSlug('eod-digest', home)).toEqual(CFG);
  });

  it('is written 0600 — the token is a capability, not a preference', () => {
    writeTelegramConfigForSlug('eod-digest', CFG, home);
    expect(statSync(telegramConfigPathForSlug('eod-digest', home)).mode & 0o777).toBe(0o600);
  });

  it('one automation cannot read another\'s bot', () => {
    // The isolation that makes per-slug worth doing: a leaked token for one job
    // must not reach another. `getUpdates` is scoped server-side by token, so
    // this half is about never LOOKING somewhere else.
    writeTelegramConfigForSlug('eod-digest', CFG, home);
    expect(readTelegramConfigForSlug('weekly-report', home)).toBeNull();
  });

  it('refuses a traversal slug on every path, writing nothing', () => {
    expect(() => telegramConfigPathForSlug('../../etc/passwd', home)).toThrow(/unsafe slug/);
    expect(readTelegramConfigForSlug('../../etc/passwd', home)).toBeNull();
    expect(() => writeTelegramConfigForSlug('../../etc/passwd', CFG, home)).toThrow(/unsafe slug/);
    expect(existsSync(join(home, '.dreamcontext', 'telegram'))).toBe(false);
  });

  it('a missing or malformed config reads as "Telegram is off for this automation"', () => {
    expect(readTelegramConfigForSlug('eod-digest', home)).toBeNull();
    mkdirSync(join(home, '.dreamcontext', 'telegram'), { recursive: true });
    writeFileSync(telegramConfigPathForSlug('eod-digest', home), 'not json', 'utf-8');
    expect(readTelegramConfigForSlug('eod-digest', home)).toBeNull();
    writeFileSync(telegramConfigPathForSlug('eod-digest', home), JSON.stringify({ botToken: '', chatId: '4242' }), 'utf-8');
    expect(readTelegramConfigForSlug('eod-digest', home)).toBeNull();
  });

  it('lists every automation with a bot, ignoring anything that is not one', () => {
    writeTelegramConfigForSlug('eod-digest', CFG, home);
    writeTelegramConfigForSlug('weekly-report', CFG, home);
    writeFileSync(join(home, '.dreamcontext', 'telegram', 'notes.txt'), 'x', 'utf-8');
    writeFileSync(join(home, '.dreamcontext', 'telegram', 'Not A Slug.json'), '{}', 'utf-8');
    expect(listTelegramSlugs(home)).toEqual(['eod-digest', 'weekly-report']);
  });

  it('lists nothing on a machine that has never set one up', () => {
    expect(listTelegramSlugs(home)).toEqual([]);
  });

  it('forgets one automation\'s bot without touching its siblings', () => {
    writeTelegramConfigForSlug('eod-digest', CFG, home);
    writeTelegramConfigForSlug('weekly-report', CFG, home);
    expect(forgetTelegramConfigForSlug('eod-digest', home)).toBe(true);
    expect(readTelegramConfigForSlug('eod-digest', home)).toBeNull();
    expect(readTelegramConfigForSlug('weekly-report', home)).toEqual(CFG);
  });

  it('forgetting one that was never configured is false, never a throw', () => {
    expect(forgetTelegramConfigForSlug('eod-digest', home)).toBe(false);
  });
});

describe('adopting the legacy global config', () => {
  const GLOBAL = { botToken: 'global:token', chatId: '999', offset: 7 };

  it('gives the global bot to an automation that has none', () => {
    writeTelegramConfig(GLOBAL, home);
    expect(adoptGlobalTelegramConfig('eod-digest', home)).toEqual(GLOBAL);
    expect(readTelegramConfigForSlug('eod-digest', home)).toEqual(GLOBAL);
  });

  it('LEAVES the global file in place — deleting a user\'s only token is not recoverable', () => {
    // They would have to go back to BotFather. The cost of keeping it is one
    // stale file; the cost of removing it is an unrecoverable upgrade.
    writeTelegramConfig(GLOBAL, home);
    adoptGlobalTelegramConfig('eod-digest', home);
    expect(readTelegramConfig(home)).toEqual(GLOBAL);
  });

  it('carries the offset across, so no update is replayed as a second answer', () => {
    writeTelegramConfig(GLOBAL, home);
    expect(adoptGlobalTelegramConfig('eod-digest', home)!.offset).toBe(7);
  });

  it('never overwrites a config the automation already has', () => {
    const own = { botToken: 'own:token', chatId: '111', offset: 0 };
    writeTelegramConfigForSlug('eod-digest', own, home);
    writeTelegramConfig(GLOBAL, home);
    expect(adoptGlobalTelegramConfig('eod-digest', home)).toEqual(own);
    expect(readTelegramConfigForSlug('eod-digest', home)).toEqual(own);
  });

  it('is null when there is no global config to adopt', () => {
    // This suite's beforeEach seeds a global config, so the fresh-machine state
    // has to be made explicitly rather than assumed.
    rmSync(telegramConfigPath(home), { force: true });
    expect(adoptGlobalTelegramConfig('eod-digest', home)).toBeNull();
    expect(readTelegramConfigForSlug('eod-digest', home)).toBeNull();
  });
});
