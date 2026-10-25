/**
 * A finished AI Team job reaches the Super Agent as ONE event (task
 * super-agent-bir-ai-team-ajanina-is-verdiginde-ajanin-isi-bitince-super-e-olay-gelir).
 *
 * The bug: `super team ask` recorded the job and repainted its card when the member's run
 * settled, but never queued an event, so the super never heard that the job finished. Now:
 *
 *  - the say job settling (a run or a reply) queues ONE pending `done` (or `stuck` for a failed
 *    one, `question` while the run waits on the owner) naming the job, never a second;
 *  - a job the owner asked for in his own turn is awaited=owner; one given from an event turn is not;
 *  - the item rides the normal `[super events]` batch with the team line and the member's last
 *    line fenced; a later ending replaces a question; the record keeps the fields only in shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-team-home-`);
});

type SayInput = { slug: string; text: string; via: string };
/** The say path's answer: no test here spawns a member. */
const say = vi.hoisted(() => ({ body: {} as Record<string, unknown> }));
vi.mock('../../src/server/routes/automations.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/routes/automations.js')>();
  return { ...real, sayToAgent: (_root: string, _input: SayInput) => ({ ok: true, status: 200, body: say.body }) };
});

/** The say path's job settling (stands in for the run or reply job), what holds a member's lock
 *  (`busy`), and a reply job still in memory (`replies`): no test here spawns a member. */
const settle = vi.hoisted(() => ({
  runs: new Map<string, Promise<unknown>>(), replies: new Map<string, Promise<unknown>>(),
  busy: new Set<string>(), live: new Map<string, Record<string, unknown>>(),
}));
vi.mock('../../src/server/automation-job.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/automation-job.js')>();
  return {
    ...real,
    whenRunSettles: (id: string) => (settle.runs.get(id) ?? null) as ReturnType<typeof real.whenRunSettles>,
    whenReplySettles: (id: string) => (settle.replies.get(id) ?? null) as ReturnType<typeof real.whenReplySettles>,
    agentActivity: (root: string, slug: string) => (settle.busy.has(slug) ? { since: 0, runId: null, queued: [] } : real.agentActivity(root, slug)),
    currentReplyJob: (id: string) => (settle.live.get(id) ?? real.currentReplyJob(id)) as ReturnType<typeof real.currentReplyJob>,
  };
});

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperState, type SuperTeamJob } from '../../src/lib/super/types.js';
import { AWAITED_LINE, TEAM_LINE, _resetSuperInbox, heldBlock, markSuperEventTurn, nextBatch, noteHeld, superBatchText, writeSuper } from '../../src/lib/super/inbox.js';
import { noteTeamJobEnd, teamJobStatus, teamLiveRows } from '../../src/lib/super/team.js';
import { TEAM_JOB_WATCH_MS, checkTeamJob, handleSuperVerb } from '../../src/server/routes/super.js';
import { createQuestion, listQuestions, noteResolution, resolveQuestion } from '../../src/lib/automations/hitl.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { superNotepad } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import * as client from '../../dashboard/src/lib/superTypes.js';

let dir: string;
let root: string;
let token = '';
const SUPER = 'sup-1';
const RUN = '2026-10-21T01:00:00.000Z';

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-team-')));
  settle.runs.clear();
  settle.replies.clear();
  settle.busy.clear();
  settle.live.clear();
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
  createAutomation(root, { slug: 'doctor', title: 'Doctor', days: 'daily', at: '09:00', prompt: 'go' });
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
async function teamAsk(text: string): Promise<string> {
  const out = await verb('team-ask', { member: 'doctor', text });
  expect(out.status).toBe(200);
  return (out.json.result as { job: string }).job;
}
const stored = () => readSuperState(root);
const teamItems = async () => (await stored()).queue.filter((q) => q.team);
const at = (s: number) => new Date(Date.parse(RUN) + s * 1000);
const entry = (s: number, e: Parameters<typeof appendThreadEntry>[2]) => appendThreadEntry(root, 'doctor', { ...e, now: at(s) });
/** The run stops to ask the owner: its `asked` entry and its pending question record, as the runner writes them. */
function asks(s: number, text = 'Publish the report to the team?'): void {
  createQuestion(root, { slug: 'doctor', runFiredAt: RUN, kind: 'flow-hitl', sessionId: 'sess-1', channel: 'chat', question: text, choices: [] });
  entry(s, { runId: RUN, kind: 'system', event: 'asked', text: `Asked: ${text}`, via: 'runner' });
}
/** The run asks from inside itself (`automations propose`): a question record, no thread entry. */
const propose = (text: string) => createQuestion(root, { slug: 'doctor', runFiredAt: RUN, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: text, choices: [] });
/** The owner answers the waiting one (AI Team, the CLI or Telegram: none of them through the super);
 *  `said` is what the resumed turn answered with. */
