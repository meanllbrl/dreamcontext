/**
 * Task jobs end to end (AI Team v2 C1), with REAL processes: the built CLI is the detached task
 * host (`tasks run-job`), the scheduler is `automations tick --all` (no server at all), and a
 * stand-in `claude` on the fake HOME's PATH records every spawn and calls the real
 * `tasks deliver` / `automations propose` with the env its host gave it.
 *
 *   AC-C1-1  two agents' due tasks start in one tick that returns at once; a routine still fires
 *            on the next tick while they run; the scheduler process exits, the tasks finish
 *   AC-C1-3  SIGKILL the host (child alive) → stalled + row → Stop; Let it finish → its delivery
 *            is accepted; host and child both killed → stopped on the next tick, lock freed
 *   AC-C1-5  code task in a worktree (200-char slug), brain inside the code repo untouched, a
 *            fixture vault written by a run's CLI call leaves the live brain byte-identical, a
 *            synced agent_repo ignored, an absent repo → blocked
 *   AC-C1-11 a second machine (same login, then another login) ticks the same brain and touches
 *            nothing of machine 1's run, whose delivery is then accepted
 *   AC-C1-12 a question in a task run → the owner answers → the next tick resumes the SAME
 *            session through a host, in the worktree, and its delivery lands
 *
 * Needs `dist/index.js` (npm run build:cli).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { createAgent } from '../../src/lib/agents/store.js';
import { registerProject } from '../../src/lib/automations/registry.js';
import { createAutomation } from '../../src/lib/automations/store.js';
import { commitAssignment, prepareAssignment } from '../../src/lib/agents/task-assignment.js';
import { reconcileTaskJobs, stopTaskAction, letFinishAction } from '../../src/lib/agents/task-starter.js';
import { claimsForTask, readTaskJobs } from '../../src/lib/agents/task-jobs.js';
import { listInboxRows } from '../../src/lib/owner-inbox.js';
import { pendingQuestion } from '../../src/lib/automations/hitl.js';
import { resumeWithAnswer, resumeWithMessage } from '../../src/lib/automations/verdict.js';
import { lockPathFor } from '../../src/lib/automations/store.js';
import { setGlobalGitHubLogin } from '../../src/lib/git-sync/auth-store.js';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { setLinkedRepoPath } from '../../src/lib/linked-repos.js';
import { parseStatusHistory } from '../../src/lib/task-history.js';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const ORIGINAL_HOME = process.env.HOME;
const NOW = new Date();

const STANDIN = `#!/usr/bin/env node
// A stand-in claude: records each spawn, then does what its task's queue says.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const home = process.env.HOME;
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const sid = at('--session-id') || at('--resume') || 'standin-session';
const taskId = process.env.DREAMCONTEXT_TASK_ID || null;
const pick = (k) => process.env[k];
const record = (extra) => fs.appendFileSync(path.join(home, 'standin-calls.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), taskId, pid: process.pid, at: Date.now(),
  env: { ctx: pick('DREAMCONTEXT_CONTEXT_ROOT'), wt: pick('DREAMCONTEXT_TASK_WORKTREE'), run: pick('DREAMCONTEXT_TASK_RUN') },
  ...extra,
}) + '\\n');
let action = { result: 'Done.' };
if (taskId) {
  const qf = path.join(home, 'standin', taskId + '.json');
  if (fs.existsSync(qf)) {
    const q = JSON.parse(fs.readFileSync(qf, 'utf8'));
    action = q.shift() || action;
    fs.writeFileSync(qf, JSON.stringify(q));
  }
}
record({ action });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const cli = (args, cwd) => spawnSync(process.execPath, [process.env.STANDIN_CLI, ...args], { cwd: cwd || process.cwd(), env: process.env, encoding: 'utf8' });
if (action.waitFor) { const until = Date.now() + 60000; while (!fs.existsSync(action.waitFor) && Date.now() < until) sleep(100); }
if (action.sleepMs) sleep(action.sleepMs);
if (action.fixtureLog) { const r = cli(['tasks', 'log', action.fixtureLog.slug, 'written by the run'], action.fixtureLog.cwd); record({ fixtureLog: r.status, out: (r.stdout || '') + (r.stderr || '') }); }
if (action.propose) { const r = cli(['automations', 'propose', action.agent, '--title', 'A question', '--body', action.propose]); record({ propose: r.status, out: (r.stdout || '') + (r.stderr || '') }); }
if (action.deliver) { const r = cli(['tasks', 'deliver', taskId, '--note', action.deliver]); record({ deliver: r.status, out: (r.stdout || '') + (r.stderr || '') }); }
if (action.hang) { setInterval(() => {}, 1000); return; }
process.stdout.write(JSON.stringify({ session_id: sid, result: action.result || 'Done.', is_error: !!action.isError, permission_denials: [], total_cost_usd: 0.01, num_turns: 3, duration_ms: 500, subtype: 'success' }));
`;

interface Machine { home: string }
let scratch: string;
let projectRoot: string;
let contextRoot: string;
let m1: Machine;

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function machine(login: string): Machine {
  const home = tmp('dc-c1e2e-home-');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(home, '.local', 'bin', 'claude'), 0o755);
  // A current usage reading, so account protection decides without a /usage probe.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: Date.now() + 3_600_000,
      utilization: {
        five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() },
        seven_day: { utilization: 10, resets_at: new Date(Date.now() + 40 * 3_600_000).toISOString() },
      },
    },
  }));
  setGlobalGitHubLogin(login, home);
  registerProject(projectRoot, home);
  return { home };
}

function use(m: Machine): void {
  process.env.HOME = m.home;
}

function writeTask(slug: string, id: string, extra: Record<string, unknown> = {}): void {
  const body = ['', '## Why', 'Because.', '', '## Acceptance Criteria', '- [ ] it works', '', '## Changelog', ''].join('\n');
  writeFileSync(join(contextRoot, 'state', `${slug}.md`), matter.stringify(body, { id, name: `Task ${id}`, status: 'todo', ...extra }));
}

function task(slug: string): Record<string, unknown> {
  return matter(readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8')).data as Record<string, unknown>;
}

function queue(m: Machine, taskId: string, actions: unknown[]): void {
  mkdirSync(join(m.home, 'standin'), { recursive: true });
  writeFileSync(join(m.home, 'standin', `${taskId}.json`), JSON.stringify(actions));
}

function calls(m: Machine): Array<{ argv: string[]; cwd: string; taskId: string | null; pid: number; env: Record<string, string>; action?: unknown; deliver?: number; out?: string; propose?: number; fixtureLog?: number }> {
  const p = join(m.home, 'standin-calls.jsonl');
  if (!existsSync(p)) return [];
  // One record per spawn: a stand-in appends a line when it starts and one per thing it did.
  const byPid = new Map<number, Record<string, unknown>>();
  for (const line of readFileSync(p, 'utf-8').split('\n').filter(Boolean)) {
    const rec = JSON.parse(line) as Record<string, unknown> & { pid: number };
    byPid.set(rec.pid, { ...(byPid.get(rec.pid) ?? {}), ...rec });
  }
  return [...byPid.values()] as ReturnType<typeof calls>;
}

function assign(slug: string, agent: string, opts: Record<string, unknown> = {}): void {
  const prep = prepareAssignment(contextRoot, slug, agent, { source: 'cli', ...opts });
  if (!prep.ok) throw new Error(`${prep.code}: ${prep.message}`);
  commitAssignment(contextRoot, prep, new Date(), { source: 'cli' });
}

/** `automations tick --all` as the scheduler runs it: a separate process with this machine's HOME. */
function tick(m: Machine): { ms: number; out: string } {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'automations', 'tick', '--all'], {
    cwd: tmpdir(), env: { ...childEnv(), HOME: m.home, STANDIN_CLI: CLI }, encoding: 'utf8', timeout: 60_000,
  });
  if (process.env.C1_E2E_DEBUG) writeFileSync(process.env.C1_E2E_DEBUG, `--- tick ${m.home}\n${r.stdout}${r.stderr}\n`, { flag: 'a' });
  return { ms: Date.now() - t0, out: `${r.stdout}${r.stderr}` };
}

