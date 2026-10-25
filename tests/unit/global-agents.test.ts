/**
 * AI Team v2 D1: global agents. One agent of this machine, listed in every project, kept out of
 * every brain; its project side per project, so runs in two projects never share a lock; its
 * memory a journal any number of runs append to, folded by one consolidator at a time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createProgram } from '../../src/cli/program.js';
import { createAgent, createGlobalAgent, getAgent, listAgents, readGlobalAgent, recordAgentLesson, removeAgent } from '../../src/lib/agents/store.js';
import { GLOBAL_REGISTRY_KEY, globalAgentHome, globalAgentPath, globalProjectDir } from '../../src/lib/agents/scope.js';
import { appendGlobalJournal, consolidateGlobalMemory, journalDir, readGlobalPattern } from '../../src/lib/agents/global-memory.js';
import { getRunTarget, lockPathFor, outputDirFor, sidecarPathFor } from '../../src/lib/automations/store.js';
import { threadSlugDir } from '../../src/lib/automations/threads.js';
import { checkApproval, listRegisteredProjects, readAutomationsRegistry, registerProject } from '../../src/lib/automations/registry.js';
import { prepareAgentChat } from '../../src/lib/whiteboards/card-chat.js';
import { handleAgentsCreate, handleAgentsDelete, handleLauncherGlobalAgents, handleLauncherGlobalAgentsCreate, listAgentSummaries } from '../../src/server/routes/agents.js';
import { handleTasksAssignAgent } from '../../src/server/routes/tasks.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { noteShadowedGlobalAgents, startDueTaskJobs } from '../../src/lib/agents/task-starter.js';
import { readTaskJobs } from '../../src/lib/agents/task-jobs.js';
import { listInboxRows, resolveInboxRow } from '../../src/lib/owner-inbox.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cwd: string;
let realHome: string | undefined;
let fakeHome: string;
let a: { project: string; context: string };
let b: { project: string; context: string };

function makeProject(prefix: string): { project: string; context: string } {
  const project = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const context = join(project, '_dream_context');
  mkdirSync(join(context, 'state'), { recursive: true });
  return { project, context };
}

/** Every file and folder under a brain, relative. */
function brainPaths(context: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      out.push(relative(context, abs));
      if (statSync(abs).isDirectory()) walk(abs);
    }
  };
  walk(context);
  return out;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...x: unknown[]) => { lines.push(x.join(' ')); }));
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

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

function req(body?: unknown, socket: object = { remoteAddress: '127.0.0.1' }): IncomingMessage {
  const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')]);
  return Object.assign(readable, { method: 'POST', url: '/', headers: { host: 'localhost' }, socket }) as unknown as IncomingMessage;
}

const NOW = new Date('2026-10-25T09:00:00.000Z');
const scout = { slug: 'scout', title: 'Scout', prompt: 'You find things out.' };

beforeEach(() => {
  cwd = process.cwd();
  realHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dc-global-home-')));
  process.env.HOME = fakeHome;
  a = makeProject('dc-global-a-');
  b = makeProject('dc-global-b-');
  registerProject(a.project);
  registerProject(b.project);
});

afterEach(() => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  for (const d of [fakeHome, a.project, b.project]) rmSync(d, { recursive: true, force: true });
});