function answer(said?: string): void {
  const q = resolveQuestion(root, listQuestions(root, 'doctor').find((x) => x.state === 'pending')!, 'yes', 'dashboard');
  if (said !== undefined) noteResolution(root, q, { note: said, error: null });
}
/** The answer's resumed turn ended: the `replied` entry its resume writes last. */
const replied = () => appendThreadEntry(root, 'doctor', { runId: RUN, kind: 'system', event: 'replied', text: 'Question answered via dashboard. Session resumed.', via: 'runner' });
/** A deferred the test resolves when the say path's job settles. */
function deferred(): { p: Promise<unknown>; resolve: (v: unknown) => void } {
  let resolve!: (v: unknown) => void;
  const p = new Promise((r) => { resolve = r; });
  return { p, resolve };
}

describe('a team job\'s ending is ONE event for the super', () => {
  it('a run the owner asked for ends: ONE pending done item naming the job, awaited=owner', async () => {
    const run = deferred();
    settle.runs.set('aj-1', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'check the errors', via: 'super' });
    say.body = { job: { id: 'aj-1', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    const job = await teamAsk('check the errors');
    expect((await stored()).team[0]).toMatchObject({ id: job, awaited: true });
    expect(await teamItems()).toEqual([]);
    entry(2, { runId: RUN, kind: 'agent', text: 'No errors since midnight.', via: 'cli' });
    entry(3, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect(await teamItems()).toHaveLength(1));
    const s = await stored();
    const [item] = s.queue.filter((q) => q.team);
    expect(item).toMatchObject({ sessionId: SUPER, kind: 'done', state: 'pending', team: job });
    expect(s.team[0].told).toBe('done');
    // Asked again (a second settle, a later read): never a second item.
    const again = structuredClone(s);
    expect(noteTeamJobEnd(root, again, job, null)).toBe(false);
    expect(again.queue.filter((q) => q.team)).toHaveLength(1);
  });

  it('a failed run is ONE stuck item', async () => {
    const run = deferred();
    settle.runs.set('aj-2', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-2', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    await teamAsk('x');
    entry(2, { runId: RUN, kind: 'system', event: 'failed', text: 'failed', via: 'runner' });
    run.resolve({ status: 'error' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['stuck']));
  });

  it('a reply job settling ok is ONE done item, recorded with its ending in the same write', async () => {
    const reply = deferred();
    settle.replies.set('rj-1', reply.p);
    say.body = { job: { id: 'rj-1', kind: 'reply' }, started: true, runId: RUN, entryId: 'e-1', queued: true };
    await teamAsk('disk');
    reply.resolve({ status: 'ok', deliveredAt: '2026-10-21T01:00:05.000Z', finishedAt: '2026-10-21T01:00:09.000Z' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['done']));
    expect((await stored()).team[0]).toMatchObject({ outcome: 'done', told: 'done' });
  });

  it('a job given from an event turn is not the owner\'s: no awaited', async () => {
    markSuperEventTurn(SUPER, true);
    say.body = { job: { id: 'aj-3', kind: 'run' }, started: true, runId: RUN, entryId: 'e-3' };
    await teamAsk('x');
    expect((await stored()).team[0].awaited).toBeUndefined();
  });
});

describe('the team item in a [super events] batch', () => {
  const job = (o: Partial<SuperTeamJob> = {}): SuperTeamJob =>
    ({ id: 'team-abc', member: 'doctor', runId: RUN, entryId: '', jobKind: 'run', queued: false, brief: 'Error check', startedAt: 1, ...o });
  const state = (j: SuperTeamJob): SuperState => ({ ...emptySuperState(), session: SUPER, enabled: true, team: [j] });

  it('names the job and its member, says awaited=owner, fences the member\'s words; the batch carries the team rule', () => {
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'go', via: 'super' });
    entry(2, { runId: RUN, kind: 'agent', text: 'No errors since midnight.', via: 'cli' });
    entry(3, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    const s = state(job({ entryId: ask.id, awaited: true }));
    expect(noteTeamJobEnd(root, s, 'team-abc', null)).toBe(true);
    const { items } = nextBatch(s);
    expect(items).toHaveLength(1);
    const text = superBatchText(root, s, items, 'b-1');
    expect(text).toContain(`- item=${items[0].id} team=team-abc member=doctor event=done awaited=owner status=done`);
    expect(text).toMatch(/<untrusted-project-output[^>]*>\s*Last line: No errors since midnight\./);
    expect(text).toMatch(/<untrusted-project-output[^>]*>\s*Brief: Error check/);
    expect(text).toContain(AWAITED_LINE);
    expect(text).toContain(TEAM_LINE);
    expect(text).not.toContain('child=');
  });

  it('not the owner\'s job: no awaited=owner, no awaited rule', () => {
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'go', via: 'super' });
    entry(2, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    const s = state(job({ entryId: ask.id }));
    noteTeamJobEnd(root, s, 'team-abc', null);
    const text = superBatchText(root, s, nextBatch(s).items, 'b-1');
    expect(text).toMatch(/^- item=\S+ team=team-abc member=doctor event=done status=done$/m);
    expect(text).not.toContain(AWAITED_LINE);
    expect(text).toContain(TEAM_LINE);
  });

  it('a run that stopped to ask the owner is a question; its later ending replaces it with done', () => {
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'go', via: 'super' });
    asks(2);
    const s = state(job({ entryId: ask.id, awaited: true }));
    // The live run job says it settled fine: the open question still wins.
    expect(noteTeamJobEnd(root, s, 'team-abc', { kind: 'run', status: 'success' })).toBe(true);
    const q = nextBatch(s).items;
    expect(q.map((x) => x.kind)).toEqual(['question']);
    expect(superBatchText(root, s, q, 'b-1')).toMatch(/<untrusted-project-output[^>]*>\s*Question: Publish the report to the team\?/);
    expect(noteTeamJobEnd(root, s, 'team-abc', null)).toBe(false);
    answer();
    // Answered, its resumed turn still running: no event yet, the question no longer stands.
    expect(nextBatch(s, root)).toEqual({ items: [], drop: [q[0].id] });
    expect(noteTeamJobEnd(root, s, 'team-abc', null)).toBe(false);
    expect(s.queue.find((x) => x.kind === 'question')?.state).toBe('done');
    replied();
    expect(noteTeamJobEnd(root, s, 'team-abc', null)).toBe(true);
    const next = nextBatch(s);
    expect(next.items.map((x) => x.kind)).toEqual(['done']);
    expect(s.queue.find((x) => x.kind === 'question')?.state).toBe('done');
  });

  it('a job still running queues nothing; one that left the record makes its item stale', () => {
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'go', via: 'super' });
    const s = state(job({ entryId: ask.id }));
    expect(noteTeamJobEnd(root, s, 'team-abc', { kind: 'run', status: 'running' })).toBe(false);
    entry(2, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    noteTeamJobEnd(root, s, 'team-abc', null);
    s.team = [];
    expect(nextBatch(s)).toMatchObject({ items: [], drop: [s.queue[0].id] });
  });

  it('while the owner has a question open it is held, and told with his answer as the team line', () => {
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'go', via: 'super' });
    entry(2, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    const s = state(job({ entryId: ask.id, awaited: true }));
    s.queue.push({ id: 'q-ask', sessionId: SUPER, kind: 'ask', state: 'escalated', createdAt: 1, ownerText: 'Which plan?' });
    noteTeamJobEnd(root, s, 'team-abc', null);
    expect(noteHeld(s)).toBe(true);
    const item = s.queue.find((q) => q.team)!;
    expect(s.held).toEqual([{ item: item.id, child: SUPER, kind: 'done', at: item.createdAt }]);
    expect(heldBlock(root, s)?.text).toContain(`- item=${item.id} team=team-abc member=doctor event=done awaited=owner`);
    s.team = [];
    expect(heldBlock(root, s)?.text).toContain(`- item=${item.id} team=team-abc event=done moved-on`);
  });

  it('no super session: nothing queued', () => {
    entry(1, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    const s = { ...state(job()), session: null };
    expect(noteTeamJobEnd(root, s, 'team-abc', null)).toBe(false);
  });
});

