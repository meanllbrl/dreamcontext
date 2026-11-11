/**
 * One answer function for every surface (uye-bildirim K5, G4; plan criteria 6 and 7).
 *
 *  - `answerOwnerItem` per kind: a refused call allowed once (grant from the STORED item, one
 *    server turn into the live session, its input fenced as data), allowed while its chat is not
 *    running (the outbox, the item's own line), not needed; a member's own `super ask` answered
 *    from the desktop (his reply, marked his, in the member's queue: a cold member gets it when it
 *    attaches); a member Super's own permission answered through its own window (none: `no_window`);
 *  - a `member` mirror reaches the member's item, and closes with it;
 *  - first answer wins, the second is told so;
 *  - the phone answers questions and permissions only and never writes a grant;
 *  - the desktop route answers only behind the shell's owner key (`fromOwnerPage`).
 *
 * Scratch HOME (the grant store is machine-local) and vault; real registry, inbox and verbs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-answer-home-`);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat, registerCrewHandle, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, superKey } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, ownerItems, setGrantEnvForTest, setMemberGateForTest, settleAllowedOnce, wireSuperInbox, writeSuper,
} from '../../src/lib/super/inbox.js';
import { ALLOWED_WAITING_TEXT, ALLOW_ONCE_SENTENCE, _resetOwnerAnswers, allowTurnText, answerOwnerItem, shownKeyOf } from '../../src/lib/super/answer.js';
import { readOutbox } from '../../src/lib/super/outbox.js';
import { teamJobStatus, teamLiveRows } from '../../src/lib/super/team.js';
import { consumeOnce, listGrants } from '../../src/lib/grants/store.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { handleSuperOwnerAnswer, handleSuperVerb, setTeamAskRouteForTest } from '../../src/server/routes/super.js';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { _resetDelegating } from '../../src/lib/super/delegating.js';
import { _resetOwnerQuestions } from '../../src/lib/super/owner-question.js';
import type { Resolver } from '../../src/lib/grants/eligible.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-answer-1';
const KEY = 'c4'.repeat(32);

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
  (out as unknown as { setHeader: () => void }).setHeader = () => {};
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

/** What a surface drew for this item (its stored call: a refusal's fact, a permission's call, or
 *  their copy on a mirror), sent with an answer as every surface does (G2: consent matches display). */
async function shownFor(record: string, item: string): Promise<{ tool: string; input: string } | undefined> {
  const s = await readSuperState(root, record === 'main' ? undefined : `m:${record}`);
  const q = s.queue.find((x) => x.id === item);
  const r = q?.wait?.refusal;
  if (r) return { tool: r.tool, input: r.input };
  return q?.call ? { tool: q.call.tool, input: q.call.input } : undefined;
}
async function answerShown(at: string, req: Parameters<typeof answerOwnerItem>[1]): ReturnType<typeof answerOwnerItem> {
  const shown = await shownFor(req.record, req.item);
  return answerOwnerItem(at, { ...req, ...(shown ? { shown } : {}) });
}

const rota = () => readSuperState(root, 'm:rota');

const RESOLVER: Resolver = {
  which: (n) => (n === 'node' ? '/opt/fakebin/node' : null),
  realpath: (p) => p,
  isRegularFile: () => true,
  sha256: () => 'b'.repeat(64),
};

function crew(sessionId: string, mode = 'auto'): ChatHandle {
  const h = registerChat({ sessionId, conversationId: null, vault: 'acme', mode: 'super', crew: true, permissionMode: mode });
  h.userSent('go');
  return h;
}
function refuse(h: ChatHandle, command: string, id = 'toolu_r1'): void {
  h.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  h.observe({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'blocked' }] },
    tool_result_meta: [{ id, non_execution_kind: 'automode-blocked', permission_decision: { decision: 'reject', source: 'classifier', reason_type: 'classifier' } }],
  });
  h.observe({ type: 'result', subtype: 'success', is_error: false });
}

