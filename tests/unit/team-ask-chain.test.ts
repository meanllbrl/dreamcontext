/**
 * One conversation and one card per member (plan-r10 1b, owner i74xj5: "aynı üyeye tek konuşma,
 * tek kart"), through the real `team-ask` verb:
 *
 *  - three asks to one member = ONE card, ONE root, two follow-ups `by: 'super'` (the card reads "3 iş");
 *  - an ask while the root still runs waits behind it as a follow-up ("sırada");
 *  - a root with a pending question, a light root, a sticking override, 20 turns, two waiting
 *    follow-ups, or a reply refusal other than `say_at_limit` each start a NEW root on the SAME card
 *    with the recent-posts preamble; the pending question stays open and is never answered;
 *  - `say_at_limit` from the reply is the 429 itself; `atLiveLimit` refuses a reply at 15;
 *  - the trim never drops a current root; the boot collapse keeps the newest card's place, once;
 *  - `teamItemLines` never says the owner wrote Super's own follow-up;
 *  - `super open team <job>` opens that job's member's one card.
 * No test here spawns a member: the say and reply paths and the run's session are stand-ins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/team-chain-home-`);
});

type Out = { ok: true; status: 200; body: Record<string, unknown> } | { ok: false; status: number; code: string; message: string };
/** Every say and reply the verb makes, and a stand-in answer for each (null = the real path). */
const paths = vi.hoisted(() => ({
  says: [] as Array<{ slug: string; text: string; via: string }>,
  replies: [] as Array<{ slug: string; runId: string; text: string; via: string }>,
  say: null as null | ((n: number) => Out),
  reply: null as null | ((n: number) => Out),
}));
vi.mock('../../src/server/routes/automations.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/routes/automations.js')>();
  return {
    ...real,
    sayToAgent: (root: string, input: { slug: string; text: string; via: string }) => {
      paths.says.push({ slug: input.slug, text: input.text, via: input.via });
      return paths.say ? paths.say(paths.says.length) : real.sayToAgent(root, input as Parameters<typeof real.sayToAgent>[1]);
    },
    replyToAgent: (root: string, input: { slug: string; runId: string; text: string; via: string }) => {
      paths.replies.push({ slug: input.slug, runId: input.runId, text: input.text, via: input.via });
      return paths.reply ? paths.reply(paths.replies.length) : real.replyToAgent(root, input as Parameters<typeof real.replyToAgent>[1]);
    },
  };
});

/** Which members' runs are in flight, and how many turns the machine runs. */
const live = vi.hoisted(() => ({ active: new Set<string>(), turns: 0 }));
vi.mock('../../src/server/automation-job.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/automation-job.js')>();
  return {
    ...real,
    whenRunSettles: () => null,
    whenReplySettles: () => null,
    liveTurnCount: () => live.turns,
    agentActivity: (root: string, slug: string) => (live.active.has(slug)
      ? { since: 0, runId: null, queued: [], runs: [{ runId: null, since: 0 }], count: 1 }
      : real.agentActivity(root, slug)),
  };
});

/** The resume itself (no claude here): which way a reply went. */
const turns = vi.hoisted(() => ({ messages: [] as string[], answers: [] as string[] }));
vi.mock('../../src/lib/automations/verdict.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/automations/verdict.js')>();
  return {
    ...real,
    resumeWithMessage: async (_root: string, _slug: string, text: string) => { turns.messages.push(text); return { status: 'ok', error: null, result: 'ok', costUsd: null }; },
    resumeWithAnswer: async (_root: string, _q: unknown, text: string) => { turns.answers.push(text); return { status: 'ok', error: null, result: 'ok' }; },
  };
});

/** Whether the root's run left a session this Mac can resume. */
const session = vi.hoisted(() => ({ resumable: true }));
vi.mock('../../src/lib/automations/run-chat.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/automations/run-chat.js')>();
  return { ...real, runChatSession: () => (session.resumable ? { claudeId: '6f02f3ed-0e2e-434e-b0b3-b4f606e32879', resumable: true } : null) };
});

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, memberTeamCardId, readSuperState, resetSuperIndex, sanitizeSuperState } from '../../src/lib/super/store.js';
import { MAX_TEAM_JOBS, emptySuperState, trimTeamJobs, type SuperState, type SuperTeamJob } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { teamItemLines } from '../../src/lib/super/team.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { replyToAgent } from '../../src/server/routes/automations.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { createQuestion, listQuestions } from '../../src/lib/automations/hitl.js';
import * as client from '../../dashboard/src/lib/superTypes.js';