describe('a global agent is created once and listed in every project (AC-D1-1)', () => {
  it('the CLI: `agents create --scope global` lands on this machine, both projects list it as global and may run it, neither brain holds anything of it', async () => {
    process.chdir(a.project);
    const before = { a: brainPaths(a.context), b: brainPaths(b.context) };
    const { code, out } = await run(['agents', 'create', 'scout', '--title', 'Scout', '--prompt', 'You find things out.', '--scope', 'global']);
    expect(code, out).toBe(0);
    expect(existsSync(globalAgentPath('scout'))).toBe(true);
    for (const p of [a, b]) {
      const agent = listAgents(p.context).find((x) => x.slug === 'scout');
      expect(agent?.scope).toBe('global');
      const summary = listAgentSummaries(p.context).find((x) => x.slug === 'scout');
      expect(summary).toMatchObject({ scope: 'global', approvedToRun: true, readOnly: false, arrivedBySync: false });
    }
    // One grant, in the machine's `global` bucket: no project bucket holds it.
    const registry = readAutomationsRegistry();
    expect(registry.projects[GLOBAL_REGISTRY_KEY]?.agentApprovals?.scout).toBeTruthy();
    expect(listRegisteredProjects()).not.toContain(GLOBAL_REGISTRY_KEY);
    expect({ a: brainPaths(a.context), b: brainPaths(b.context) }).toEqual(before);
    expect((await run(['agents', 'create', 'x', '--title', 'X', '--prompt', 'P', '--scope', 'everywhere'])).code).not.toBe(0);
  });

  it('the launcher: POST then GET /api/launcher/global-agents, with no project at all; POST /api/agents {scope: global} from a project; a name a project member holds is refused', async () => {
    const created = makeRes();
    await handleLauncherGlobalAgentsCreate(req({ title: 'Scout', prompt: 'You find things out.' }), created.res, {}, null);
    expect(created.status()).toBe(201);
    expect(created.body().agent).toMatchObject({ slug: 'scout', title: 'Scout', approvedToRun: true });
    const listed = makeRes();
    await handleLauncherGlobalAgents(req(), listed.res, {}, null);
    expect(listed.body().agents.map((x: { slug: string }) => x.slug)).toEqual(['scout']);

    const fromProject = makeRes();
    await handleAgentsCreate(req({ title: 'Critic', prompt: 'You review.', scope: 'global' }), fromProject.res, {}, a.context);
    expect(fromProject.status()).toBe(200);
    expect(fromProject.body().agent).toMatchObject({ slug: 'critic', scope: 'global' });
    expect(listAgents(b.context).map((x) => x.slug)).toEqual(['critic', 'scout']);

    createAgent(a.context, { slug: 'writer', title: 'Writer', prompt: 'You write.' }, { approve: { now: NOW } });
    const clash = makeRes();
    await handleAgentsCreate(req({ title: 'Writer', prompt: 'P', scope: 'global' }), clash.res, {}, a.context);
    expect(clash.status()).toBeGreaterThanOrEqual(400);
    expect(existsSync(globalAgentPath('writer'))).toBe(false);
    // …and a project agent may not take a global agent's name either.
    expect(() => createAgent(b.context, { slug: 'scout', title: 'S', prompt: 'P' })).toThrow(/global agents/);
  });

  it('a project member of the same name wins in its own project only', () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    createAgent(a.context, { slug: 'scout-local', title: 'x', prompt: 'P' });
    mkdirSync(join(a.context, 'automations'), { recursive: true });
    writeFileSync(join(a.context, 'automations', 'scout.md'), '---\ntitle: Scout routine\nagent: scout-local\n---\n\n## Job\n\nx\n');
    expect(getAgent(a.context, 'scout')?.scope).not.toBe('global');
    expect(getAgent(b.context, 'scout')?.scope).toBe('global');
  });
});

