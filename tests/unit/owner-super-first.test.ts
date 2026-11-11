/**
 * Mirror hardening and "Super first" (uye-bildirim K8, K9; criterion 10).
 *
 *  - K9: a member's own question is on his bar at once, but its banner and Telegram copy wait for
 *    the Super Agent's turn at it, at most 90 s; a Super answer inside that window means no ring at
 *    all; a permission never waits; with main's Super not running nothing waits;
 *  - K8: an archived or switched-off member's mirrors close; a mirror closed and reopened is
 *    offered on Telegram again; the phone names the member by its title; `super ask`'s reply says
 *    where the question really went.
 *
 * Real registry, inbox and verbs, scratch HOME and vault; the banner and Telegram sinks are stand-ins.
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
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import {
  SUPER_FIRST_MS, _resetSuperInbox, _superInboxDrained, closeMemberMirrors, setMemberGateForTest, setMemberTitleSource, syncAllMemberMirrors, wireSuperInbox, writeSuper,
} from '../../src/lib/super/inbox.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { handleSuperVerb, setTeamAskRouteForTest } from '../../src/server/routes/super.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { _resetDelegating } from '../../src/lib/super/delegating.js';
import { _resetOwnerQuestions, noteTelegramSend, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';
import { phoneSuperQuestions } from '../../src/server/routes/super-phone-questions.js';

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

describe('K9: the Super Agent goes first on a member\'s own question', () => {
  it('on the bar at once; no banner and no Telegram until the window ends (90 s)', async () => {
    registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    const session = await rotaSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { item, reply } = await rotaAsks(session);
    const m = (await mirrors()).find((x) => x.answers === item) as SuperQueueItem;
    expect(m.state).not.toBe('done');
    expect(reply).toMatchObject({ mirrored: true, superFirst: true });
    expect(banners.filter((b) => b.includes('May I send'))).toEqual([]);
    expect(telegram).not.toContain(m.id);
    await vi.advanceTimersByTimeAsync(SUPER_FIRST_MS + 50);
    await _superInboxDrained();
    expect(banners.some((b) => b.startsWith('Rota Planner'))).toBe(true);
    expect(telegram).toContain(m.id);
  });

  it('answered by the Super inside its window: it never rings', async () => {
    registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    const session = await rotaSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { item } = await rotaAsks(session);
    const m = (await mirrors()).find((x) => x.answers === item) as SuperQueueItem;
    const r = await verb(tokenFor(MAIN), 'team-answer', { item: m.id, text: 'He said yes to Ada last week.' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await vi.advanceTimersByTimeAsync(SUPER_FIRST_MS + 50);
    await _superInboxDrained();
    expect(banners.filter((b) => b.startsWith('Rota Planner'))).toEqual([]);
    expect(telegram).not.toContain(m.id);
  });

  it('with main\'s Super not running nothing waits', async () => {
    const session = await rotaSession();
    const { reply } = await rotaAsks(session);
    expect(reply.superFirst).toBeUndefined();
    expect(banners.some((b) => b.startsWith('Rota Planner'))).toBe(true);
  });

  it('a permission never waits: a member Super\'s own permission rings at once', async () => {
    registerChat({ sessionId: MAIN, conversationId: null, vault: 'acme', mode: 'super' });
    const session = await rotaSession();
    const h = registerChat({ sessionId: session, conversationId: null, vault: 'acme', mode: 'super', crew: true, permissionMode: 'default' });
    h.userSent('go');
    h.observe({ type: 'control_request', request_id: 'req-own-p', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_x' } });
    await _superInboxDrained();
    expect(banners.some((b) => b.startsWith('Rota Planner'))).toBe(true);
  });
});

describe('K8: mirror hardening', () => {
  it('an archived member\'s mirrors close; a switched-off member\'s too', async () => {
    const session = await rotaSession();
    await rotaAsks(session);
    expect((await mirrors()).some((m) => m.state !== 'done')).toBe(true);
    expect(await closeMemberMirrors(root, 'rota')).toBe(1);
    expect((await mirrors()).every((m) => m.state === 'done')).toBe(true);
    // Gone from the project: its record is no longer listed, and the sweep closes what is left.
    await writeSuper(root, (s) => { s.queue.push({ id: 'q-ghost-1', sessionId: MAIN, kind: 'member', state: 'escalated', createdAt: Date.now(), member: 'ghost', answers: 'q-ghost-item', of: 'ask' }); });
    await syncAllMemberMirrors(root);
    expect((await main()).queue.find((q) => q.id === 'q-ghost-1')?.state).toBe('done');
  });

  it('a mirror closed and reopened is offered on Telegram again', async () => {
    const session = await rotaSession();
    const { item } = await rotaAsks(session);
    const m = (await mirrors()).find((x) => x.answers === item) as SuperQueueItem;
    expect(telegram.filter((id) => id === m.id)).toHaveLength(1);
    noteTelegramSend(m.id, { ok: true });
    // Closed by something other than the member's item, then put back by the member's next write.
    await writeSuper(root, (s) => { const q = s.queue.find((x) => x.id === m.id); if (q) q.state = 'done'; });
    await writeSuper(root, 'm:rota', (s) => { s.pool = [...s.pool]; });
    await _superInboxDrained();
    expect((await mirrors()).find((x) => x.id === m.id)?.state).toBe('escalated');
    expect(telegram.filter((id) => id === m.id)).toHaveLength(2);
  });

  it('the phone names the member by its title', async () => {
    const session = await rotaSession();
    await rotaAsks(session);
    const listed = phoneSuperQuestions(await main(), () => 'gone', () => null, (slug) => (slug === 'rota' ? 'Rota Planner' : slug));
    const q = listed.questions.find((x) => x.member === 'rota');
    expect(q).toMatchObject({ kind: 'ask', memberTitle: 'Rota Planner' });
  });

  it('`super ask` from a member with main not handed over says it is not on his list', async () => {
    const session = await rotaSession();
    await writeSuper(root, (s) => { s.enabled = false; });
    const { reply } = await rotaAsks(session);
    expect(reply.mirrored).toBe(false);
    expect(String(reply.note)).toContain('NOT on the owner');
  });
});