describe('a member\'s question stays the member\'s', () => {
  it('the job\'s question arms the watch: its tick alone brings the done after he answers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const run = deferred();
      settle.runs.set('aj-t', run.p);
      const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
      say.body = { job: { id: 'aj-t', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
      await teamAsk('x');
      asks(2);
      run.resolve({ status: 'success' });
      await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
      answer();
      replied();
      await vi.advanceTimersByTimeAsync(TEAM_JOB_WATCH_MS);
      await vi.waitFor(async () => expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['question', 'done'], ['done', 'pending']]));
      // The watch died with it: later ticks add nothing.
      await vi.advanceTimersByTimeAsync(TEAM_JOB_WATCH_MS * 3);
      expect(await teamItems()).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('a job whose ending is owed is watched again from the record after a restart', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
      asks(2);
      const asked = listQuestions(root, 'doctor')[0];
      // What a restarted server finds on disk: a job whose question waits, an item already told, no watch in memory.
      const job: SuperTeamJob = { id: 'team-restart', member: 'doctor', runId: RUN, entryId: ask.id, jobKind: 'run', queued: false, brief: '', startedAt: 1, awaited: true, told: 'question', toldQuestion: asked.id, open: true };
      writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, team: [job],
        queue: [{ id: 'q-told', sessionId: SUPER, kind: 'question', state: 'done', createdAt: 1, team: job.id }] }));
      answer();
      replied();
      await vi.advanceTimersByTimeAsync(TEAM_JOB_WATCH_MS * 2);
      expect(await teamItems()).toHaveLength(1);
      // Any read of the record that the server makes (here: a write) arms it again.
      await writeSuper(root, () => {});
      await vi.advanceTimersByTimeAsync(TEAM_JOB_WATCH_MS);
      await vi.waitFor(async () => expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['question', 'done'], ['done', 'pending']]));
    } finally { vi.useRealTimers(); }
  });

  it('a question answered before its run\'s settle was read: the watch still brings the done', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const run = deferred();
      settle.runs.set('aj-early', run.p);
      const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
      say.body = { job: { id: 'aj-early', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
      await teamAsk('x');
      asks(2);
      answer();
      run.resolve({ status: 'success' });
      await vi.waitFor(async () => expect((await stored()).team[0].told).toBeUndefined());
      await new Promise((r) => setTimeout(r, 50));
      expect(await teamItems()).toEqual([]);
      replied();
      await vi.advanceTimersByTimeAsync(TEAM_JOB_WATCH_MS);
      await vi.waitFor(async () => expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['done', 'pending']]));
    } finally { vi.useRealTimers(); }
  });

  it('no time limit: a day and more later, the done still arrives by the watch alone, no write, no owner action', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const run = deferred();
      settle.runs.set('aj-late', run.p);
      const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
      say.body = { job: { id: 'aj-late', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
      await teamAsk('x');
      propose('Publish it?');
      run.resolve({ status: 'success' });
      await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
      /** One watch tick, and its reads finished (they are real file reads, not timers). */
      const tick = async () => { await vi.advanceTimersByTimeAsync(TEAM_JOB_WATCH_MS); await new Promise((r) => setTimeout(r, 150)); };
      // Monday: 25 hours on, the watch ticks while he still has not answered, and nothing writes the record.
      vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
      await tick();
      expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['question', 'pending']]);
      answer('Published.');
      replied();
      await vi.advanceTimersByTimeAsync(TEAM_JOB_WATCH_MS);
      await vi.waitFor(async () => expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['question', 'done'], ['done', 'pending']]));
    } finally { vi.useRealTimers(); }
  });

  it('a question asked with `automations propose` (no thread entry) is a question, never a done', async () => {
    const run = deferred();
    settle.runs.set('aj-p', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-p', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    await teamAsk('x');
    propose('Publish the report?');
    // The run itself ends `ok`: it stopped to ask.
    entry(3, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['question', 'pending']]));
  });

  it('a resumed turn that asks again is a SECOND question event; the done follows the last answer, in its words', async () => {
    const run = deferred();
    settle.runs.set('aj-2q', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-2q', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    const job = await teamAsk('publish the two parts');
    propose('Publish part 1?');
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
    // He answers; the resumed turn asks again before it ends.
    answer('I proposed part 2.');
    propose('Publish part 2?');
    replied();
    expect(await checkTeamJob(root, job)).toBe(true);
    let items = await teamItems();
    expect(items.map((q) => [q.kind, q.state])).toEqual([['question', 'done'], ['question', 'pending']]);
    const s = await stored();
    const second = listQuestions(root, 'doctor').find((q) => q.state === 'pending')!;
    expect(s.team[0]).toMatchObject({ told: 'question', toldQuestion: second.id, open: true });
    const text = superBatchText(root, s, nextBatch(s, root).items, 'b-2');
    expect(text).toMatch(/event=question status=asking/);
    expect(text).toMatch(/<untrusted-project-output[^>]*>\s*Question: Publish part 2\?/);
    // Nothing moved: the watch writes nothing.
    expect(await checkTeamJob(root, job)).toBe(true);
    expect(await teamItems()).toHaveLength(2);
    answer('Published both parts.');
    replied();
    expect(await checkTeamJob(root, job)).toBe(false);
    items = await teamItems();
    expect(items.map((q) => [q.kind, q.state])).toEqual([['question', 'done'], ['question', 'done'], ['done', 'pending']]);
    const after = await stored();
    expect(after.team[0].open).toBeUndefined();
    const done = superBatchText(root, after, nextBatch(after, root).items, 'b-3');
    expect(done).toMatch(/event=done awaited=owner/);
    expect(done).toMatch(/<untrusted-project-output[^>]*>\s*Last line: Published both parts\./);
  });

  it('a member that left the AI Team can never end its job: one stuck, and the watch stops', async () => {
    const run = deferred();
    settle.runs.set('aj-gone', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-gone', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    const job = await teamAsk('x');
    // Still working: its lock is held.
    settle.busy.add('doctor');
    entry(2, { runId: RUN, kind: 'agent', text: 'working', via: 'cli' });
    run.resolve({ status: 'success' });
    // A file mid-rewrite (a pull, a save) is not a member gone: present, even unreadable, it is never stuck.
    const file = join(root, 'automations', 'doctor.md');
    writeFileSync(file, '---\n: : not yaml\n');
    expect(await checkTeamJob(root, job)).toBe(true);
    expect(await checkTeamJob(root, job)).toBe(true);
    expect(await teamItems()).toEqual([]);
    rmSync(file);
    // Gone on one tick only: not yet.
    expect(await checkTeamJob(root, job)).toBe(true);
    expect(await teamItems()).toEqual([]);
    expect(await checkTeamJob(root, job)).toBe(false);
    expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['stuck', 'pending']]);
    expect(superBatchText(root, await stored(), (await teamItems()), 'b-g')).toMatch(/Last line: The member is no longer in the AI Team\./);
    expect(await checkTeamJob(root, job)).toBe(false);
  });

  it('an answer\'s resumed turn lost with the server (no record, nothing running): one stuck, outcome unknown, on the second tick', async () => {
    const run = deferred();
    settle.runs.set('aj-lost', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-lost', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    const job = await teamAsk('x');
    propose('Publish it?');
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
    answer();
    // The server stopped during the resumed turn: no `replied`, no resolution, no lock, no say job.
    expect(await checkTeamJob(root, job)).toBe(true);
    expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['question', 'done']]);
    expect(await checkTeamJob(root, job)).toBe(true);
    const items = await teamItems();
    expect(items.map((q) => [q.kind, q.state])).toEqual([['question', 'done'], ['stuck', 'pending']]);
    expect(superBatchText(root, await stored(), [items[1]], 'b-l')).toMatch(/Last line: Outcome unknown/);
    expect((await stored()).team[0].open).toBeUndefined();
    // Nothing is owed any more: the next tick ends the watch.
    expect(await checkTeamJob(root, job)).toBe(false);
  });

  it('a lost turn whose question lands inside the concluding write stays watched', async () => {
    const run = deferred();
    settle.runs.set('aj-lq', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-lq', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    const job = await teamAsk('x');
    propose('Publish part 1?');
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
    answer();
    expect(await checkTeamJob(root, job)).toBe(true);
    // The resumed turn asks again in the moment between the second tick's read and its write.
    const readQ = listQuestions;
    let once = true;
    vi.spyOn(await import('../../src/lib/automations/hitl.js'), 'listQuestions').mockImplementation((r, slug) => {
      if (once) { once = false; return readQ(r, slug); }
      propose('Publish part 2?');
      vi.restoreAllMocks();
      return readQ(r, slug);
    });
    const keep = await checkTeamJob(root, job);
    vi.restoreAllMocks();
    expect((await stored()).team[0]).toMatchObject({ told: 'question', open: true });
    expect(keep).toBe(true);
  });

  it('a reply to a busy member never takes the busy run\'s question for its own; refused, it is stuck', async () => {
    const reply = deferred();
    settle.replies.set('rj-busy', reply.p);
    say.body = { job: { id: 'rj-busy', kind: 'reply' }, started: true, runId: RUN, entryId: 'e-busy', queued: true };
    // The reply waits for the busy run's lock.
    settle.busy.add('doctor');
    settle.live.set('rj-busy', { id: 'rj-busy', status: 'running', phase: 'waiting', finishedAt: null });
    const job = await teamAsk('also check the logs');
    // The busy run the reply waits behind asks the owner, then the reply is refused ("answer that first").
    propose('Publish the busy run\'s report?');
    expect(await checkTeamJob(root, job)).toBe(true);
    expect(await teamItems()).toEqual([]);
    const finishedAt = new Date().toISOString();
    settle.live.set('rj-busy', { id: 'rj-busy', status: 'refused', phase: 'waiting', finishedAt });
    reply.resolve({ status: 'refused', finishedAt });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['stuck', 'pending']]));
  });

  it('a second answer claimed before the first resume\'s last write is not ended by it', async () => {
    const run = deferred();
    settle.runs.set('aj-race', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-race', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    const job = await teamAsk('x');
    propose('Publish part 1?');
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
    answer();
    propose('Publish part 2?');
    answer('Published both parts.');
    // The FIRST resume's `replied` lands only now: one resume for two answers is not the end.
    replied();
    expect(await checkTeamJob(root, job)).toBe(true);
    expect((await teamItems()).filter((q) => q.kind === 'done')).toEqual([]);
    replied();
    expect(await checkTeamJob(root, job)).toBe(false);
    expect((await teamItems()).filter((q) => q.kind === 'done').map((q) => q.state)).toEqual(['pending']);
  });

  it('the card and super state read the same as the event: asking while the question waits, never done', async () => {
    const run = deferred();
    settle.runs.set('aj-card', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-card', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    const job = await teamAsk('x');
    propose('Publish it?');
    entry(3, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
    const s = await stored();
    expect(teamJobStatus(root, s.team[0], null).status).toBe('asking');
    expect(teamLiveRows(root, s)?.[job]?.status).toBe('asking');
    answer('Published.');
    // The resumed turn runs: working, and the earlier read was never pinned as final.
    expect(teamLiveRows(root, s)?.[job]?.status).toBe('running');
    replied();
    expect(teamLiveRows(root, s)?.[job]).toEqual({ status: 'done', lastLine: 'Published.' });
    const st = await verb('state', {});
    expect(JSON.stringify(st.json)).toContain('"status":"done"');
  });

  it('an answer that resumed nothing still writes its replied: it never ends the job while the real resume runs', async () => {
    const run = deferred();
    settle.runs.set('aj-retry', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-retry', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    settle.busy.add('doctor');
    const job = await teamAsk('x');
    propose('Publish part 1?');
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
    answer();
    propose('Publish part 2?');
    replied();
    // His first answer to part 2 fails to spawn: its replied is written, the question reopens…
    const q2 = listQuestions(root, 'doctor').find((q) => q.state === 'pending')!;
    resolveQuestion(root, q2, 'yes', 'dashboard', new Date(Date.now() - 5_000).toISOString());
    replied();
    writeFileSync(join(root, 'automations', 'hitl', 'doctor', `${q2.id}.json`), JSON.stringify({ ...q2, state: 'pending' }));
    expect(await checkTeamJob(root, job)).toBe(true);
    // …then his second answer resumes it, and that resume is still running.
    await new Promise((r) => setTimeout(r, 5));
    answer();
    expect(await checkTeamJob(root, job)).toBe(true);
    expect((await teamItems()).filter((q) => q.kind === 'done')).toEqual([]);
    replied();
    expect(await checkTeamJob(root, job)).toBe(false);
    expect((await teamItems()).filter((q) => q.kind === 'done').map((q) => q.state)).toEqual(['pending']);
  });

  it('an ending that lands just as its turn is concluded lost wins over the conclusion', async () => {
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    entry(2, { runId: RUN, kind: 'system', event: 'ok', text: 'ok', via: 'runner' });
    const late: SuperTeamJob = { id: 'team-late', member: 'doctor', runId: RUN, entryId: ask.id, jobKind: 'run', queued: false, brief: '', startedAt: 1, open: true };
    const s: SuperState = { ...emptySuperState(), session: SUPER, enabled: true, team: [late] };
    expect(noteTeamJobEnd(root, s, 'team-late', null, Date.now(), 'lost')).toBe(true);
    expect(s.team[0]).toMatchObject({ told: 'done' });
    expect(s.team[0].concluded).toBeUndefined();
  });

  it('the window draws asking: its parser keeps it, its ring asks, both languages name it', async () => {
    const job = { id: 'team-a1', member: 'doctor', runId: RUN, jobKind: 'run', queued: false, brief: 'logs', startedAt: 5 };
    const view = client.readSuperStateView({ ...emptySuperState(), vault: 'acme', session: SUPER, enabled: true, team: [job], teamLive: { 'team-a1': { status: 'asking', lastLine: 'q' } } });
    expect(view?.teamLive).toEqual({ 'team-a1': { status: 'asking', lastLine: 'q' } });
    const { teamRingKind } = await import('../../dashboard/src/components/sleepy/super/TeamTile.js');
    expect(teamRingKind('asking')).toBe('asking');
    const i18n = readFileSync(join(process.cwd(), 'dashboard', 'src', 'context', 'I18nContext.tsx'), 'utf-8');
    expect(i18n.match(/'super\.team\.state\.asking': '[^']+'/g)).toHaveLength(2);
  });

  it('a record from before `open` that was told a question is still watched to its end', async () => {
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    propose('Publish it?');
    const asked = listQuestions(root, 'doctor')[0];
    const job: SuperTeamJob = { id: 'team-legacy', member: 'doctor', runId: RUN, entryId: ask.id, jobKind: 'run', queued: false, brief: '', startedAt: 1, told: 'question', toldQuestion: asked.id };
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, team: [job] }));
    expect(await checkTeamJob(root, job.id)).toBe(true);
    answer('Published.');
    replied();
    expect(await checkTeamJob(root, job.id)).toBe(false);
    expect((await teamItems()).map((q) => q.kind)).toEqual(['done']);
  });

  it('answered outside the super (AI Team, CLI, Telegram): the watch closes the question, then queues ONE done', async () => {
    const run = deferred();
    settle.runs.set('aj-w', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-w', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    const job = await teamAsk('x');
    asks(2);
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
    // Still waiting on him: the watch keeps watching and writes nothing.
    expect(await checkTeamJob(root, job)).toBe(true);
    expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['question', 'pending']]);
    answer();
    expect(await checkTeamJob(root, job)).toBe(true);
    expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['question', 'done']]);
    entry(3, { runId: RUN, kind: 'agent', text: 'Published.', via: 'cli' });
    replied();
    expect(await checkTeamJob(root, job)).toBe(false);
    expect((await teamItems()).map((q) => [q.kind, q.state])).toEqual([['question', 'done'], ['done', 'pending']]);
    expect((await stored()).team[0]).toMatchObject({ told: 'done', awaited: true });
    expect(await checkTeamJob(root, job)).toBe(false);
    expect(await teamItems()).toHaveLength(2);
  });


  it('the super cannot escalate a team question as a child\'s; the agenda never lists it as one', async () => {
    const run = deferred();
    settle.runs.set('aj-q', run.p);
    const ask = entry(1, { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    say.body = { job: { id: 'aj-q', kind: 'run' }, started: true, runId: RUN, entryId: ask.id };
    await teamAsk('x');
    asks(2, 'Publish it?');
    run.resolve({ status: 'success' });
    await vi.waitFor(async () => expect((await teamItems()).map((q) => q.kind)).toEqual(['question']));
    const [item] = await teamItems();
    const r = await verb('queue-ask', { item: item.id, text: 'Doctor asks whether to publish.' });
    expect(r.json.error).toBe('team_question');
    expect((await teamItems())[0].state).toBe('pending');
    // An owner question open: a child's pending question shows queued in Waiting on you, the team one never.
    const s = await stored();
    s.queue.push({ id: 'q-ask', sessionId: SUPER, kind: 'ask', state: 'escalated', createdAt: 1, ownerText: 'Which plan?' });
    s.queue.push({ id: 'q-child', sessionId: 'c1', kind: 'question', state: 'pending', createdAt: 2 });
    const look = { live: () => null, titleFor: (sid: string) => `Job ${sid}`, superTitle: 'Super Agent' };
    const waiting = superNotepad(s as Parameters<typeof superNotepad>[0], look).waiting;
    expect(waiting.map((w) => [w.item, w.chip])).toEqual([['q-ask', 'ask'], ['q-child', 'queued']]);
  });
});