let dir: string;
let root: string;
let token = '';
const SUPER = 'sup-1';
const RUN = '2026-11-02T08:00:00.000Z';
const RUN2 = '2026-11-02T09:00:00.000Z';

function makeVault(state: Partial<SuperState> = {}): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-chain-')));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  makeVault();
  paths.says.length = 0;
  paths.replies.length = 0;
  live.active.clear();
  live.turns = 0;
  session.resumable = true;
  turns.messages.length = 0;
  turns.answers.length = 0;
  // A fresh run on the first say, a fresh run on RUN2 after it; a follow-up on every reply.
  paths.say = (n) => ({ ok: true, status: 200, body: { job: { id: `job-${n}`, kind: 'run' }, started: true, runId: n === 1 ? RUN : RUN2, entryId: `e-say-${n}`, slug: 'gantt' } });
  paths.reply = (n) => ({ ok: true, status: 200, body: { job: { id: `rj-${n}`, kind: 'reply', phase: 'delivering' }, runId: RUN, entryId: `e-reply-${n}`, queued: false, answers: false } });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
  createAgent(root, { slug: 'gantt', title: 'Gantt', prompt: 'Plan the projects.' }, { approve: { now: new Date() } });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
const ask = (text: string, extra: Record<string, unknown> = {}) => verb('team-ask', { member: 'gantt', text, ...extra });
const stored = () => readSuperState(root);
const teamCards = (s: SuperState) => s.containers.filter((c) => c.kind === 'team');
const roots = (s: SuperState) => s.team.filter((j) => !j.followUpOf);

/** The run's own words, so a new root has something to open with. */
function posts(): void {
  appendThreadEntry(root, 'gantt', { runId: RUN, kind: 'user', text: 'Fix the ClickUp assignments', via: 'super' });
  appendThreadEntry(root, 'gantt', { runId: RUN, kind: 'agent', text: 'Fixed 12 of 14 assignments.', via: 'cli' });
}

describe('three asks to one member: one conversation, one card', () => {
  it('one card, one root, two follow-ups by super; the card reads "3 iş"', async () => {
    for (const t of ['Fix the ClickUp assignments', 'Rename Ozan', 'Close the sprint']) expect((await ask(t)).status).toBe(200);
    expect(paths.says).toHaveLength(1);
    expect(paths.replies.map((r) => [r.runId, r.via])).toEqual([[RUN, 'super'], [RUN, 'super']]);
    const s = await stored();
    expect(roots(s)).toHaveLength(1);
    const root0 = roots(s)[0];
    const follow = s.team.filter((j) => j.followUpOf === root0.id);
    expect(follow).toHaveLength(2);
    expect(follow.every((j) => j.by === 'super' && j.jobKind === 'reply' && j.runId === RUN)).toBe(true);
    expect(teamCards(s)).toEqual([expect.objectContaining({ id: memberTeamCardId('gantt'), ref: root0.id })]);
    const view = client.readSuperStateView({ ...s, vault: 'acme' });
    const card = view?.team.find((j) => j.id === root0.id);
    expect(card?.chain?.jobs).toBe(3);
    expect(card?.chain?.newest.brief).toBe('Close the sprint');
  });

  it('an ask while the root still runs waits behind it as a follow-up ("sırada")', async () => {
    session.resumable = false;
    expect((await ask('first')).status).toBe(200);
    live.active.add('gantt');
    paths.reply = (n) => ({ ok: true, status: 200, body: { job: { id: `rj-${n}`, kind: 'reply', phase: 'waiting' }, runId: RUN, entryId: `e-reply-${n}`, queued: true, answers: false } });
    const r = await ask('second');
    expect(r.json.result).toMatchObject({ queued: true, status: 'queued', continued: true });
    const s = await stored();
    expect(s.team[0]).toMatchObject({ queued: true, by: 'super', followUpOf: roots(s)[0].id });
    expect(teamCards(s)).toHaveLength(1);
  });
});

