/**
 * A Super's OWN session produces items (uye-bildirim K1, plan criterion 2).
 *
 * A member Super's own AskUserQuestion, tool permission, owner card and refused call each become
 * an item of its own record (no child row needed, born `escalated`: never an event to itself) and a
 * `member` mirror in main's queue; the item closes when the request resolves and when the session
 * is replaced. Main's own refusal is an item born `escalated`, with no event to main itself; main's
 * own question and permission prompts stay as they were (no item).
 *
 * Through the REAL registry, inbox and Super verbs, in a scratch HOME and vault.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-owner-wait-home-`);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, nextBatch, ownerItems, setGrantEnvForTest, setMemberGateForTest, syncOwnDraft, wireSuperInbox, writeSuper,
} from '../../src/lib/super/inbox.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { handleSuperVerb, setTeamAskRouteForTest } from '../../src/server/routes/super.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { _resetDelegating } from '../../src/lib/super/delegating.js';
import { _resetOwnerQuestions } from '../../src/lib/super/owner-question.js';
import type { Resolver } from '../../src/lib/grants/eligible.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-own-1';

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

/** A resolver with a `node` outside the project and every file a regular one: a pure stand-in. */
const RESOLVER: Resolver = {
  which: (n) => (n === 'node' ? '/opt/fakebin/node' : null),
  realpath: (p) => p,
  isRegularFile: () => true,
  sha256: () => 'a'.repeat(64),
};

async function rotaSession(): Promise<string> {
  const r = await verb(tokenFor(MAIN), 'team-ask', { member: 'rota', text: 'Build the funnel report.', brief: 'report' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (await rota()).session as string;
}

function crew(sessionId: string, mode = 'auto'): ChatHandle {
  const h = registerChat({ sessionId, conversationId: null, vault: 'acme', mode: 'super', crew: true, permissionMode: mode });
  h.userSent('go');
  return h;
}

/** One refused Bash call in a turn (a classifier block, the synthetic shape W4 pins). */
function refuse(h: ChatHandle, command: string, id = 'toolu_r1'): void {
  h.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  h.observe({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: id, decision_reason_type: 'classifier', message: 'The safety check blocked it.' });
  h.observe({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'blocked' }] },
    tool_result_meta: [{ id, non_execution_kind: 'automode-blocked', permission_decision: { decision: 'reject', source: 'classifier', reason_type: 'classifier' } }],
  });
  h.observe({ type: 'result', subtype: 'success', is_error: false });
}

beforeEach(() => {
  setTeamAskRouteForTest('request');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-owner-wait-')));
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
  rmSync(dir, { recursive: true, force: true });
});

