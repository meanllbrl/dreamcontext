/**
 * An awaited job's result stands under the owner message that started it (owner 2026-10-30:
 * "bunun bittiğini neden cevap olarak almadın"). The Super gave a job with `super team ask` in
 * his turn; its done reached the Super in an event turn with no `<owner-msg>`, so the result
 * linked to nothing. Now:
 *
 *  - every owner message tells the server its ref (`noteSuperOwnerMsg`); an event turn drops it;
 *  - `team ask` and `delegate` in his turn record it as the job's `origin`, by themselves;
 *    `--origin <ref>` names it outside his turn (and makes the job his); a malformed one is refused;
 *  - the awaited=owner event line carries `origin=<ref>`, every result of the job the same ref;
 *  - the window links the event turn's `<!-- re:<ref> -->` answer under his message.
 * Fictional words throughout; HOME is a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-origin-home-`);
});

/** The say path's answer: no test here spawns a member. */
const say = vi.hoisted(() => ({ body: {} as Record<string, unknown> }));
vi.mock('../../src/server/routes/automations.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/routes/automations.js')>();
  return { ...real, sayToAgent: () => ({ ok: true, status: 200, body: say.body }) };
});
const settle = vi.hoisted(() => ({ runs: new Map<string, Promise<unknown>>() }));
vi.mock('../../src/server/automation-job.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/automation-job.js')>();
  return { ...real, whenRunSettles: (id: string) => (settle.runs.get(id) ?? null) as ReturnType<typeof real.whenRunSettles> };
});
/** The window opening a delegated child: answered here, with a fixed session id. */
vi.mock('../../src/lib/window-control.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/window-control.js')>();
  return {
    ...real,
    sendSuperCommand: async (...a: Parameters<typeof real.sendSuperCommand>) => (a[1] === 'delegate'
      ? { ok: true, result: { sessionId: 'child-orbit' } }
      : real.sendSuperCommand(...a)),
  };
});

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, msgRef, type SuperState } from '../../src/lib/super/types.js';
import { AWAITED_LINE, _resetSuperInbox, markSuperEventTurn, nextBatch, noteSuperOwnerMsg, superBatchText, superOwnerMsgRef } from '../../src/lib/super/inbox.js';
import { handleSuperVerb, setTeamAskRouteForTest } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { replyGroups } from '../../dashboard/src/components/sleepy/chat/replyLinks.js';
import { splitReplyMark } from '../../dashboard/src/lib/replyMark.js';
import type { ChatItem } from '../../dashboard/src/components/sleepy/chatSession.js';
import { SUPER_BRIEF_TEXT, superBriefing } from '../../src/server/chat-modes.js';

let dir: string;
let root: string;
let token = '';
const SUPER = 'sup-1';
const RUN = '2026-10-30T09:00:00.000Z';
const ASK = 'Go through the Orbit inbox and answer what is left unanswered';

// Wave 1's headless team-ask chain (it still serves in-flight jobs and the owner's thread reply):
// these tests drive it through `team ask`; Wave 2's request route is super-multi-*.test.ts.
beforeEach(() => { setTeamAskRouteForTest('say'); });
afterEach(() => { setTeamAskRouteForTest(null); });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-origin-')));
  settle.runs.clear();
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
  createAutomation(root, { slug: 'desk', title: 'Desk', days: 'daily', at: '09:00', prompt: 'go' });
});
afterEach(() => { markSuperEventTurn(SUPER, false); rmSync(dir, { recursive: true, force: true }); });

