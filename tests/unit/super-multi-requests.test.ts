/**
 * Plan-r10 1, Wave 2 lane A step A2: every AI Team member is a Super of its own.
 *
 *  - `team ask` from main is a `request` in the MEMBER's queue (memberCallState on every request,
 *    429 at the 21st open request), delivered by the member's own pump as a server event
 *    ("Super Agent'tan"), accepted at its turn's result end, closed only by `team done` (once),
 *    which gives main ONE event; exits, boot and the 30-minute fallback follow the plan's rules.
 *  - `team answer` closes main's question and sends a `reply` the member's pump delivers, which
 *    closes the member's ask.
 *  - Origins: main:* work never reaches the owner; batches never mix origins; `mainBatches`.
 *  - One inbox per super: owner messages, child events and turn ends stay in their own super.
 *  - Owner routes act on `?superId=`; members off stop their Super; the first child carries its crew.
 *
 * Scratch HOME and vault only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-multi-req-home-`);
});

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState, superKey, withSuperState } from '../../src/lib/super/store.js';
import { MAX_QUEUE, emptySuperState, trimTeamJobs, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import {
  REQUEST_FROM, REQUEST_QUIET_MS, REQUEST_UNSTARTED_MS, TEAM_LINE, _resetSuperInbox, _superInboxDrained, attachSuperInbox, bootRequests, checkQuietRequests, isRequestQuestion, nextBatch,
  noteOwnerActivity, ownerQuestionOpen, setMemberGateForTest, superBatchText, superQueueHead, superOwnerSpoke, superTurnEnded, superTurnOrigin, superView, wireSuperInbox, writeSuper,
  type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { TEAM_ASK_ROUTE, handleSuperLayout, handleSuperStateGet, handleSuperVerb, setTeamAskRouteForTest, stopMemberSuper } from '../../src/server/routes/super.js';
import { handleAgentsSetEnabled } from '../../src/server/routes/agents.js';
import { registerLiveChat, unregisterLiveChat, type LiveChatEntry } from '../../src/server/routes/agent-chat-live.js';
import { createAgent, setAgentCallEnabled } from '../../src/lib/agents/store.js';
import { memberSummaries, phoneMemberRow, summarizeMember } from '../../src/lib/super/member-summary.js';
import { rosterSummary } from '../../src/server/routes/agent-sessions.js';
import { superWindowRefusal } from '../../src/server/routes/window-control.js';
import { memberCrewCandidates, memberCrewDecision, memberCrewOf, memberCrewPermissionMode, superUpgradeRefusal } from '../../src/server/routes/agent-chat.js';
import { crewBridgeMode, crewToolRefusal } from '../../src/lib/super/member-crew.js';
import { _resetDelegating, mintCrewTicket, noteDelegating } from '../../src/lib/super/delegating.js';
import { _resetOwnerQuestions, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-1';
const W = { timeout: 10_000 };

function req(body: unknown, headers: Record<string, string> = {}, url = '/'): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url });
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
const reg = (sid: string, mode = 'basic'): ChatHandle => registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode });
const idle = (sid: string, mode = 'super') => { const h = reg(sid, mode); h.userSent(''); h.observe({ type: 'result' }); return h; };
function fakeInbox(sessionId: string, over: Partial<SuperInbox> = {}) {
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`, sessionId, attached: () => true, idle: () => true,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
    ...over,
  };
  return { inbox, delivered };
}
const main = () => readSuperState(root);
const rota = () => readSuperState(root, 'm:rota');

/** Ask Rota through main and return the request id and the member's session. */
async function askRota(text = 'Plan the Friday routes.') {
  const r = await verb(tokenFor(MAIN), 'team-ask', { member: 'rota', text, brief: 'Friday routes' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const result = r.json.result as { request: string; job: string };
  return { request: result.request, job: result.job, session: (await rota()).session as string };
}

// The request route is live since Wave 3 (TEAM_ASK_ROUTE); named here anyway, so these tests keep
// testing it whatever the default says. 'the live route' below runs with no override.
beforeEach(() => { setTeamAskRouteForTest('request'); });
afterEach(() => { setTeamAskRouteForTest(null); });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-multi-req-')));
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
  createAgent(root, { slug: 'rota', title: 'Rota', prompt: 'You keep the routes.' }, { approve: { now: new Date() } });
  createAgent(root, { slug: 'mira', title: 'Mira', prompt: 'You write the newsletter.' }, { approve: { now: new Date() } });
});
afterEach(async () => {
  await _superInboxDrained();
  setMemberGateForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('team ask is a request in the member\'s own Super', () => {
  it('lands pending in the MEMBER\'s queue (record born), main gets a team job naming it; nothing in main\'s queue', async () => {
    const { request, job } = await askRota();
    const m = await rota();
    expect(m).toMatchObject({ enabled: true, member: 'rota' });
    expect(m.queue).toEqual([expect.objectContaining({ id: request, kind: 'request', state: 'pending', text: 'Plan the Friday routes.' })]);
    const s = await main();
    expect(s.team.find((j) => j.id === job)).toMatchObject({ member: 'rota', request });
    expect(s.queue.some((q) => q.kind === 'request')).toBe(false);
    // Main's card for the member reads the member's record: queued.
    expect(superView(root, s).teamLive?.[job]?.status).toBe('queued');
  });

  it('an off or unapproved member is 409 and nothing is queued; the 21st open request is 429', async () => {
    createAgent(root, { slug: 'pera', title: 'Pera', prompt: 'You price things.' });
    const un = await verb(tokenFor(MAIN), 'team-ask', { member: 'pera', text: 'price it' });
    expect(un.status).toBe(409);
    expect(un.json.error).toBe('say_unapproved');
    expect((await readSuperState(root, 'm:pera')).queue).toEqual([]);
    // Where the owner approves it now (plan-r10 1e): its stage band and "Üyeleri yönet", no AI Team page.
    expect(String(un.json.message)).toContain('the owner does, on its approval card (its stage, or "Üyeleri yönet")');
    const approval = (await main()).queue.find((q) => q.kind === 'approval' && q.member === 'pera');
    expect(approval?.ownerText).toBe('pera waits for its one approval card (on its stage, and in "Üyeleri yönet"), so the Super Agent cannot give it a job. Open the card there, then tell the Super Agent.');
    for (let i = 0; i < 20; i++) await askRota(`job ${i}`);
    const full = await verb(tokenFor(MAIN), 'team-ask', { member: 'rota', text: 'one more' });
    expect(full.status).toBe(429);
    expect(full.json.error).toBe('member_queue_full');
    expect((await rota()).queue.filter((q) => q.kind === 'request')).toHaveLength(20);
  });

  it('asking the same member again follows up on its ONE card', async () => {
    const a = await askRota('one');
    const b = await askRota('two');
    const s = await main();
    expect(s.team.find((j) => j.id === b.job)).toMatchObject({ followUpOf: a.job, by: 'super' });
    expect(s.containers.filter((c) => c.kind === 'team')).toHaveLength(1);
  });

  it('an in-flight Wave 1 headless job keeps its record and the member\'s one card; the request starts its own chain', async () => {
    await withSuperState(root, 'main', (s) => {
      s.team = [{ id: 'team-old-1', member: 'rota', runId: '2026-11-01T10:00:00.000Z', jobKind: 'run', queued: false, brief: 'old', startedAt: 1, open: true }];
      s.containers = [{ id: 'team-x', kind: 'team', ref: 'team-old-1', shape: 'square', place: 'float' }];
    });
    const { job } = await askRota();
    const s = await main();
    expect(s.team.find((j) => j.id === 'team-old-1')).toMatchObject({ open: true });
    expect(s.team.find((j) => j.id === job)?.followUpOf).toBeUndefined();
    expect(s.containers.filter((c) => c.kind === 'team')).toHaveLength(1);
  });
});

describe('the live route (Wave 3): team ask with no route override', () => {
  beforeEach(() => { setTeamAskRouteForTest(null); });

  it('the default is `request`: a request item in the member\'s record, and main\'s team job for the member\'s one card', async () => {
    expect(TEAM_ASK_ROUTE).toBe('request');
    const r = await verb(tokenFor(MAIN), 'team-ask', { member: 'rota', text: 'Check Monday.', brief: 'Monday' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const result = r.json.result as { job: string; member: string; request: string; queued: boolean; status: string };
    expect(result).toMatchObject({ member: 'rota', queued: true, status: 'queued' });
    expect(typeof result.request).toBe('string');
    const m = await rota();
    expect(m).toMatchObject({ enabled: true, member: 'rota' });
    expect(m.queue).toEqual([expect.objectContaining({ id: result.request, kind: 'request', state: 'pending', text: 'Check Monday.' })]);
    const s = await main();
    expect(s.team.find((j) => j.id === result.job)).toMatchObject({ member: 'rota', request: result.request, open: true, brief: 'Monday' });
    expect(s.containers.filter((c) => c.kind === 'team')).toEqual([expect.objectContaining({ ref: result.job })]);
    // Nothing for main's own pump: the request lives in the member's queue only.
    expect(s.queue.some((q) => q.kind === 'request')).toBe(false);
    expect(superView(root, s).teamLive?.[result.job]?.status).toBe('queued');
  });
});

describe('the request\'s life', () => {
  it('delivered as a framed server event, accepted at the turn\'s end (still open, card working), closed once by team done', async () => {
    const { request, job, session } = await askRota();
    idle(session);
    const { inbox, delivered } = fakeInbox(session);
    attachSuperInbox(inbox);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    expect(delivered[0].text).toContain(REQUEST_FROM);
    expect(delivered[0].text).toContain('Plan the Friday routes.');
    expect(delivered[0].event).toMatchObject({ kind: 'batch', items: [{ item: request, kind: 'request' }] });
    await vi.waitFor(async () => expect((await rota()).queue[0].state).toBe('delivered'), W);
    expect((await rota()).mainBatches?.length).toBe(1);
    expect(superTurnOrigin(session)).toBe(`main:${request}`);
    superTurnEnded(session);
    await vi.waitFor(async () => expect((await rota()).queue[0].acceptedAt).toBeTypeOf('number'), W);
    expect((await rota()).queue[0].state).toBe('delivered');
    expect(superView(root, await main()).teamLive?.[job]?.status).toBe('running');
    // A second attach never delivers it again.
    const again = fakeInbox(session);
    attachSuperInbox(again.inbox);
    await _superInboxDrained();
    expect(again.delivered).toHaveLength(0);

    const done = await verb(tokenFor(session, 'm:rota'), 'team-done', { item: request, result: 'Friday has 3 routes.' });
    expect(done.status).toBe(200);
    const twice = await verb(tokenFor(session, 'm:rota'), 'team-done', { item: request, result: 'again' });
    expect(twice.status).toBe(409);
    const s = await main();
    const events = s.queue.filter((q) => q.team === job && q.kind === 'done');
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('Friday has 3 routes.');
    expect(superView(root, s).teamLive?.[job]?.status).toBe('done');
  });

  it('a busy member gets it after its turn ends', async () => {
    const { session } = await askRota();
    idle(session);
    let busy = true;
    const { inbox, delivered } = fakeInbox(session, { idle: () => !busy });
    attachSuperInbox(inbox);
    await _superInboxDrained();
    expect(delivered).toHaveLength(0);
    busy = false;
    superTurnEnded(session);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
  });

  it('a pure exit before its result puts it back; at the second exit it STAYS pending and main hears it once', async () => {
    const { request, job, session } = await askRota();
    idle(session);
    for (let n = 1; n <= 2; n++) {
      const { inbox, delivered } = fakeInbox(session);
      const detach = attachSuperInbox(inbox);
      await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
      await vi.waitFor(async () => expect((await rota()).queue[0].state).toBe('delivered'), W);
      detach();
      await vi.waitFor(async () => expect((await rota()).queue[0]).toMatchObject({ id: request, state: 'pending', exits: n }), W);
    }
    await vi.waitFor(async () => expect((await main()).queue.filter((q) => q.team === job && q.partial)).toHaveLength(1), W);
  });

  it('at boot: delivered with no acceptedAt goes back to pending; accepted stays open', () => {
    const s = sanitizeSuperState({
      ...emptySuperState(), session: 's', enabled: true, member: 'rota',
      queue: [
        { id: 'q-a-0000000a', sessionId: 's', kind: 'request', state: 'delivered', createdAt: 1, text: 'a' },
        { id: 'q-b-0000000b', sessionId: 's', kind: 'request', state: 'delivered', createdAt: 1, text: 'b', acceptedAt: 2 },
      ],
    });
    expect(bootRequests(s)).toBe(true);
    expect(s.queue.map((q) => q.state)).toEqual(['pending', 'delivered']);
  });

  it('an open request is never pruned, whatever the queue holds', () => {
    const many = Array.from({ length: MAX_QUEUE + 5 }, (_, i) => ({ id: `q-z-${String(i).padStart(8, '0')}`, sessionId: 's', kind: 'stuck', state: 'pending', createdAt: i + 2 }));
    const s = sanitizeSuperState({
      ...emptySuperState(), session: 's', enabled: true,
      queue: [{ id: 'q-r-0000000r', sessionId: 's', kind: 'request', state: 'pending', createdAt: 1, text: 'keep me' }, ...many],
    });
    expect(s.queue).toHaveLength(MAX_QUEUE);
    expect(s.queue.some((q) => q.kind === 'request')).toBe(true);
  });

  it('the 30-minute fallback gives main ONE line and closes nothing', async () => {
    const { request, job } = await askRota();
    await withSuperState(root, 'm:rota', (s) => { const q = s.queue[0]; q.state = 'delivered'; q.acceptedAt = 1; });
    const s = await rota();
    const key = superKey(root, 'm:rota');
    checkQuietRequests(key, s, 1 + REQUEST_QUIET_MS + 1);
    checkQuietRequests(key, s, 1 + REQUEST_QUIET_MS + 2);
    await vi.waitFor(async () => expect((await main()).queue.filter((q) => q.team === job && q.partial)).toHaveLength(1), W);
    expect((await rota()).queue.find((q) => q.id === request)?.state).toBe('delivered');
  });

  it('a pending request to a member that turned off is not delivered; main hears it once', async () => {
    const { job, session } = await askRota();
    setMemberGateForTest(() => 'off');
    idle(session);
    const { inbox, delivered } = fakeInbox(session);
    attachSuperInbox(inbox);
    await vi.waitFor(async () => expect((await main()).queue.filter((q) => q.team === job && q.partial)).toHaveLength(1), W);
    expect(delivered).toHaveLength(0);
    expect((await rota()).queue[0].state).toBe('pending');
  });

  it('turning a member off stops its live Super and kills its keys', async () => {
    const { session } = await askRota();
    const cut = vi.fn(async () => { unregisterLiveChat(entry); });
    const entry: LiveChatEntry = { conversationId: session, projectRoot: dir, busy: false, turnStartedAt: null, lastTurnEndedAt: null, adopt: () => false, supersede: () => () => undefined, cut };
    registerLiveChat(entry);
    const s = await stopMemberSuper(root, 'rota');
    expect(s.enabled).toBe(false);
    expect(cut).toHaveBeenCalled();
  });
});

describe('a member\'s question to main, and main\'s answer', () => {
  it('lands in MAIN\'s queue (never the owner\'s), team answer closes it and its reply reaches the member as an event and closes the ask', async () => {
    const { request, job, session } = await askRota();
    const asked = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which depot first?', for: request });
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const askId = (asked.json.result as { item: string }).item;
    const m1 = await rota();
    expect(m1.queue.find((q) => q.id === askId)).toMatchObject({ kind: 'ask', workOrigin: `main:${request}` });
    const s1 = await main();
    const q = s1.queue.find((x) => x.kind === 'question' && x.team === job);
    expect(q).toMatchObject({ answers: askId, text: 'Which depot first?' });
    // The owner may still ask the member's own question at the same time (another audience).
    const own = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Owner: may I reroute?', for: 'owner' });
    expect(own.status, JSON.stringify(own.json)).toBe(200);
    // Only main answers it.
    expect((await verb(tokenFor(session, 'm:rota'), 'team-answer', { item: q!.id, text: 'North' })).status).toBe(403);
    const ans = await verb(tokenFor(MAIN), 'team-answer', { item: q!.id, text: 'North depot first.' });
    expect(ans.status, JSON.stringify(ans.json)).toBe(200);
    expect((await main()).queue.find((x) => x.id === q!.id)?.state).toBe('done');
    const reply = (await rota()).queue.find((x) => x.kind === 'reply');
    expect(reply).toMatchObject({ answers: askId, text: 'North depot first.', state: 'pending' });
  });

  it('the queue-ask team_question refusal stays: main never forwards a member\'s question', async () => {
    const { request, session } = await askRota();
    await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which depot?', for: request });
    const q = (await main()).queue.find((x) => x.kind === 'question' && !!x.team)!;
    const r = await verb(tokenFor(MAIN), 'queue-ask', { item: q.id, text: 'Owner, which depot?' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('team_question');
    // …and its message sends main to `team answer`, never to the owner.
    expect(String(r.json.message)).toContain('super team answer');
    expect(String(r.json.message)).not.toMatch(/owner's to answer/);
  });

  it('main\'s event turn tags it from=member-super, and the team rule says it is main\'s to answer, never the owner\'s', async () => {
    const { request, job, session } = await askRota();
    await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which depot?', for: request });
    const s = await main();
    const q = s.queue.find((x) => x.kind === 'question' && x.team === job)!;
    const text = superBatchText(root, s, [q], 'b-q');
    expect(text).toMatch(new RegExp(`^- item=${q.id} team=${job} member=rota event=question from=member-super`, 'm'));
    expect(text).toContain(TEAM_LINE);
    expect(TEAM_LINE).toContain('event=question on a line WITHOUT from=member-super means the member\'s run stopped to ask the owner');
    expect(TEAM_LINE).toContain('event=question on a line WITH from=member-super is that member\'s own Super asking YOU about the job you gave it, never the owner\'s');
    expect(TEAM_LINE).toContain('`dreamcontext super team answer <item> "<answer>"`');
    expect(TEAM_LINE).toContain('never tell him the member asks and never forward it');
    // The approval card lives on the member's stage and in "Üyeleri yönet" now, not an AI Team page.
    expect(TEAM_LINE).not.toMatch(/in AI Team\b/);
  });
});

describe('origins', () => {
  it('a batch never mixes origins', () => {
    const s: SuperState = {
      ...emptySuperState(), session: 's', enabled: true, member: 'rota',
      children: {
        a: { sessionId: 'a', brief: '', adopted: false, startedAt: 1, row: 'done', workOrigin: 'owner' },
        b: { sessionId: 'b', brief: '', adopted: false, startedAt: 1, row: 'done', workOrigin: 'main:q-r-0000000r' },
      },
      queue: [
        { id: 'q-1-0000000a', sessionId: 'a', kind: 'done', state: 'pending', createdAt: 1 },
        { id: 'q-2-0000000b', sessionId: 'b', kind: 'done', state: 'pending', createdAt: 2 },
      ] as SuperQueueItem[],
    };
    expect(nextBatch(s).items.map((q) => q.id)).toEqual(['q-1-0000000a']);
  });

  it('a turn an owner message is steered into is the owner\'s from then on', async () => {
    const { request, session } = await askRota();
    idle(session);
    const { inbox, delivered } = fakeInbox(session);
    attachSuperInbox(inbox);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    expect(superTurnOrigin(session)).toBe(`main:${request}`);
    superOwnerSpoke(session, Date.now(), [], [], true);
    expect(superTurnOrigin(session)).toBe('owner');
  });

  it('mainBatches is written, sanitized and mirrored', () => {
    const s = sanitizeSuperState({ ...emptySuperState(), session: 's', enabled: true, mainBatches: ['b-1', 'b-1', 'NOT OK', 'b-2'] });
    expect(s.mainBatches).toEqual(['b-1', 'b-2']);
  });

  it('a main:* question of a member is never announced to the owner; an owner one is, with the member\'s name', async () => {
    const titles: string[] = [];
    setOwnerQuestionSinks({ banner: (t: string) => { titles.push(t); return true; }, push: () => 0, presence: () => ({ vault: null, session: null }) } as never);
    await askRota();
    await writeSuper(root, 'm:rota', (s) => {
      s.queue.push({ id: 'q-m-0000000m', sessionId: s.session as string, kind: 'ask', state: 'escalated', createdAt: 5, ownerText: 'main one', workOrigin: 'main:q-r-0000000r' });
    });
    expect(titles).toEqual([]);
    await writeSuper(root, 'm:rota', (s) => {
      s.queue.push({ id: 'q-o-0000000o', sessionId: s.session as string, kind: 'ask', state: 'escalated', createdAt: 6, ownerText: 'May I reroute?' });
    });
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatch(/^Rota · /);
  });
});

describe('one inbox per super', () => {
  it('an owner message on a member stage never closes main\'s ask, nor the reverse; [About task] closes none', async () => {
    const { session } = await askRota();
    await writeSuper(root, (s) => { s.queue.push({ id: 'q-main-0000000a', sessionId: MAIN, kind: 'ask', state: 'escalated', createdAt: 1, ownerText: 'main ask' }); });
    await writeSuper(root, 'm:rota', (s) => { s.queue.push({ id: 'q-rota-0000000b', sessionId: session, kind: 'ask', state: 'escalated', createdAt: 1, ownerText: 'rota ask' }); });
    superOwnerSpoke(session, Date.now(), [], [{ kind: 'task', id: 'fix-login' }]);
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === 'q-rota-0000000b')?.state).toBe('escalated');
    superOwnerSpoke(session);
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === 'q-rota-0000000b')?.state).toBe('done');
    expect((await main()).queue.find((q) => q.id === 'q-main-0000000a')?.state).toBe('escalated');
    superOwnerSpoke(MAIN);
    await _superInboxDrained();
    expect((await main()).queue.find((q) => q.id === 'q-main-0000000a')?.state).toBe('done');
  });

  it('a member child\'s question lands in the member\'s queue, never main\'s', async () => {
    const { session } = await askRota();
    await writeSuper(root, 'm:rota', (s) => { s.children['kid-1'] = { sessionId: 'kid-1', brief: 'x', adopted: false, startedAt: Date.now(), row: 'working' }; });
    const h = reg('kid-1');
    h.userSent('go');
    h.observe({ type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] } } });
    await vi.waitFor(async () => expect((await rota()).queue.some((q) => q.kind === 'question' && q.sessionId === 'kid-1')).toBe(true), W);
    // Only its mirror reaches main (kind member, owner 2026-11-10), never the question item itself.
    expect((await main()).queue.some((q) => q.sessionId === 'kid-1' && q.kind !== 'member')).toBe(false);
    expect(session).toBeTruthy();
  });

  it('main\'s owner lease never holds the member\'s pump', async () => {
    const { session } = await askRota();
    await noteOwnerActivity(root);
    idle(session);
    const { inbox, delivered } = fakeInbox(session);
    attachSuperInbox(inbox);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
  });

  it('a turn end of main never settles the member\'s carried request', async () => {
    const { session } = await askRota();
    idle(session);
    idle(MAIN);
    const { inbox, delivered } = fakeInbox(session);
    attachSuperInbox(inbox);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    superTurnEnded(MAIN);
    await _superInboxDrained();
    expect((await rota()).queue[0].acceptedAt).toBeUndefined();
  });
});