describe('the member\'s card comes back with a continued ask', () => {
  it('a card closed or retired since the root ended is put back as the member\'s ONE card when Super asks again', async () => {
    expect((await ask('first')).status).toBe(200);
    const s = await stored();
    const r0 = roots(s)[0];
    // The owner closed it (or makeRoom retired it): no team card on the stage.
    makeVault({ team: s.team, containers: s.containers.filter((c) => c.kind !== 'team') });
    resetSuperIndex();
    expect(teamCards(await stored())).toEqual([]);
    const r = await ask('second');
    expect(r.json.result).toMatchObject({ continued: true });
    const after = await stored();
    expect(teamCards(after)).toEqual([expect.objectContaining({ id: memberTeamCardId('gantt'), ref: r0.id })]);
    // A third ask finds it there: still one card.
    expect((await ask('third')).status).toBe(200);
    expect(teamCards(await stored())).toHaveLength(1);
  });
});

describe('a new root on the SAME card, with the recent posts', () => {
  async function expectNewRootSameCard(firstRootId: string): Promise<void> {
    const s = await stored();
    expect(roots(s).map((j) => j.runId)).toEqual([RUN2, RUN]);
    expect(teamCards(s)).toEqual([expect.objectContaining({ id: memberTeamCardId('gantt'), ref: roots(s)[0].id })]);
    expect(roots(s)[0].id).not.toBe(firstRootId);
    // The fresh run opens with where the conversation stood.
    expect(paths.says[1].text).toContain('Earlier in this conversation');
    expect(paths.says[1].text).toContain('Fixed 12 of 14 assignments.');
  }
  const first = async () => {
    expect((await ask('Fix the ClickUp assignments')).status).toBe(200);
    posts();
    return roots(await stored())[0].id;
  };

  it('a root whose run waits on the owner\'s question; the question stays open and unanswered', async () => {
    const id = await first();
    createQuestion(root, { slug: 'gantt', runFiredAt: RUN, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish it?', choices: [] });
    expect((await ask('and the next one')).status).toBe(200);
    expect(paths.replies).toEqual([]);
    await expectNewRootSameCard(id);
    expect(listQuestions(root, 'gantt').filter((q) => q.state === 'pending')).toHaveLength(1);
  });

  it('a light root', async () => {
    expect((await ask('Fix the ClickUp assignments', { light: true })).status).toBe(200);
    posts();
    const id = roots(await stored())[0].id;
    expect((await ask('a full one')).status).toBe(200);
    expect(paths.replies).toEqual([]);
    await expectNewRootSameCard(id);
  });

  it('a light ask', async () => {
    const id = await first();
    expect((await ask('just read', { light: true })).status).toBe(200);
    expect(paths.replies).toEqual([]);
    await expectNewRootSameCard(id);
  });

  it('an override that would stick to the session (a one-job model on a member with none)', async () => {
    const id = await first();
    expect((await ask('on another model', { model: 'sonnet' })).status).toBe(200);
    expect(paths.replies).toEqual([]);
    await expectNewRootSameCard(id);
  });

  it('20 turns', async () => {
    const id = await first();
    const s = await stored();
    const r0 = roots(s)[0];
    const follow: SuperTeamJob[] = Array.from({ length: 19 }, (_, i) => ({
      id: `team-fu-${String(i).padStart(4, '0')}`, member: 'gantt', runId: RUN, jobKind: 'reply', queued: false,
      brief: `turn ${i}`, startedAt: r0.startedAt + i + 1, followUpOf: r0.id, by: 'super', outcome: 'done',
    }));
    makeVault({ team: [...follow.reverse(), ...s.team], containers: s.containers });
    resetSuperIndex();
    expect((await ask('turn 21')).status).toBe(200);
    expect(paths.replies).toEqual([]);
    await expectNewRootSameCard(id);
  });

  it('two follow-ups already waiting', async () => {
    const id = await first();
    const s = await stored();
    const r0 = roots(s)[0];
    const waiting = (n: number): SuperTeamJob => ({ id: `team-wait-${n}`, member: 'gantt', runId: RUN, jobKind: 'reply', queued: true, open: true, brief: 'w', startedAt: r0.startedAt + n, followUpOf: r0.id, by: 'super' });
    makeVault({ team: [waiting(2), waiting(1), ...s.team], containers: s.containers });
    resetSuperIndex();
    expect((await ask('a third one')).status).toBe(200);
    expect(paths.replies).toEqual([]);
    await expectNewRootSameCard(id);
  });

  it('a reply refusal other than say_at_limit (not bound, a stale run, busy, a question)', async () => {
    for (const code of ['not_bound', 'stale_run', 'say_busy', 'question_pending']) {
      rmSync(dir, { recursive: true, force: true });
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-chain-')));
      root = join(dir, 'acme', '_dream_context');
      mkdirSync(join(root, 'state'), { recursive: true });
      makeVault();
      resetSuperIndex();
      token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
      createAgent(root, { slug: 'gantt', title: 'Gantt', prompt: 'Plan the projects.' }, { approve: { now: new Date() } });
      paths.says.length = 0;
      paths.replies.length = 0;
      paths.reply = () => ({ ok: false, status: 409, code, message: 'no' });
      const id = await first();
      expect((await ask('the next one')).status).toBe(200);
      expect(paths.replies).toHaveLength(1);
      await expectNewRootSameCard(id);
    }
  });

  it('say_at_limit from the reply is the 429 itself: nothing starts, nothing is recorded', async () => {
    await first();
    paths.reply = () => ({ ok: false, status: 429, code: 'say_at_limit', message: '15 jobs are already running.' });
    const r = await ask('one more');
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('say_at_limit');
    expect(paths.says).toHaveLength(1);
    expect((await stored()).team).toHaveLength(1);
  });
});

describe('replyToAgent', () => {
  it('refuses at the machine\'s live limit (15), the owner\'s reply too, before anything is written', () => {
    paths.reply = null;
    appendThreadEntry(root, 'gantt', { runId: RUN, kind: 'user', text: 'x', via: 'dashboard' });
    live.active.add('gantt');
    live.turns = 15;
    for (const via of ['super', 'dashboard'] as const) {
      const r = replyToAgent(root, { slug: 'gantt', runId: RUN, text: 'more', via });
      expect(r).toMatchObject({ ok: false, status: 429, code: 'say_at_limit' });
    }
  });
});

describe('Super\'s words are never the owner\'s answer (noAnswer)', () => {
  it('a question waiting on the run when Super\'s follow-up is delivered stays open: a plain message, never resumeWithAnswer', async () => {
    paths.reply = null;
    appendThreadEntry(root, 'gantt', { runId: RUN, kind: 'user', text: 'x', via: 'super' });
    live.active.add('gantt');
    // The race: the question appears after team-ask checked, before the reply reaches the run.
    createQuestion(root, { slug: 'gantt', runFiredAt: RUN, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish it?', choices: [] });
    const r = replyToAgent(root, { slug: 'gantt', runId: RUN, text: 'Also rename Ozan.', via: 'super' });
    expect(r).toMatchObject({ ok: true, body: { answers: false } });
    await vi.waitFor(() => expect(turns.messages).toEqual(['Also rename Ozan.']));
    expect(turns.answers).toEqual([]);
    expect(listQuestions(root, 'gantt').filter((q) => q.state === 'pending')).toHaveLength(1);
  });

  it('the owner\'s own reply still answers it (unchanged)', async () => {
    paths.reply = null;
    appendThreadEntry(root, 'gantt', { runId: RUN, kind: 'user', text: 'x', via: 'dashboard' });
    live.active.add('gantt');
    createQuestion(root, { slug: 'gantt', runFiredAt: RUN, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Publish it?', choices: [] });
    const r = replyToAgent(root, { slug: 'gantt', runId: RUN, text: 'Yes, publish.', via: 'dashboard' });
    expect(r).toMatchObject({ ok: true, body: { answers: true } });
    await vi.waitFor(() => expect(turns.answers).toEqual(['Yes, publish.']));
    expect(turns.messages).toEqual([]);
  });
});

describe('the record keeps the card true', () => {
  const job = (id: string, extra: Partial<SuperTeamJob> = {}): SuperTeamJob => ({ id, member: 'gantt', runId: RUN, jobKind: 'run', queued: false, brief: id, startedAt: 0, ...extra });

  it('the trim drops the oldest follow-ups first and never a member\'s current root', () => {
    const r0 = job('team-root-old', { startedAt: 1 });
    const follow = Array.from({ length: MAX_TEAM_JOBS + 3 }, (_, i) => job(`team-fu-${i}`, { startedAt: 2 + i, followUpOf: r0.id, jobKind: 'reply' }));
    const list = [...follow].reverse().concat([r0]);
    const kept = trimTeamJobs(list);
    expect(kept).toHaveLength(MAX_TEAM_JOBS);
    expect(kept.some((j) => j.id === r0.id)).toBe(true);
    expect(kept.some((j) => j.id === 'team-fu-0')).toBe(false);
    // A record read from disk is cut the same way.
    expect(sanitizeSuperState({ ...emptySuperState(), session: SUPER, team: list }).team.some((j) => j.id === r0.id)).toBe(true);
  });

  it('first boot collapses a member\'s cards into one: the newest keeps its place and size, groups and view follow; idempotent', () => {
    const a = job('team-aaa-000001', { startedAt: 1 });
    const b = job('team-aaa-000002', { startedAt: 2 });
    const c = job('team-aaa-000003', { startedAt: 3 });
    const other = { ...job('team-bbb-000001', { startedAt: 4 }), member: 'pixel' };
    const raw = {
      ...emptySuperState(), session: SUPER, enabled: true,
      team: [other, c, b, a],
      containers: [
        { id: 'team-old-1', kind: 'team', ref: a.id, shape: 'square', place: 'float' },
        { id: 'team-old-2', kind: 'team', ref: b.id, shape: 'square', place: 'others' },
        { id: 'team-old-3', kind: 'team', ref: c.id, shape: 'square', place: 'float', size: 'large', sizeBy: 'owner', pos: { x: 0.4, y: 0.2 } },
        { id: 'team-old-4', kind: 'team', ref: other.id, shape: 'square', place: 'float' },
      ],
      groups: [{ id: 'grp-x', name: 'pair', cards: ['team-old-3', 'team-old-4'], place: 'float' }],
      view: { mode: 'half', card: 'team-old-3' },
    };
    const once = sanitizeSuperState(raw);
    const gantt = once.containers.filter((x) => x.kind === 'team' && x.ref === c.id);
    expect(gantt).toEqual([expect.objectContaining({ id: memberTeamCardId('gantt'), ref: c.id, place: 'float', size: 'large', pos: { x: 0.4, y: 0.2 } })]);
    expect(once.containers.filter((x) => x.kind === 'team')).toHaveLength(2);
    expect(once.containers.some((x) => x.ref === a.id || x.ref === b.id)).toBe(false);
    expect(once.groups[0]?.cards).toEqual([memberTeamCardId('gantt'), memberTeamCardId('pixel')]);
    expect(once.view.card).toBe(memberTeamCardId('gantt'));
    const twice = sanitizeSuperState(JSON.parse(JSON.stringify(once)));
    expect(twice.containers).toEqual(once.containers);
    expect(twice.groups).toEqual(once.groups);
  });

  it('Super\'s own follow-up is never "the owner wrote to the member"', () => {
    const r0 = job('team-root-000001', { startedAt: 1, told: 'done' });
    const fu = job('team-fu-0000001', { startedAt: 2, followUpOf: r0.id, by: 'super', jobKind: 'reply', brief: 'Rename Ozan' });
    const s: SuperState = { ...emptySuperState(), session: SUPER, enabled: true, team: [fu, r0] };
    const lines = teamItemLines(root, 'acme', s, { id: 'q-1', sessionId: SUPER, kind: 'stuck', state: 'pending', createdAt: 3, team: fu.id }).join('\n');
    expect(lines).not.toContain('The owner wrote');
    expect(lines).not.toContain('followup=owner');
    expect(lines).toContain('followup=super');
    expect(lines).toContain('Brief: Rename Ozan');
  });

  it('`super open team <job>` opens that job\'s member\'s one card, whichever job is named', async () => {
    for (const t of ['one', 'two']) expect((await ask(t)).status).toBe(200);
    const s = await stored();
    const fu = s.team.find((j) => j.followUpOf)!;
    const r = await verb('open', { kind: 'team', ref: fu.id });
    expect(r.status).toBe(200);
    expect(teamCards(await stored())).toEqual([expect.objectContaining({ id: memberTeamCardId('gantt'), ref: roots(s)[0].id })]);
  });
});