function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
async function verb(name: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const out = { status: 0, json: {} as Record<string, unknown> };
  const r = out as unknown as ServerResponse;
  (r as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (r as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  await handleSuperVerb(req(body), r, { verb: name });
  return out;
}
const stored = () => readSuperState(root);
const entry = (s: number, e: Parameters<typeof appendThreadEntry>[2]) => appendThreadEntry(root, 'desk', { ...e, now: new Date(Date.parse(RUN) + s * 1000) });
/** What agent-chat.ts writeOwnerTurn does for an owner message to the Super. */
const ownerWrites = (text: string) => { markSuperEventTurn(SUPER, false); noteSuperOwnerMsg(SUPER, msgRef(text)); };

describe('the server knows the owner message of the running turn', () => {
  it('set by his message, dropped when an event turn opens', () => {
    ownerWrites(ASK);
    expect(superOwnerMsgRef(SUPER)).toBe(msgRef(ASK));
    markSuperEventTurn(SUPER, true);
    expect(superOwnerMsgRef(SUPER)).toBeUndefined();
  });

  it('a slash command answers no message of his', () => {
    ownerWrites(ASK);
    noteSuperOwnerMsg(SUPER, null);
    expect(superOwnerMsgRef(SUPER)).toBeUndefined();
  });
});

describe('owner message → team ask → done event → the answer links to his message', () => {
  it('team ask in his turn records origin; its done line says awaited=owner origin=<ref>; the window links it', async () => {
    ownerWrites(ASK);
    const run = { resolve: (_: unknown) => {} };
    settle.runs.set('aj-1', new Promise((r) => { run.resolve = r; }));
    const asked = entry(1, { runId: RUN, kind: 'user', text: 'answer the inbox', via: 'super' });
    say.body = { job: { id: 'aj-1', kind: 'run' }, started: true, runId: RUN, entryId: asked.id };
    const out = await verb('team-ask', { member: 'desk', text: 'answer the inbox' });
    expect(out.status).toBe(200);
    expect((await stored()).team[0]).toMatchObject({ awaited: true, origin: msgRef(ASK) });

    // His turn ends; the job finishes while the next turn is an event turn (no <owner-msg> there).
    markSuperEventTurn(SUPER, true);
    entry(2, { runId: RUN, kind: 'agent', text: 'Answered 4 waiting messages.', via: 'cli' });
    entry(3, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await stored()).queue.filter((q) => q.team)).toHaveLength(1));
    const s = await stored();
    const { items } = nextBatch(s);
    const text = superBatchText(root, s, items, 'b-1');
    expect(text).toContain(`event=done awaited=owner origin=${msgRef(ASK)} status=`);
    expect(text).toContain(AWAITED_LINE);
    expect(AWAITED_LINE).toContain('open your text with `<!-- re:<ref> -->`');

    // The Super writes the result in that event turn, opening it with the ref the line gave.
    const answer = `<!-- re:${msgRef(ASK)} -->\nThe desk answered the 4 waiting messages.`;
    const mark = splitReplyMark(answer);
    expect(mark.refs).toEqual([msgRef(ASK)]);
    const owner: ChatItem = { kind: 'user', id: 'u1', text: ASK, ts: 1 };
    const ack: ChatItem = { kind: 'text', id: 't1', index: 0, text: 'Gave it to the desk.', done: true, ts: 2 };
    const later: ChatItem = { kind: 'user', id: 'u2', text: 'And the weekly numbers?', ts: 3 };
    const reply2: ChatItem = { kind: 'text', id: 't2', index: 0, text: 'Here they are.', done: true, ts: 4 };
    const ev: ChatItem = { kind: 'user', id: 'e1', text: text, ts: 5, superEvent: 'batch' };
    const res: ChatItem = { kind: 'text', id: 't3', index: 0, text: mark.body, done: true, ts: 6, replyTo: mark.refs };
    const m = replyGroups([owner, ack, later, reply2, ev, res]);
    expect(m.get('t3')).toMatchObject({ targets: ['u1'], strip: true });
  });

  it('a team ask in an event turn has no origin; --origin names his message and makes it his; a malformed one is refused', async () => {
    say.body = { job: { id: 'aj-2', kind: 'run' }, started: true, runId: RUN, entryId: 'e-2' };
    ownerWrites(ASK);
    markSuperEventTurn(SUPER, true);
    expect((await verb('team-ask', { member: 'desk', text: 'x' })).status).toBe(200);
    const first = (await stored()).team[0];
    expect(first.awaited).toBeUndefined();
    expect(first.origin).toBeUndefined();

    say.body = { job: { id: 'aj-3', kind: 'run' }, started: true, runId: RUN, entryId: 'e-3' };
    expect((await verb('team-ask', { member: 'desk', text: 'y', origin: msgRef(ASK) })).status).toBe(200);
    expect((await stored()).team.find((j) => j.id !== first.id)).toMatchObject({ awaited: true, origin: msgRef(ASK) });

    const bad = await verb('team-ask', { member: 'desk', text: 'z', origin: 'NOT A REF' });
    expect(bad.status).toBe(400);
    expect((await stored()).team).toHaveLength(2);
  });
});

