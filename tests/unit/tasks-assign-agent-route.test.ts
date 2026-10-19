/**
 * POST /api/tasks/:slug/assign-agent (src/server/routes/tasks.ts). The run itself is doubled:
 * the route must start the EXISTING ask run on the agent's call target with the task as data,
 * and never spawn anything for a refusal.
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

const { handleTasksAssignAgent, handleTasksUpdate } = await import('../../src/server/routes/tasks.js');
const { currentAutomationJob } = await import('../../src/server/automation-job.js');
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

async function settled(slug: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const job = currentAutomationJob(contextRoot, slug);
    if (job && job.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
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
  it('202: sets agent:, moves an open task, and runs the call target with the task and the owner note', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    writeTask('fix-login');
    const { res, status, body } = makeRes();
    await handleTasksAssignAgent(req('POST', { agent: 'scout', note: 'Start with the tests.' }), res, { slug: 'fix-login' }, contextRoot);
    expect(status()).toBe(202);
    expect(body()).toMatchObject({ jobId: expect.any(String), runId: expect.any(String), statusMoved: true });
    await settled('scout');

    expect(runAutomation).toHaveBeenCalledTimes(1);
    const [, slug, opts] = runAutomation.mock.calls[0];
    expect(slug).toBe('scout');
    expect(opts).toMatchObject({
      target: 'agent', ask: 'Start with the tests.', task: { slug: 'fix-login', name: 'Fix login' },
    });
    expect(opts.fireAt.toISOString()).toBe(body().runId);

    const text = readFileSync(taskPath('fix-login'), 'utf-8');
    expect(text).toMatch(/^agent: scout$/m);
    expect(text).toMatch(/^status: in_progress$/m);
    expect(text).toContain('- Run ');
  });

  it('409 for an agent approved only through its job, naming the Agents page; nothing written or run', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' });
    createAutomation(contextRoot, { slug: 'daily-notes', title: 'Daily notes', agent: 'writer', days: 'daily', at: '08:00' }, { approve: { now: NOW } });
    writeTask('fix-login');
    const before = readFileSync(taskPath('fix-login'), 'utf-8');
    const { res, status, body } = makeRes();
    await handleTasksAssignAgent(req('POST', { agent: 'writer' }), res, { slug: 'fix-login' }, contextRoot);
    expect(status()).toBe(409);
    expect(body().error).toBe('agent_not_approved_to_run');
    expect(String(body().message)).toContain('Agents page');
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
  });
});
