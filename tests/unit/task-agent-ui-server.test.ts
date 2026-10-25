/**
 * AI Team v2 C2, the server half of the task UI: the task read carries its agent job (the list a
 * display projection, the single read its deliveries, this machine's rows and the live session)
 * and who moved its status; the drawer answers the job through `POST /:slug/agent-action`; the
 * notch lists every project's task rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const hosts = vi.hoisted(() => [] as Array<{ slug: string; runId: string }>);
vi.mock('../../src/lib/agents/task-starter.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/agents/task-starter.js')>();
  return {
    ...orig,
    startDueTaskJobs: (root: string, deps: Parameters<typeof orig.startDueTaskJobs>[1] = {}) =>
      orig.startDueTaskJobs(root, { ...deps, spawnHost: (_r, slug, runId) => { hosts.push({ slug, runId }); return 4_700_000 + hosts.length; } }),
  };
});

const { handleTasksAssignAgent, handleTasksGet, handleTasksList, handleTasksAgentAction, handleTasksUpdate } = await import('../../src/server/routes/tasks.js');
const { reconcileTaskRows } = await import('../../src/lib/agents/task-starter.js');
const { raiseInboxRow, listInboxRows } = await import('../../src/lib/owner-inbox.js');
const { createAgent } = await import('../../src/lib/agents/store.js');
const { agentJobOf } = await import('../../src/lib/agents/task-job-api.js');
const { ownerTaskRows } = await import('../../src/server/assistant-inbox.js');

const NOW = new Date('2026-10-12T09:00:00.000Z');
let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, any> } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, any> };
}

function req(method: string, body?: unknown, url = '/', remote = '127.0.0.1'): IncomingMessage {
  const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')]);
  return Object.assign(readable, { method, url, headers: { host: 'localhost' }, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;
}

const taskPath = (slug: string) => join(contextRoot, 'state', `${slug}.md`);

function writeTask(slug: string, front: string[] = [], changelog: string[] = []): void {
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(taskPath(slug), ['---', `id: task_${slug.slice(0, 6)}`, `name: ${slug}`, 'status: in_review', 'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', ...front, '---', '', '## Changelog', '', ...changelog, ''].join('\n'));
}

beforeEach(() => {
  hosts.length = 0;
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-c2-ui-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-c2-ui-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('the task read carries its agent job (C2)', () => {
  const delivered = [
    'agent: scout',
    'reviewer: critic',
    'agent_state: queued',
    'agent_step: rework',
    'agent_workspace: code',
    'agent_repo: app',
    'review_round: 2',
    'review_cap: 3',
    'deliveries: [{round: 1, at: "2026-10-11T10:00:00.000Z", by: scout, note: "First go", refs: [{kind: doc, path: knowledge/plan.md}, {kind: bogus, path: x}], branch: super/task-abc, commits: ["abc123 First"]}, {round: 2, at: "2026-10-12T08:00:00.000Z", by: scout, note: "Second go", refs: []}]',
  ];
  const history = [
    '### 2026-10-12 - Status → in_progress (by reviewer:critic)', '- Review round 2: sent back.',
    '### 2026-10-12 - Status → in_review (by agent:scout)', '- Delivered round 2.',
    '### 2026-10-11 - Status → in_review (by agent:scout)', '- Delivered round 1.',
    '### 2026-10-10 - Status → in_progress (by owner)',
  ];

  it('the single read: deliveries (unknown ref kinds dropped), this machine\'s rows, the live session, the status history', async () => {
    writeTask('fix-login', delivered, history);
    raiseInboxRow(projectRoot, { kind: 'task-stuck', ref: 'fix-login', agent: 'critic', title: 'Stuck', actions: ['one-more-round', 'take-over', 'cancel'], dedupeKey: 'task-stuck:task_fix-lo' });
    raiseInboxRow(projectRoot, { kind: 'task-stuck', ref: 'other-task', agent: 'critic', title: 'Other', actions: ['cancel'], dedupeKey: 'task-stuck:task_other-' });
    const r = makeRes();
    await handleTasksGet(req('GET'), r.res, { slug: 'fix-login' }, contextRoot);
    expect(r.status()).toBe(200);
    const job = r.body().task.agent_job;
    expect(job).toMatchObject({ state: 'queued', step: 'rework', round: 2, cap: 3, reviewer: 'critic', workspace: 'code', repo: 'app', reviewPassed: false, sessionId: null });
    expect(job.deliveries).toHaveLength(2);
    expect(job.deliveries[0]).toMatchObject({ round: 1, note: 'First go', refs: [{ kind: 'doc', path: 'knowledge/plan.md' }], branch: 'super/task-abc', commits: ['abc123 First'] });
    expect(job.rows.map((x: { title: string }) => x.title)).toEqual(['Stuck']);
    expect(r.body().task.status_history.map((h: { by: string | null }) => h.by)).toEqual(['reviewer:critic', 'agent:scout', 'agent:scout', 'owner']);
    expect(r.body().task.status_history[0].reason).toBe('Review round 2: sent back.');
  });

  it('the list carries the display projection only; a task no agent was given has none', async () => {
    writeTask('fix-login', delivered, history);
    writeTask('plain');
    const r = makeRes();
    await handleTasksList(req('GET'), r.res, {}, contextRoot);
    const bySlug = new Map((r.body().tasks as Array<{ slug: string; agent_job: unknown }>).map((t) => [t.slug, t.agent_job]));
    expect(bySlug.get('plain')).toBeNull();
    expect(bySlug.get('fix-login')).toMatchObject({ state: 'queued', round: 2 });
    expect(bySlug.get('fix-login')).not.toHaveProperty('deliveries');
  });

  it('agentJobOf clamps the cap, ignores an unknown state and says why a job is blocked or stopped', () => {
    expect(agentJobOf({ agent: 'scout', agent_state: 'exploded', review_cap: 99 })).toMatchObject({ state: null, cap: 10 });
    expect(agentJobOf({ agent: 'scout', agent_state: 'blocked', agent_blocked: 'repo missing', agent_stopped: 'x' })).toMatchObject({ reason: 'repo missing' });
    expect(agentJobOf({ agent: 'scout', agent_state: 'stopped', agent_stopped: 'ended ok without delivering' })).toMatchObject({ reason: 'ended ok without delivering' });
    expect(agentJobOf({})).toBeNull();
  });
});

describe('POST /api/tasks/:slug/agent-action (C2)', () => {
  it('reschedules and starts a scheduled job, closes the rows that offered the action, refuses what does not apply', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    writeTask('fix-login');
    await handleTasksAssignAgent(req('POST', { agent: 'scout', startAt: '2099-01-01T09:00:00+03:00' }), makeRes().res, { slug: 'fix-login' }, contextRoot);
    expect(readFileSync(taskPath('fix-login'), 'utf-8')).toMatch(/^agent_state: scheduled$/m);

    const moved = makeRes();
    await handleTasksAgentAction(req('POST', { action: 'reschedule', text: '2099-02-01T10:00:00+03:00' }), moved.res, { slug: 'fix-login' }, contextRoot);
    expect(moved.status()).toBe(200);
    expect(readFileSync(taskPath('fix-login'), 'utf-8')).toMatch(/^agent_start_at: .*2099-02-01T07:00:00/m);

    raiseInboxRow(projectRoot, { kind: 'task-start-missed', ref: 'fix-login', agent: 'scout', title: 'Missed', actions: ['start-now', 'reschedule'], dedupeKey: 'task-start-missed:task_fix-lo' });
    const now = makeRes();
    await handleTasksAgentAction(req('POST', { action: 'start-now' }), now.res, { slug: 'fix-login' }, contextRoot);
    expect(now.status()).toBe(200);
    // Due now (the spawn itself is the drain's, covered by the C1 tests): the start moved off 2099.
    expect(readFileSync(taskPath('fix-login'), 'utf-8')).not.toMatch(/^agent_start_at: .*2099/m);
    expect(listInboxRows(projectRoot).filter((r) => r.ref === 'fix-login')).toEqual([]);

    const bad = makeRes();
    await handleTasksAgentAction(req('POST', { action: 'explode' }), bad.res, { slug: 'fix-login' }, contextRoot);
    expect([bad.status(), bad.body().error]).toEqual([400, 'bad_action']);

    writeTask('nobody');
    const refused = makeRes();
    await handleTasksAgentAction(req('POST', { action: 'start-now' }), refused.res, { slug: 'nobody' }, contextRoot);
    expect([refused.status(), refused.body().error]).toEqual([409, 'not_assigned_here']);
  });
});

describe('the drawer answers only what holds, and only its owner (C2 end review r1)', () => {
  function teammates(slug: string): void {
    const path = join(contextRoot, 'agents', `${slug}.md`);
    writeFileSync(path, readFileSync(path, 'utf-8').replace(/^owner:.*$/m, 'owner: alice'));
  }

  it('a teammate\'s agent: every drawer action and the board\'s unassign answer 403 not_owner, nothing changes', async () => {
    createAgent(contextRoot, { slug: 'helper', title: 'Helper', prompt: 'Help.' }, { approve: { now: NOW } });
    teammates('helper');
    writeTask('shared-task', ['agent: helper', 'agent_state: delivered', 'review_round: 1']);
    const before = readFileSync(taskPath('shared-task'), 'utf-8');
    for (const action of ['complete', 'stop', 'take-over', 'cancel', 'send-back']) {
      const r = makeRes();
      await handleTasksAgentAction(req('POST', { action, text: 'x' }), r.res, { slug: 'shared-task' }, contextRoot);
      expect([action, r.status(), r.body().error]).toEqual([action, 403, 'not_owner']);
    }
    const off = makeRes();
    await handleTasksUpdate(req('PATCH', { agent: null }), off.res, { slug: 'shared-task' }, contextRoot);
    expect([off.status(), off.body().error]).toEqual([403, 'not_owner']);
    // Nor is the task handed to one of mine over the teammate's agent.
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    const over = makeRes();
    await handleTasksAssignAgent(req('POST', { agent: 'scout' }), over.res, { slug: 'shared-task' }, contextRoot);
    expect([over.status(), over.body().error]).toEqual([403, 'not_owner']);
    expect(readFileSync(taskPath('shared-task'), 'utf-8')).toBe(before);
  });

  it('complete signs off only a delivery, then the task is closed', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    writeTask('fix-login', ['agent: scout', 'agent_state: running', 'agent_step: rework', 'review_round: 1']);
    const early = makeRes();
    await handleTasksAgentAction(req('POST', { action: 'complete' }), early.res, { slug: 'fix-login' }, contextRoot);
    expect([early.status(), early.body().error]).toEqual([409, 'not_delivered']);
    expect(readFileSync(taskPath('fix-login'), 'utf-8')).toMatch(/^status: in_review$/m);

    writeFileSync(taskPath('fix-login'), readFileSync(taskPath('fix-login'), 'utf-8').replace(/^agent_state: running$/m, 'agent_state: delivered'));
    const ok = makeRes();
    await handleTasksAgentAction(req('POST', { action: 'complete' }), ok.res, { slug: 'fix-login' }, contextRoot);
    expect(ok.status()).toBe(200);
    expect(readFileSync(taskPath('fix-login'), 'utf-8')).toMatch(/^status: completed$/m);
  });

  it('start-now on a job that no longer waits to start is refused (it was not patched)', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    writeTask('fix-login');
    await handleTasksAssignAgent(req('POST', { agent: 'scout', startAt: '2099-01-01T09:00:00+03:00' }), makeRes().res, { slug: 'fix-login' }, contextRoot);
    writeFileSync(taskPath('fix-login'), readFileSync(taskPath('fix-login'), 'utf-8').replace(/^agent_state: scheduled$/m, 'agent_state: running'));
    const r = makeRes();
    await handleTasksAgentAction(req('POST', { action: 'start-now' }), r.res, { slug: 'fix-login' }, contextRoot);
    expect([r.status(), r.body().error]).toEqual([409, 'not_waiting']);
    expect(readFileSync(taskPath('fix-login'), 'utf-8')).toMatch(/^agent_start_at: .*2099/m);
  });

  it('a renamed task keeps its rows: the drawer finds them by id, the reconciler moves their ref, the notch opens the new slug', async () => {
    mkdirSync(join(fakeHome, '.dreamcontext'), { recursive: true });
    writeFileSync(join(fakeHome, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: projectRoot }] }));
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    // Raised while the task was `old-name`; the task (same id) is now `new-name`.
    writeTask('new-name', ['id: task_old-na', 'agent: scout', 'agent_state: stuck', 'review_round: 5']);
    writeFileSync(taskPath('new-name'), readFileSync(taskPath('new-name'), 'utf-8').replace(/^id: task_new-na\n/m, ''));
    raiseInboxRow(projectRoot, { kind: 'task-stuck', ref: 'old-name', agent: 'scout', title: 'Stuck', actions: ['one-more-round', 'take-over', 'cancel'], dedupeKey: 'task-stuck:task_old-na' });

    expect(ownerTaskRows().map((r) => r.task)).toEqual(['new-name']);
    const g = makeRes();
    await handleTasksGet(req('GET'), g.res, { slug: 'new-name' }, contextRoot);
    expect(g.body().task.agent_job.rows.map((x: { title: string }) => x.title)).toEqual(['Stuck']);
    reconcileTaskRows(contextRoot);
    expect(listInboxRows(projectRoot).map((r) => r.ref)).toEqual(['new-name']);
  });
});

describe('the notch lists every project\'s task rows (C2)', () => {
  it('task rows only, newest first, with the project they belong to', () => {
    mkdirSync(join(fakeHome, '.dreamcontext'), { recursive: true });
    writeFileSync(join(fakeHome, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'acme', path: projectRoot }] }));
    raiseInboxRow(projectRoot, { kind: 'task-review', ref: 'fix-login', agent: 'scout', title: 'Scout did it', actions: ['complete', 'send-back'], dedupeKey: 'a' }, undefined, new Date('2026-10-12T09:00:00Z'));
    raiseInboxRow(projectRoot, { kind: 'task-stuck', ref: 'other', agent: 'critic', title: 'Stuck', actions: ['cancel'], dedupeKey: 'b' }, undefined, new Date('2026-10-12T10:00:00Z'));
    raiseInboxRow(projectRoot, { kind: 'renamed', ref: 'scout', agent: 'scout', title: 'Renamed', actions: ['dismiss'], dedupeKey: 'c' });
    const rows = ownerTaskRows();
    expect(rows.map((r) => [r.vault, r.task, r.kind])).toEqual([['acme', 'other', 'task-stuck'], ['acme', 'fix-login', 'task-review']]);
  });
});
