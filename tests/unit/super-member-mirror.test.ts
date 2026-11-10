/**
 * An AI Team member waiting on the OWNER reaches him and the Super Agent (owner 2026-11-10: otobot
 * asked for his approval with `super ask`, and the card sat only on otobot's own stage: not on his
 * bar, not in the Super chat, not on Telegram, and the Super Agent never heard of it).
 *
 * Whatever the owner must answer in a member's OWN record (its `super ask`, a job's question or
 * permission, a card only he can act on) is mirrored into MAIN's queue as a `member` item, on every
 * write of the member's record (`syncMemberMirrors`): his bar and Telegram read main's queue, and
 * the Super Agent hears it as one event. The mirror closes when the member's item closes, whoever
 * answered it; the Super may answer a member's own question as its own words, never a permission.
 *
 * Scratch HOME and vault only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-member-mirror-home-`);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import {
  MEMBER_LINE, REPLY_OWNER_ASK_LINE, _resetSuperInbox, _superInboxDrained, attachSuperInbox, nextBatch, type SuperInbox, ownerItems, setMemberGateForTest, superBatchText, superEventText, superQueueHead, wireSuperInbox, writeSuper,
} from '../../src/lib/super/inbox.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { handleSuperVerb, setTeamAskRouteForTest } from '../../src/server/routes/super.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { _resetDelegating } from '../../src/lib/super/delegating.js';
import { _resetOwnerQuestions, announces, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';
import { memberMirrorTarget } from '../../src/lib/super/answer.js';
import { enableSuper } from '../../src/lib/super/handover.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-1';

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

/** Main gives Rota a job (its record is born with a Super session); its session id. */
async function rotaWorking(): Promise<{ request: string; session: string }> {
  const r = await verb(tokenFor(MAIN), 'team-ask', { member: 'rota', text: 'DM Ada the report.', brief: 'DM' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { request: (r.json.result as { request: string }).request, session: (await rota()).session as string };
}

/** The field case: the member asks the OWNER for his own approval (`super ask --for owner`). */
async function rotaAsksOwner(session: string, text = 'May I send the DM to Ada?') {
  const r = await verb(tokenFor(session, 'm:rota'), 'ask', { text, options: ['Send it', 'Do not send'], for: 'owner' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  await _superInboxDrained();
  return (r.json.result as { item: string }).item;
}

beforeEach(() => {
  setTeamAskRouteForTest('request');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-member-mirror-')));
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
  wireSuperInbox();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true }));
  createAgent(root, { slug: 'rota', title: 'Rota Planner', prompt: 'You keep the routes.' }, { approve: { now: new Date() } });
});
afterEach(async () => {
  await _superInboxDrained();
  setTeamAskRouteForTest(null);
  setMemberGateForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('a member\'s question to the owner reaches main\'s queue', () => {
  it('its own `super ask` is mirrored: member, the item it stands for, its kind, its words and card', async () => {
    const { session } = await rotaWorking();
    const ask = await rotaAsksOwner(session);
    const own = (await rota()).queue.find((q) => q.id === ask);
    expect(own).toMatchObject({ kind: 'ask', state: 'escalated' });
    const m = await mirrors();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'member', member: 'rota', answers: ask, of: 'ask', state: 'pending', sessionId: session });
    expect(m[0].ownerText).toContain('May I send the DM');
    expect(m[0].ask?.questions[0].options.map((o) => o.label)).toEqual(['Send it', 'Do not send']);
  });

  it('a job\'s permission is mirrored with no words of anyone (D7); a main-audience ask is NOT (it is main\'s)', async () => {
    const { request, session } = await rotaWorking();
    await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which depot first?', for: request });
    await writeSuper(root, 'm:rota', (s) => {
      s.queue.push({ id: 'q-perm-1', sessionId: 'sess-rota-child', kind: 'permission', state: 'pending', createdAt: Date.now(), requestId: 'req-1' });
    });
    await _superInboxDrained();
    const m = await mirrors();
    expect(m.map((x) => x.of)).toEqual(['permission']);
    expect(m[0]).toMatchObject({ answers: 'q-perm-1', requestId: 'req-1', sessionId: 'sess-rota-child' });
    expect(m[0].ownerText).toBeUndefined();
  });

  it('lives exactly as long as the member\'s item: anything else closing it first is undone (end review r1)', async () => {
    const { session } = await rotaWorking();
    const ask = await rotaAsksOwner(session);
    const [m] = await mirrors();
    // Something other than the member's item closed it (a hand-over's sweep, an old `queue done`)
    // while the member still waits: the next write of the member's record puts it back on his
    // list, once, with no second event (escalated), never stranded on the member's page.
    await writeSuper(root, (s) => { const q = s.queue.find((x) => x.id === m.id); if (q) q.state = 'done'; });
    await writeSuper(root, 'm:rota', (s) => { s.pool = [...s.pool]; });
    await _superInboxDrained();
    expect((await mirrors()).map((x) => [x.id, x.state])).toEqual([[m.id, 'escalated']]);
    // A fresh question: a new mirror; answered on the member's own stage: closed in main too.
    await writeSuper(root, 'm:rota', (s) => { const q = s.queue.find((x) => x.id === ask); if (q) q.state = 'done'; });
    const ask2 = await rotaAsksOwner(session, 'Second question?');
    const open = (await mirrors()).filter((x) => x.state !== 'done');
    expect(open.map((x) => x.answers)).toEqual([ask2]);
    await writeSuper(root, 'm:rota', (s) => { const q = s.queue.find((x) => x.id === ask2); if (q) q.state = 'done'; });
    await _superInboxDrained();
    expect((await mirrors()).every((x) => x.state === 'done')).toBe(true);
  });

  it('nothing is mirrored while the project\'s Super Agent is not handed over', async () => {
    const { session } = await rotaWorking();
    await writeSuper(root, (s) => { s.enabled = false; });
    await rotaAsksOwner(session);
    expect(await mirrors()).toEqual([]);
  });
});

describe('the Super Agent hears it, and may answer only the member\'s own question', () => {
  it('a mirror born while the Super Agent is idle reaches it through its own queue, unprompted (end review r1)', async () => {
    const { session } = await rotaWorking();
    const h = registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    h.userSent(''); h.observe({ type: 'result' });
    const delivered: string[] = [];
    const inbox: SuperInbox = {
      id: 'inbox-main', sessionId: MAIN, attached: () => true, idle: () => true,
      deliver: async (text) => { delivered.push(text); return true; },
    };
    attachSuperInbox(inbox);
    await _superInboxDrained();
    delivered.length = 0;
    await rotaAsksOwner(session);
    await vi.waitFor(() => expect(delivered.some((t) => t.includes('event=member'))).toBe(true), { timeout: 10_000 });
  });

  it('a hand-over keeps a member\'s waiting item; one asked while nobody was handed over reaches him at the next', async () => {
    const { session } = await rotaWorking();
    const first = await rotaAsksOwner(session);
    // A hand-over sweeps items about chats it does not keep: never a member's mirror.
    await enableSuper(root, { adopt: [], titles: {} });
    expect((await mirrors()).map((m) => [m.answers, m.state === 'done'])).toEqual([[first, false]]);
    // Asked while nobody is handed over: no mirror then; the next hand-over brings it.
    await writeSuper(root, 'm:rota', (s) => { const q = s.queue.find((x) => x.id === first); if (q) q.state = 'done'; });
    await _superInboxDrained();
    await writeSuper(root, (s) => { s.enabled = false; });
    const ask = await rotaAsksOwner(session, 'Asked while away?');
    expect((await mirrors()).filter((m) => m.state !== 'done')).toEqual([]);
    await enableSuper(root, { adopt: [], titles: {} });
    expect((await mirrors()).filter((m) => m.state !== 'done').map((m) => m.answers)).toEqual([ask]);
  });

  it('one event line naming the member, its question and options, with the member rule', async () => {
    const { session } = await rotaWorking();
    await rotaAsksOwner(session);
    const state = await main();
    const { items } = nextBatch(state, root);
    expect(items.map((q) => q.kind)).toContain('member');
    const text = superBatchText(root, state, items, 'b-test');
    expect(text).toContain('event=member member=rota waits=ask');
    expect(text).toContain('Question: May I send the DM to Ada?');
    expect(text).toContain('Options: Send it | Do not send');
    expect(text).toContain(MEMBER_LINE);
  });

  it('`team answer` on it: a reply in the member\'s queue (the Super\'s words), the mirror closes', async () => {
    const { session } = await rotaWorking();
    const ask = await rotaAsksOwner(session);
    const [m] = await mirrors();
    const r = await verb(tokenFor(MAIN), 'team-answer', { item: m.id, text: 'He said yes this morning.' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const reply = (await rota()).queue.find((q) => q.kind === 'reply');
    expect(reply).toMatchObject({ answers: ask, text: 'He said yes this morning.', state: 'pending' });
    expect(reply?.workOrigin).toBe('owner');
    expect(superEventText(root, await rota(), reply as SuperQueueItem)).toContain(REPLY_OWNER_ASK_LINE);
    expect((await mirrors())[0].state).toBe('done');
    // The Super's answer is the one close that stands while the member's ask is still open.
    await writeSuper(root, 'm:rota', (s) => { s.pool = [...s.pool]; });
    await _superInboxDrained();
    expect((await mirrors()).map((x) => x.state)).toEqual(['done']);
  });

  it('`queue done` on a mirror is refused with what is the Super\'s and what is his; nothing closes', async () => {
    const { session } = await rotaWorking();
    await rotaAsksOwner(session);
    await writeSuper(root, 'm:rota', (s) => {
      s.queue.push({ id: 'q-perm-3', sessionId: 'sess-rota-child', kind: 'permission', state: 'pending', createdAt: Date.now(), requestId: 'req-3' });
    });
    await _superInboxDrained();
    for (const m of await mirrors()) {
      const r = await verb(tokenFor(MAIN), 'queue-done', { item: m.id });
      expect(r.status, m.of).toBe(403);
      expect(r.json.error).toBe('member_item');
      expect(String(r.json.message)).toContain(m.of === 'ask' ? 'super team answer' : 'his bar');
    }
    expect((await mirrors()).every((x) => x.state !== 'done')).toBe(true);
  });

  it('`team answer` on a permission is refused with where it waits (owner_only), nothing changes', async () => {
    await rotaWorking();
    await writeSuper(root, 'm:rota', (s) => {
      s.queue.push({ id: 'q-perm-2', sessionId: 'sess-rota-child', kind: 'permission', state: 'pending', createdAt: Date.now(), requestId: 'req-2' });
    });
    await _superInboxDrained();
    const [m] = await mirrors();
    const r = await verb(tokenFor(MAIN), 'team-answer', { item: m.id, text: 'allow' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('owner_only');
    expect(String(r.json.message)).toContain('his bar');
    expect((await mirrors())[0].state).toBe('pending');
  });
});

describe('his surfaces', () => {
  it('Telegram is offered the mirror (main\'s queue), and the answer path resolves the member\'s own item', async () => {
    const offered: SuperQueueItem[] = [];
    setOwnerQuestionSinks({ telegram: ({ item }) => { offered.push(item); return 'at_mac'; } });
    const { session } = await rotaWorking();
    const ask = await rotaAsksOwner(session);
    const [m] = await mirrors();
    expect(announces(m)).toBe(true);
    expect(announces({ ...m, state: 'done' })).toBe(false);
    expect(offered.some((q) => q.id === m.id && q.kind === 'member')).toBe(true);
    const t = await memberMirrorTarget(root, m.id);
    expect(t).toMatchObject({ superId: 'm:rota', session, item: { id: ask, kind: 'ask' } });
  });

  it('main\'s own head (banner, notch) never leads with a mirror: the member record announced it', async () => {
    const { session } = await rotaWorking();
    await rotaAsksOwner(session);
    const state = await main();
    expect(state.queue.some((q) => q.kind === 'member')).toBe(true);
    expect(superQueueHead(state)).toBeNull();
    expect(ownerItems(state)).toEqual([]);
    // The member's own record leads with its question: what the mirror stands for.
    expect(superQueueHead(await rota())?.kind).toBe('ask');
  });

  it('the record keeps a mirror only whole (member, item, kind)', () => {
    const base = { id: 'q-m-1', sessionId: 'sess-x', kind: 'member', state: 'escalated', createdAt: 1, member: 'rota', answers: 'q-a-1', of: 'ask' };
    const read = (q: Record<string, unknown>) => sanitizeSuperState({ ...emptySuperState(), session: MAIN, enabled: true, queue: [q] }).queue;
    expect(read(base)).toEqual([base]);
    expect(read({ ...base, of: 'nope' })).toEqual([]);
    expect(read({ ...base, answers: undefined })).toEqual([]);
    expect(read({ ...base, member: '../x' })).toEqual([]);
  });
});