/** The env a real scheduler has: none of the test runner's markers (they switch the default host spawn off). */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
}

async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('dist/index.js is missing: run npm run build:cli first');
});

beforeEach(() => {
  scratch = tmp('dc-c1e2e-');
  projectRoot = join(scratch, 'project');
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  m1 = machine('owner-one');
  use(m1);
  process.env.STANDIN_CLI = CLI;
});

afterEach(() => {
  // Leave nothing behind: every host this machine claimed and every stand-in child is killed.
  if (m1) {
    use(m1);
    for (const c of readTaskJobs(projectRoot).claims) {
      for (const pid of [c.hostPid, c.childPid]) { if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    for (const c of calls(m1)) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  process.env.HOME = ORIGINAL_HOME;
  // A host killed a moment ago may still be closing its log: removal is best effort.
  for (const dir of [scratch, m1?.home]) {
    if (!dir) continue;
    // Few, short retries (the delay grows with each): a host that is still closing its log must
    // not hold the suite; a folder it keeps busy is left to the OS's temp cleanup.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* left for the OS */ }
  }
}, 30_000);

describe('AC-C1-1: no server, one tick, detached hosts', () => {
  it('two agents\' due tasks start in one tick that returns at once; a routine fires on the next tick; both tasks finish', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'p' }, { approve: { now: NOW } });
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'p' }, { approve: { now: NOW } });
    writeTask('a', 'task_a');
    writeTask('b', 'task_b');
    queue(m1, 'task_a', [{ sleepMs: 4000, deliver: 'A done.' }]);
    queue(m1, 'task_b', [{ sleepMs: 4000, deliver: 'B done.' }]);
    assign('a', 'scout');
    assign('b', 'writer');
    const first = tick(m1);
    expect(first.ms).toBeLessThan(15_000);
    await until('both stand-ins running', () => calls(m1).filter((c) => c.taskId).length === 2);
    expect(['a', 'b'].map((s) => task(s).agent_state)).toEqual(['running', 'running']);
    // A routine due now fires on the next tick while both task jobs still run.
    const due = new Date(Date.now() - 60_000);
    const at = `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
    createAutomation(contextRoot, { slug: 'digest', title: 'Digest', days: 'daily', at, prompt: 'Write it.' }, { approve: { now: new Date(Date.now() - 86_400_000) } });
    tick(m1);
    expect(calls(m1).some((c) => c.taskId === null)).toBe(true);
    // The scheduler process is long gone; the hosts finish on their own.
    await until('both delivered', () => task('a').status === 'in_review' && task('b').status === 'in_review', 40_000);
    await until('both stand-ins recorded their delivery', () => calls(m1).filter((c) => c.deliver === 0).length === 2);
  }, 90_000);
});

describe('AC-C1-3: a host that dies', () => {
  it('SIGKILL the host while its child lives → stalled + one row → Stop: stopped, lock freed, the next queued task starts', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'p' }, { approve: { now: NOW } });
    writeTask('a', 'task_a');
    writeTask('b', 'task_b');
    queue(m1, 'task_a', [{ hang: true }]);
    queue(m1, 'task_b', [{ deliver: 'B done.' }]);
    assign('a', 'scout');
    tick(m1);
    await until('the child is running', () => calls(m1).some((c) => c.taskId === 'task_a'));
    assign('b', 'scout');
    const claim = claimsForTask(projectRoot, 'task_a')[0];
    await until('the host recorded its child', () => !!claimsForTask(projectRoot, 'task_a')[0]?.childPid);
    process.kill(claim.hostPid!, 'SIGKILL');
    await until('the host is gone', () => !alive(claim.hostPid));
    reconcileTaskJobs(contextRoot);
    reconcileTaskJobs(contextRoot);
    expect(task('a').agent_state).toBe('stalled');
    expect(listInboxRows(projectRoot).filter((r) => r.kind === 'task-orphaned')).toHaveLength(1);
    expect(stopTaskAction(contextRoot, 'a', { cliEntry: CLI })).toEqual({ ok: true });
    expect(task('a').agent_state).toBe('stopped');
    const child = calls(m1).find((c) => c.taskId === 'task_a')!.pid;
    await until('the child group was killed', () => !alive(child));
    await until('the lock is free', () => !existsSync(lockPathFor(contextRoot, 'scout')));
    // Stop drained: the next queued task of the same agent runs.
    await until('b delivered', () => task('b').status === 'in_review', 30_000);
  }, 90_000);

  it('Let it finish: the orphaned child\'s delivery is accepted; once it exits its claim closes and the lock frees', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'p' }, { approve: { now: NOW } });
    writeTask('a', 'task_a');
    const go = join(scratch, 'go');
    queue(m1, 'task_a', [{ waitFor: go, deliver: 'Finished without my host.' }]);
    assign('a', 'scout');
    tick(m1);
    await until('the host recorded its child', () => !!claimsForTask(projectRoot, 'task_a')[0]?.childPid);
    const claim = claimsForTask(projectRoot, 'task_a')[0];
    process.kill(claim.hostPid!, 'SIGKILL');
    await until('the host is gone', () => !alive(claim.hostPid));
    reconcileTaskJobs(contextRoot);
    expect(letFinishAction(contextRoot, 'a')).toEqual({ ok: true });
    writeFileSync(go, '');
    await until('delivered', () => task('a').status === 'in_review', 30_000);
    await until('the delivery recorded', () => calls(m1).find((c) => c.deliver !== undefined)?.deliver === 0);
    const child = calls(m1)[0].pid;
    await until('the child exited', () => !alive(child));
    reconcileTaskJobs(contextRoot);
    expect(readTaskJobs(projectRoot).claims).toEqual([]);
    expect(existsSync(lockPathFor(contextRoot, 'scout'))).toBe(false);
    expect(task('a').agent_state).toBe('delivered');
  }, 90_000);

  it('host and child both killed → stopped on the next tick, the lock freed whatever its age; a late delivery is refused', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'p' }, { approve: { now: NOW } });
    writeTask('a', 'task_a');
    queue(m1, 'task_a', [{ hang: true }]);
    assign('a', 'scout');
    tick(m1);
    await until('the host recorded its child', () => !!claimsForTask(projectRoot, 'task_a')[0]?.childPid);
    const claim = claimsForTask(projectRoot, 'task_a')[0];
    process.kill(claim.hostPid!, 'SIGKILL');
    process.kill(-claim.childPid!, 'SIGKILL');
    await until('both gone', () => !alive(claim.hostPid) && !alive(claim.childPid));
    tick(m1);
    expect(task('a').agent_state).toBe('stopped');
    expect(existsSync(lockPathFor(contextRoot, 'scout'))).toBe(false);
    const late = spawnSync(process.execPath, [CLI, 'tasks', 'deliver', 'task_a', '--note', 'late'], {
      cwd: projectRoot, env: { ...childEnv(), HOME: m1.home, DREAMCONTEXT_TASK_RUN: claim.runId, DREAMCONTEXT_TASK_TOKEN: 'x'.repeat(48) }, encoding: 'utf8',
    });
    expect(late.status).not.toBe(0);
    expect(`${late.stdout}${late.stderr}`).toMatch(/no longer holds the task/);
  }, 90_000);
});

describe('AC-C1-5 + AC-C1-12: a code task in its worktree, a question, the answer, the same session', () => {
  let code: string;
  beforeEach(() => {
    // The code repo carries a brain of its own, checked in (the brain-inside-the-code-repo case).
    code = join(scratch, 'code');
    mkdirSync(join(code, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(code, '_dream_context', 'state', 'copy.md'), '---\nid: copy\nname: A checked-in copy\nstatus: todo\n---\n');
    writeFileSync(join(code, 'app.ts'), 'export const x = 1;\n');
    execFileSync('git', ['init', '-q', '-b', 'main', code]);
    execFileSync('git', ['-C', code, 'add', '-A']);
    execFileSync('git', ['-C', code, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'init']);
    updateSetupConfig(projectRoot, { linkedRepos: [{ name: 'code', gitRemoteUrl: 'https://github.com/example/code.git' }] });
    setLinkedRepoPath('https://github.com/example/code.git', code, m1.home);
  });

  it('runs in task-<8hex>, the live brain gets the delivery, the worktree copy and a fixture vault stay as they should', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'p' }, { approve: { now: NOW } });
    const longSlug = `fix-${'x'.repeat(195)}`;
    expect(longSlug.length).toBe(199);
    writeTask(longSlug, 'task_long');
    const fixture = join(scratch, 'fixture');
    mkdirSync(join(fixture, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(fixture, '_dream_context', 'state', 'f.md'), '---\nid: f\nname: Fixture\nstatus: todo\n---\n\n## Changelog\n');
    const liveBefore = readFileSync(join(contextRoot, 'state', `${longSlug}.md`), 'utf-8');
    queue(m1, 'task_long', [{ fixtureLog: { slug: 'f', cwd: fixture }, deliver: 'Changed app.ts.' }]);
    assign(longSlug, 'scout', { workspace: 'code', repo: 'code' });
    // A synced edit of the display repo is ignored: the run uses this machine's own record.
    writeFileSync(join(contextRoot, 'state', `${longSlug}.md`), readFileSync(join(contextRoot, 'state', `${longSlug}.md`), 'utf-8').replace('agent_repo: code', 'agent_repo: evil'));
    void liveBefore;
    tick(m1);
    await until('delivered', () => task(longSlug).status === 'in_review', 40_000);
    await until('the delivery recorded', () => calls(m1).find((c) => c.taskId === 'task_long')?.deliver !== undefined);
    const call = calls(m1).find((c) => c.taskId === 'task_long')!;
    expect(call.cwd).toMatch(/code-super-task-[0-9a-f]{8}$/);
    expect(call.env.wt).toBe(call.cwd);
    expect(call.env.ctx).toBe(contextRoot);
    expect(call.deliver).toBe(0);
    expect(call.fixtureLog).toBe(0);
    // The fixture got the log line; the worktree's checked-in brain copy is untouched.
    expect(readFileSync(join(fixture, '_dream_context', 'state', 'f.md'), 'utf-8')).toContain('written by the run');
    expect(readFileSync(join(call.cwd, '_dream_context', 'state', 'copy.md'), 'utf-8')).toBe('---\nid: copy\nname: A checked-in copy\nstatus: todo\n---\n');
    expect(execFileSync('git', ['-C', call.cwd, 'status', '--porcelain']).toString()).toBe('');
    expect(parseStatusHistory(readFileSync(join(contextRoot, 'state', `${longSlug}.md`), 'utf-8'))[0]).toMatchObject({ to: 'in_review', by: 'agent:scout' });
  }, 90_000);

  it('a question → waiting_owner → the answer → the next tick resumes the SAME session in the worktree → delivered; a second answer and a thread message start nothing', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'p' }, { approve: { now: NOW } });
    writeTask('ask', 'task_ask');
    queue(m1, 'task_ask', [{ propose: 'Which login should I fix?', agent: 'scout' }, { deliver: 'Fixed the SSO login.' }]);
    assign('ask', 'scout', { workspace: 'code', repo: 'code' });
    tick(m1);
    await until('waiting on the owner', () => task('ask').agent_state === 'waiting_owner', 40_000);
    expect(calls(m1)[0].propose).toBe(0);
    const q = pendingQuestion(contextRoot, 'scout');
    expect(q).not.toBeNull();
    const answered = await resumeWithAnswer(contextRoot, q!, 'The SSO one.', 'dashboard');
    expect(answered.status).toBe('ok');
    expect(task('ask').agent_state).toBe('queued');
    const again = await resumeWithAnswer(contextRoot, q!, 'Another.', 'telegram');
    expect(again.status).toBe('refused');
    const talk = await resumeWithMessage(contextRoot, 'scout', 'how is it going?', { surface: 'telegram' });
    expect(talk.status).toBe('refused');
    tick(m1);
    await until('delivered', () => task('ask').status === 'in_review', 40_000);
    const [first, second] = calls(m1).filter((c) => c.taskId === 'task_ask');
    const sid = first.argv[first.argv.indexOf('--session-id') + 1];
    expect(second.argv.slice(0, 2)).toEqual(['--resume', sid]);
    expect(second.cwd).toBe(first.cwd);
    expect(second.argv[second.argv.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(second.argv[second.argv.indexOf('-p') + 1]).toContain('The SSO one.');
    expect(calls(m1).filter((c) => c.taskId === 'task_ask')).toHaveLength(2);
    // The brain inside the code repo: the worktree's checked-in copy stays byte-identical throughout.
    expect(readFileSync(join(first.cwd, '_dream_context', 'state', 'copy.md'), 'utf-8')).toBe('---\nid: copy\nname: A checked-in copy\nstatus: todo\n---\n');
  }, 120_000);

  it('an absent repo → blocked "on <machine>"', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'p' }, { approve: { now: NOW } });
    writeTask('gone', 'task_gone');
    assign('gone', 'scout', { workspace: 'code', repo: 'code' });
    rmSync(code, { recursive: true, force: true });
    tick(m1);
    await until('blocked', () => task('gone').agent_state === 'blocked', 30_000);
    expect(String(task('gone').agent_blocked)).toMatch(/repo code|worktree/);
    expect(calls(m1)).toEqual([]);
  }, 60_000);
});

describe('AC-C1-11: a second machine ticks the same brain', () => {
  it.each([['the same login', 'owner-one'], ['another login', 'teammate']])('%s: machine 1\'s run, claim and lock are untouched; its delivery is then accepted', async (_label, login) => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'p' }, { approve: { now: NOW } });
    writeTask('a', 'task_a');
    const go = join(scratch, 'go');
    queue(m1, 'task_a', [{ waitFor: go, deliver: 'Done on machine 1.' }]);
    assign('a', 'scout');
    tick(m1);
    await until('running on machine 1', () => task('a').agent_state === 'running' && !!claimsForTask(projectRoot, 'task_a')[0]?.childPid);
    const before = { task: readFileSync(join(contextRoot, 'state', 'a.md'), 'utf-8'), lock: readFileSync(lockPathFor(contextRoot, 'scout'), 'utf-8'), claims: JSON.stringify(readTaskJobs(projectRoot).claims) };
    const m2 = machine(login);
    tick(m2);
    tick(m2);
    use(m1);
    expect(readFileSync(join(contextRoot, 'state', 'a.md'), 'utf-8')).toBe(before.task);
    expect(readFileSync(lockPathFor(contextRoot, 'scout'), 'utf-8')).toBe(before.lock);
    expect(JSON.stringify(readTaskJobs(projectRoot).claims)).toBe(before.claims);
    expect(calls(m2)).toEqual([]);
    writeFileSync(go, '');
    await until('delivered by machine 1', () => task('a').status === 'in_review', 30_000);
    try { rmSync(m2.home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }, 90_000);
});
