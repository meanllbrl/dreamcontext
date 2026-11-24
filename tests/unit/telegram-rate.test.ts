/**
 * A run's rating request on Telegram (plan uye-karnesi W3 C11-C13, criteria 22-24): his star tap,
 * the "Not ekle" prompt and his typed or spoken reply, the replay of a note the app stopped on, the
 * 72-hour window and the closing sweep. A fixture hub and a stubbed transport; no model, no network.
 *
 * Fictional project and agents only ("Acme", "herodot").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAgent } from '../../src/lib/agents/store.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { newThreadEntryId, threadSlugDir } from '../../src/lib/automations/threads.js';
import { THREAD_ENTRY_MARKER, type ThreadEntry } from '../../src/lib/automations/types.js';
import { readScorecard } from '../../src/lib/agents/scorecard.js';
import { attachTelegramAsk, rateRun, setTelegramMessage } from '../../src/lib/agents/scorecard-ops.js';
import { rateKeyboard, type JournalEntry } from '../../src/lib/telegram/contract.js';
import { TelegramError } from '../../src/lib/telegram/transport.js';
import {
  RATE_LINES, SWEEP_MAX_TRIES, onRateReply, onRateTap, replayRateNote, resetRateIndexForTests, setRateSpawnForTests, sweepRateAsks, wireRating,
} from '../../src/server/telegram/rate.js';
import type { ActiveBinding, TelegramHub } from '../../src/server/telegram/hub.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let realHome: string | undefined;
const NOW = new Date('2026-11-20T12:00:00.000Z');
const H = 3_600_000;
const FIRED = '2026-11-20T09:00:00.000Z';
const ENDED = Date.parse('2026-11-20T09:01:00.000Z');
const BOT = 111;
const CHAT = 222;
const NOTE = 'Çok fazla bütçe, test edilmemiş kitleye';

let seq = 0;
function put(e: Omit<ThreadEntry, 'id'>): void {
  const dir = threadSlugDir(contextRoot, 'daily-digest');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${e.at.slice(0, 10)}.md`);
  const prev = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  writeFileSync(path, `${prev}${THREAD_ENTRY_MARKER}\n\`\`\`json\n${JSON.stringify({ ...e, id: newThreadEntryId(Date.parse(e.at) + seq++) })}\n\`\`\`\n\n`);
}
function run(firedAt = FIRED): string {
  const end = new Date(Date.parse(firedAt) + 60_000).toISOString();
  put({ runId: firedAt, kind: 'system', event: 'started', at: firedAt, text: '', via: 'runner' } as Omit<ThreadEntry, 'id'>);
  put({ runId: firedAt, kind: 'agent', at: end, text: 'Budget plan posted.', via: 'cli' } as Omit<ThreadEntry, 'id'>);
  put({ runId: firedAt, kind: 'system', event: 'ok', at: end, text: '', via: 'runner' } as Omit<ThreadEntry, 'id'>);
  return `daily-digest::${firedAt}`;
}

interface Fake {
  hub: TelegramHub;
  ab: ActiveBinding;
  answers: Array<[string, string | undefined]>;
  edits: Array<[number, unknown]>;
  sent: Array<{ html: string; opts?: Record<string, unknown> }>;
  journal: JournalEntry[];
  /** Every journal entry ever written (the note is journaled before it is stored). */
  seen: JournalEntry[];
  spawned: unknown[];
  clock: { now: number };
  heard: Array<{ ok: true; text: string } | { ok: false }>;
  editFails: unknown[];
}

