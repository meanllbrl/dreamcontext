/**
 * A team job whose member is gone, or whose answer a restart cut off, never reads "working" for
 * ever and never tells the same thing twice (Tilki 2026-11-21: a deleted member's job "working"
 * for 16 days, its "has not closed" line told again on every relaunch; this Mac the same day: Doc's
 * two finished jobs told "has not closed" in the relaunch's first second, their answers lost).
 *
 *  - The quiet note is told once per job, on the record: a restart never tells it again.
 *  - A relaunch counts the quiet from its own start, never from 0.
 *  - A request job whose member left the AI Team is concluded `gone` on a second watch tick: ONE
 *    stuck event, then failed for good; no later note.
 *  - `super team cancel` closes a job (main only) and its member's request; nothing is deleted.
 *  - A child's `done` stays news when its chat closes before the member's Super heard it.
 *  - An old record never owed an event whose member is gone is concluded quietly.
 *  - `super read <team>` of a request nobody closed reads what the member's children wrote.
 *
 * Scratch HOME and vault only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-orphan-home-`);
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState, superKey, withSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperChild, type SuperQueueItem } from '../../src/lib/super/types.js';
import {
  REQUEST_QUIET_MS, _resetSuperInbox, _setInboxStartedAtForTests, _superInboxDrained, checkQuietRequests, nextBatch, setMemberGateForTest, wireSuperInbox,
} from '../../src/lib/super/inbox.js';
import { teamJobStatus } from '../../src/lib/super/team.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { checkTeamJob, handleSuperVerb, setTeamAskRouteForTest } from '../../src/server/routes/super.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { _resetDelegating } from '../../src/lib/super/delegating.js';
import { _resetOwnerQuestions } from '../../src/lib/super/owner-question.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-1';
const W = { timeout: 10_000 };

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
const notesOf = async (job: string) => (await main()).queue.filter((q) => q.team === job && q.partial);

async function askRota(text = 'Plan the Friday routes.') {
  const r = await verb(tokenFor(MAIN), 'team-ask', { member: 'rota', text, brief: 'Friday routes' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const result = r.json.result as { request: string; job: string };
  return { request: result.request, job: result.job, session: (await rota()).session as string };
}
/** The request as the member's turn took it, long ago. */
async function accepted(request: string) {
  await withSuperState(root, 'm:rota', (s) => { const q = s.queue.find((x) => x.id === request)!; q.state = 'delivered'; q.acceptedAt = 1; });
}