describe('window, sessions, summary', () => {
  it('a member token cannot open a new window chat; another chat cannot mode the member tab', async () => {
    const { session } = await askRota();
    reg(session, 'super');
    const memberTok = tokenFor(session, 'm:rota');
    expect(superWindowRefusal(memberTok, 'new', {})).toMatch(/super delegate/);
    reg('other-chat');
    const other = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: 'other-chat', mode: 'basic' }).token;
    expect(superWindowRefusal(other, 'mode', { tab: session })).toBeTruthy();
  });

  it('a member\'s sessions are never the owner\'s tabs in the summary', () => {
    const saved = { sessions: [{ id: 't1', title: 'x', kind: 'chat', sessionId: 'sess-rota', bypass: false }, { id: 't2', title: 'y', kind: 'chat', sessionId: 'mine', bypass: false }], windows: [] } as never;
    expect(rosterSummary(saved, { enabled: false, session: null }, () => false, new Set(['sess-rota'])).tabs).toBe(1);
  });

  it('summary members: owner and routine work only; superOnly; global; lastAt', () => {
    const s: SuperState = {
      ...emptySuperState(), session: 's', enabled: true, member: 'rota',
      children: {
        own: { sessionId: 'own', brief: '', adopted: false, startedAt: 10, row: 'working', workOrigin: 'owner' },
        mainKid: { sessionId: 'mainKid', brief: '', adopted: false, startedAt: 20, row: 'working', workOrigin: 'main:q-r-0000000r' },
      },
      queue: [{ id: 'q-r-0000000r', sessionId: 's', kind: 'request', state: 'delivered', createdAt: 30, text: 'x' }] as SuperQueueItem[],
    };
    const both = summarizeMember('rota', s, { global: true, enabled: true, approval: false }, () => true);
    expect(both).toMatchObject({ slug: 'rota', global: true, ownerWorking: 1, superOnly: false, lastAt: 30 });
    const onlyMain = summarizeMember('rota', { ...s, children: { mainKid: s.children.mainKid } }, { global: false, enabled: true, approval: true }, () => true);
    expect(onlyMain).toMatchObject({ ownerWorking: 0, superOnly: true, approval: true, asking: false, unread: 0 });
  });

  it('a member child doing main\'s work asks a permission: it still reaches the owner (D7)', () => {
    const s: SuperState = {
      ...emptySuperState(), session: 's', enabled: true, member: 'rota',
      children: { mainKid: { sessionId: 'mainKid', brief: '', adopted: false, startedAt: 20, row: 'asking', workOrigin: 'main:q-r-0000000r' } },
      queue: [
        { id: 'q-r-0000000r', sessionId: 's', kind: 'request', state: 'delivered', createdAt: 30, text: 'x' },
        { id: 'q-mq-0000000q', sessionId: 'mainKid', kind: 'question', requestId: 'r-q', state: 'pending', createdAt: 35 },
        { id: 'q-mp-0000000p', sessionId: 'mainKid', kind: 'permission', requestId: 'r-p', state: 'pending', createdAt: 40 },
      ] as SuperQueueItem[],
    };
    expect(superQueueHead(s)?.id).toBe('q-mp-0000000p');
    expect(summarizeMember('rota', s, { global: false, enabled: true, approval: false }, () => true)).toMatchObject({ asking: true, superOnly: false });
    // Its question stays main's; a permission its Super decides first is not his yet.
    const superFirst = { ...s, queue: s.queue.map((q) => (q.kind === 'permission' ? { ...q, toSuper: true as const } : q)) };
    expect(superQueueHead(superFirst)).toBeNull();
    expect(summarizeMember('rota', superFirst, { global: false, enabled: true, approval: false }, () => true).asking).toBe(false);
  });

  it('summary members[].pending: request and reply items still pending, nothing else; owner counts unchanged', () => {
    const item = (id: string, kind: SuperQueueItem['kind'], state: SuperQueueItem['state'], extra: Partial<SuperQueueItem> = {}) =>
      ({ id, sessionId: 's', kind, state, createdAt: 5, text: 'x', ...extra }) as SuperQueueItem;
    const s: SuperState = {
      ...emptySuperState(), session: 's', enabled: true, member: 'rota',
      queue: [
        item('q-req-pend-0001', 'request', 'pending'),
        item('q-req-pend-0002', 'request', 'pending'),
        item('q-req-dlvr-0003', 'request', 'delivered'),
        item('q-req-done-0004', 'request', 'done'),
        item('q-rep-pend-0005', 'reply', 'pending'),
        item('q-rep-done-0006', 'reply', 'done'),
        // Pending, but not main's work waiting for the member's Super: never counted.
        item('q-ask-pend-0007', 'ask', 'pending', { workOrigin: 'main:q-req-dlvr-0003' }),
        item('q-don-pend-0008', 'done', 'pending'),
      ],
    };
    const m = summarizeMember('rota', s, { global: false, enabled: true, approval: false }, () => true);
    expect(m.pending).toBe(3);
    // The owner-facing facts are those of the same record without its pending items.
    const without = summarizeMember('rota', { ...s, queue: s.queue.filter((q) => !((q.kind === 'request' || q.kind === 'reply') && q.state === 'pending')) },
      { global: false, enabled: true, approval: false }, () => true);
    expect({ ...m, pending: 0, lastAt: 0 }).toEqual({ ...without, pending: 0, lastAt: 0 });
    // No record yet: nothing waits.
    expect(summarizeMember('rota', null, { global: false, enabled: true, approval: false }).pending).toBe(0);
    // The phone's row carries the owner-facing facts only.
    expect(Object.keys(phoneMemberRow(m)).sort()).toEqual(['approval', 'asking', 'enabled', 'global', 'lastAt', 'ownerWorking', 'slug', 'superOnly', 'unread']);
  });

  it('summary members[].pending follows a real team ask: 1 while it waits for the member\'s Super, 0 once delivered', async () => {
    const { session } = await askRota();
    const before = (await memberSummaries(root)).find((x) => x.slug === 'rota');
    expect(before?.pending).toBe(1);
    // A request is main's work: no owner-facing count for it.
    expect(before).toMatchObject({ ownerWorking: 0, asking: false, unread: 0 });
    expect((await memberSummaries(root)).find((x) => x.slug === 'mira')?.pending).toBe(0);
    idle(session);
    const { inbox, delivered } = fakeInbox(session);
    attachSuperInbox(inbox);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    await vi.waitFor(async () => expect((await memberSummaries(root)).find((x) => x.slug === 'rota')?.pending).toBe(0), W);
  });

  it('a crewTicket ties the FIRST child to exactly its member (consumed once); main\'s delegate frame-free children unchanged', () => {
    // Nothing in flight, no ticket, no hint: exactly as before.
    expect(memberCrewDecision({ conversation: 'main-kid', contextRoot: root })).toEqual({ mark: null, cap: [] });
    const ticket = mintCrewTicket(root, 'm:rota', 'q-job-00000001');
    expect(memberCrewDecision({ conversation: 'new-kid', ticket, contextRoot: root })).toEqual({ mark: 'rota', cap: ['rota'] });
    // Replayed: ties nothing (and with nothing in flight, nothing is marked).
    expect(memberCrewDecision({ conversation: 'new-kid-2', ticket, contextRoot: root })).toEqual({ mark: null, cap: [] });
    // Forged: ties nothing either.
    expect(memberCrewDecision({ conversation: 'new-kid-3', ticket: 'f'.repeat(36), contextRoot: root }).mark).toBeNull();
    // A ticket of another vault ties nothing here.
    const elsewhere = mintCrewTicket(join(dir, 'other', '_dream_context'), 'm:rota', 'q-job-00000002');
    expect(memberCrewDecision({ conversation: 'x', ticket: elsewhere, contextRoot: root }).mark).toBeNull();
  });

  it('main and a member delegating at once: main\'s child (its exact tie is its record) never gets a member mark; an untied one fails CLOSED', async () => {
    noteDelegating(superKey(root), 1);
    noteDelegating(superKey(root, 'm:rota'), 1);
    // Main's child, once its record names it: none, whatever is in flight.
    await withSuperState(root, 'main', (s) => { s.children['main-kid'] = { sessionId: 'main-kid', brief: 'x', adopted: false, startedAt: Date.now() }; });
    expect(memberCrewDecision({ conversation: 'main-kid', contextRoot: root })).toEqual({ mark: null, cap: [] });
    // A first spawn with no ticket while a member delegates: marked (never as one member), capped.
    expect(memberCrewDecision({ conversation: 'unknown-kid', contextRoot: root })).toEqual({ mark: '*', cap: ['rota'] });
    // With the member's ticket: exactly that member.
    const ticket = mintCrewTicket(root, 'm:rota', 'q-job-00000003');
    expect(memberCrewDecision({ conversation: 'rota-kid', ticket, contextRoot: root })).toEqual({ mark: 'rota', cap: ['rota'] });
    noteDelegating(superKey(root), -1);
    noteDelegating(superKey(root, 'm:rota'), -1);
  });

  it('two members in flight, no ticket: the ambiguous mark, capped at the NARROWEST of their levels; a URL hint only narrows', () => {
    createAgent(root, { slug: 'asker', title: 'Asker', prompt: 'You ask first.', autonomy: 'ask' }, { approve: { now: new Date() } });
    noteDelegating(superKey(root, 'm:rota'), 1);
    noteDelegating(superKey(root, 'm:asker'), 1);
    const d = memberCrewDecision({ conversation: 'new-kid', contextRoot: root });
    expect(d.mark).toBe('*');
    expect([...d.cap].sort()).toEqual(['asker', 'rota']);
    // Rota alone runs at its own (balanced: auto); with Asker in the tie the child gets ask (default).
    expect(memberCrewPermissionMode(root, ['rota'], true)).toBe('auto');
    expect(memberCrewPermissionMode(root, [d.mark as string, ...d.cap], true)).toBe('default');
    noteDelegating(superKey(root, 'm:rota'), -1);
    noteDelegating(superKey(root, 'm:asker'), -1);
    // A hint alone, nothing in flight: it narrows (marked, capped at that member), never names it.
    expect(memberCrewDecision({ conversation: 'x', hint: 'asker', contextRoot: root })).toEqual({ mark: '*', cap: ['asker'] });
    expect(memberCrewOf('x', null, root)).toBeNull();
    expect(memberCrewCandidates('x', root)).toEqual([]);
  });

  it('a member\'s child on a bridge tool runs at the member\'s level: Codex default for Ask, Antigravity refused below Free', () => {
    expect(crewBridgeMode('codex', 'default')).toBe('default');
    expect(crewBridgeMode('codex', 'auto')).toBe('auto');
    expect(crewBridgeMode('antigravity', 'auto')).toBeNull();
    expect(crewBridgeMode('antigravity', 'bypassPermissions')).not.toBeNull();
    expect(crewToolRefusal('antigravity', 'auto')).toMatch(/no mode as narrow/);
    expect(crewToolRefusal('codex', 'default')).toBeNull();
    expect(crewToolRefusal(undefined, 'default')).toBeNull();
  });

  it('a member\'s delegate on Antigravity is refused 409 before anything starts (Rota is balanced)', async () => {
    const { session } = await askRota();
    const r = await verb(tokenFor(session, 'm:rota'), 'delegate', { prompt: 'do it', brief: 'x', tool: 'antigravity' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('tool_too_wide');
  });
});