async function rotaSession(): Promise<string> {
  const r = await verb(tokenFor(MAIN), 'team-ask', { member: 'rota', text: 'Build the funnel report.', brief: 'report' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (await rota()).session as string;
}
/** Rota's own refused call: its own item, and the mirror in main. */
async function rotaRefused(command = 'node scripts/report.mjs'): Promise<{ session: string; item: SuperQueueItem; mirror: SuperQueueItem }> {
  const session = await rotaSession();
  refuse(crew(session), command);
  await _superInboxDrained();
  const item = (await rota()).queue.find((q) => q.own && q.kind === 'owner' && q.wait?.kind === 'refusal') as SuperQueueItem;
  const mirror = (await main()).queue.find((q) => q.kind === 'member' && q.answers === item?.id) as SuperQueueItem;
  expect(item).toBeTruthy();
  expect(mirror).toBeTruthy();
  return { session, item, mirror };
}

beforeEach(() => {
  setTeamAskRouteForTest('request');
  // The grant store lives under HOME, set once per file: each test starts with none of the last
  // test's grants (a leftover one-shot names another item and would answer for it).
  rmSync(join(process.env.HOME as string, '.dreamcontext', 'grants'), { recursive: true, force: true });
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'owner-answer-')));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
  resetWindowControl();
  resetSuperIndex();
  _resetSuperInbox();
  _resetChatRegistry();
  _resetDelegating();
  _resetOwnerQuestions();
  _resetOwnerAnswers();
  setMemberGateForTest(null);
  setGrantEnvForTest({ resolver: () => RESOLVER, roots: (p) => [p, '/tmp'] });
  wireSuperInbox();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true }));
  createAgent(root, { slug: 'rota', title: 'Rota Planner', prompt: 'You keep the routes.' }, { approve: { now: new Date() } });
});
afterEach(async () => {
  await _superInboxDrained();
  setTeamAskRouteForTest(null);
  setMemberGateForTest(null);
  setGrantEnvForTest({ resolver: null, roots: null });
  setOwnerKey(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('the server turn an Allow writes', () => {
  it('is the fixed sentence, the tool, and the input fenced as data that no backtick run can close', () => {
    const t = allowTurnText('Bash', 'node x.mjs ````evil````');
    expect(t).toContain(ALLOW_ONCE_SENTENCE);
    expect(t).toContain('Tool: Bash');
    expect(t).toContain('`````\nnode x.mjs ````evil````\n`````');
  });
});

describe('consent matches display (G2): an Allow lands only on the call he saw', () => {
  it('an Allow that says nothing of what it showed is refused as changed, and writes nothing', async () => {
    const { mirror } = await rotaRefused();
    expect(await answerOwnerItem(root, { record: 'main', item: mirror.id, via: 'bar', answer: { kind: 'refusal', action: 'allow', size: 'once' } }))
      .toMatchObject({ ok: false, error: 'changed' });
    expect(listGrants()).toEqual([]);
    // Not needed shows nothing to compare: it is taken as before.
    expect(await answerOwnerItem(root, { record: 'main', item: mirror.id, via: 'bar', answer: { kind: 'refusal', action: 'not_needed' } }))
      .toEqual({ ok: true, outcome: 'dismissed' });
  });

  it('the record rewritten between his look and his tap: refused as changed, the rewritten call is never allowed', async () => {
    const { item, mirror } = await rotaRefused();
    const seen = await shownFor('main', mirror.id);
    expect(seen).toEqual({ tool: 'Bash', input: 'node scripts/report.mjs' });
    // Something with write access to the project rewrites the member's stored refusal.
    await writeSuper(root, 'm:rota', (s) => {
      const q = s.queue.find((x) => x.id === item.id);
      if (q?.wait?.refusal) q.wait.refusal = { ...q.wait.refusal, input: 'node scripts/payout.mjs --all' };
    });
    const r = await answerOwnerItem(root, { record: 'main', item: mirror.id, via: 'bar', shown: seen, answer: { kind: 'refusal', action: 'allow', size: 'once' } });
    expect(r).toMatchObject({ ok: false, error: 'changed' });
    expect(listGrants()).toEqual([]);
  });

  it('Telegram keeps the key of what its card showed: the same key allows, another is refused', async () => {
    const { mirror } = await rotaRefused();
    const wrong = await answerOwnerItem(root, { record: 'main', item: mirror.id, via: 'telegram', shownKey: shownKeyOf('Bash', 'node scripts/other.mjs'), answer: { kind: 'refusal', action: 'allow', size: 'once' } });
    expect(wrong).toMatchObject({ ok: false, error: 'changed' });
    const right = await answerOwnerItem(root, { record: 'main', item: mirror.id, via: 'telegram', shownKey: shownKeyOf('Bash', 'node scripts/report.mjs'), answer: { kind: 'refusal', action: 'allow', size: 'once' } });
    expect(right.ok).toBe(true);
    expect(listGrants().map((g) => g.input)).toEqual(['node scripts/report.mjs']);
  });
});

describe('a refused call: Allow once', () => {
  it('writes the grant from the STORED item, one server turn into the live session, and closes when spent', async () => {
    const { session, item, mirror } = await rotaRefused();
    const turns: string[] = [];
    registerCrewHandle(session, { sendServerTurn: (t) => { turns.push(t); return true; } });
    const r = await answerShown(root, { record: 'main', item: mirror.id, via: 'bar', answer: { kind: 'refusal', action: 'allow', size: 'once' } });
    expect(r).toEqual({ ok: true, outcome: 'allowed' });
    // Allowed, waiting for its call to run: marked on the item and on its mirror (no Allow buttons).
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === item.id)?.allowed).toBe('once');
    expect((await main()).queue.find((q) => q.id === mirror.id)?.allowed).toBe('once');
    const grants = listGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ scope: 'once', tool: 'Bash', input: 'node scripts/report.mjs', pin: session, item: item.id });
    // The once pins the script as it was when he looked.
    expect(grants[0].script?.sha256).toBe(item.wait?.refusal?.scriptSha);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain(ALLOW_ONCE_SENTENCE);
    expect(turns[0]).toContain('node scripts/report.mjs');
    // First answer wins: a second tap anywhere is told so, and writes nothing.
    const again = await answerShown(root, { record: 'rota', item: item.id, via: 'telegram', answer: { kind: 'refusal', action: 'allow', size: 'once' } });
    expect(again).toMatchObject({ ok: false, error: 'already_answered' });
    expect(listGrants()).toHaveLength(1);
    // Open until the grant is used; spent by an enforcer, the item closes.
    expect((await rota()).queue.find((q) => q.id === item.id)?.state).not.toBe('done');
    expect(consumeOnce(grants[0].id)).toBe(true);
    await settleAllowedOnce(superKey(root, 'm:rota'));
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === item.id)?.state).toBe('done');
    expect((await main()).queue.find((q) => q.id === mirror.id)?.state).toBe('done');
    // Closed, it carries no mark any more.
    expect((await rota()).queue.find((q) => q.id === item.id)?.allowed).toBeUndefined();
  });

  it('with no live process: the turn waits in the outbox and the item says so', async () => {
    const { session, item } = await rotaRefused();
    const r = await answerShown(root, { record: 'rota', item: item.id, via: 'bar', answer: { kind: 'refusal', action: 'allow' } });
    expect(r).toEqual({ ok: true, outcome: 'allowed_waiting' });
    expect((await rota()).queue.find((q) => q.id === item.id)?.ownerText?.startsWith(ALLOWED_WAITING_TEXT)).toBe(true);
    const box = await readOutbox(superKey(root, 'm:rota'));
    expect(box.some((x) => x.child === session && x.text.includes(ALLOW_ONCE_SENTENCE))).toBe(true);
  });

  it('a size the item does not offer is refused, and the phone never allows a refusal', async () => {
    const { item } = await rotaRefused('npm test');
    // `npm test` is no pinned script: Allow once only.
    expect(item.offer?.sizes).toEqual(['once']);
    expect(await answerShown(root, { record: 'rota', item: item.id, via: 'bar', answer: { kind: 'refusal', action: 'allow', size: 'job' } }))
      .toMatchObject({ ok: false, error: 'not_offered' });
    expect(await answerShown(root, { record: 'rota', item: item.id, via: 'phone', answer: { kind: 'refusal', action: 'allow' } }))
      .toMatchObject({ ok: false, error: 'not_offered', message: 'Allow it on Telegram or the Mac.' });
    expect(listGrants()).toEqual([]);
  });

  it('Not needed closes it and writes no grant', async () => {
    const { item, mirror } = await rotaRefused();
    expect(await answerShown(root, { record: 'main', item: mirror.id, via: 'chat', answer: { kind: 'refusal', action: 'not_needed' } }))
      .toEqual({ ok: true, outcome: 'dismissed' });
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === item.id)?.state).toBe('done');
    expect(listGrants()).toEqual([]);
  });

  it('an input stored cut gets no grant of any size', async () => {
    const session = await rotaSession();
    refuse(crew(session), `node scripts/report.mjs ${'a'.repeat(17_000)}`);
    await _superInboxDrained();
    const item = (await rota()).queue.find((q) => q.own && q.wait?.kind === 'refusal') as SuperQueueItem;
    expect(item.wait?.refusal?.whole).toBe(false);
    // No size at all: the record keeps no offer, and the card shows it uncut on the Mac only.
    expect(item.offer).toBeUndefined();
    expect(await answerShown(root, { record: 'rota', item: item.id, via: 'bar', answer: { kind: 'refusal', action: 'allow' } }))
      .toMatchObject({ ok: false, error: 'not_offered' });
    expect(listGrants()).toEqual([]);
  });
});