beforeEach(() => { setTeamAskRouteForTest('request'); });
afterEach(() => { setTeamAskRouteForTest(null); });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-orphan-')));
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
});
afterEach(async () => {
  await _superInboxDrained();
  setMemberGateForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('a request job\'s notes are told once, on the record', () => {
  it('a relaunch never tells "has not closed" again (Tilki: once per restart)', async () => {
    const { request, job } = await askRota();
    await accepted(request);
    const key = superKey(root, 'm:rota');
    checkQuietRequests(key, await rota(), 1 + REQUEST_QUIET_MS + 1);
    await vi.waitFor(async () => expect(await notesOf(job)).toHaveLength(1), W);
    expect((await main()).team.find((j) => j.id === job)?.saidNotes).toEqual(['stale']);
    // The note names where the job's answer can still be read.
    expect((await notesOf(job))[0].text).toContain(`super read ${job}`);
    // A relaunch: every in-memory mark is gone, the record stays.
    _resetSuperInbox();
    wireSuperInbox();
    checkQuietRequests(key, await rota(), 1 + 3 * REQUEST_QUIET_MS);
    await _superInboxDrained();
    expect(await notesOf(job)).toHaveLength(1);
  });

  it('a relaunch counts the quiet from its own start, never from 0 (Doc: told in its first second)', async () => {
    const { request, job } = await askRota();
    await accepted(request);
    const key = superKey(root, 'm:rota');
    const boot = 10 * REQUEST_QUIET_MS;
    _setInboxStartedAtForTests(boot);
    checkQuietRequests(key, await rota(), boot + 1_000);
    await _superInboxDrained();
    expect(await notesOf(job)).toHaveLength(0);
    checkQuietRequests(key, await rota(), boot + REQUEST_QUIET_MS + 1);
    await vi.waitFor(async () => expect(await notesOf(job)).toHaveLength(1), W);
  });

  it('saidNotes and a cancelled conclusion survive the sanitizer; unknown values do not', () => {
    const s = sanitizeSuperState({
      ...emptySuperState(), session: MAIN, enabled: true,
      team: [{ id: 'team-abc-123456', member: 'rota', runId: '2026-11-21T10:00:00.000Z', jobKind: 'run', queued: false, brief: 'x', startedAt: 1, concluded: 'cancelled', saidNotes: ['stale', 'bogus', 'off', 'stale'] }],
    });
    expect(s.team[0]).toMatchObject({ concluded: 'cancelled', saidNotes: ['stale', 'off'] });
    const bad = sanitizeSuperState({
      ...emptySuperState(), session: MAIN, enabled: true,
      team: [{ id: 'team-abc-123456', member: 'rota', runId: '2026-11-21T10:00:00.000Z', jobKind: 'run', queued: false, brief: 'x', startedAt: 1, concluded: 'whatever', saidNotes: 'stale' }],
    });
    expect(bad.team[0].concluded).toBeUndefined();
    expect(bad.team[0].saidNotes).toBeUndefined();
  });
});

describe('a request job whose member left the AI Team', () => {
  it('is concluded gone on a second watch tick: ONE stuck event, failed for good, no later note', async () => {
    const { request, job } = await askRota();
    await accepted(request);
    rmSync(join(root, 'agents', 'rota.md'));
    expect(await checkTeamJob(root, job)).toBe(true);
    expect((await main()).queue.filter((q) => q.team === job && q.kind === 'stuck')).toHaveLength(0);
    expect(await checkTeamJob(root, job)).toBe(false);
    const m = await main();
    const j = m.team.find((x) => x.id === job)!;
    expect(j).toMatchObject({ concluded: 'gone', told: 'stuck' });
    expect(j.open).toBeUndefined();
    expect(m.queue.filter((q) => q.team === job && q.kind === 'stuck')).toHaveLength(1);
    expect(teamJobStatus(root, j, null).status).toBe('failed');
    // Nothing more about it: the watch stops, the quiet note never comes.
    expect(await checkTeamJob(root, job)).toBe(false);
    checkQuietRequests(superKey(root, 'm:rota'), await rota(), 1 + REQUEST_QUIET_MS + 1);
    await _superInboxDrained();
    expect(await notesOf(job)).toHaveLength(0);
    // Its data stays: the member's request is untouched.
    expect((await rota()).queue.find((q) => q.id === request)?.state).toBe('delivered');
  });

  it('a result it still sends when it comes back reaches main once, as an answer', async () => {
    const { request, job, session } = await askRota();
    await accepted(request);
    rmSync(join(root, 'agents', 'rota.md'));
    await checkTeamJob(root, job);
    await checkTeamJob(root, job);
    // The same member comes back (restored) and finishes the old request.
    createAgent(root, { slug: 'rota', title: 'Rota', prompt: 'You keep the routes.' }, { approve: { now: new Date() } });
    const r = await verb(tokenFor(session, 'm:rota'), 'team-done', { item: request, result: 'Two vans on Friday.' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await vi.waitFor(async () => expect((await notesOf(job)).map((q) => q.text)).toEqual([expect.stringContaining('Two vans on Friday.')]), W);
    expect((await main()).team.find((x) => x.id === job)).toMatchObject({ concluded: 'gone', told: 'stuck' });
  });

  it('a member still in the AI Team is never concluded', async () => {
    const { request, job } = await askRota();
    await accepted(request);
    expect(await checkTeamJob(root, job)).toBe(true);
    expect(await checkTeamJob(root, job)).toBe(true);
    expect((await main()).team.find((x) => x.id === job)?.concluded).toBeUndefined();
  });
});

describe('super team cancel', () => {
  it('closes main\'s job and its member\'s request, once; nothing is deleted', async () => {
    const { request, job } = await askRota();
    await accepted(request);
    const r = await verb(tokenFor(MAIN), 'team-cancel', { job, why: 'not needed any more' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.result).toMatchObject({ job, cancelled: true, requestClosed: true, memberTold: true });
    const j = (await main()).team.find((x) => x.id === job)!;
    expect(j).toMatchObject({ concluded: 'cancelled', told: 'stuck' });
    expect(teamJobStatus(root, j, null)).toEqual({ status: 'failed', lastLine: 'Cancelled by the Super Agent.' });
    const m = await rota();
    const q = m.queue.find((x) => x.id === request)!;
    expect(q).toMatchObject({ state: 'done', result: 'Cancelled by the Super Agent: not needed any more' });
    // The member was working on it: it hears the cancel as its own event, to stop.
    const told = m.queue.find((x) => x.kind === 'reply' && x.cancels);
    expect(told).toMatchObject({ workOrigin: `main:${request}`, state: 'pending' });
    const again = await verb(tokenFor(MAIN), 'team-cancel', { job });
    expect(again.status).toBe(409);
    expect((again.json as { error?: string }).error).toBe('already_closed');
  });

  it('closes the member\'s open question about it too (a later ask is never refused ask_open)', async () => {
    const { request, job, session } = await askRota();
    await accepted(request);
    await withSuperState(root, 'm:rota', (s) => {
      s.queue.push({ id: 'q-ask-00000001', sessionId: session, kind: 'ask', state: 'escalated', createdAt: 5, ownerText: 'Which vans?', workOrigin: `main:${request}` } as SuperQueueItem);
    });
    expect((await verb(tokenFor(MAIN), 'team-cancel', { job })).status).toBe(200);
    expect((await rota()).queue.find((x) => x.id === 'q-ask-00000001')?.state).toBe('done');
  });

  it('a request never started is closed with no event to the member', async () => {
    const { request, job } = await askRota();
    const r = await verb(tokenFor(MAIN), 'team-cancel', { job });
    expect(r.json.result).toMatchObject({ requestClosed: true, memberTold: false });
    const m = await rota();
    expect(m.queue.find((x) => x.id === request)?.state).toBe('done');
    expect(m.queue.some((x) => x.kind === 'reply')).toBe(false);
  });

  it('an unknown job is 404; a member\'s Super is refused', async () => {
    const { session } = await askRota();
    const r = await verb(tokenFor(MAIN), 'team-cancel', { job: 'team-nope-000000' });
    expect(r.status).toBe(404);
    const m = await verb(tokenFor(session, 'm:rota'), 'team-cancel', { job: 'team-nope-000000' });
    expect(m.status).toBe(403);
  });
});

describe('a finished child\'s done is never lost to its chat closing', () => {
  it('a pending done stays deliverable once its row moved done -> gone', () => {
    const child: SuperChild = { sessionId: 'kid-1', brief: 'report', adopted: false, startedAt: 1, row: 'gone', rowAt: 3, finishedAt: 2 } as SuperChild;
    const done: SuperQueueItem = { id: 'q-done-0000001', sessionId: 'kid-1', kind: 'done', state: 'pending', createdAt: 2 };
    const s = { ...emptySuperState(), session: MAIN, enabled: true, children: { 'kid-1': child }, queue: [done] };
    const out = nextBatch(s);
    expect(out.drop).not.toContain(done.id);
    expect(out.items.map((q) => q.id)).toContain(done.id);
    // A child that moved on (working again) still drops it.
    const moved = { ...s, children: { 'kid-1': { ...child, row: 'working' as const } } };
    expect(nextBatch(moved).drop).toContain(done.id);
  });
});

describe('an old record never owed an event', () => {
  it('whose member is gone is concluded quietly: failed, no event', async () => {
    const job = 'team-old-abcdef';
    await withSuperState(root, 'main', (s) => {
      s.team.push({ id: job, member: 'gone-member', runId: '2026-10-30T10:23:15.184Z', jobKind: 'run', queued: false, brief: 'old', startedAt: 1793355795195 });
    });
    expect(await checkTeamJob(root, job)).toBe(true);
    expect(await checkTeamJob(root, job)).toBe(false);
    const m = await main();
    const j = m.team.find((x) => x.id === job)!;
    expect(j.concluded).toBe('gone');
    expect(j.told).toBeUndefined();
    expect(m.queue.filter((q) => q.team === job)).toHaveLength(0);
    expect(teamJobStatus(root, j, null).status).toBe('failed');
  });
});

describe('super read of a request nobody closed', () => {
  it('reads what the member\'s children wrote last', async () => {
    const { request, job } = await askRota();
    await accepted(request);
    const kid = '0b9f6c1e-1111-4a2b-9c3d-123456789abc';
    await withSuperState(root, 'm:rota', (s) => {
      s.children[kid] = { sessionId: kid, brief: 'Friday routes report', adopted: false, startedAt: 5, workOrigin: `main:${request}`, row: 'gone', finishedAt: 6 } as SuperChild;
    });
    const tdir = join(homedir(), '.claude', 'projects', 'acme');
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, `${kid}.jsonl`), `${JSON.stringify({ type: 'assistant', timestamp: '2026-11-21T15:24:00Z', message: { id: 'm1', content: [{ type: 'text', text: 'Report written: tmp/routes.md. Friday needs two vans.' }] } })}\n`);
    const r = await verb(tokenFor(MAIN), 'read', { child: job });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const text = (r.json.result as { text: string }).text;
    expect(text).toContain('Friday needs two vans.');
    expect(text).toContain('has not closed this job');
  });
});
