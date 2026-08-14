/**
 * The Telegram channel — the one that makes a HITL question actually
 * answerable.
 *
 * Every other surface in this feature requires the human to be at the Mac. An
 * automation fires at 18:00 precisely because nobody is at the Mac, so a gate
 * that can only be answered there is a gate that becomes a rubber stamp: you
 * come back the next morning, find seven questions, and answer them all
 * without reading. Tilki's Concierge got this right first and it is the least
 * negotiable thing it teaches — the answer surface has to be where the human
 * already is, which is their phone.
 *
 * THE CREDENTIALS ARE A CAPABILITY, NOT A PREFERENCE. A bot token plus an
 * authorized chat id is the ability to resume a `bypassPermissions` session on
 * this machine. They live machine-locally at 0600 — never the brain, because
 * the brain is synced and a token in a synced repo hands every teammate that
 * ability. Same boundary as the session-binding store, and for a strictly
 * stronger reason.
 *
 * Layer 1 of Concierge's hardening is reproduced verbatim: every inbound
 * update is checked against the authorized chat id and silently dropped
 * otherwise. Not answered, not logged back to the sender — dropped. Anyone
 * can message a bot whose token they do not have; without this gate, anyone
 * could answer your questions.
 *
 * PER-AUTOMATION, NOT ONE GLOBAL BOT (D8). One leaked token used to hand over
 * every automation at once; per-slug credentials make the blast radius one
 * job. The isolation is structural, not merely enforced by this file:
 * `getUpdates` is scoped server-side BY BOT TOKEN, so two per-slug bots
 * cannot see each other's message streams even if they wanted to — but
 * every LOOKUP this file performs must also stay scoped to the slugs a bot
 * was actually given, never a project-wide scan (S5). A per-slug bot resolves
 * a question ONLY through `pendingQuestion(contextRoot, slug)` for slugs it
 * was explicitly handed; `allPendingQuestions` (project-wide) is reachable
 * ONLY from the two legacy, whole-project entry points this file keeps for
 * backward compatibility (`emitPendingCards`, `describeTelegram`) — never
 * from `pollTelegram`'s per-bot fan-out.
 *
 * `pollTelegram` fans out: one poll per automation with its own bot
 * (`listTelegramSlugs`), scoped to that slug alone, plus (if a legacy global
 * config is still present) one more poll covering whatever automations have
 * not adopted a bot of their own — never covering a slug twice.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isSafeAutomationSlug, listAutomations, readAutomationCache } from './store.js';
import { resumeWithAnswer, resumeWithMessage } from './verdict.js';
import { allPendingQuestions, pendingQuestion, setChannelRef } from './hitl.js';
import { AutomationError, type AutomationQuestion } from './types.js';

// ─── Machine-local config ───────────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string;
  /** The ONE chat allowed to answer questions. Everything else is dropped. */
  chatId: string;
  /** getUpdates offset, persisted so an update is never processed twice — a
   *  replayed callback would be a second answer to a question already
   *  resolved. */
  offset: number;
}

export function telegramConfigPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'telegram.json');
}

// ─── Per-automation credentials ─────────────────────────────────────────────
//
// ONE bot per automation, at `~/.dreamcontext/telegram/<slug>.json`, replacing
// the single global config above.
//
// WHY PER-SLUG AT ALL. A bot token plus an authorized chat id is the ability to
// resume a `bypassPermissions` session on this machine. One global token means
// one leak hands over every automation at once, and it means the person who
// wants digest questions on their phone is also opting in the job that touches
// production. Per-automation credentials make the blast radius one job.
//
// The isolation is structural rather than enforced by us: `getUpdates` is scoped
// server-side BY BOT TOKEN, so two per-slug bots cannot see each other's message
// streams even if they wanted to. What this module must add is the other half —
// every lookup a bot performs is scoped to ITS slug, never a project-wide scan.
// A compromised token for `slug-a` must not be able to answer `slug-b`.
//
// The slug is a PATH SEGMENT here, which the old single-filename design never
// had to think about, so it is validated rather than trusted.
//
// NOT gitignore-first, unlike `lab/credentials.ts`: that writes INTO the brain,
// where a secret is one `git add` from being published, so it must have a
// governing ignore entry before it touches disk. This writes to HOME, which is
// not a repository at all — there is no `.gitignore` to place and creating one
// would be theatre. The protection here is the same one the session-binding
// store uses: 0600, and a boundary git never sees.