describe('its project side is per project, on this machine (AC-D1-2 by construction)', () => {
  it('thread, outputs, run lock, run record: under its folder, one per project, never in a brain', () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    const target = getRunTarget(a.context, 'scout', 'agent')!;
    const [pa, pb] = [globalProjectDir('scout', a.project), globalProjectDir('scout', b.project)];
    expect(pa).not.toBe(pb);
    expect(threadSlugDir(a.context, 'scout').startsWith(pa)).toBe(true);
    expect(threadSlugDir(b.context, 'scout').startsWith(pb)).toBe(true);
    expect(lockPathFor(a.context, 'scout').startsWith(pa)).toBe(true);
    expect(lockPathFor(a.context, 'scout')).not.toBe(lockPathFor(b.context, 'scout'));
    expect(sidecarPathFor(b.context, 'scout').startsWith(pb)).toBe(true);
    expect(outputDirFor(a.context, target).dir.startsWith(pa)).toBe(true);
    // A project member's paths are untouched.
    createAgent(a.context, { slug: 'writer', title: 'Writer', prompt: 'You write.' });
    expect(lockPathFor(a.context, 'writer')).toBe(join(a.context, 'automations', 'cache', '.writer.lock'));
  });

  it('one approval covers every project; a stage conversation opens in each', () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    for (const p of [a, b]) {
      expect(checkApproval(p.project, getRunTarget(p.context, 'scout', 'agent')!).approved).toBe(true);
      expect(prepareAgentChat(p.context, 'scout').ok).toBe(true);
    }
  });

  it('deleting it from a project deletes it everywhere: file, folder, grant', () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    recordAgentLesson(a.context, 'scout', { lesson: 'Check the date first.' });
    expect(removeAgent(b.context, 'scout')).toEqual({ removed: true });
    expect(existsSync(globalAgentPath('scout'))).toBe(false);
    expect(existsSync(globalAgentHome('scout'))).toBe(false);
    expect(listAgents(a.context).some((x) => x.slug === 'scout')).toBe(false);
    expect(readAutomationsRegistry().projects[GLOBAL_REGISTRY_KEY]?.agentApprovals?.scout).toBeUndefined();
  });
});

