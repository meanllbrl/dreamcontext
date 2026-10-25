/**
 * POST /api/tasks/:slug/assign-agent (src/server/routes/tasks.ts). Since AI Team v2 C1 the route
 * runs nothing in-process: it commits the assignment and drains once, and a due step is handed to
 * a detached task host (doubled here: `spawnHost` records it). A busy agent queues the task
 * instead of answering 409, and a refusal writes and starts nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const runAutomation = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/automations/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/automations/runner.js')>()),
  runAutomation,
}));

const hosts = vi.hoisted(() => [] as Array<{ slug: string; runId: string }>);
vi.mock('../../src/lib/agents/task-starter.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/agents/task-starter.js')>();
  return {
    ...orig,
    startDueTaskJobs: (root: string, deps: Parameters<typeof orig.startDueTaskJobs>[1] = {}) =>
      orig.startDueTaskJobs(root, { ...deps, spawnHost: (_r, slug, runId) => { hosts.push({ slug, runId }); return 4_600_000 + hosts.length; } }),
  };
});

const { handleTasksAssignAgent, handleTasksUpdate } = await import('../../src/server/routes/tasks.js');
const { readTaskJobs } = await import('../../src/lib/agents/task-jobs.js');
const { parseStatusHistory } = await import('../../src/lib/task-history.js');
const { createAgent } = await import('../../src/lib/agents/store.js');
const { createAutomation } = await import('../../src/lib/automations/store.js');

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
}

function req(method: string, body?: unknown): IncomingMessage {
  const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')]);
  return Object.assign(readable, { method, headers: {} }) as unknown as IncomingMessage;
}

const NOW = new Date('2026-10-12T09:00:00.000Z');
let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

function taskPath(slug: string): string {
  return join(contextRoot, 'state', `${slug}.md`);
}

function writeTask(slug: string, status = 'todo'): void {
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(taskPath(slug), ['---', 'id: task_t1', 'name: Fix login', `status: ${status}`, 'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', '---', '', '## Changelog', ''].join('\n'));
}

beforeEach(() => {
  hosts.length = 0;
  runAutomation.mockReset();
  runAutomation.mockResolvedValue({
    slug: 'scout', status: 'ok', outputPath: null, error: null, durationMs: 1, event: null, cache: null,
    denials: 0, costUsd: null, reviewCardId: null,
  });
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-assign-route-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-assign-route-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('POST /api/tasks/:slug/assign-agent', () => {
  it('202: sets agent:, moves an open task, and hands the due step to a detached host with the owner note', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    writeTask('fix-login');
    const { res, status, body } = makeRes();
    await handleTasksAssignAgent(req('POST', { agent: 'scout', note: 'Start with the tests.' }), res, { slug: 'fix-login' }, contextRoot);
    expect(status()).toBe(202);
    expect(body()).toMatchObject({ runId: expect.stringMatching(/^tr_/), statusMoved: true, state: 'starting', step: 'work', started: true });
    expect(hosts).toEqual([{ slug: 'fix-login', runId: body().runId }]);
    expect(runAutomation).not.toHaveBeenCalled();
    // The owner's note waits for the step's brief in the machine-local store, never in the task file.
    expect(readTaskJobs(projectRoot).notes).toEqual([expect.objectContaining({ kind: 'assign', text: 'Start with the tests.' })]);

    const text = readFileSync(taskPath('fix-login'), 'utf-8');
    expect(text).toMatch(/^agent: scout$/m);
    expect(text).toMatch(/^status: in_progress$/m);
    expect(text).toMatch(/^agent_state: starting$/m);
    expect(text).not.toContain('Start with the tests.');
  });

  it('a busy agent queues the task (no more 409 agent_busy); a future start is scheduled', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    writeTask('fix-login');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(taskPath('second'), ['---', 'id: task_t2', 'name: Second', 'status: todo', '---', '', '## Changelog', ''].join('\n'));
    writeFileSync(taskPath('later'), ['---', 'id: task_t3', 'name: Later', 'status: todo', '---', '', '## Changelog', ''].join('\n'));
    await handleTasksAssignAgent(req('POST', { agent: 'scout' }), makeRes().res, { slug: 'fix-login' }, contextRoot);
    const busy = makeRes();
    await handleTasksAssignAgent(req('POST', { agent: 'scout' }), busy.res, { slug: 'second' }, contextRoot);
    expect(busy.status()).toBe(202);
    expect(busy.body()).toMatchObject({ state: 'queued', started: false });
    const later = makeRes();
    await handleTasksAssignAgent(req('POST', { agent: 'scout', startAt: '2099-01-01T09:00:00+03:00' }), later.res, { slug: 'later' }, contextRoot);
    expect(later.body()).toMatchObject({ state: 'scheduled', started: false });
    expect(hosts).toHaveLength(1);
  });

  it('400 for a naive start or the agent as its own reviewer; 404 for an unknown reviewer', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    writeTask('fix-login');
    const cases: [unknown, number, string][] = [
      [{ agent: 'scout', startAt: '2026-10-26 09:00' }, 400, 'invalid_start'],
      [{ agent: 'scout', reviewer: 'scout' }, 400, 'reviewer_is_agent'],
      [{ agent: 'scout', reviewer: 'ghost' }, 404, 'unknown_reviewer'],
      [{ agent: 'scout', workspace: 'disk' }, 400, 'invalid_workspace'],
    ];
    for (const [b, code, error] of cases) {
      const r = makeRes();
      await handleTasksAssignAgent(req('POST', b), r.res, { slug: 'fix-login' }, contextRoot);
      expect([r.status(), r.body().error]).toEqual([code, error]);
    }
    expect(hosts).toEqual([]);
  });

  it('409 for an agent approved only through its job, naming the AI Team page; nothing written or run', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' });
    createAutomation(contextRoot, { slug: 'daily-notes', title: 'Daily notes', agent: 'writer', days: 'daily', at: '08:00' }, { approve: { now: NOW } });
    writeTask('fix-login');
    const before = readFileSync(taskPath('fix-login'), 'utf-8');
    const { res, status, body } = makeRes();
    await handleTasksAssignAgent(req('POST', { agent: 'writer' }), res, { slug: 'fix-login' }, contextRoot);
    expect(status()).toBe(409);
    expect(body().error).toBe('agent_not_approved_to_run');
    expect(String(body().message)).toContain('AI Team page');
    expect(String(body().message)).not.toContain('dreamcontext');
    expect(readFileSync(taskPath('fix-login'), 'utf-8')).toBe(before);
    expect(runAutomation).not.toHaveBeenCalled();
  });

  it('400 without an agent, 404 for an unknown task or agent, 400 for an unsafe slug', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    writeTask('fix-login');
    const cases: [string, unknown, number][] = [
      ['fix-login', {}, 400],
      ['nope', { agent: 'scout' }, 404],
      ['fix-login', { agent: 'nobody' }, 404],
      ['../x', { agent: 'scout' }, 400],
    ];
    for (const [slug, b, code] of cases) {
      const { res, status } = makeRes();
      await handleTasksAssignAgent(req('POST', b), res, { slug }, contextRoot);
      expect(status()).toBe(code);
    }
    expect(runAutomation).not.toHaveBeenCalled();
  });
});

describe('PATCH agent', () => {
  it('accepts an existing agent or null, and refuses anything else', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' });
    writeTask('fix-login');
    const bad = makeRes();
    await handleTasksUpdate(req('PATCH', { agent: '../evil' }), bad.res, { slug: 'fix-login' }, contextRoot);
    expect(bad.status()).toBe(400);
    const unknown = makeRes();
    await handleTasksUpdate(req('PATCH', { agent: 'nobody' }), unknown.res, { slug: 'fix-login' }, contextRoot);
    expect(unknown.status()).toBe(400);
    const ok = makeRes();
    await handleTasksUpdate(req('PATCH', { agent: 'scout' }), ok.res, { slug: 'fix-login' }, contextRoot);
    expect(ok.status()).toBe(200);
    expect(readFileSync(taskPath('fix-login'), 'utf-8')).toMatch(/^agent: scout$/m);
    expect(runAutomation).not.toHaveBeenCalled();
    expect(hosts).toEqual([]);
  });

  it('a status moved from the dashboard is the owner\'s (provenance); clearing the agent ends its job', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    writeTask('fix-login');
    await handleTasksAssignAgent(req('POST', { agent: 'scout' }), makeRes().res, { slug: 'fix-login' }, contextRoot);
    const moved = makeRes();
    await handleTasksUpdate(req('PATCH', { status: 'in_review' }), moved.res, { slug: 'fix-login' }, contextRoot);
    expect(moved.status()).toBe(200);
    expect(parseStatusHistory(readFileSync(taskPath('fix-login'), 'utf-8'))[0]).toMatchObject({ to: 'in_review', by: 'owner' });
    const cleared = makeRes();
    await handleTasksUpdate(req('PATCH', { agent: null }), cleared.res, { slug: 'fix-login' }, contextRoot);
    expect(cleared.status()).toBe(200);
    const text = readFileSync(taskPath('fix-login'), 'utf-8');
    expect(text).toMatch(/^agent: null$/m);
    expect(text).toMatch(/^agent_state: (stopped|null)$/m);
    expect(readTaskJobs(projectRoot).claims).toEqual([]);
    expect(readTaskJobs(projectRoot).meta).toEqual([]);
  });
});