describe('a member Super\'s own requests are items of its own record, mirrored into main', () => {
  it('its own permission: an own item born escalated (no child row), with its offer, and a mirror', async () => {
    const session = await rotaSession();
    const h = crew(session, 'default');
    h.observe({ type: 'control_request', request_id: 'req-own-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'node scripts/report.mjs' }, tool_use_id: 'toolu_p1' } });
    await _superInboxDrained();
    const s = await rota();
    const own = s.queue.find((q) => q.own && q.kind === 'permission');
    expect(own).toMatchObject({ requestId: 'req-own-1', state: 'escalated', sessionId: session });
    expect(s.children[session]).toBeUndefined();
    expect(own?.offer?.sizes).toEqual(['once', 'job', 'member']);
    // Never an event to itself: the member's own pump has nothing to carry for it.
    expect(nextBatch(s).items.map((q) => q.id)).not.toContain(own?.id);
    const m = (await mirrors()).find((x) => x.answers === own?.id);
    expect(m).toMatchObject({ of: 'permission', state: 'pending', member: 'rota', requestId: 'req-own-1' });
    expect(m?.offer?.sizes).toEqual(['once', 'job', 'member']);
    // The item and its mirror carry the whole call: the bar draws the command, not an Open button.
    expect(own?.call).toEqual({ tool: 'Bash', input: 'node scripts/report.mjs', whole: true });
    expect(m?.call).toEqual({ tool: 'Bash', input: 'node scripts/report.mjs', whole: true });
    // The request resolves: the item and its mirror close.
    h.answered('req-own-1');
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === own?.id)?.state).toBe('done');
    expect((await mirrors()).find((x) => x.answers === own?.id)?.state).toBe('done');
  });

  it('its own question: a direct own question, mirrored as `question`', async () => {
    const session = await rotaSession();
    const h = crew(session, 'default');
    h.observe({
      type: 'control_request', request_id: 'req-own-q', request: {
        subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q1',
        input: { questions: [{ question: 'Which depot first?', options: [{ label: 'North' }, { label: 'South' }] }] },
      },
    });
    await _superInboxDrained();
    const own = (await rota()).queue.find((q) => q.own && q.kind === 'question');
    expect(own).toMatchObject({ direct: true, state: 'escalated', requestId: 'req-own-q' });
    expect((await mirrors()).find((x) => x.answers === own?.id)?.of).toBe('question');
  });

  it('its own owner card and its own refused call: own owner items, mirrored as `owner`', async () => {
    const session = await rotaSession();
    const h = crew(session);
    h.observe({ type: 'assistant', message: { content: [{ type: 'text', text: '```dream-view\n{"type":"run","id":"gh-login","command":"gh auth login","why":"sign in to GitHub"}\n```' }] } });
    refuse(h, 'node scripts/report.mjs');
    await _superInboxDrained();
    const items = (await rota()).queue.filter((q) => q.own && q.kind === 'owner');
    expect(items.map((q) => q.wait?.kind).sort()).toEqual(['refusal', 'run']);
    const refusal = items.find((q) => q.wait?.kind === 'refusal');
    expect(refusal?.state).toBe('escalated');
    expect(refusal?.wait?.refusal).toMatchObject({ tool: 'Bash', input: 'node scripts/report.mjs', whole: true, source: 'classifier' });
    // The pinned script's sha is read when the refusal is born (a once grant pins what he saw).
    expect(refusal?.wait?.refusal?.scriptSha).toBeTruthy();
    // A classifier category nobody measured is Allow once only (SAFE_CATEGORIES is empty) when
    // given; with none, the script form takes every size.
    expect(refusal?.offer?.sizes[0]).toBe('once');
    const ofs = (await mirrors()).filter((m) => items.some((q) => q.id === m.answers)).map((m) => m.of);
    expect(ofs).toEqual(['owner', 'owner']);
    // The refusal's mirror carries its wait, refused call included, and its offer.
    const rm = (await mirrors()).find((m) => m.answers === refusal?.id);
    expect(rm?.wait).toMatchObject({ kind: 'refusal', id: refusal?.wait?.id, refusal: { tool: 'Bash', input: 'node scripts/report.mjs', whole: true, source: 'classifier' } });
    expect(rm?.offer).toEqual(refusal?.offer);
    // The card's mirror carries its wait too (it is drawn as Open, never as an Allow).
    expect((await mirrors()).find((m) => m.answers === items.find((q) => q.wait?.kind === 'run')?.id)?.wait?.kind).toBe('run');
    expect(ownerItems(await rota()).map((q) => q.id)).toEqual(expect.arrayContaining(items.map((q) => q.id)));
  });

  it('a replaced session closes every own item of the old one', async () => {
    const session = await rotaSession();
    const h = crew(session);
    refuse(h, 'node scripts/report.mjs');
    await _superInboxDrained();
    expect((await rota()).queue.some((q) => q.own && q.state !== 'done')).toBe(true);
    await writeSuper(root, 'm:rota', (s) => { s.session = 'sess-rota-next'; });
    await writeSuper(root, 'm:rota', (s) => { syncOwnDraft(s, 'm:rota', 'sess-rota-next', null, Date.now()); });
    await _superInboxDrained();
    expect((await rota()).queue.filter((q) => q.own).every((q) => q.state === 'done')).toBe(true);
  });
});

describe('main\'s own session', () => {
  it('a refused call of main itself: an own item born escalated, no event to main', async () => {
    await writeSuper(root, (s) => { s.enabled = true; });
    const h = crew(MAIN);
    refuse(h, 'node scripts/deploy-check.mjs', 'toolu_m1');
    await _superInboxDrained();
    const s = await main();
    const own = s.queue.find((q) => q.own && q.kind === 'owner');
    expect(own).toMatchObject({ state: 'escalated', sessionId: MAIN, wait: { kind: 'refusal' } });
    // Main's own crew has no member: never a member size.
    expect(own?.offer?.sizes).not.toContain('member');
    expect(nextBatch(s).items.map((q) => q.id)).not.toContain(own?.id);
    expect(ownerItems(s).map((q) => q.id)).toContain(own?.id);
  });

  it('main\'s own question and permission prompts stay as they were: no item', async () => {
    await writeSuper(root, (s) => { s.enabled = true; });
    const h = crew(MAIN, 'default');
    h.observe({ type: 'control_request', request_id: 'req-main-p', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_mp' } });
    await _superInboxDrained();
    expect((await main()).queue.filter((q) => q.own)).toEqual([]);
  });
});