describe('delegate records the origin too, and every result of one job links to the same message', () => {
  it('delegate in his turn: the child carries origin; its done and its later stuck both say it', async () => {
    ownerWrites(ASK);
    const out = await verb('delegate', { prompt: 'Answer the Orbit inbox', brief: 'Orbit inbox', mode: 'basic' });
    expect(out.status).toBe(200);
    const s = await stored();
    expect(s.children['child-orbit']).toMatchObject({ awaited: true, origin: msgRef(ASK) });

    // Two results of the same job, in two event turns: both lines carry the same origin.
    const done: SuperState = { ...s, children: { 'child-orbit': { ...s.children['child-orbit'], row: 'done' } },
      queue: [{ id: 'q-1', sessionId: 'child-orbit', kind: 'done', state: 'pending', createdAt: 1 }] };
    const stuck: SuperState = { ...s, children: { 'child-orbit': { ...s.children['child-orbit'], row: 'stuck' } },
      queue: [{ id: 'q-2', sessionId: 'child-orbit', kind: 'stuck', state: 'pending', createdAt: 2 }] };
    for (const st of [done, stuck]) {
      expect(superBatchText(root, st, st.queue, 'b')).toContain(`awaited=owner origin=${msgRef(ASK)} status=`);
    }

    // The window: two event-turn answers, both opening with that ref, both under his message.
    const owner: ChatItem = { kind: 'user', id: 'u1', text: ASK, ts: 1 };
    const other: ChatItem = { kind: 'user', id: 'u2', text: 'Something else', ts: 2 };
    const ans: ChatItem = { kind: 'text', id: 't0', index: 0, text: 'On it.', done: true, ts: 3 };
    const items: ChatItem[] = [owner, other, ans];
    for (const n of [1, 2]) {
      const mark = splitReplyMark(`<!-- re:${msgRef(ASK)} -->\nResult ${n}.`);
      items.push({ kind: 'user', id: `e${n}`, text: '[super events] batch=b items=1', ts: 3 + n, superEvent: 'batch' });
      items.push({ kind: 'text', id: `r${n}`, index: 0, text: mark.body, done: true, ts: 4 + n, replyTo: mark.refs });
    }
    const m = replyGroups(items);
    expect(m.get('r1')).toMatchObject({ targets: ['u1'], strip: true });
    expect(m.get('r2')).toMatchObject({ targets: ['u1'], strip: true });
  });

  it('delegate in an event turn has none; --origin gives it one', async () => {
    ownerWrites(ASK);
    markSuperEventTurn(SUPER, true);
    expect((await verb('delegate', { prompt: 'Answer the Orbit inbox', mode: 'basic' })).status).toBe(200);
    expect((await stored()).children['child-orbit'].origin).toBeUndefined();
    expect((await stored()).children['child-orbit'].awaited).toBeUndefined();
    expect((await verb('delegate', { prompt: 'Answer it again', mode: 'basic', origin: 'nope' })).status).toBe(400);
  });
});

describe('the record and the briefing', () => {
  it('origin is kept only as a message ref', () => {
    const s = sanitizeSuperState({
      ...emptySuperState(), session: SUPER,
      children: { a: { sessionId: 'a', brief: '', adopted: false, startedAt: 1, awaited: true, origin: 'abc123' }, b: { sessionId: 'b', brief: '', adopted: false, startedAt: 1, origin: '<!-- x' } },
      team: [
        { id: 'team-abc', member: 'desk', runId: RUN, jobKind: 'run', queued: false, brief: '', startedAt: 1, origin: 'zz99aa' },
        { id: 'team-def', member: 'desk', runId: RUN, jobKind: 'run', queued: false, brief: '', startedAt: 2, origin: 'TOOLONGREF' },
      ],
    } as unknown as SuperState);
    expect(s.children.a.origin).toBe('abc123');
    expect(s.children.b.origin).toBeUndefined();
    expect(s.team.find((j) => j.id === 'team-abc')?.origin).toBe('zz99aa');
    expect(s.team.find((j) => j.id === 'team-def')?.origin).toBeUndefined();
  });

  it('the events rule (rev 17): an awaited=owner result with origin opens with its re: mark', () => {
    for (const t of [superBriefing(), SUPER_BRIEF_TEXT]) {
      expect(t).toContain('with `origin=<ref>` (his message that asked for it), open each\n  result with `<!-- re:<ref> -->`.');
    }
  });
});