function fake(over: { chatId?: number } = {}): Fake {
  const f = {
    answers: [], edits: [], sent: [], journal: [], seen: [], spawned: [], clock: { now: ENDED + H }, heard: [], editFails: [],
  } as unknown as Fake;
  let mid = 1000;
  const transport = {
    answerCallbackQuery: async (_id: string, text?: string) => { f.answers.push([_id, text]); return true; },
    editMessageReplyMarkup: async (_chat: number, messageId: number, markup: unknown) => {
      if (f.editFails.length) { const e = f.editFails.shift(); if (e) throw e; }
      f.edits.push([messageId, markup]);
      return true;
    },
  };
  const ab = {
    key: 'bind-1', scope: 'project', target: 'super', contextRoot, projectName: 'acme',
    binding: { botId: BOT, chatId: over.chatId ?? CHAT }, transport, chain: Promise.resolve(), disabled: false, halted: false,
  } as unknown as ActiveBinding;
  const hub = {
    home,
    active: new Map([['bind-1', ab]]),
    now: () => f.clock.now,
    async send(_ab: ActiveBinding, html: string, opts?: Record<string, unknown>) { f.sent.push({ html, opts }); return { message_id: ++mid }; },
    editJournal(_ab: ActiveBinding, fn: (p: JournalEntry[]) => JournalEntry[]) {
      f.journal = fn(f.journal);
      for (const j of f.journal) if (!f.seen.includes(j)) f.seen.push(j);
    },
    async notice() { /* none */ },
    async hearVoice() { return f.heard.shift() ?? null; },
    rateHook: null,
  } as unknown as TelegramHub;
  f.hub = hub;
  f.ab = ab;
  return f;
}