describe('an allowed call refused again is offered again, never locked', () => {
  it('the script changed: the stale grant goes, the mark clears, and a NEW item asks him again', async () => {
    const { session, item, mirror } = await rotaRefused();
    // Re-registered with his own "go": his words to the session answer its waits, so the allowed
    // item may close before the call comes back refused. Either way, the fresh refusal's item must
    // leave no earlier Allow standing (inbox.ts `dropStaleGrants`).
    const h = crew(session);
    // The live process: the Allow's server turn goes in as a turn the registry sees.
    registerCrewHandle(session, { sendServerTurn: (t) => { h.userSent(t, { server: true }); return true; } });
    expect(await answerShown(root, { record: 'main', item: mirror.id, via: 'bar', answer: { kind: 'refusal', action: 'allow', size: 'job' } }))
      .toEqual({ ok: true, outcome: 'allowed' });
    expect(listGrants().map((g) => g.item)).toEqual([item.id]);
    // The rule no longer covers it (the script was edited): the same call is refused again.
    refuse(h, 'node scripts/report.mjs', 'toolu_r2');
    await new Promise((r) => setTimeout(r, 5));
    await _superInboxDrained();
    const s = await rota();
    expect(s.queue.find((q) => q.id === item.id)?.state).toBe('done');
    const again = s.queue.find((q) => q.own && q.wait?.kind === 'refusal' && q.state !== 'done') as SuperQueueItem;
    expect(again.id).not.toBe(item.id);
    expect(again.wait?.id).toBe(item.wait?.id);
    expect(again.allowed).toBeUndefined();
    expect(listGrants()).toEqual([]);
    // Its mirror is a new one, and he can answer it.
    const m2 = (await main()).queue.find((q) => q.kind === 'member' && q.answers === again.id && q.state !== 'done');
    expect(m2).toBeTruthy();
    expect(await answerShown(root, { record: 'main', item: m2!.id, via: 'bar', answer: { kind: 'refusal', action: 'not_needed' } }))
      .toEqual({ ok: true, outcome: 'dismissed' });
  });
});

