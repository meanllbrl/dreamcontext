/**
 * A member that stops on main's job without closing it or asking (uye-bildirim K6, criterion 8).
 *
 *  - one row per "not stalled" condition (`notStalledReason`);
 *  - a turn with a refusal produces the refusal item and no nudge;
 *  - the first silent end: ONE server nudge (a `nudge` item, never mirrored, never counted);
 *  - a second silent end after the nudge went in: a `stalled` own item with its last sentence, and
 *    its mirror tells main at once; never raised again without new progress;
 *  - a nudge undeliverable for two minutes: the stalled item.
 *
 * Real registry, inbox and verbs, scratch HOME and vault.
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
import { _resetChatRegistry, registerChat, type ChatEntry, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import {
  NUDGE_UNDELIVERED_MS, _resetSuperInbox, _superInboxDrained, notStalledReason, ownerItems, setGrantEnvForTest, setMemberGateForTest, superTurnEnded, wireSuperInbox, writeSuper,
} from '../../src/lib/super/inbox.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { summarizeMember } from '../../src/lib/super/member-summary.js';
import { handleSuperVerb, setTeamAskRouteForTest } from '../../src/server/routes/super.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { _resetDelegating } from '../../src/lib/super/delegating.js';
import { _resetOwnerQuestions } from '../../src/lib/super/owner-question.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-stall-1';

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
const tokenFor = (sessionId: string) => mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId, mode: 'super' }).token;
const main = () => readSuperState(root);
const rota = () => readSuperState(root, 'm:rota');

/** Main's job, accepted by Rota (its turn carried it); Rota's Super session as a crew chat. */
async function rotaOnTheJob(): Promise<{ session: string; request: string; h: ChatHandle }> {
  const r = res();
  await handleSuperVerb(req({ member: 'rota', text: 'Build the funnel report.', brief: 'report' }, { 'x-dreamcontext-window-token': tokenFor(MAIN) }), r, { verb: 'team-ask' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const s0 = await rota();
  const request = s0.queue.find((q) => q.kind === 'request')?.id as string;
  await writeSuper(root, 'm:rota', (s) => { const q = s.queue.find((x) => x.id === request); if (q) { q.state = 'delivered'; q.acceptedAt = Date.now(); } });
  const h = registerChat({ sessionId: s0.session as string, conversationId: null, vault: 'acme', mode: 'super', crew: true, permissionMode: 'auto' });
  return { session: s0.session as string, request, h };
}

/** A turn that ends in prose: no tool, nothing closed, nothing asked. */
async function silentTurn(h: ChatHandle, session: string, text = 'I looked at the numbers. The owner must decide which funnel goes first.'): Promise<void> {
  h.userSent('go on');
  h.observe({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  h.observe({ type: 'result', subtype: 'success', is_error: false });
  superTurnEnded(session);
  await new Promise((r) => setTimeout(r, 5));
  await _superInboxDrained();
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
  wireSuperInbox();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true }));
  createAgent(root, { slug: 'rota', title: 'Rota Planner', prompt: 'You keep the routes.' }, { approve: { now: new Date() } });
});
afterEach(async () => {
  vi.useRealTimers();
  await _superInboxDrained();
  setTeamAskRouteForTest(null);
  setMemberGateForTest(null);
  setGrantEnvForTest({ resolver: null, roots: null });
  rmSync(dir, { recursive: true, force: true });
});

describe('notStalledReason: one row per condition that is no silent stop', () => {
  const base = (): SuperState => ({
    ...emptySuperState(), enabled: true, session: 'sess-m', member: 'rota',
    queue: [{ id: 'q-req-1', sessionId: 'sess-m', kind: 'request', state: 'delivered', createdAt: 1, acceptedAt: 2, text: 'job' }],
  });
  const idle = (over: Partial<ChatEntry> = {}): ChatEntry => ({
    sessionId: 'sess-m', conversationId: null, vault: 'acme', mode: 'super', title: '', status: 'idle', lastAssistantText: ['done.'], pendingQuestion: null,
    updatedAt: new Date().toISOString(), lastFrameAt: new Date().toISOString(), toolsInFlight: 0,
    lastTurn: { endedAt: new Date().toISOString(), interrupted: false, resultSeq: 1 }, ...over,
  });
  const rows: Array<[string, (s: SuperState) => void, Partial<ChatEntry>]> = [
    ['not a member Super', (s) => { delete s.member; }, {}],
    ['no accepted request from main', (s) => { delete s.queue[0].acceptedAt; }, {}],
    ['its turn has not ended', () => {}, { status: 'working' }],
    ['interrupted', () => {}, { lastTurn: { endedAt: '', interrupted: true, resultSeq: 1 } }],
    ['a usage limit switch', () => {}, { lastTurn: { endedAt: '', interrupted: false, resultSeq: 1, limited: true } }],
    ['a background job still runs', () => {}, { backgroundTasks: 1, backgroundJobs: 1, backgroundAt: new Date().toISOString() }],
    ['it waits on the owner', () => {}, { ownerWaits: [{ kind: 'run', id: 'gh', line: 'sign in' }] }],
    ['it asked', (s) => { s.queue.push({ id: 'q-ask-1', sessionId: 'sess-m', kind: 'ask', state: 'escalated', createdAt: 3, ownerText: 'Which?' }); }, {}],
    ['a schedule of its own is pending', (s) => { s.queue.push({ id: 'q-sch-1', sessionId: 'sess-m', kind: 'schedule', state: 'pending', createdAt: 3, automation: 'nightly', fire: new Date().toISOString() }); }, {}],
  ];
  for (const [why, edit, over] of rows) {
    it(why, () => {
      const s = base();
      edit(s);
      expect(notStalledReason(s, idle(over))).toBe(why);
    });
  }
});