describe('owner routes take ?superId', () => {
  const ownerGet = async (url: string, headers: Record<string, string> = {}) => {
    const r = res();
    await handleSuperStateGet(req(undefined, headers, url), r, {}, root);
    return r;
  };

  it('act on the member record with it, on main without it; unknown 404, malformed 400, a window token 403', async () => {
    const { session } = await askRota();
    expect((await ownerGet('/?superId=m%3Arota')).json.session).toBe(session);
    expect((await ownerGet('/')).json.session).toBe(MAIN);
    expect((await ownerGet('/?superId=m%3Aghost')).status).toBe(404);
    expect((await ownerGet('/?superId=m%3A..%2Fx')).status).toBe(400);
    expect((await ownerGet('/?superId=m%3Arota', { 'x-dreamcontext-window-token': tokenFor(session, 'm:rota') })).status).toBe(403);
  });

  it('owner-wins with a member superId: his size stands against the member Super\'s own shape', async () => {
    const { session } = await askRota();
    await writeSuper(root, 'm:rota', (s) => { s.containers.push({ id: 'web-aaaaaaaaaaaa', kind: 'web', ref: 'https://example.com/', shape: 'square', place: 'float' }); });
    const r = res();
    await handleSuperLayout(req({ cards: [{ id: 'web-aaaaaaaaaaaa', size: 'large' }] }, {}, '/?superId=m%3Arota'), r, {}, root);
    expect(r.status).toBe(200);
    expect((await rota()).containers.find((c) => c.id === 'web-aaaaaaaaaaaa')).toMatchObject({ size: 'large', sizeBy: 'owner' });
    // Main's record is untouched by a member's layout.
    expect((await main()).containers.some((c) => c.id === 'web-aaaaaaaaaaaa')).toBe(false);
    const shaped = await verb(tokenFor(session, 'm:rota'), 'shape', { container: 'web-aaaaaaaaaaaa', shape: 'small' });
    expect(shaped.status).toBe(409);
    expect((await rota()).containers.find((c) => c.id === 'web-aaaaaaaaaaaa')?.size).toBe('large');
  });
});

