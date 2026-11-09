/**
 * The Super Agent answers in the owner's language, and a send that waits says so (owner
 * 2026-11-08, Tilki: "super agent cevap verdiğinde bu şekilde kalıyor").
 *
 * A. He wrote Turkish; the Super's answer, its next event turn and its handoff were English. The
 *    only language rule sat once in a briefing ~300k tokens back, under English notes and tool
 *    output. Now the server decides his language from his words, keeps it on the record, and
 *    names it on his message and at the end of every server-written turn.
 * B. `super send` answered `delivered: "queued"` while the child was stopped on his question card;
 *    the Super told him "I passed this to the plan job". The answer now says it is NOT read yet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-lang-home-`);
});

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { QUEUE_KINDS, emptySuperState, type QueueKind, type SuperQueueItem } from '../../src/lib/super/types.js';
import {
  SUPER_TURN_KINDS, _resetSuperInbox, _superInboxDrained, attachSuperInbox, startSuperInbox, superKnownLanguage, superOwnerLanguage, superTurnEnded,
  type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { detectOwnerLanguage, ownerLanguageBlock, ownerLanguageLine, withOwnerLanguage } from '../../src/lib/super/owner-language.js';
import { _resetOwnerQuestions, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';
import { SEND_QUEUED_WAITS, handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, deliverWindowResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const SUPER = 'sup-lang-1';
const C1 = 'child-0001-aaaa';
const W = { timeout: 10_000 };
let dir: string;
let root: string;
let token = '';
let sendHow = 'queued';
let banners: Array<{ title: string; body: string; link: string | null }>;
const handles = new Map<string, ChatHandle>();

const reg = (sid: string, mode = 'basic'): ChatHandle => {
  const h = registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode });
  handles.set(sid, h);
  return h;
};
const askQuestion = (h: ChatHandle, requestId: string, question = 'Postgres or sqlite?') => h.observe({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question, options: [{ label: 'postgres' }, { label: 'sqlite' }] }] } },
});

function fakeInbox(busy: { on: boolean }) {
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`, sessionId: SUPER, attached: () => true, idle: () => !busy.on,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
  };
  return { inbox, delivered };
}

function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'super-lang-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  _resetOwnerQuestions();
  handles.clear();
  sendHow = 'queued';
  banners = [];
  setOwnerQuestionSinks({
    presence: () => ({ vault: null, session: null }),
    banner: (title, body, link) => { banners.push({ title, body, link }); return true; },
    push: () => 0,
  });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { [C1]: { sessionId: C1, brief: 'Pick the database', adopted: true, startedAt: 1 } },
  }));
  // The window: a `super answer` it carries out answers the child through its own session.
  token = mintWindowToken({
    vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
    send: (frame) => {
      if (frame.subtype === 'window_command' && frame.verb === 'send') {
        // The child is stopped on a question card: the window keeps the message (`queued`).
        setImmediate(() => deliverWindowResult(token, frame.id, { ok: true, result: { delivered: sendHow } }));
        return true;
      }
      if (frame.subtype === 'super_command' && frame.verb === 'answer') {
        const a = frame.args as { child: string; requestId: string };
        setImmediate(() => { handles.get(a.child)?.answered(a.requestId); deliverSuperResult(token, frame.id, { ok: true, result: {} }); });
      }
      return true;
    },
  }).token;
  const sup = reg(SUPER, 'super');
  sup.userSent('');
  sup.observe({ type: 'result' });
  await startSuperInbox([root]);
});
afterEach(async () => {
  await _superInboxDrained();
  _resetSuperInbox();
  _resetOwnerQuestions();
  rmSync(dir, { recursive: true, force: true });
});



describe('the owner\'s language is detected from his own words', () => {
  it('Turkish letters, ASCII Turkish, English, and words that do not tell', () => {
    expect(detectOwnerLanguage('bu taraf daha çok notion formül arayüzü gibi olmalı ona göre düzenle')).toBe('Turkish');
    expect(detectOwnerLanguage('tamam devam et, bunu da yap')).toBe('Turkish');
    expect(detectOwnerLanguage('Please make the formula window look like the Notion one')).toBe('English');
    expect(detectOwnerLanguage('ok')).toBeNull();
    expect(detectOwnerLanguage('`src/lib/super/inbox.ts` https://example.com/a')).toBeNull();
  });
  it('the window\'s headers, quotes, pictures, code and paths are not his words', () => {
    const reply = '[Reply to message ref=abc123 from=super]\nquote: "I redrew the formula window and it is open on the plan page"\nbunu tekrar yap';
    expect(detectOwnerLanguage(reply)).toBe('Turkish');
    const english = '[Picture 1: /Users/x/çalışma/shot.png]\nwhat is this and why is it here';
    expect(detectOwnerLanguage(english)).toBe('English');
    expect(detectOwnerLanguage('```\nconst şey = 1\n```\nplease fix this and the tests')).toBe('English');
  });
  it('every word votes: one Turkish letter in an English sentence is no verdict (review 2026-11-08)', () => {
    expect(detectOwnerLanguage('Please ask Björn to check the façade layer and merge it')).toBe('English');
    // Plain lowercasing: an English "I" never becomes the Turkish dotless ı.
    expect(detectOwnerLanguage('I THINK IT IS DONE AND I WANT THE SUMMARY')).toBe('English');
    expect(detectOwnerLanguage('Tamam, Björn\'a sor ve bitir')).toBe('Turkish');
    // A Turkish suffix after an apostrophe is no English "i" (re-review 2026-11-08).
    expect(detectOwnerLanguage("test'i calistir, PR'i merge et")).not.toBe('English');
    expect(detectOwnerLanguage("test'i yap, PR'i merge et")).toBe('Turkish');
  });
  it('an agenda line\'s `line:` is the Super\'s words, never his', () => {
    const about = '[About agenda line note=n3 section=now]\nline: "Waiting for the plan job to finish the migration and the tests"\n\ntamam devam';
    expect(detectOwnerLanguage(about)).toBe('Turkish');
  });
  it('the block names the language; unknown, it points at his message', () => {
    expect(ownerLanguageBlock('Turkish')).toMatch(/^<owner-language> He writes Turkish\. Every word you write to him in this turn is Turkish/);
    expect(ownerLanguageBlock(null)).toMatch(/^<owner-language> Write to him in the language of his message above/);
    // Never absent (kitup 2026-11-09): unknown, it still says this turn's English is not his.
    expect(ownerLanguageLine(null)).toMatch(/^\[owner language\] Write him in the language of his own last message to you/);
    expect(ownerLanguageLine('Turkish')).toMatch(/^\[owner language\] The owner writes Turkish/);
    expect(withOwnerLanguage('[super events] x', null).split('\n').at(-1)).toBe(ownerLanguageLine(null));
  });
});

describe('the Super is told his language on every turn', { timeout: 30_000 }, () => {
  it('his message decides it, a message that does not tell keeps it, and the record holds it', async () => {
    expect(superOwnerLanguage(SUPER, 'bu taraf daha çok notion formül arayüzü gibi olmalı')).toBe('Turkish');
    expect(superOwnerLanguage(SUPER, 'ok')).toBe('Turkish');
    await _superInboxDrained();
    expect((await readSuperState(root)).ownerLanguage).toBe('Turkish');
    // A restart reads it back from the record (a fresh session inherits it the same way).
    _resetSuperInbox();
    resetSuperIndex();
    await startSuperInbox([root]);
    expect(superOwnerLanguage(SUPER, 'ok')).toBe('Turkish');
    // He switches: the next turns follow him.
    expect(superOwnerLanguage(SUPER, 'please write the summary for the team and send it')).toBe('English');
    await _superInboxDrained();
    expect((await readSuperState(root)).ownerLanguage).toBe('English');
  });

  it('a server-written text never decides it; an agenda reply goes by his words (review 2026-11-08)', async () => {
    expect(superOwnerLanguage(SUPER, 'bu taraf daha çok notion formül arayüzü gibi olmalı')).toBe('Turkish');
    // The continue-at-reset turn is read-only: the server's English never overwrites his Turkish.
    expect(superKnownLanguage(SUPER)).toBe('Turkish');
    expect(superOwnerLanguage(SUPER, '[super events] batch=b-1 items=1\nplease tell the owner what the job did and what is next')).toBe('Turkish');
    expect(superOwnerLanguage(SUPER, '[About agenda line note=n3 section=now]\nline: "Waiting for the plan job to finish the migration and the tests"\n\ntamam devam')).toBe('Turkish');
    await _superInboxDrained();
    expect((await readSuperState(root)).ownerLanguage).toBe('Turkish');
  });

  it('a run report or an interrupt note on his path never decides it (kitup 2026-11-09)', async () => {
    expect(superOwnerLanguage(SUPER, 'bu taraf daha çok notion formül arayüzü gibi olmalı')).toBe('Turkish');
    expect(superOwnerLanguage(SUPER, '[ran in chat] the owner ran this and it exited 0, please read the output and tell him what it did')).toBe('Turkish');
    expect(superOwnerLanguage(SUPER, 'Your previous turn was stopped by the owner, so please check what is done and what is not')).toBe('Turkish');
    await _superInboxDrained();
    expect((await readSuperState(root)).ownerLanguage).toBe('Turkish');
  });

  it('an event turn ends by naming it; before he ever wrote, it still says the note is not his', async () => {
    const busy = { on: false };
    const { inbox, delivered } = fakeInbox(busy);
    attachSuperInbox(inbox);
    askQuestion(reg(C1), 'req-1');
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    expect(delivered[0].text.split('\n').at(-1)).toBe(ownerLanguageLine(null));
    busy.on = true;
    superOwnerLanguage(SUPER, 'bu taraf daha çok notion formül arayüzü gibi olmalı');
    await _superInboxDrained();
    handles.get(C1)!.answered('req-1');
    askQuestion(handles.get(C1)!, 'req-2');
    busy.on = false;
    superTurnEnded(SUPER);
    await vi.waitFor(() => expect(delivered.length).toBeGreaterThanOrEqual(2), W);
    const last = delivered[delivered.length - 1].text;
    expect(last.split('\n').at(-1)).toMatch(/^\[owner language\] The owner writes Turkish: any text you write him in this turn is Turkish/);
  });
});

describe('every kind of server-written turn ends with his language (kitup 2026-11-09)', { timeout: 60_000 }, () => {
  // Kinds that never become a turn of their own: an `ask` is the Super's own question, an `ended`
  // item is born done, an `approval` waits on the owner's card. A NEW kind fails here until it is
  // put on one side: a turn kind goes through the pump, which ends every turn with the line.
  const NEVER_A_TURN: readonly QueueKind[] = ['ask', 'ended', 'approval'];
  it('the ledger: every queue kind is a pump turn or named as never one', () => {
    for (const k of QUEUE_KINDS) expect(SUPER_TURN_KINDS.includes(k) !== NEVER_A_TURN.includes(k), k).toBe(true);
  });

  // The kinds whose item stands on its own record; the rest (a live question or permission, an
  // owed debt, a member's request or reply, an owner wait) need live state the tests above drive.
  const item = (kind: QueueKind): SuperQueueItem => ({
    id: `q-${kind}`, kind, state: 'pending', createdAt: Date.now(),
    sessionId: kind === 'recap' || kind === 'handover' || kind === 'fresh' || kind === 'automation' ? SUPER : C1,
    ...(kind === 'automation' ? { automation: 'daily-digest', decision: 'approved' as const } : {}),
  });
  const ROW: Partial<Record<QueueKind, string>> = { done: 'done', stuck: 'stuck', gone: 'gone', restarted: 'working' };
  for (const kind of ['done', 'stuck', 'gone', 'restarted', 'recap', 'handover', 'fresh', 'automation'] as QueueKind[]) {
    it(`${kind}: the turn's last line names Turkish`, async () => {
      await _superInboxDrained();
      _resetSuperInbox();
      resetSuperIndex();
      writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
        ...emptySuperState(), session: SUPER, enabled: true, ownerLanguage: 'Turkish',
        children: { [C1]: { sessionId: C1, brief: 'Pick the database', adopted: true, startedAt: 1, ...(ROW[kind] ? { row: ROW[kind] } : {}) } },
        queue: [item(kind)],
      }));
      await startSuperInbox([root]);
      const { inbox, delivered } = fakeInbox({ on: false });
      attachSuperInbox(inbox);
      superTurnEnded(SUPER);
      await vi.waitFor(() => expect(delivered.length).toBeGreaterThanOrEqual(1), W);
      for (const d of delivered) expect(d.text.split('\n').at(-1)).toBe(ownerLanguageLine('Turkish'));
    });
  }
});

describe('a send that waits behind a question says so', { timeout: 30_000 }, () => {
  async function send(text: string) {
    const r = res();
    await handleSuperVerb(req({ child: C1, text }), r, { verb: 'send' });
    return r;
  }
  it('queued: the answer says it is NOT read yet, last, and the message is kept on disk', async () => {
    reg(C1);
    const r = await send('W2 ekranında formül penceresi Notion gibi olsun');
    expect({ status: r.status, json: r.json }).toMatchObject({ status: 200 });
    const out = r.json.result as Record<string, unknown>;
    expect(out).toMatchObject({ child: C1, delivered: 'queued', waits: SEND_QUEUED_WAITS });
    expect(Object.keys(out).at(-1)).toBe('waits');
    expect(SEND_QUEUED_WAITS).toMatch(/^NOT read yet/);
    expect(SEND_QUEUED_WAITS).toMatch(/Never tell the owner the job has it/);
    expect(SEND_QUEUED_WAITS).toMatch(/super allow/);
    const box = join(process.env.HOME!, '.dreamcontext', 'super-outbox');
    expect(readdirSync(box).map((f) => readFileSync(join(box, f), 'utf8')).join('')).toContain('Notion gibi');
  });
  it('steered or sent: no such line', async () => {
    reg(C1);
    sendHow = 'steered';
    const r = await send('go on');
    expect(r.status).toBe(200);
    const out = r.json.result as Record<string, unknown>;
    expect(out).toMatchObject({ child: C1, delivered: 'steered' });
    expect(out.waits).toBeUndefined();
  });
});