describe('its memory: a journal, folded by one consolidator at a time (AC-D1-3)', () => {
  it('lessons from two projects both land, in its memory, never in an agent file', () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    recordAgentLesson(a.context, 'scout', { lesson: 'In A, read the brief first.' });
    recordAgentLesson(b.context, 'scout', { lesson: 'In B, ask before deleting.' });
    const pattern = readGlobalAgent('scout')!.pattern;
    expect(pattern).toContain('read the brief first');
    expect(pattern).toContain('ask before deleting');
    expect(readFileSync(globalAgentPath('scout'), 'utf-8')).not.toContain('## Pattern');
    expect(readdirSync(journalDir('scout'))).toEqual([]);
  });

  it('a crash between the write and the deletes never folds a lesson twice', () => {
    appendGlobalJournal('scout', a.project, { lesson: 'one' });
    appendGlobalJournal('scout', b.project, { lesson: 'two' });
    expect(consolidateGlobalMemory('scout', { crashAfterWrite: true }).folded).toBe(2);
    expect(readdirSync(journalDir('scout'))).toHaveLength(2);
    const count = () => (readGlobalPattern('scout').match(/\*\*\[/g) ?? []).length;
    expect(count()).toBe(2);
    expect(consolidateGlobalMemory('scout').folded).toBe(0);
    expect(count()).toBe(2);
    expect(readdirSync(journalDir('scout'))).toEqual([]);
  });

  it('a second consolidator waits for the first, then folds', () => {
    appendGlobalJournal('scout', a.project, { lesson: 'after the wait' });
    const lock = join(globalAgentHome('scout'), 'memory', '.consolidate.lock');
    // Another process holds the lock for ~1.2 s.
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      setTimeout(() => { fs.rmSync(${JSON.stringify(lock)}, { force: true }); process.exit(0); }, 1200);
    `], { stdio: 'ignore' });
    const until = Date.now() + 5000;
    while (!existsSync(lock) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    expect(existsSync(lock)).toBe(true);
    const t0 = Date.now();
    const r = consolidateGlobalMemory('scout', { waitMs: 10_000 });
    expect(r).toEqual({ folded: 1, busy: false });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
    expect(readGlobalPattern('scout')).toContain('after the wait');
    holder.kill();
  });

  it('ten concurrent writers in two projects, each consolidating: nothing is lost', async () => {
    const script = join(fakeHome, 'writer.ts');
    writeFileSync(script, `
      import { appendGlobalJournal, consolidateGlobalMemory } from ${JSON.stringify(join(REPO, 'src/lib/agents/global-memory.ts'))};
      const [project, n] = process.argv.slice(-2);
      appendGlobalJournal('scout', project, { lesson: 'lesson number ' + n });
      consolidateGlobalMemory('scout');
    `);
    const runOne = (project: string, n: number) => new Promise<number>((resolve) => {
      const child = spawn(join(REPO, 'node_modules', '.bin', 'vite-node'), [script, project, String(n)], {
        cwd: REPO, env: { ...process.env, HOME: fakeHome }, stdio: 'ignore',
      });
      child.on('exit', (code) => resolve(code ?? 1));
    });
    const codes = await Promise.all(Array.from({ length: 10 }, (_, i) => runOne(i % 2 ? a.project : b.project, i)));
    expect(codes).toEqual(Array(10).fill(0));
    consolidateGlobalMemory('scout');
    const pattern = readGlobalPattern('scout');
    for (let i = 0; i < 10; i++) expect(pattern, `lesson ${i}`).toContain(`lesson number ${i}`);
    expect(readdirSync(journalDir('scout'))).toEqual([]);
  }, 120_000);
});

describe('end review r1 (D1): what the reviewers found', () => {
  it('the `global` bucket is a name: a project at <cwd>/global keeps its own bucket and never shares the global grants', () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-global-cwd-')));
    const project = join(root, 'global');
    mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
    process.chdir(root);
    try {
      registerProject(project);
      const registry = readAutomationsRegistry();
      expect(registry.projects[project]).toEqual({ approvals: {} });
      expect(registry.projects[GLOBAL_REGISTRY_KEY]?.agentApprovals?.scout).toBeTruthy();
      expect(listRegisteredProjects()).toContain(project);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an unreadable memory is never folded over: the journal keeps the lesson, the memory file is untouched', () => {
    appendGlobalJournal('scout', a.project, { lesson: 'kept before' });
    consolidateGlobalMemory('scout');
    const memory = join(globalAgentHome('scout'), 'memory', 'memory.md');
    const broken = '---\nfolded: [unclosed\n---\n\nThe owner\'s hand edit.\n';
    writeFileSync(memory, broken);
    appendGlobalJournal('scout', a.project, { lesson: 'learned after the edit' });
    expect(consolidateGlobalMemory('scout')).toEqual({ folded: 0, busy: false });
    expect(readFileSync(memory, 'utf-8')).toBe(broken);
    expect(readdirSync(journalDir('scout'))).toHaveLength(1);
    expect(readGlobalPattern('scout')).toContain('learned after the edit');
  });

  it('a routine bound to a global agent is approved in its own project; no automation may take a global agent\'s name', () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    createAutomation(a.context, { slug: 'daily-look', title: 'Daily look', agent: 'scout', job: 'Look around.', days: 'daily', at: '09:00' }, { approve: { now: NOW } });
    const routine = getRunTarget(a.context, 'daily-look', 'automation')!;
    expect(routine.agentScope).toBeUndefined();
    expect(checkApproval(a.project, routine).approved).toBe(true);
    expect(readAutomationsRegistry().projects[GLOBAL_REGISTRY_KEY]?.approvals['daily-look']).toBeUndefined();
    expect(() => createAutomation(b.context, { slug: 'scout', title: 'S', days: 'daily', at: '09:00' })).toThrow(/global agents/);
  });

  it('delete: refused while a routine of another project runs as it, or while a run of it holds its lock; a stale folder never blocks the name again', () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    createAutomation(b.context, { slug: 'daily-look', title: 'Daily look', agent: 'scout', job: 'Look.', days: 'daily', at: '09:00' });
    expect(removeAgent(a.context, 'scout')).toEqual({ removed: false, usedBy: [expect.stringMatching(/daily-look$/)] });
    rmSync(join(b.context, 'automations', 'daily-look.md'));
    const lock = lockPathFor(b.context, 'scout');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(() => removeAgent(a.context, 'scout')).toThrow(/running in/);
    rmSync(lock);
    expect(removeAgent(a.context, 'scout')).toEqual({ removed: true });
    // A late run write recreated its folder: the name is free all the same.
    mkdirSync(join(globalAgentHome('scout'), 'projects', 'x', 'cache'), { recursive: true });
    expect(() => createGlobalAgent(scout, { approve: { now: NOW } })).not.toThrow();
  });

  it('a task given to the global agent never runs as a project member that took its name later: blocked, and the owner told once', async () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    writeFileSync(join(a.context, 'state', 'fix-login.md'), ['---', 'id: task_fixlogin', 'name: Fix login', 'status: todo', "created_at: '2026-10-01'", "updated_at: '2026-10-01'", '---', '', '## Changelog', ''].join('\n'));
    const r = makeRes();
    // Close to now: an info row lives a day, and a drain far in the future would age it out.
    const startAt = new Date(Date.now() + 3_600_000);
    await handleTasksAssignAgent(req({ agent: 'scout', startAt: startAt.toISOString() }), r.res, { slug: 'fix-login' }, a.context);
    expect(r.status()).toBe(202);
    expect(readTaskJobs(a.project).meta.find((m) => m.taskId === 'task_fixlogin')?.globalAgents).toEqual(['scout']);
    // A member of the same name arrives (a teammate's synced file).
    mkdirSync(join(a.context, 'agents'), { recursive: true });
    writeFileSync(join(a.context, 'agents', 'scout.md'), '---\ntitle: Not your scout\n---\n\n## Prompt\n\nSomeone else.\n');
    const spawned: string[] = [];
    startDueTaskJobs(a.context, { now: () => new Date(startAt.getTime() + 300_000), spawnHost: (_r, slug) => { spawned.push(slug); return 4_900_000; } });
    expect(spawned).toEqual([]);
    expect(readFileSync(join(a.context, 'state', 'fix-login.md'), 'utf-8')).toMatch(/^agent_state: blocked$/m);
    const rows = listInboxRows(a.project);
    expect(rows.some((x) => x.kind === 'task-blocked')).toBe(true);
    const shadow = rows.filter((x) => x.dedupeKey === 'global-shadowed:scout');
    expect(shadow).toHaveLength(1);
    // Dismissed, it stays dismissed.
    resolveInboxRow(a.project, shadow[0].id);
    noteShadowedGlobalAgents(a.context);
    expect(listInboxRows(a.project).some((x) => x.dedupeKey === 'global-shadowed:scout')).toBe(false);
  });

  it('the phone creates, edits and deletes no global agent; an agent run\'s create is never approved by it', async () => {
    createGlobalAgent(scout, { approve: { now: NOW } });
    const phone = { remoteAddress: '127.0.0.1' };
    markPhoneSocket(phone);
    const made = makeRes();
    await handleAgentsCreate(req({ title: 'Helper', prompt: 'P', scope: 'global' }, phone), made.res, {}, a.context);
    expect([made.status(), made.body().error]).toEqual([403, 'phone_unavailable']);
    const gone = makeRes();
    await handleAgentsDelete(req(undefined, phone), gone.res, { slug: 'scout' }, a.context);
    expect([gone.status(), gone.body().error]).toEqual([403, 'phone_unavailable']);
    expect(existsSync(globalAgentPath('scout'))).toBe(true);

    process.chdir(a.project);
    process.env.DREAMCONTEXT_AUTOMATION_RUN = '1';
    try {
      const { code } = await run(['agents', 'create', 'helper', '--title', 'Helper', '--prompt', 'P', '--scope', 'global']);
      expect(code).toBe(0);
    } finally {
      delete process.env.DREAMCONTEXT_AUTOMATION_RUN;
    }
    expect(existsSync(globalAgentPath('helper'))).toBe(true);
    expect(readAutomationsRegistry().projects[GLOBAL_REGISTRY_KEY]?.agentApprovals?.helper).toBeUndefined();
    expect(listAgentSummaries(b.context).find((x) => x.slug === 'helper')?.approvedToRun).toBe(false);
  });
});