describe('first answer wins, at every size', () => {
  it('allowed for this job while its chat is closed: a second Allow and a Not needed are told it was answered', async () => {
    const { item, mirror } = await rotaRefused();
    expect(item.offer?.sizes).toContain('job');
    expect(await answerShown(root, { record: 'main', item: mirror.id, via: 'bar', answer: { kind: 'refusal', action: 'allow', size: 'job' } }))
      .toEqual({ ok: true, outcome: 'allowed_waiting' });
    expect(await answerShown(root, { record: 'main', item: mirror.id, via: 'telegram', answer: { kind: 'refusal', action: 'allow', size: 'member' } }))
      .toMatchObject({ ok: false, error: 'already_answered' });
    expect(await answerShown(root, { record: 'rota', item: item.id, via: 'telegram', answer: { kind: 'refusal', action: 'allow', size: 'once' } }))
      .toMatchObject({ ok: false, error: 'already_answered' });
    expect(await answerShown(root, { record: 'rota', item: item.id, via: 'bar', answer: { kind: 'refusal', action: 'not_needed' } }))
      .toMatchObject({ ok: false, error: 'already_answered' });
    // One rule, naming the item it answered; one turn waiting for the chat.
    expect(listGrants().map((g) => [g.scope, g.item])).toEqual([['job', item.id]]);
    const box = await readOutbox(superKey(root, 'm:rota'));
    expect(box.filter((x) => x.text.includes('node scripts/report.mjs'))).toHaveLength(1);
  });

  it('an always-rule on a permission is written only once its answer landed', async () => {
    const session = await rotaSession();
    crew(session, 'default').observe({ type: 'control_request', request_id: 'req-own-j', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'node scripts/report.mjs' }, tool_use_id: 'toolu_oj' } });
    await _superInboxDrained();
    const own = (await rota()).queue.find((q) => q.own && q.kind === 'permission') as SuperQueueItem;
    expect(own.offer?.sizes).toContain('job');
    // No window to answer through: the prompt is unanswered, so no rule may stand.
    expect(await answerShown(root, { record: 'rota', item: own.id, via: 'bar', answer: { kind: 'permission', behavior: 'allow', size: 'job' } }))
      .toMatchObject({ ok: false, error: 'no_window' });
    expect(listGrants()).toEqual([]);
  });
});