describe('end review (Wave 2)', () => {
  it('1: an escalated main:* CHILD question never holds the member\'s pump, and is never escalated to the owner', async () => {
    const { request, job, session } = await askRota();
    await writeSuper(root, 'm:rota', (s) => {
      s.children['kid-q'] = { sessionId: 'kid-q', brief: 'x', adopted: false, startedAt: Date.now(), row: 'asking', workOrigin: `main:${request}` };
      s.queue.push({ id: 'q-esc-0000000e', sessionId: 'kid-q', kind: 'question', state: 'escalated', createdAt: 1, ownerText: 'which?' });
    });
    const m = await rota();
    expect(ownerQuestionOpen(m)).toBe(false);
    expect(superQueueHead(m)?.id).not.toBe('q-esc-0000000e');
    // The child keeps asking: the member's Super is told twice, then main hears it (never the owner).
    await writeSuper(root, 'm:rota', (s) => { s.queue = s.queue.filter((q) => q.id !== 'q-esc-0000000e'); });
    const h = reg('kid-q');
    h.userSent('go');
    h.observe({ type: 'control_request', request_id: 'r-q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which depot?', options: [{ label: 'a' }, { label: 'b' }] }] } } });
    await vi.waitFor(async () => expect((await rota()).queue.some((q) => q.kind === 'question' && q.sessionId === 'kid-q')).toBe(true), W);
    idle(session);
    // Like the real bridge: busy from a delivered turn until that turn ends (one turn at a time).
    let busy = false;
    const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
    const { inbox } = fakeInbox(session, {
      idle: () => !busy,
      deliver: async (text, event) => { delivered.push({ text, event }); busy = true; return true; },
    });
    attachSuperInbox(inbox);
    for (let n = 1; n <= 3; n++) {
      await vi.waitFor(() => expect(delivered).toHaveLength(n), W);
      busy = false;
      superTurnEnded(session);
    }
    // The request went once; the main:* question came twice, then went to main.
    expect(delivered[0].event.items?.[0]?.kind).toBe('request');
    expect(delivered.filter((d) => d.event.items?.some((i) => i.kind === 'request'))).toHaveLength(1);
    await vi.waitFor(async () => expect((await main()).queue.filter((q) => q.team === job && q.partial && /asks about this job/.test(q.text ?? ''))).toHaveLength(1), W);
    const q = (await rota()).queue.find((x) => x.kind === 'question' && x.sessionId === 'kid-q');
    expect(q?.state).toBe('done');
  });

  it('2: turning a member off through POST /api/agents/:slug/enabled tells main once per open request, its card reads it, its children stop, its index entry stays', async () => {
    const { job, session } = await askRota();
    await writeSuper(root, 'm:rota', (s) => { s.children['kid-live'] = { sessionId: 'kid-live', brief: 'x', adopted: false, startedAt: Date.now() }; });
    const cuts: string[] = [];
    const live = (id: string): LiveChatEntry => {
      const e: LiveChatEntry = { conversationId: id, projectRoot: dir, busy: false, turnStartedAt: null, lastTurnEndedAt: null, adopt: () => false, supersede: () => () => undefined, cut: async () => { cuts.push(id); unregisterLiveChat(e); } };
      registerLiveChat(e);
      return e;
    };
    live(session);
    live('kid-live');
    const r = res();
    await handleAgentsSetEnabled(req({ enabled: false }, { origin: 'http://127.0.0.1:4173' }), r, { slug: 'rota' }, root);
    expect(r.status).toBe(200);
    expect(cuts.sort()).toEqual(['kid-live', session].sort());
    const s = await main();
    expect(s.queue.filter((q) => q.team === job && q.partial && /turned off/.test(q.text ?? ''))).toHaveLength(1);
    expect(superView(root, s).teamLive?.[job]?.status).toBe('failed');
    // The entry stays (enabled: false): a respawn of its child is still its crew.
    expect(memberCrewDecision({ conversation: 'kid-live', contextRoot: root }).mark).toBe('rota');
    // A later pump never tells main a second time.
    idle(session);
    attachSuperInbox(fakeInbox(session).inbox);
    await _superInboxDrained();
    expect((await main()).queue.filter((q) => q.team === job && q.partial)).toHaveLength(1);
  });

  it('3: Wave 3 flipped TEAM_ASK_ROUTE to the request route; the guide describes it as live', () => {
    expect(TEAM_ASK_ROUTE).toBe('request');
    const guide = readFileSync(new URL('../../skill/references/super-orchestration.md', import.meta.url), 'utf-8').replace(/\s+/g, ' ');
    expect(guide).not.toMatch(/after Wave 3|not live yet|Until then `team ask`/i);
    expect(guide).toContain('lands in the member\'s own Super as a request');
    expect(guide).toContain('`super team answer <item> "<answer>"`');
    expect(guide).toContain('`super team done`');
  });

  it('4: team done closes the member\'s asks to main about that request and main\'s linked question; a later ask to main is free', async () => {
    const first = await askRota('one');
    const second = await askRota('two');
    const tok = tokenFor(first.session, 'm:rota');
    const asked = await verb(tok, 'ask', { text: 'Which depot?', for: first.request });
    const askId = (asked.json.result as { item: string }).item;
    expect((await verb(tok, 'team-done', { item: first.request, result: 'Done.' })).status).toBe(200);
    expect((await rota()).queue.find((q) => q.id === askId)?.state).toBe('done');
    expect((await main()).queue.filter((q) => q.kind === 'question' && q.team === first.job && q.state !== 'done')).toEqual([]);
    const again = await verb(tok, 'ask', { text: 'And this one?', for: second.request });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
  });

  it('5: trimming never drops a job whose request is still open', () => {
    const jobs = Array.from({ length: 35 }, (_, i) => ({
      id: `team-j${i}`, member: 'rota', runId: '2026-11-01T10:00:00.000Z', jobKind: 'run' as const, queued: false, brief: '', startedAt: 1000 - i,
      ...(i > 0 ? { followUpOf: 'team-j0', by: 'super' as const } : {}),
      ...(i === 34 ? { request: 'q-open-0000000a', open: true as const } : {}),
    }));
    const kept = trimTeamJobs(jobs, 30);
    expect(kept).toHaveLength(30);
    expect(kept.some((j) => j.id === 'team-j34')).toBe(true);
  });

  it('8: a member Super never adopts; main never adopts another super\'s chat; send to a chat another super holds is refused', async () => {
    const { session } = await askRota();
    const byMember = await verb(tokenFor(session, 'm:rota'), 'adopt', { chat: 'any-chat', force: true });
    expect(byMember.status).toBe(403);
    expect(byMember.json.error).toBe('main_only');
    await writeSuper(root, 'm:rota', (s) => { s.children['rota-kid'] = { sessionId: 'rota-kid', brief: 'x', adopted: false, startedAt: Date.now() }; });
    const byMain = await verb(tokenFor(MAIN), 'adopt', { chat: 'rota-kid', force: true });
    expect(byMain.status).toBe(409);
    expect(byMain.json.error).toBe('other_super');
    // A chat main holds that the member's record names too: the member may not write to it.
    await writeSuper(root, (s) => { s.children['shared-kid'] = { sessionId: 'shared-kid', brief: 'x', adopted: false, startedAt: Date.now() }; });
    await writeSuper(root, 'm:rota', (s) => { s.children['shared-kid'] = { sessionId: 'shared-kid', brief: 'x', adopted: false, startedAt: Date.now() }; });
    const send = await verb(tokenFor(session, 'm:rota'), 'send', { child: 'shared-kid', text: 'hi' });
    expect(send.status).toBe(409);
    expect(send.json.error).toBe('other_super');
  });

  it('6: a member\'s delegate frame carries a one-time crewTicket; main\'s frame carries none', async () => {
    const { session } = await askRota();
    const frames: Array<Record<string, unknown>> = [];
    const tok = (sessionId: string, superId?: 'm:rota') => {
      const minted = mintWindowToken({
        vault: 'acme', contextRoot: root, sessionId, mode: 'super', ...(superId ? { superId } : {}),
        send: (f: Record<string, unknown>) => { frames.push(f); setImmediate(() => deliverSuperResult(minted.token, f.id, { ok: false, error: 'refused' })); return true; },
      });
      return minted.token;
    };
    await verb(tok(session, 'm:rota'), 'delegate', { prompt: 'do it', brief: 'x' });
    await verb(tok(MAIN), 'delegate', { prompt: 'do it', brief: 'x' });
    const [memberFrame, mainFrame] = frames.filter((f) => f.verb === 'delegate');
    expect((memberFrame.args as Record<string, unknown>).crewTicket).toMatch(/^[0-9a-f]{36}$/);
    expect(Object.keys(mainFrame.args as Record<string, unknown>)).not.toContain('crewTicket');
    expect(Object.keys(mainFrame.args as Record<string, unknown>)).not.toContain('memberCrew');
    expect(mainFrame.superId).toBeUndefined();
    // The ticket ties exactly once.
    const t = (memberFrame.args as Record<string, string>).crewTicket;
    expect(memberCrewDecision({ conversation: 'k1', ticket: t, contextRoot: root }).mark).toBe('rota');
    expect(memberCrewDecision({ conversation: 'k2', ticket: t, contextRoot: root }).mark).toBeNull();
  });
});