beforeEach(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-tgrate-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-tgrate-home-')));
  realHome = process.env.HOME;
  process.env.HOME = home;
  createAgent(contextRoot, { slug: 'herodot', title: 'Herodot', prompt: 'Herodot plans the fictional Acme budget.', learning: false }, { approve: { now: NOW, home } });
  createAutomation(contextRoot, { slug: 'daily-digest', title: 'Daily digest', agent: 'herodot', days: 'daily', at: '09:00' }, { approve: { now: NOW, home } });
  resetRateIndexForTests();
});
afterEach(() => {
  setRateSpawnForTests(null);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A run whose result went out with stars on message 77. */
function asked(): { key: string; askId: string; runKey: string } {
  const key = run();
  const a = attachTelegramAsk(projectRoot, 'herodot', key, { botId: BOT, chatId: CHAT }, { home, now: NOW })!;
  expect(a).not.toBeNull();
  setTelegramMessage(projectRoot, 'herodot', a.runKey, 77, home);
  return { key, askId: a.askId, runKey: a.runKey };
}
const tap = (askId: string, what: string, messageId = 77) => ({ id: `cb-${seq++}`, data: `s:${askId}:${what}`, message: { message_id: messageId } });
const card = () => readScorecard(projectRoot, 'herodot', home).card;

describe('the request on the card', () => {
  it('one request per run; a failed or unknown run gets none', () => {
    const key = run();
    expect(attachTelegramAsk(projectRoot, 'herodot', key, { botId: BOT, chatId: CHAT }, { home, now: NOW })).not.toBeNull();
    expect(attachTelegramAsk(projectRoot, 'herodot', key, { botId: BOT, chatId: CHAT }, { home, now: NOW })).toBeNull();
    expect(attachTelegramAsk(projectRoot, 'herodot', 'daily-digest::2026-11-01T00:00:00.000Z', { botId: BOT, chatId: CHAT }, { home, now: NOW })).toBeNull();
    expect(Object.keys(card().telegramAsks)).toEqual([key]);
  });
});

describe('a star tap (criterion 22)', () => {
  it('4★ stores his rating from Telegram and redraws the tapped message; 2★ later keeps firstAt', async () => {
    const { askId, runKey } = asked();
    const f = fake();
    await onRateTap(f.hub, f.ab, tap(askId, '4'));
    expect(card().ratings[runKey]).toMatchObject({ stars: 4, by: 'owner', via: 'telegram' });
    expect(f.answers.at(-1)?.[1]).toBe(RATE_LINES.saved(4));
    expect(f.edits.at(-1)).toEqual([77, rateKeyboard(askId, 4)]);
    const first = card().ratings[runKey].firstAt;
    f.clock.now += H;
    // A duplicate message of the same ask (a send retry) redraws itself.
    await onRateTap(f.hub, f.ab, tap(askId, '2', 78));
    expect(card().ratings[runKey]).toMatchObject({ stars: 2, firstAt: first });
    expect(f.edits.at(-1)).toEqual([78, rateKeyboard(askId, 2)]);
  });

  it('lands with the hub restarted between the send and the tap (the request is on the card, not in memory)', async () => {
    const { askId, runKey } = asked();
    resetRateIndexForTests();
    const f = fake();
    await onRateTap(f.hub, f.ab, tap(askId, '5'));
    expect(card().ratings[runKey]?.stars).toBe(5);
  });

  it('an unknown ask id or another chat stores nothing', async () => {
    const { askId, runKey } = asked();
    const f = fake();
    await onRateTap(f.hub, f.ab, tap('0123456789abcdef', '4'));
    expect(f.answers.at(-1)?.[1]).toBe(RATE_LINES.gone);
    const other = fake({ chatId: 999 });
    await onRateTap(other.hub, other.ab, tap(askId, '4'));
    expect(other.answers.at(-1)?.[1]).toBe(RATE_LINES.gone);
    expect(card().ratings[runKey]).toBeUndefined();
  });
});

describe('his note (criterion 23)', () => {
  it('"Not ekle" before stars says stars first; after stars one prompt, his typed reply stored byte for byte with one draft', async () => {
    const spawned: unknown[] = [];
    setRateSpawnForTests((j) => { spawned.push(j); });
    const { askId, runKey } = asked();
    const f = fake();
    await onRateTap(f.hub, f.ab, tap(askId, 'n'));
    expect(f.answers.at(-1)?.[1]).toBe(RATE_LINES.starsFirst);
    expect(f.sent).toHaveLength(0);
    await onRateTap(f.hub, f.ab, tap(askId, '3'));
    await onRateTap(f.hub, f.ab, tap(askId, 'n'));
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].opts).toMatchObject({ reply_markup: { force_reply: true } });
    const promptId = 1001;
    expect(card().telegramAsks[runKey].notePromptIds).toEqual([promptId]);
    // A message that is not a reply to a prompt is not his note: it goes on to the Super.
    expect(await onRateReply(f.hub, f.ab, 1, { message_id: 5, text: 'hello' })).toBe(false);
    expect(await onRateReply(f.hub, f.ab, 2, { message_id: 6, text: 'hi', reply_to_message: { message_id: 4242 } })).toBe(false);
    expect(await onRateReply(f.hub, f.ab, 3, { message_id: 7, text: NOTE, reply_to_message: { message_id: promptId } })).toBe(true);
    await f.ab.chain;
    expect(f.seen.map((j) => [j.kind, j.askId])).toEqual([['rate-note', askId]]);
    expect(card().ratings[runKey]).toMatchObject({ stars: 3, note: NOTE, via: 'telegram' });
    expect(spawned).toHaveLength(1);
    expect(f.journal).toEqual([]);
    expect(f.sent.at(-1)?.html).toContain('Not kaydedildi');
  });

  it('a voice note that cannot be heard asks again with a new prompt; a reply to either prompt is stored', async () => {
    setRateSpawnForTests(() => {});
    const { askId, runKey } = asked();
    const f = fake();
    await onRateTap(f.hub, f.ab, tap(askId, '4'));
    await onRateTap(f.hub, f.ab, tap(askId, 'n'));
    f.heard.push({ ok: false });
    await onRateReply(f.hub, f.ab, 10, { message_id: 20, voice: { file_id: 'v1' }, reply_to_message: { message_id: 1001 } });
    await f.ab.chain;
    expect(f.sent.at(-1)?.html).toContain('çeviremedim');
    expect(card().telegramAsks[runKey].notePromptIds).toEqual([1001, 1002]);
    f.heard.push({ ok: true, text: 'Bütçeyi değiştirmeden önce bana sor.' });
    await onRateReply(f.hub, f.ab, 11, { message_id: 21, voice: { file_id: 'v2' }, reply_to_message: { message_id: 1001 } });
    await f.ab.chain;
    expect(card().ratings[runKey].note).toBe('Bütçeyi değiştirmeden önce bana sor.');
  });

  it('after a restart the prompt ids are indexed again from the card; a replay of a stored note starts no second draft', async () => {
    const spawned: unknown[] = [];
    setRateSpawnForTests((j) => { spawned.push(j); });
    const { askId, runKey } = asked();
    const f = fake();
    await onRateTap(f.hub, f.ab, tap(askId, '4'));
    await onRateTap(f.hub, f.ab, tap(askId, 'n'));
    resetRateIndexForTests();
    const stop = wireRating(f.hub);
    try {
      expect(await onRateReply(f.hub, f.ab, 30, { message_id: 40, text: NOTE, reply_to_message: { message_id: 1001 } })).toBe(true);
      await f.ab.chain;
      expect(card().ratings[runKey].note).toBe(NOTE);
      expect(spawned).toHaveLength(1);
      // The app stopped after storing but before confirming: the journal replays it.
      replayRateNote(f.hub, f.ab, { updateId: 30, kind: 'rate-note', written: false, at: f.clock.now, msg: { message_id: 40, text: NOTE }, askId } as JournalEntry);
      await f.ab.chain;
      expect(spawned).toHaveLength(1);
      expect(card().ratings[runKey].note).toBe(NOTE);
    } finally { stop(); }
  });
});