describe('a member\'s own question and permission', () => {
  it('its own `super ask` answered from the desktop: his reply, marked his, waits in its queue', async () => {
    const session = await rotaSession();
    const r = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'May I send the DM?', options: ['Send it', 'Do not send'], for: 'owner' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await _superInboxDrained();
    const askId = (r.json.result as { item: string }).item;
    const mirror = (await main()).queue.find((q) => q.kind === 'member' && q.answers === askId) as SuperQueueItem;
    const a = await answerShown(root, { record: 'main', item: mirror.id, via: 'bar', answer: { kind: 'question', answers: { 'May I send the DM?': 'Send it' } } });
    expect(a).toEqual({ ok: true, outcome: 'answered' });
    const s = await rota();
    const reply = s.queue.find((q) => q.kind === 'reply' && q.answers === askId);
    expect(reply).toMatchObject({ workOrigin: 'owner', state: 'pending' });
    expect(reply?.text).toContain('Send it');
    // It left his list at once (first answer wins), and a second surface is told so.
    expect(ownerItems(s).map((q) => q.id)).not.toContain(askId);
    expect(await answerShown(root, { record: 'rota', item: askId, via: 'telegram', answer: { kind: 'ask', text: 'no' } }))
      .toMatchObject({ ok: false, error: 'already_answered' });
  });

  it('its own permission goes through its own window: none open, `no_window`', async () => {
    const session = await rotaSession();
    crew(session, 'default').observe({ type: 'control_request', request_id: 'req-own-p', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'node scripts/report.mjs' }, tool_use_id: 'toolu_op' } });
    await _superInboxDrained();
    const own = (await rota()).queue.find((q) => q.own && q.kind === 'permission') as SuperQueueItem;
    expect(await answerShown(root, { record: 'rota', item: own.id, via: 'bar', answer: { kind: 'permission', behavior: 'allow' } }))
      .toMatchObject({ ok: false, error: 'no_window' });
    // The phone may answer a permission, never with a grant size.
    expect(await answerShown(root, { record: 'rota', item: own.id, via: 'phone', answer: { kind: 'permission', behavior: 'allow', size: 'member' } }))
      .toMatchObject({ ok: false, error: 'not_offered' });
    expect(listGrants()).toEqual([]);
  });
});

