/**
 * A member the owner talks to himself: its question is his alone (owner 2026-11-15, "Ben Conor ile
 * konuşuyorum neden sana geliyor bildirimler?"). Real registry, inbox and verbs; stand-in sinks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/member-owner-talk-home-`);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, memberItemForOwnerOnly, movedPastAsks, setMemberGateForTest, startSuperInbox, setMemberTitleSource, superAskStillOpen, superOwnerSpoke, wireSuperInbox, writeSuper,
} from '../../src/lib/super/inbox.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { handleSuperVerb, setTeamAskRouteForTest } from '../../src/server/routes/super.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { _resetDelegating } from '../../src/lib/super/delegating.js';
import { _resetOwnerQuestions, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';
import { ownerTalkBinding } from '../../src/server/telegram/asks.js';
import type { ActiveBinding } from '../../src/server/telegram/hub.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-first-1';

function req(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(body === undefined ? '' : JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
const tokenFor = (sessionId: string, superId?: 'main' | `m:${string}`) =>
  mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId, mode: 'super', ...(superId ? { superId } : {}) }).token;
async function verb(token: string, name: string, body: Record<string, unknown> = {}) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}
const main = () => readSuperState(root);
const rota = () => readSuperState(root, 'm:rota');
const mirrors = async () => (await main()).queue.filter((q) => q.kind === 'member');

let banners: string[];
let telegram: string[];

async function rotaSession(): Promise<string> {
  const r = await verb(tokenFor(MAIN), 'team-ask', { member: 'rota', text: 'Plan the routes.', brief: 'routes' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (await rota()).session as string;
}
async function rotaAsks(session: string): Promise<{ item: string; reply: Record<string, unknown> }> {
  const r = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'May I send the DM to Ada?', options: ['Send it', 'Do not send'], for: 'owner' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  await _superInboxDrained();
  return { item: (r.json.result as { item: string }).item, reply: r.json.result as Record<string, unknown> };
}
function sinks(): void {
  setOwnerQuestionSinks({
    presence: () => ({ vault: null, session: null }),
    banner: (title, body) => { banners.push(`${title} | ${body}`); return true; },
    telegram: ({ item }) => { telegram.push(item.id); return true; },
  });
}

beforeEach(() => {
  setTeamAskRouteForTest('request');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'member-owner-talk-')));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
  resetWindowControl();
  resetSuperIndex();
  _resetSuperInbox();
  _resetChatRegistry();
  _resetDelegating();
  _resetOwnerQuestions();
  setMemberGateForTest(null);
  setMemberTitleSource((_root, slug) => (slug === 'rota' ? 'Rota Planner' : slug));
  banners = [];
  telegram = [];
  sinks();
  wireSuperInbox();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true }));
  createAgent(root, { slug: 'rota', title: 'Rota Planner', prompt: 'You keep the routes.' }, { approve: { now: new Date() } });
});
afterEach(async () => {
  vi.useRealTimers();
  await _superInboxDrained();
  setTeamAskRouteForTest(null);
  setMemberGateForTest(null);
  setMemberTitleSource(null);
  rmSync(dir, { recursive: true, force: true });
});
describe('his own conversation with a member: its question is his alone (owner 2026-11-15)', () => {
  it('asked in his turn: on his list at once, no Super event, no Super-first hold, rings now', async () => {
    registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    const session = await rotaSession();
    // He writes to the member himself: this turn is his.
    superOwnerSpoke(session);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const r = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which reference should the update video follow?', options: ['I send one', 'You start'] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await _superInboxDrained();
    const item = (r.json.result as { item: string }).item;
    expect((await rota()).queue.find((q) => q.id === item)?.ownerTalk).toBe(true);
    const m = (await mirrors()).find((x) => x.answers === item) as SuperQueueItem;
    // On his Waiting on you list, never pending for the Super Agent's event turn.
    expect(m.state).toBe('escalated');
    expect(m.ownerTalk).toBe(true);
    expect(r.json.result).toMatchObject({ mirrored: true, reached: true });
    expect((r.json.result as { superFirst?: boolean }).superFirst).toBeUndefined();
    expect(String((r.json.result as { note: string }).note)).toContain('not told');
    // Rings now, under the member's name: nothing waits for the Super Agent.
    expect(banners.some((b) => b.startsWith('Rota Planner'))).toBe(true);
    expect(telegram).toContain(m.id);
    // Nothing for the Super Agent to hear: no pending item in main's queue mentions it.
    expect((await main()).queue.filter((q) => q.kind === 'member' && q.state === 'pending')).toEqual([]);
  });

  it('work the Super Agent gave (its request turn, `--for owner`): through the Super Agent as before', async () => {
    registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    const session = await rotaSession();
    const { item, reply } = await rotaAsks(session);
    expect((await rota()).queue.find((q) => q.id === item)?.ownerTalk).toBeUndefined();
    const m = (await mirrors()).find((x) => x.answers === item) as SuperQueueItem;
    expect(m.ownerTalk).toBeUndefined();
    expect(reply).toMatchObject({ mirrored: true, superFirst: true });
  });

  it('the one decision: a child of work he started is his; a child of the Super\'s work, or the member\'s own item, is not', () => {
    const children = {
      'kid-owner': { workOrigin: 'owner' },
      'kid-main': { workOrigin: 'main:q-req-1' },
    } as unknown as SuperState['children'];
    const item = (over: Partial<SuperQueueItem>): SuperQueueItem => ({ id: 'q-x-1', sessionId: 'kid-owner', kind: 'question', state: 'escalated', createdAt: 1, ...over });
    expect(memberItemForOwnerOnly({ children }, item({}))).toBe(true);
    expect(memberItemForOwnerOnly({ children }, item({ sessionId: 'kid-main' }))).toBe(false);
    expect(memberItemForOwnerOnly({ children }, item({ sessionId: 'rota-own', kind: 'permission' }))).toBe(false);
    expect(memberItemForOwnerOnly({ children }, item({ sessionId: 'rota-own', kind: 'ask' }))).toBe(false);
    expect(memberItemForOwnerOnly({ children }, item({ sessionId: 'rota-own', kind: 'ask', ownerTalk: true }))).toBe(true);
  });

  it('Telegram: his own-conversation item goes on the member\'s own bot when it is bound to the project', () => {
    const memberBot = { target: 'rota', contextRoot: '/x/_dream_context', disabled: undefined } as unknown as ActiveBinding;
    const hub = { bindingOfSuper: (_v: string, id: string) => (id === 'm:rota' ? memberBot : null) };
    const mirror: SuperQueueItem = { id: 'q-m-1', sessionId: 's', kind: 'member', state: 'escalated', createdAt: 1, member: 'rota', of: 'ask', ownerTalk: true };
    expect(ownerTalkBinding(hub, 'acme', mirror)).toBe(memberBot);
    // The Super's work: the Super bot, as before.
    expect(ownerTalkBinding(hub, 'acme', { ...mirror, ownerTalk: undefined })).toBeNull();
    // No member bot bound (or a global one with no project root): the Super bot.
    expect(ownerTalkBinding({ bindingOfSuper: () => null }, 'acme', mirror)).toBeNull();
    expect(ownerTalkBinding({ bindingOfSuper: () => ({ ...memberBot, contextRoot: null }) as ActiveBinding }, 'acme', mirror)).toBeNull();
  });

  it('his next message in the member\'s own chat answers its open question: one record closes, every "Needs you" with it', async () => {
    registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    const session = await rotaSession();
    superOwnerSpoke(session);
    const r = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which reference should the update video follow?', options: ['I send one', 'You start'] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await _superInboxDrained();
    const item = (r.json.result as { item: string }).item;
    // Not "this message did not answer your card": in the member's chat it is the answer.
    expect(superAskStillOpen(session)).toContain('<super-ask-closed');
    // He writes "I did it" in the member's chat, about no card.
    superOwnerSpoke(session);
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === item)?.state).toBe('done');
    expect((await mirrors()).filter((m) => m.answers === item && m.state !== 'done')).toEqual([]);
  });

  it('a message he wrote ABOUT something else leaves the member\'s card open, so it never comes back as a new card (open note 2026-11-19)', async () => {
    registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    const session = await rotaSession();
    superOwnerSpoke(session);
    const r = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which reference should the update video follow?', options: ['I send one', 'You start'] });
    await _superInboxDrained();
    const item = (r.json.result as { item: string }).item;
    // Written about a task (an [About …] header), not about the card.
    const elsewhere = [{ kind: 'task' as const, id: 'video-edit' }];
    expect(superAskStillOpen(session, elsewhere)).toContain('<super-ask-still-open');
    expect(superAskStillOpen(session, elsewhere)).toContain('never ask that card again');
    superOwnerSpoke(session, Date.now(), [], elsewhere);
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === item)?.state).toBe('escalated');
    // A reply to the card's message is how he answers it in his own chat: it closes.
    const reply = [{ kind: 'reply' as const, id: 'abc123' }];
    expect(superAskStillOpen(session, reply)).toContain('<super-ask-closed');
    superOwnerSpoke(session, Date.now(), [], reply);
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === item)?.state).toBe('done');
  });

  it('a turn he did not write (a server continue, a run report) closes nothing in the member\'s chat', async () => {
    registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    const session = await rotaSession();
    superOwnerSpoke(session);
    const r = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which reference should the update video follow?', options: ['I send one', 'You start'] });
    await _superInboxDrained();
    const item = (r.json.result as { item: string }).item;
    // The old rule's note, never "this message closed your card".
    expect(superAskStillOpen(session, [], false)).toContain('<super-ask-still-open');
    superOwnerSpoke(session, Date.now(), [], [], false, false);
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === item)?.state).toBe('escalated');
  });

  it('a question an older version left open after he wrote to the member closes once, at the record\'s first write', async () => {
    const session = await rotaSession();
    const askedAt = Date.now() - 60_000;
    const file = join(root, 'state', '.super', 'members', 'rota.json');
    // The stuck record as an older version left it: an open question, then a message of his.
    const stuck = JSON.parse(JSON.stringify((await rota())));
    delete stuck.movedPastDone;
    stuck.queue.push({ id: 'q-old-ask-1', sessionId: session, kind: 'ask', state: 'escalated', createdAt: askedAt, ownerText: 'What do I do for the update video?' });
    stuck.owed = [{ id: 'o9', kind: 'msg', ref: 'abc123', seq: 9, at: askedAt + 30_000, gist: 'I did it', nudges: 0 }];
    stuck.owedSeq = 9;
    writeFileSync(file, JSON.stringify(stuck));
    resetSuperIndex();
    await startSuperInbox([root]);
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === 'q-old-ask-1')?.state).toBe('done');
    expect((await mirrors()).filter((m) => m.answers === 'q-old-ask-1' && m.state !== 'done')).toEqual([]);
    // Never again: a later question with a later debt (a Telegram run report) stays open.
    await writeSuper(root, 'm:rota', (s) => {
      s.queue.push({ id: 'q-new-ask-2', sessionId: session, kind: 'ask', state: 'escalated', createdAt: Date.now() - 10_000, ownerText: 'Next?' });
      s.owed = [...(s.owed ?? []), { id: 'o10', kind: 'msg', ref: 'run999', seq: 10, at: Date.now(), gist: 'run report', nudges: 0 }];
      s.owedSeq = 10;
    });
    await startSuperInbox([root]);
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === 'q-new-ask-2')?.state).toBe('escalated');
  });

  it('only a message AFTER the question counts, and only in a member\'s record', () => {
    const ask: SuperQueueItem = { id: 'q-a-1', sessionId: 's', kind: 'ask', state: 'escalated', createdAt: 1000 };
    const msg = (at: number) => ({ id: 'o1', kind: 'msg' as const, ref: 'r1', seq: 1, at, gist: 'g', nudges: 0 });
    expect(movedPastAsks({ queue: [ask], owed: [msg(900)] })).toEqual([]);
    expect(movedPastAsks({ queue: [ask], owed: [msg(1100)] }).map((q) => q.id)).toEqual(['q-a-1']);
    // A question to the Super Agent about its own request is not his.
    expect(movedPastAsks({ queue: [{ ...ask, workOrigin: 'main:q-r-1' }], owed: [msg(1100)] })).toEqual([]);
  });

  it('the Super Agent\'s own card keeps its rule: a message about nothing leaves it open', async () => {
    const askedAt = Date.now() - 60_000;
    await writeSuper(root, (s) => {
      s.queue.push({ id: 'q-main-ask-1', sessionId: MAIN, kind: 'ask', state: 'escalated', createdAt: askedAt, ownerText: 'Ship it?' });
      s.owed = [{ id: 'o3', kind: 'msg', ref: 'def456', seq: 3, at: askedAt + 30_000, gist: 'something else', nudges: 0 }];
      s.owedSeq = 3;
    });
    await writeSuper(root, (s) => { s.pool = [...s.pool]; });
    expect((await main()).queue.find((q) => q.id === 'q-main-ask-1')?.state).toBe('escalated');
  });
});