describe('the 72-hour window (criterion 24)', () => {
  it('a tap after the window answers expired and stores nothing; a reply that arrived at hour 71 and is processed at 73 is stored', async () => {
    setRateSpawnForTests(() => {});
    const { askId, runKey } = asked();
    const f = fake();
    await onRateTap(f.hub, f.ab, tap(askId, '4'));
    await onRateTap(f.hub, f.ab, tap(askId, 'n'));
    f.clock.now = ENDED + 73 * H;
    replayRateNote(f.hub, f.ab, { updateId: 50, kind: 'rate-note', written: false, at: ENDED + 71 * H, msg: { message_id: 60, text: NOTE }, askId } as JournalEntry);
    await f.ab.chain;
    expect(card().ratings[runKey].note).toBe(NOTE);
    // A tap now: expired, keyboard removed, the rating as it was.
    await onRateTap(f.hub, f.ab, tap(askId, '1'));
    expect(f.answers.at(-1)?.[1]).toBe(RATE_LINES.expired);
    expect(f.edits.at(-1)).toEqual([77, null]);
    expect(card().ratings[runKey].stars).toBe(4);
  });

  it('an unrated run past the window: the tap stores nothing', async () => {
    const { askId, runKey } = asked();
    const f = fake();
    f.clock.now = ENDED + 72 * H;
    await onRateTap(f.hub, f.ab, tap(askId, '4'));
    expect(f.answers.at(-1)?.[1]).toBe(RATE_LINES.expired);
    expect(card().ratings[runKey]).toBeUndefined();
  });

  it('the sweep removes past-window keyboards: success and a permanent error close at once, a transient one after 3 tries', async () => {
    const { runKey } = asked();
    const f = fake();
    f.clock.now = ENDED + 71 * H;
    await sweepRateAsks(f.hub, f.ab);
    expect(f.edits).toEqual([]);
    f.clock.now = ENDED + 73 * H;
    for (let i = 0; i < SWEEP_MAX_TRIES - 1; i++) {
      f.editFails.push(new TelegramError('editMessageReplyMarkup', 0, 'network'));
      await sweepRateAsks(f.hub, f.ab);
      expect(card().telegramAsks[runKey].closedAt).toBeUndefined();
      expect(card().telegramAsks[runKey].sweepTries).toBe(i + 1);
    }
    f.editFails.push(new TelegramError('editMessageReplyMarkup', 0, 'network'));
    await sweepRateAsks(f.hub, f.ab);
    expect(card().telegramAsks[runKey].closedAt).toBeDefined();
    // Closed: never tried again.
    const before = f.edits.length;
    await sweepRateAsks(f.hub, f.ab);
    expect(f.edits.length).toBe(before);
  });

  it('a permanent error closes the request at once; a plain success too', async () => {
    const a = asked();
    const second = run('2026-11-20T10:00:00.000Z');
    const b = attachTelegramAsk(projectRoot, 'herodot', second, { botId: BOT, chatId: CHAT }, { home, now: NOW })!;
    setTelegramMessage(projectRoot, 'herodot', b.runKey, 88, home);
    const f = fake();
    f.clock.now = ENDED + 80 * H;
    f.editFails.push(new TelegramError('editMessageReplyMarkup', 400, 'message to edit not found'));
    await sweepRateAsks(f.hub, f.ab);
    expect(card().telegramAsks[a.runKey].closedAt).toBeDefined();
    expect(card().telegramAsks[b.runKey].closedAt).toBeDefined();
    expect(f.edits).toEqual([[88, null]]);
    // A rating given in the window stays after its keyboard is gone.
    expect(rateRun(projectRoot, 'herodot', { run: a.key, stars: 4, by: 'owner', home, now: NOW }).rating?.stars).toBe(4);
  });
});