describe('the record keeps the team fields only in shape', () => {
  it('a queue item keeps its job id on an ending kind only; a team job keeps awaited and told', () => {
    const raw = {
      ...emptySuperState(), session: SUPER, enabled: true,
      team: [
        { id: 'team-abc', member: 'doctor', runId: RUN, jobKind: 'run', queued: false, brief: '', startedAt: 1, awaited: true, told: 'done' },
        { id: 'team-def', member: 'doctor', runId: RUN, jobKind: 'run', queued: false, brief: '', startedAt: 2, awaited: 'yes', told: 'exploded' },
      ],
      queue: [
        { id: 'q-1', sessionId: SUPER, kind: 'done', state: 'pending', createdAt: 1, team: 'team-abc' },
        { id: 'q-2', sessionId: SUPER, kind: 'stuck', state: 'pending', createdAt: 1, team: '../../etc' },
        { id: 'q-3', sessionId: SUPER, kind: 'handover', state: 'pending', createdAt: 1, team: 'team-abc' },
      ],
    };
    const s = sanitizeSuperState(raw);
    expect(s.team.find((j) => j.id === 'team-abc')).toMatchObject({ awaited: true, told: 'done' });
    const def = s.team.find((j) => j.id === 'team-def');
    expect(def?.awaited).toBeUndefined();
    expect(def?.told).toBeUndefined();
    expect(s.queue.find((q) => q.id === 'q-1')?.team).toBe('team-abc');
    expect(s.queue.find((q) => q.id === 'q-2')?.team).toBeUndefined();
    expect(s.queue.find((q) => q.id === 'q-3')?.team).toBeUndefined();
  });
});