describe('POST /api/super/owner-answer (G4)', () => {
  const ORIGIN = { origin: 'http://127.0.0.1:4173', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  function post(body: unknown, headers: Record<string, string>): IncomingMessage {
    return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST', url: '/api/super/owner-answer', headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1', setTimeout() {} }, setTimeout() {},
    }) as unknown as IncomingMessage;
  }

  it('refuses every kind without the owner key (owner_page_only) and answers with it', async () => {
    setOwnerKey(KEY);
    const { mirror } = await rotaRefused();
    const body = { record: 'main', item: mirror.id, via: 'bar', answer: { kind: 'refusal', action: 'not_needed' } };
    const no = res();
    await handleSuperOwnerAnswer(post(body, ORIGIN), no, {}, root);
    expect(no.status).toBe(403);
    expect(no.json).toMatchObject({ ok: false, error: 'owner_page_only' });
    const yes = res();
    await handleSuperOwnerAnswer(post(body, { ...ORIGIN, [OWNER_KEY_HEADER]: KEY }), yes, {}, root);
    expect(yes.status).toBe(200);
    expect(yes.json).toEqual({ ok: true, outcome: 'dismissed' });
    // Answered already: 409 for the second surface.
    const twice = res();
    await handleSuperOwnerAnswer(post(body, { ...ORIGIN, [OWNER_KEY_HEADER]: KEY }), twice, {}, root);
    expect(twice.status).toBe(409);
    expect(twice.json).toMatchObject({ error: 'already_answered' });
  });

  it('builds a grant from the stored item, whatever text the request body carries', async () => {
    setOwnerKey(KEY);
    const { mirror } = await rotaRefused();
    const r = res();
    const shown = await shownFor('main', mirror.id);
    await handleSuperOwnerAnswer(post({ record: 'main', item: mirror.id, via: 'bar', shown, answer: { kind: 'refusal', action: 'allow', size: 'once', input: 'rm -rf /' }, tool: 'Bash', input: 'rm -rf /' }, { ...ORIGIN, [OWNER_KEY_HEADER]: KEY }), r, {}, root);
    expect(r.status).toBe(200);
    expect(listGrants().map((g) => g.input)).toEqual(['node scripts/report.mjs']);
  });

  it('an Allow whose shown call is not what would run is refused as changed (409), and writes nothing', async () => {
    setOwnerKey(KEY);
    const { mirror } = await rotaRefused();
    const r = res();
    await handleSuperOwnerAnswer(post({ record: 'main', item: mirror.id, via: 'bar', shown: { tool: 'Bash', input: 'node scripts/other.mjs' }, answer: { kind: 'refusal', action: 'allow', size: 'once' } }, { ...ORIGIN, [OWNER_KEY_HEADER]: KEY }), r, {}, root);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, error: 'changed' });
    expect(listGrants()).toEqual([]);
  });
});

describe("main's card for a member that waits on the owner (2026-11-11, kitup Turing)", () => {
  it('reads asking while the refusal stands, never a working spinner; running again once it is settled', async () => {
    const session = await rotaSession();
    // The member took the job (its turn ended with it in hand): before anything waits, it works.
    await writeSuper(root, 'm:rota', (s) => { for (const q of s.queue) if (q.kind === 'request') { q.state = 'delivered'; q.acceptedAt = Date.now(); } });
    await _superInboxDrained();
    const job = (await main()).team.find((j) => j.member === 'rota' && j.request);
    expect(job).toBeTruthy();
    expect(teamJobStatus(root, job!, null).status).toBe('running');
    // Its next turn is refused by the classifier (a real purchase): an owner item on its record.
    refuse(crew(session), 'node scripts/buy.mjs');
    await _superInboxDrained();
    const item = (await rota()).queue.find((q) => q.own && q.kind === 'owner' && q.wait?.kind === 'refusal');
    expect(item).toBeTruthy();
    expect(teamJobStatus(root, job!, null).status).toBe('asking');
    // He says it is not needed: the wait closes, the card works again.
    const mirror = (await main()).queue.find((q) => q.kind === 'member' && q.answers === item!.id);
    expect(await answerOwnerItem(root, { record: 'main', item: mirror!.id, via: 'bar', answer: { kind: 'refusal', action: 'not_needed' } }))
      .toMatchObject({ ok: true });
    await _superInboxDrained();
    expect(teamJobStatus(root, job!, null).status).toBe('running');
  });
});

describe("a member's one card reads its current job, never its first one (2026-11-11, kitup Turing)", () => {
  it('after a follow-up, the card line is the follow-up\'s, not the done root\'s', async () => {
    await rotaSession();
    // The first job ends with a result; the Super asks the member again on the same card.
    await writeSuper(root, 'm:rota', (s) => { for (const q of s.queue) if (q.kind === 'request') { q.state = 'done'; q.result = 'Old report filed.'; } });
    const again = await verb(tokenFor(MAIN), 'team-ask', { member: 'rota', text: 'Now the Q4 report.', brief: 'q4 report' });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    await _superInboxDrained();
    const s = await main();
    const rootJob = s.team.find((j) => j.member === 'rota' && !j.followUpOf);
    expect(s.team.find((j) => j.followUpOf === rootJob?.id)).toBeTruthy();
    const row = teamLiveRows(root, s)?.[rootJob!.id];
    expect(row?.lastLine).toBe('q4 report');
    expect(row?.status).toBe('queued');
  });
});