describe('surum-0402 review (Wave 2 re-check)', () => {
  it('an unapproved member\'s level never widens a child, and its Super cannot delegate or resume', async () => {
    // Pera asks for Free but nobody approved it: its children run at the narrowest level.
    createAgent(root, { slug: 'pera', title: 'Pera', prompt: 'You price things.', autonomy: 'free' });
    expect(memberCrewPermissionMode(root, ['pera'], true)).toBe('default');
    // Rota is approved (balanced): its own level holds.
    expect(memberCrewPermissionMode(root, ['rota'], true)).toBe('auto');
    await writeSuper(root, 'm:pera', (s) => { s.session = 'sess-pera-1'; s.enabled = true; });
    const tok = tokenFor('sess-pera-1', 'm:pera');
    const d = await verb(tok, 'delegate', { prompt: 'do it', brief: 'x' });
    expect(d.status, JSON.stringify(d.json)).toBe(409);
    expect(d.json.error).toBe('member_not_ready');
    const r = await verb(tok, 'resume', { child: 'kid-none' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('member_not_ready');
  });

  it('a member\'s `super end` records the end in the member\'s own record, never main\'s', async () => {
    const { session } = await askRota();
    await writeSuper(root, 'm:rota', (s) => { s.children['kid-end'] = { sessionId: 'kid-end', brief: 'x', adopted: false, startedAt: Date.now() }; });
    const r = await verb(tokenFor(session, 'm:rota'), 'end', { child: 'kid-end' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await rota()).children['kid-end']?.endedAt).toBeTypeOf('number');
    expect((await main()).children['kid-end']).toBeUndefined();
  });
});

describe('review 2026-11-02: no window, a member\'s question to main, an off member\'s Super', () => {
  const memberKey = () => superKey(root, 'm:rota');
  const unstartedLines = async (job: string) => (await main()).queue.filter((q) => q.team === job && q.kind === 'done' && q.partial && /has not started this job/.test(q.text ?? ''));

  it('a request nothing started for 10 minutes (no live member Super) gives main ONE line and closes nothing', async () => {
    const { request, job } = await askRota();
    const born = (await rota()).queue.find((q) => q.id === request)!;
    // Before 10 minutes: nothing.
    checkQuietRequests(memberKey(), await rota(), born.createdAt + REQUEST_UNSTARTED_MS - 1);
    await _superInboxDrained();
    expect(await unstartedLines(job)).toHaveLength(0);
    // After: one line, naming why and when it starts.
    checkQuietRequests(memberKey(), await rota(), born.createdAt + REQUEST_UNSTARTED_MS + 1);
    await vi.waitFor(async () => expect(await unstartedLines(job)).toHaveLength(1), W);
    expect((await unstartedLines(job))[0].text).toBe('Rota has not started this job: no window is open to start its Super; it starts when the app shows the project.');
    // Once per request, and the request stays pending and open; main's job stays open.
    checkQuietRequests(memberKey(), await rota(), born.createdAt + 3 * REQUEST_UNSTARTED_MS);
    await _superInboxDrained();
    expect(await unstartedLines(job)).toHaveLength(1);
    expect((await rota()).queue.find((q) => q.id === request)).toMatchObject({ kind: 'request', state: 'pending' });
    expect((await main()).team.find((j) => j.id === job)?.open).toBe(true);
  });

  it('no line while a live chat holds the member\'s Super, for an accepted request, or for an off member', async () => {
    const { request, job, session } = await askRota();
    const born = (await rota()).queue.find((q) => q.id === request)!;
    const late = born.createdAt + REQUEST_UNSTARTED_MS + 1;
    reg(session, 'super');
    checkQuietRequests(memberKey(), await rota(), late);
    await _superInboxDrained();
    expect(await unstartedLines(job)).toHaveLength(0);
    _resetChatRegistry();
    // Accepted already: the 30-minute fallback's business, not this one.
    const accepted = await rota();
    accepted.queue = accepted.queue.map((q) => (q.id === request ? { ...q, acceptedAt: born.createdAt } : q));
    checkQuietRequests(memberKey(), accepted, late);
    await _superInboxDrained();
    expect(await unstartedLines(job)).toHaveLength(0);
    // An off member has its own line; this one would mislead.
    setMemberGateForTest(() => 'off');
    checkQuietRequests(memberKey(), await rota(), late);
    await _superInboxDrained();
    expect(await unstartedLines(job)).toHaveLength(0);
  });

  it('a member Super\'s question about main\'s request never makes main\'s event turn the owner\'s', async () => {
    const { request, job, session } = await askRota();
    idle(MAIN);
    const { inbox, delivered } = fakeInbox(MAIN);
    attachSuperInbox(inbox);
    const asked = await verb(tokenFor(session, 'm:rota'), 'ask', { text: 'Which depot?', for: request });
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    const q = (await main()).queue.find((x) => x.kind === 'question' && x.team === job)!;
    expect(isRequestQuestion(await main(), q)).toBe(true);
    await vi.waitFor(() => expect(delivered.some((d) => d.text.includes('from=member-super'))).toBe(true), W);
    await vi.waitFor(async () => expect((await main()).queue.find((x) => x.id === q.id)?.state).not.toBe('pending'), W);
    // Not folded into an owner-facing turn: no owner batch, so no unfolded turn and no owner unread.
    expect((await main()).ownerBatches ?? []).toEqual([]);
    // A headless (Wave 1) member's question is still the owner's.
    expect(isRequestQuestion({ team: [{ id: 'team-h', member: 'rota', runId: 'r', jobKind: 'run', queued: false, brief: '', startedAt: 1 }] },
      { id: 'q-h-00000001', sessionId: MAIN, kind: 'question', state: 'pending', createdAt: 1, team: 'team-h' } as SuperQueueItem)).toBe(false);
  });

  it('the upgrade gate refuses a member Super whose member is off or waits for its approval card', async () => {
    const { session } = await askRota();
    const gate = (sid: string, slug: string) => superUpgradeRefusal({ mode: 'super', phone: false, contextRoot: root, resumeId: sid, sessionId: '', chatAgent: slug });
    expect(gate(session, 'rota')).toBeNull();
    // Turned off by the owner (its manifest): refused even with its own session.
    setAgentCallEnabled(root, 'rota', false);
    expect(gate(session, 'rota')).toBe(409);
    setAgentCallEnabled(root, 'rota', true);
    expect(gate(session, 'rota')).toBeNull();
    // Its live Super stopped (the record says off): refused, no disk needed.
    await stopMemberSuper(root, 'rota');
    expect(gate(session, 'rota')).toBe(409);
    // A member waiting for its approval card: refused.
    createAgent(root, { slug: 'pera', title: 'Pera', prompt: 'You price things.' });
    const PERA = '77777777-6666-4555-8444-333333333333';
    await withSuperState(root, 'm:pera', (s) => { s.session = PERA; s.enabled = true; s.member = 'pera'; });
    expect(gate(PERA, 'pera')).toBe(409);
    // Main's own Super is unchanged by this.
    expect(superUpgradeRefusal({ mode: 'super', phone: false, contextRoot: root, resumeId: MAIN, sessionId: '' })).toBeNull();
  });
});