/** Directory holding every automation's bot credentials. */
export function telegramConfigDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'telegram');
}

/** One automation's bot credentials. Throws on a slug that is not path-safe
 *  rather than returning a traversal path — this value is used to WRITE a
 *  credential file, so a caller that skipped validation must fail loudly. */
export function telegramConfigPathForSlug(slug: string, home: string = homedir()): string {
  if (!isSafeAutomationSlug(slug)) {
    throw new AutomationError(`Refusing to resolve a Telegram config path for an unsafe slug: "${slug}"`);
  }
  return join(telegramConfigDir(home), `${slug}.json`);
}

/** Never throws; a missing or malformed config reads as "Telegram is off for
 *  this automation", the correct degradation for an optional channel. */
export function readTelegramConfigForSlug(slug: string, home: string = homedir()): TelegramConfig | null {
  if (!isSafeAutomationSlug(slug)) return null;
  return readConfigFile(telegramConfigPathForSlug(slug, home));
}

/**
 * Atomic + 0600, per automation.
 *
 * The mode is set on the TEMP file before the rename, so the token is never
 * readable by other users even for the instant between create and chmod — the
 * same ordering the global writer above uses, and the same one
 * `lab/credentials.ts` uses for its own secret.
 */
export function writeTelegramConfigForSlug(slug: string, cfg: TelegramConfig, home: string = homedir()): void {
  const path = telegramConfigPathForSlug(slug, home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Every automation with a bot configured on this machine, sorted. A missing
 *  directory means none — the state every machine is in until someone runs
 *  `automations telegram setup`. */
export function listTelegramSlugs(home: string = homedir()): string[] {
  let names: string[];
  try {
    names = readdirSync(telegramConfigDir(home));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .filter((slug) => isSafeAutomationSlug(slug))
    .sort();
}

/** Remove one automation's bot credentials. Idempotent. */
export function forgetTelegramConfigForSlug(slug: string, home: string = homedir()): boolean {
  if (!isSafeAutomationSlug(slug)) return false;
  try {
    unlinkSync(telegramConfigPathForSlug(slug, home));
    return true;
  } catch {
    return false;
  }
}

/**
 * One-shot migration: adopt the legacy global config for an automation that has
 * none of its own.
 *
 * The global file is left IN PLACE, deliberately. Deleting a user's only bot
 * token during an upgrade is not recoverable — they would have to go back to
 * BotFather — and the cost of leaving it is one stale file. Returns the config
 * that is now in force for the slug, or null when there was nothing to adopt.
 */
export function adoptGlobalTelegramConfig(slug: string, home: string = homedir()): TelegramConfig | null {
  if (!isSafeAutomationSlug(slug)) return null;
  const existing = readTelegramConfigForSlug(slug, home);
  if (existing) return existing;
  const global = readTelegramConfig(home);
  if (!global) return null;
  // The offset resets to the global's, not to zero: replaying updates already
  // handled would be a second answer to something already resolved.
  writeTelegramConfigForSlug(slug, global, home);
  return global;
}

/** Shared lenient parse for both the global and per-slug files. */
function readConfigFile(path: string): TelegramConfig | null {
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

/** Never throws; a missing or malformed config reads as "Telegram is off",
 *  which is the correct degradation for an optional channel. */
export function readTelegramConfig(home: string = homedir()): TelegramConfig | null {
  return readConfigFile(telegramConfigPath(home));
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
      // A network blip is not an error worth failing a tick over — the
      // question stays unposted and the next tick tries again.
      return { ok: false };
    }
  },
};

// ─── Rendering ──────────────────────────────────────────────────────────────

/** Telegram caps a message at 4096 chars; the body is capped well under that so
 *  the header and footer always survive. */
const TELEGRAM_BODY_MAX = 3_000;

export function renderQuestionText(q: AutomationQuestion): string {
  const body = q.question.length > TELEGRAM_BODY_MAX
    ? `${q.question.slice(0, TELEGRAM_BODY_MAX - 1).trimEnd()}…`
    : q.question;
  const lines = [`🤖 ${q.slug}`, '', body];
  if (q.steers.length > 0) {
    lines.push('', `✍️ ${q.steers.length} correction(s) so far — latest: "${q.steers[q.steers.length - 1].text}"`);
  }
  lines.push(
    '',
    q.choices.length > 0
      ? 'Tap an answer below, or reply with your own.'
      : 'Reply with your answer — it goes straight back to the run that asked.',
  );
  return lines.join('\n');
}

/** One button per offered choice, each on its own row so a long choice label
 *  never gets clipped against a neighbour. `undefined` (no keyboard at all)
 *  for a free-text-only question — a question is never a command a surface
 *  executes, so there is nothing to render a button for. */
export function renderQuestionKeyboard(q: AutomationQuestion): unknown | undefined {
  if (q.choices.length === 0) return undefined;
  return {
    inline_keyboard: q.choices.map((choice, i) => [{ text: choice, callback_data: `answer:${q.id}:${i}` }]),
  };
}

// ─── Posting ────────────────────────────────────────────────────────────────

/**
 * Post every question in `questions` that has not been posted yet, and record
 * its message id so a later poll EDITS it in place rather than posting a
 * second copy of a question that is still the same question. A question that
 * IS already posted and still pending is refreshed in place — a correction
 * recorded through another channel (the chat pane, the dashboard) must not
 * leave the Telegram copy showing stale text while a human decides from their
 * phone.
 */
async function emitQuestions(
  contextRoot: string,
  questions: AutomationQuestion[],
  cfg: TelegramConfig,
  transport: TelegramTransport,
): Promise<number> {
  let posted = 0;
  for (const q of questions) {
    if (q.channelRefs.telegram) {
      await editQuestionInPlace(cfg, q, transport);
      continue;
    }
    const keyboard = renderQuestionKeyboard(q);
    const res = await transport.call(cfg.botToken, 'sendMessage', {
      chat_id: cfg.chatId,
      text: renderQuestionText(q),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    if (!res.ok) continue; // no ref recorded ⇒ the next tick retries; never lost
    const messageId = (res.result as { message_id?: number } | undefined)?.message_id;
    if (typeof messageId !== 'number') continue;
    setChannelRef(contextRoot, q, 'telegram', String(messageId));
    posted += 1;
  }
  return posted;
}

/**
 * LEGACY, WHOLE-PROJECT entry point — kept exactly as named because the CLI
 * imports it directly (`dreamcontext automations telegram test`) against the
 * one global config, which by nature has no single slug to scope to. This is
 * NOT part of the per-bot fan-out `pollTelegram` drives (S5): the multi-bot
 * poll below never calls this function, and builds its own scoped question
 * list instead.
 */
export async function emitPendingCards(
  contextRoot: string,
  cfg: TelegramConfig,
  transport: TelegramTransport = fetchTransport,
): Promise<number> {
  return emitQuestions(contextRoot, allPendingQuestions(contextRoot), cfg, transport);
}

/** Refresh an already-posted message in place — same text/keyboard-shape
 *  rules `emitQuestions` uses for a fresh post, so a steer or a re-poll never
 *  shows the human two different renderings of the same question. */
async function editQuestionInPlace(
  cfg: TelegramConfig,
  q: AutomationQuestion,
  transport: TelegramTransport,
): Promise<void> {
  const messageId = q.channelRefs.telegram;
  if (!messageId) return;
  const keyboard = renderQuestionKeyboard(q);
  await transport.call(cfg.botToken, 'editMessageText', {
    chat_id: cfg.chatId,
    message_id: Number(messageId),
    text: renderQuestionText(q),
    ...(keyboard ? { reply_markup: keyboard } : { reply_markup: { inline_keyboard: [] } }),
  });
}

/** Strip the buttons and say what happened. A resolved question that keeps
 *  its buttons invites a second tap on a decision already made. */
async function finalizeQuestionMessage(
  cfg: TelegramConfig,
  q: AutomationQuestion,
  note: string,
  transport: TelegramTransport,
): Promise<void> {
  const messageId = q.channelRefs.telegram;
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
  /** Diagnostic only. Each bot polled by a fan-out persists its OWN offset to
   *  its OWN config file (per-slug or the legacy global one) — this is simply
   *  the highest offset among however many bots this call polled, `0` when
   *  none were. It is meaningful in the common single-bot case and is not
   *  something any caller should branch on. */
  offset: number;
}

function chatIdOf(u: TelegramUpdate): string | null {
  const raw = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
  return raw === undefined ? null : String(raw);
}

/**
 * S5 — resolves a question id ONLY through the scoped slugs a bot was handed,
 * via `pendingQuestion`, never `allPendingQuestions` (project-wide). A
 * callback naming a question that belongs to a DIFFERENT slug — or to no
 * slug this bot was ever given — resolves to `null` here, indistinguishable
 * from "no longer open". A leaked per-automation token therefore cannot even
 * discover, let alone answer, a sibling automation's question.
 */
function findQuestionForSlugs(contextRoot: string, slugs: string[], id: string): AutomationQuestion | null {
  for (const slug of slugs) {
    const q = pendingQuestion(contextRoot, slug);
    if (q && q.id === id) return q;
  }
  return null;
}

/** Every currently-pending question across a bot's scoped slugs, oldest slug
 *  first. At most one entry per slug — `pendingQuestion` is itself "the
 *  oldest pending", and a slug that owes a human an answer never has a
 *  second question open at the same time. */
function scopedPendingQuestions(contextRoot: string, slugs: string[]): AutomationQuestion[] {
  const out: AutomationQuestion[] = [];
  for (const slug of slugs) {
    const q = pendingQuestion(contextRoot, slug);
    if (q) out.push(q);
  }
  return out;
}

/**
 * D-E — a bare message with no question open TALKS to the latest run.
 *
 * Only a single-slug (per-automation) bot has a referent for "the latest run";
 * the legacy multi-slug fallback refuses, because guessing which automation the
 * human meant is worse than saying so. The resolution and every refusal live in
 * `resumeWithMessage`: the session id comes from the MACHINE-LOCAL binding
 * store (never the brain-synced cache's own claim), and a missing binding is a
 * plain refusal, never a trigger to spawn a fresh session — an inbound
 * Telegram message must never become a run trigger.
 */
async function handleTalkMessage(
  contextRoot: string,
  slugs: string[],
  cfg: TelegramConfig,
  text: string,
  transport: TelegramTransport,
  home: string,
): Promise<void> {
  if (slugs.length !== 1) {
    await notifyTelegram(cfg, 'Nothing is waiting for an answer right now.', transport);
    return;
  }
  const outcome = await resumeWithMessage(contextRoot, slugs[0], text, { home });
  if (outcome.status !== 'ok') {
    await notifyTelegram(cfg, `⚠️ ${outcome.error ?? 'the run could not be reached'}`, transport);
    return;
  }
  const reply = outcome.result || 'The run finished without saying anything.';
  // Cap by CODE POINT (the reply is free-form model output and a slice can
  // split a surrogate pair), same as the completion delivery in runner.ts.
  const points = [...reply];
  await notifyTelegram(
    cfg,
    points.length <= TELEGRAM_BODY_MAX ? reply : `${points.slice(0, TELEGRAM_BODY_MAX - 1).join('').trimEnd()}…`,
    transport,
  );
}

/** Resume the session that asked, act on the outcome, and tell the human what
 *  happened — the ONE finishing move both `handleAnswerCallback` and
 *  `handleAnswerMessage` share, whatever triggered it. */
async function handleAnswer(
  contextRoot: string,
  cfg: TelegramConfig,
  question: AutomationQuestion,
  answer: string,
  home: string,
  transport: TelegramTransport,
): Promise<void> {
  const outcome = await resumeWithAnswer(contextRoot, question, answer, 'telegram', { home });
  if (outcome.status === 'refused' || outcome.status === 'not-spawned') {
    // Covers R1's kind-gate refusal too: an `approval` question answered from
    // Telegram surfaces `resumeWithAnswer`'s own refusal text plainly, rather
    // than silently doing nothing.
    await notifyTelegram(cfg, `⚠️ ${outcome.error ?? 'could not answer that question'}`, transport, outcome.question.channelRefs.telegram);
    return;
  }
  const detail = outcome.question.resolutionError
    ? `⚠️ answered, but it did not finish cleanly: ${outcome.question.resolutionError}`
    : `✅ answered${outcome.question.resolutionNote ? ` — ${outcome.question.resolutionNote}` : ''}`;
  await finalizeQuestionMessage(cfg, outcome.question, detail, transport);
}

async function handleAnswerCallback(
  contextRoot: string,
  slugs: string[],
  cfg: TelegramConfig,
  update: TelegramUpdate,
  transport: TelegramTransport,
  home: string,
): Promise<void> {
  const cb = update.callback_query as NonNullable<TelegramUpdate['callback_query']>;
  if (cb.id) await transport.call(cfg.botToken, 'answerCallbackQuery', { callback_query_id: cb.id });

  const [action, questionId, choiceIndexRaw] = (cb.data ?? '').split(':');
  if (action !== 'answer' || !questionId) return;

  const question = findQuestionForSlugs(contextRoot, slugs, questionId);
  if (!question) {
    // Answered elsewhere, OR (S5) a callback naming a question outside this
    // bot's scoped slugs — both must read identically from the outside, so a
    // leaked token learns nothing about a sibling automation either way.
    await notifyTelegram(cfg, 'That question is no longer open — it may have been answered somewhere else.', transport);
    return;
  }

  const choiceIndex = Number(choiceIndexRaw);
  const answer = Number.isInteger(choiceIndex) ? question.choices[choiceIndex] : undefined;
  if (answer === undefined) return; // malformed callback data — nothing safe to answer with

  await handleAnswer(contextRoot, cfg, question, answer, home, transport);
}

async function handleAnswerMessage(
  contextRoot: string,
  slugs: string[],
  cfg: TelegramConfig,
  update: TelegramUpdate,
  transport: TelegramTransport,
  home: string,
): Promise<void> {
  const msg = update.message as NonNullable<TelegramUpdate['message']>;
  const text = (msg.text ?? '').trim();
  if (!text) return;

  const open = scopedPendingQuestions(contextRoot, slugs);

  // AMBIGUITY REFUSES TO GUESS. With several questions open across this bot's
  // slugs, "the newest" is a guess, and answering the wrong one is worse than
  // asking which one — ported straight from Concierge, which learned it with
  // 15 cards open.
  let question: AutomationQuestion | null = null;
  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo !== undefined) {
    question = open.find((q) => q.channelRefs.telegram === String(replyTo)) ?? null;
    if (!question) {
      await notifyTelegram(cfg, 'That question is no longer open, so the answer was not applied.', transport);
      return;
    }
  } else if (open.length === 1) {
    question = open[0];
  } else if (open.length === 0) {
    // Nothing pending ⇒ this is not an answer at all — it is the human
    // starting a conversation with the run. D-E resolves (or refuses) it.
    await handleTalkMessage(contextRoot, slugs, cfg, text, transport, home);
    return;
  } else {
    await notifyTelegram(
      cfg,
      `⚠️ ${open.length} questions are open, so I cannot tell which one you mean. Reply to the question you want to answer.`,
      transport,
    );
    return;
  }

  await handleAnswer(contextRoot, cfg, question, text, home, transport);
}

/** One bot's scope for a single poll: the slugs it may act on, its
 *  credentials, and where its advanced offset gets written back to — a
 *  per-slug bot writes its own file; the legacy fallback writes the shared
 *  global one. */
interface PollScope {
  slugs: string[];
  cfg: TelegramConfig;
  persistOffset: (offset: number) => void;
}

async function pollScope(
  contextRoot: string,
  scope: PollScope,
  transport: TelegramTransport,
  home: string,
): Promise<PollResult> {
  // Post anything new BEFORE reading: a question that appeared since the last
  // tick should be answerable in this same round trip.
  await emitQuestions(contextRoot, scopedPendingQuestions(contextRoot, scope.slugs), scope.cfg, transport);

  const res = await transport.call(scope.cfg.botToken, 'getUpdates', {
    offset: scope.cfg.offset,
    timeout: 0,
    allowed_updates: ['message', 'callback_query'],
  });
  if (!res.ok || !Array.isArray(res.result)) return { processed: 0, unauthorized: 0, offset: scope.cfg.offset };

  const updates = res.result as TelegramUpdate[];
  let processed = 0;
  let unauthorized = 0;
  let offset = scope.cfg.offset;

  for (const update of updates) {
    if (typeof update.update_id === 'number') offset = Math.max(offset, update.update_id + 1);

    // LAYER 1 — the auth gate. Anyone can message a bot; only the authorized
    // chat may answer questions. Dropped silently: replying would confirm the
    // bot exists and is listening.
    if (chatIdOf(update) !== scope.cfg.chatId) {
      unauthorized += 1;
      continue;
    }

    try {
      if (update.callback_query) {
        await handleAnswerCallback(contextRoot, scope.slugs, scope.cfg, update, transport, home);
        processed += 1;
      } else if (update.message?.text) {
        await handleAnswerMessage(contextRoot, scope.slugs, scope.cfg, update, transport, home);
        processed += 1;
      }
    } catch {
      // One bad update must not wedge the queue — the offset still advances
      // below, so a poisonous update is skipped rather than retried forever.
    }
  }

  // Persist the offset LAST and unconditionally: an update processed twice
  // would be a second answer to a question already resolved.
  if (offset !== scope.cfg.offset) scope.persistOffset(offset);
  return { processed, unauthorized, offset };
}

/**
 * Drain every configured bot's update queue and act on it — a fan-out over
 * one poll per automation that has its own bot, plus (if a legacy global
 * config still exists) one more poll covering whatever automations have not
 * adopted a bot of their own.
 *
 * Runs inside the dispatcher tick, so it works with the app closed — which is
 * the whole point, since that is when automations fire. An answer therefore
 * lands within one tick (5 minutes), which is right for a scheduler and wrong
 * for a chat; the server polls faster while it happens to be up.
 *
 * Cheap when nothing is configured: `listTelegramSlugs` is an empty-directory
 * readdir and `readTelegramConfig` a missing-file read, so a machine that has
 * never run `automations telegram setup` makes zero network calls here.
 */
export async function pollTelegram(
  contextRoot: string,
  home: string = homedir(),
  transport: TelegramTransport = fetchTransport,
): Promise<PollResult> {
  const perSlugSlugs = listTelegramSlugs(home);
  const results: PollResult[] = [];

  for (const slug of perSlugSlugs) {
    const cfg = readTelegramConfigForSlug(slug, home);
    if (!cfg) continue; // vanished between the list and the read — skip, not fatal
    results.push(
      await pollScope(
        contextRoot,
        { slugs: [slug], cfg, persistOffset: (offset) => writeTelegramConfigForSlug(slug, { ...cfg, offset }, home) },
        transport,
        home,
      ),
    );
  }

  // The legacy global bot, scoped to whatever automations have NOT adopted
  // their own — never a project-wide lookup even here (S5): its coverage is
  // named explicitly, not discovered by scanning every pending question.
  const legacy = readTelegramConfig(home);
  if (legacy) {
    const withOwnBot = new Set(perSlugSlugs);
    const legacySlugs = listAutomations(contextRoot)
      .map((m) => m.slug)
      .filter((slug) => !withOwnBot.has(slug));
    if (legacySlugs.length > 0) {
      results.push(
        await pollScope(
          contextRoot,
          { slugs: legacySlugs, cfg: legacy, persistOffset: (offset) => writeTelegramConfig({ ...legacy, offset }, home) },
          transport,
          home,
        ),
      );
    }
  }

  return {
    processed: results.reduce((sum, r) => sum + r.processed, 0),
    unauthorized: results.reduce((sum, r) => sum + r.unauthorized, 0),
    offset: results.reduce((max, r) => Math.max(max, r.offset), 0),
  };
}

/** LEGACY, WHOLE-PROJECT entry point — kept exactly as named for the same
 *  reason `emitPendingCards` is: the CLI's `telegram test`/`setup` verbs act
 *  on the one global config, which has no single slug to scope to. */
export function describeTelegram(contextRoot: string, home: string = homedir()): {
  configured: boolean;
  chatId: string | null;
  pending: number;
  posted: number;
} {
  const cfg = readTelegramConfig(home);
  const pending = allPendingQuestions(contextRoot);
  return {
    configured: cfg !== null,
    chatId: cfg?.chatId ?? null,
    pending: pending.length,
    posted: pending.filter((q) => q.channelRefs.telegram).length,
  };
}