describe('the nudge, then the owner', () => {
  it('first silent end: one nudge (never mirrored); second: a stalled own item that main hears; never twice', async () => {
    const { session, request, h } = await rotaOnTheJob();
    await silentTurn(h, session);
    let s = await rota();
    const nudges = s.queue.filter((q) => q.kind === 'nudge');
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({ workOrigin: `main:${request}` });
    expect(ownerItems(s).some((q) => q.kind === 'nudge')).toBe(false);
    expect((await main()).queue.some((q) => q.kind === 'member' && q.answers === nudges[0].id)).toBe(false);
    // The nudge went in (the pump would mark it); its turn ends silent again.
    await writeSuper(root, 'm:rota', (d) => { const q = d.queue.find((x) => x.kind === 'nudge'); if (q) q.state = 'delivered'; });
    await silentTurn(h, session);
    s = await rota();
    const stalled = s.queue.filter((q) => q.own && q.wait?.kind === 'stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].ownerText).toContain('The owner must decide which funnel goes first.');
    const mirror = (await main()).queue.find((q) => q.kind === 'member' && q.answers === stalled[0].id);
    expect(mirror).toMatchObject({ of: 'owner', state: 'pending' });
    // Same words again, no new progress: no second item.
    await silentTurn(h, session);
    expect((await rota()).queue.filter((q) => q.own && q.wait?.kind === 'stalled')).toHaveLength(1);
    // It works again: the stall closes.
    h.userSent('owner: go on');
    await _superInboxDrained();
    expect((await rota()).queue.find((q) => q.id === stalled[0].id)?.state).toBe('done');
  });

  it('a turn that ends with a refusal: the refusal item, and no nudge', async () => {
    const { session, h } = await rotaOnTheJob();
    h.userSent('go on');
    h.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Bash', input: { command: 'node scripts/report.mjs' } }] } });
    h.observe({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', is_error: true, content: 'blocked' }] },
      tool_result_meta: [{ id: 'toolu_s1', permission_decision: { decision: 'reject', source: 'classifier', reason_type: 'classifier' } }],
    });
    h.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'The safety check refused it.' }] } });
    h.observe({ type: 'result', subtype: 'success', is_error: false });
    superTurnEnded(session);
    await new Promise((r) => setTimeout(r, 5));
    await _superInboxDrained();
    const s = await rota();
    expect(s.queue.some((q) => q.own && q.wait?.kind === 'refusal')).toBe(true);
    expect(s.queue.some((q) => q.kind === 'nudge')).toBe(false);
  });

  it('a nudge undeliverable for two minutes hands the stall to the owner', async () => {
    const { session, h } = await rotaOnTheJob();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.userSent('go on');
    h.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'Thinking about it.' }] } });
    h.observe({ type: 'result', subtype: 'success', is_error: false });
    superTurnEnded(session);
    await vi.advanceTimersByTimeAsync(10);
    await _superInboxDrained();
    expect((await rota()).queue.filter((q) => q.kind === 'nudge' && q.state === 'pending')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NUDGE_UNDELIVERED_MS + 50);
    await _superInboxDrained();
    const s = await rota();
    expect(s.queue.filter((q) => q.own && q.wait?.kind === 'stalled' && q.state !== 'done')).toHaveLength(1);
  });
});

describe('the side menu\'s count (member-summary `asking`)', () => {
  const facts = { global: false, enabled: true, approval: false };
  const record = (wait: 'refusal' | 'stalled' | 'run'): SuperState => ({
    ...emptySuperState(), enabled: true, session: 'sess-m', member: 'rota',
    children: { 'sess-kid': { sessionId: 'sess-kid', brief: 'job', adopted: false, startedAt: 1, workOrigin: 'main:q-req-1' } } as unknown as SuperState['children'],
    queue: [{
      id: 'q-own-1', sessionId: 'sess-kid', kind: 'owner', state: 'pending', createdAt: 2,
      wait: wait === 'refusal'
        ? { kind: 'refusal', id: 'rf-0123456789abcdef', key: 'Bash', refusal: { tool: 'Bash', input: 'node x.mjs', whole: true, source: 'classifier' } }
        : { kind: wait, id: wait === 'stalled' ? 'st-q-req-1' : 'gh-login' },
    }],
  });
  it('counts a refused call or a stall of a job main gave; a card of main\'s job stays main\'s', () => {
    expect(summarizeMember('rota', record('refusal'), facts, () => false, null, () => false).asking).toBe(true);
    expect(summarizeMember('rota', record('stalled'), facts, () => false, null, () => false).asking).toBe(true);
    expect(summarizeMember('rota', record('run'), facts, () => false, null, () => false).asking).toBe(false);
  });
});
