/**
 * Task jobs, the host side (AI Team v2 C1-5, C1-8..C1-14): one claimed step run through the ONE
 * runner with a stand-in claude, its settle, the delivery and review verbs the stand-in calls
 * with the env the host gave it, the reviewer loop, the outcome → state table, the level
 * envelopes (M4), and the session gate (a task session resumes only through its host).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  argAfter, killChild, makeAgent, makeFixture, standInClaude, taskData, taskText, writeTask,
  type ChildScript, type Fixture, type SpawnCall,
} from '../helpers/task-job-fixture.js';
import { commitAssignment, prepareAssignment } from '../../src/lib/agents/task-assignment.js';
import { approvePlanAction, continueTaskAction, startDueTaskJobs, unassignTaskJob, type TaskJobDeps } from '../../src/lib/agents/task-starter.js';
import { runTaskJob, type TaskHostDeps } from '../../src/lib/agents/task-host.js';
import { deliverTask, reviewTask } from '../../src/lib/agents/task-delivery.js';
import { claimsForTask, metaFor, readTaskJobs, taskSessionFor } from '../../src/lib/agents/task-jobs.js';
import { listInboxRows } from '../../src/lib/owner-inbox.js';
import { createQuestion, pendingQuestion, readQuestion, questionPath } from '../../src/lib/automations/hitl.js';
import { latestBoundSession, recordAutomationSession, taskBindingOf } from '../../src/lib/automations/session-registry.js';
import { resumeWithAnswer, resumeWithMessage } from '../../src/lib/automations/verdict.js';
import { refusesTaskSession } from '../../src/server/routes/agent-chat.js';
import { parseStatusHistory } from '../../src/lib/task-history.js';
import { readSleepState, writeSleepState } from '../../src/cli/commands/sleep.js';
import { removeAgent } from '../../src/lib/agents/store.js';
import { revokeApproval } from '../../src/lib/automations/registry.js';
import { getRunTarget } from '../../src/lib/automations/store.js';
import { sandboxDirFor, setSwitchPolicy, upsertClaudeAccount } from '../../src/lib/claude-accounts.js';

let f: Fixture;
const T0 = new Date('2026-10-25T09:00:00.000Z');
const probeUsage = async () => ({ status: 'ok' as const, limits: { limits: [{ key: 'session', percent: 10, resetsAt: T0.getTime() + 3_600_000 }, { key: 'weekly', percent: 10, resetsAt: T0.getTime() + 86_400_000 }], fetchedAtMs: T0.getTime() } });

beforeEach(() => { f = makeFixture('dc-taskhost'); });
afterEach(() => { f.cleanup(); });

interface Harness {
  hosts: Array<{ slug: string; runId: string }>;
  notify: ReturnType<typeof vi.fn>;
  calls: SpawnCall[];
  /** Run every host the drains recorded, in order, with the next scripts. */
  runHosts: (scripts: Array<ChildScript | ((c: SpawnCall) => ChildScript)>, extra?: Partial<TaskHostDeps>) => Promise<Array<string | null>>;
  deps: TaskJobDeps;
}

/** The banner the current harness records: a delivery's stand-in passes it like the host does. */
let activeNotify: ReturnType<typeof vi.fn> | undefined;

function harness(): Harness {
  const hosts: Array<{ slug: string; runId: string }> = [];
  const live = new Set<number>();
  const notify = vi.fn();
  activeNotify = notify;
  const calls: SpawnCall[] = [];
  let pid = 4_500_000;
  const deps: TaskJobDeps = {
    home: f.home,
    now: () => T0,
    spawnHost: (_r, slug, runId) => { hosts.push({ slug, runId }); return pid++; },
    // A host in this process is alive while it runs; the recorded fake ones are not (they "exited").
    isAlive: (p) => p === process.pid || live.has(p),
    killGroup: (pg) => killChild(pg),
  };
  let ran = 0;
  return {
    hosts, notify, calls, deps,
    runHosts: async (scripts, extra = {}) => {
      const out: Array<string | null> = [];
      let n = 0;
      while (ran < hosts.length) {
        const h = hosts[ran++];
        const spawn = standInClaude(scripts.slice(n));
        const res = await runTaskJob(f.contextRoot, h.slug, h.runId, {
          ...deps, spawnImpl: spawn.impl, notify, probeUsage, stallPollMs: 5, ...extra,
        });
        n += spawn.calls.length;
        calls.push(...spawn.calls);
        out.push(res.state);
      }
      return out;
    },
  };
}

function assign(slug: string, agent: string, opts: Partial<Parameters<typeof prepareAssignment>[3]> = {}): void {
  const prep = prepareAssignment(f.contextRoot, slug, agent, { home: f.home, source: 'dashboard', ...opts });
  if (!prep.ok) throw new Error(`${prep.code}: ${prep.message}`);
  commitAssignment(f.contextRoot, prep, T0, { home: f.home });
}

/** A stand-in child that delivers with the env and cwd its host gave it. */
const delivers = (note = 'Did the work.', more: Partial<Parameters<typeof deliverTask>[2]> = {}): ChildScript => ({
  during: (c) => {
    const r = deliverTask(f.contextRoot, String(c.env.DREAMCONTEXT_TASK_ID), { note, ...more }, { env: c.env as NodeJS.ProcessEnv, cwd: c.cwd, home: f.home, now: T0, notify: activeNotify });
    if (!r.ok) throw new Error(r.message);
  },
});
const reviews = (verdict: 'pass' | 'fail', findings: string[] = []): ChildScript => ({
  during: (c) => {
    const r = reviewTask(f.contextRoot, String(c.env.DREAMCONTEXT_TASK_ID), { verdict, findings }, { env: c.env as NodeJS.ProcessEnv, home: f.home });
    if (!r.ok) throw new Error(r.message);
  },
});

/** A stand-in child that asks the owner (what `automations propose` records), for this run's fire. */
const asksQuestion = (): ChildScript => ({
  during: () => {
    const side = JSON.parse(readFileSync(join(f.contextRoot, 'automations', 'cache', '.scout.run.json'), 'utf-8')) as { fireAt: string };
    createQuestion(f.contextRoot, { slug: 'scout', runFiredAt: side.fireAt, kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Which login?', target: 'agent' });
  },
});

describe('a work step with no reviewer (C1-10, C1-11)', () => {
  it('the stand-in delivers from its run: In Review by the agent, a row, a banner with the task link', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(await h.runHosts([delivers()])).toEqual([null]);
    const d = taskData(f, 'fix');
    expect(d).toMatchObject({ status: 'in_review', agent_state: 'delivered', review_round: 1 });
    expect((d.deliveries as Array<{ note: string; by: string }>)[0]).toMatchObject({ note: 'Did the work.', by: 'scout', round: 1 });
    expect(parseStatusHistory(taskText(f, 'fix'))[0]).toMatchObject({ to: 'in_review', by: 'agent:scout' });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(listInboxRows(f.projectRoot, f.home).map((r) => [r.kind, r.actions])).toEqual([['task-review', ['complete', 'send-back']]]);
    // The run ran at the project root (a doc task), in a session named before the spawn, under the level's envelope.
    const call = h.calls[0];
    expect(call.cwd).toBe(f.projectRoot);
    expect(argAfter(call.args, '--permission-mode')).toBe('auto');
    expect(argAfter(call.args, '--session-id')).toBe(taskSessionFor(f.projectRoot, 'task_fix', 'doer', f.home));
    expect(call.env.DREAMCONTEXT_TASK_RUN).toMatch(/^tr_/);
    expect(call.env.DREAMCONTEXT_TASK_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(readTaskJobs(f.projectRoot, f.home).claims).toEqual([]);
    // Ticking twice after a delivered task with no reviewer restarts nothing.
    startDueTaskJobs(f.contextRoot, h.deps);
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(h.hosts).toHaveLength(1);
  });

  it('the brief carries the task file as data and the delivery contract', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers()]);
    const prompt = argAfter(h.calls[0].args, '-p')!;
    expect(prompt).toContain('The task file:');
    expect(prompt).toContain('## Acceptance Criteria');
    expect(prompt).toContain('dreamcontext tasks deliver task_fix --note');
    expect(prompt).toContain('Never change the task\'s status yourself');
  });
});

describe('the reviewer loop (C1-12, AC-C1-2, AC-C1-8)', () => {
  beforeEach(() => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'fix', { id: 'task_fix' });
  });

  it('deliver → exactly one reviewer run → pass: stays In Review with the badge, a row, a banner', async () => {
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    // The doer's host settles and drains: the review starts once, from that drain alone.
    await h.runHosts([delivers(), reviews('pass')]);
    expect(h.hosts.map((x) => x.slug)).toEqual(['fix', 'fix']);
    expect(taskData(f, 'fix')).toMatchObject({ status: 'in_review', agent_state: 'delivered', review_passed: true, review_round: 1 });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.calls[1].args).toEqual(expect.arrayContaining(['--disallowedTools', 'Write Edit MultiEdit NotebookEdit']));
    expect(argAfter(h.calls[1].args, '--permission-mode')).toBe('auto');
    expect(h.calls[1].env.DREAMCONTEXT_TASK_RUN).not.toBe(h.calls[0].env.DREAMCONTEXT_TASK_RUN);
    expect(readTaskJobs(f.projectRoot, f.home).verdicts).toEqual([]);
  });

  it('fail → the doer\'s SAME session resumes with the findings as data; round 2 passes', async () => {
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers(), reviews('fail', ['AC 1: the login still 500s']), delivers('Fixed the 500.'), reviews('pass')]);
    const doerSession = argAfter(h.calls[0].args, '--session-id');
    expect(h.calls[2].args.slice(0, 2)).toEqual(['--resume', doerSession]);
    expect(argAfter(h.calls[2].args, '-p')).toContain('AC 1: the login still 500s');
    const hist = parseStatusHistory(taskText(f, 'fix'));
    expect(hist.map((r) => `${r.to}:${r.by}`)).toEqual(['in_review:agent:scout', 'in_progress:reviewer:checker', 'in_review:agent:scout', 'in_progress:owner']);
    expect(taskData(f, 'fix')).toMatchObject({ review_round: 2, review_passed: true, agent_state: 'delivered' });
  });

  it('at the cap: stuck, one row with the three actions', async () => {
    assign('fix', 'scout', { reviewer: 'checker', reviewCap: 1 });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers(), reviews('fail', ['still broken'])]);
    expect(taskData(f, 'fix').agent_state).toBe('stuck');
    const row = listInboxRows(f.projectRoot, f.home).find((r) => r.kind === 'task-stuck');
    expect(row?.actions).toEqual(['one-more-round', 'take-over', 'cancel']);
  });

  it('a doer that exits failed after delivering leaves the review step queued', async () => {
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    // The reviewer is busy (its lock held by a live process): the review stays queued, the doer is not restarted.
    const { lockPathFor } = await import('../../src/lib/automations/store.js');
    mkdirSync(join(f.contextRoot, 'automations', 'cache'), { recursive: true });
    writeFileSync(lockPathFor(f.contextRoot, 'checker'), JSON.stringify({ pid: process.pid, at: T0.getTime() }));
    await h.runHosts([{ ...delivers(), is_error: true, result: 'crashed after delivering' }]);
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'queued', agent_step: 'review', status: 'in_review' });
    expect(h.hosts).toHaveLength(1);
  });

  it('no verdict: one retry of the review, then stuck', async () => {
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers(), { result: 'looked, said nothing' }, { result: 'again nothing' }]);
    expect(taskData(f, 'fix').agent_state).toBe('stuck');
    expect(h.hosts).toHaveLength(3);
  });

  it('a doc reviewer that edited the delivered doc: the verdict is refused; one that changed nothing is accepted while another session writes the brain', async () => {
    writeFileSync(join(f.contextRoot, 'report.md'), '# Report\n');
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    const edits: ChildScript = { during: (c) => { writeFileSync(join(f.contextRoot, 'report.md'), '# Report\nedited by the reviewer\n'); reviews('pass').during!(c); } };
    const othersWrite: ChildScript = { during: (c) => { writeTask(f, 'unrelated', { id: 'task_u' }); writeFileSync(join(f.contextRoot, 'state', 'fix.md'), taskText(f, 'fix') + '\nanother session wrote here\n'); reviews('pass').during!(c); } };
    await h.runHosts([delivers('Wrote the report.', { docs: ['report.md'] }), edits, othersWrite]);
    expect(taskText(f, 'fix')).toContain('Review refused');
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'delivered', review_passed: true });
  });
});

describe('outcome → state (C1-5, AC-C1-4)', () => {
  beforeEach(() => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
  });

  it('ok without a delivery, failed: stopped + a row', async () => {
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(await h.runHosts([{ result: 'I looked around.' }])).toEqual(['stopped']);
    expect(listInboxRows(f.projectRoot, f.home).filter((r) => r.kind === 'task-stopped')).toHaveLength(1);
  });

  it('a question → waiting_owner + a row, the claim kept with its session', async () => {
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(await h.runHosts([asksQuestion()])).toEqual(['waiting_owner']);
    expect(taskData(f, 'fix').agent_state).toBe('waiting_owner');
    expect(claimsForTask(f.projectRoot, 'task_fix', f.home)).toEqual([expect.objectContaining({ phase: 'waiting_owner' })]);
    expect(listInboxRows(f.projectRoot, f.home).filter((r) => r.kind === 'task-question')).toHaveLength(1);
  });

  it('every no-child refusal goes back to queued at its place, armed, with no row: a sleep (deferred), an open question (review gate)', async () => {
    const before = taskData(f, 'fix').agent_queued_at;
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    // A sleep starts between the claim and the run.
    writeSleepState(f.contextRoot, { ...readSleepState(f.contextRoot), sleep_started_at: T0.toISOString() });
    expect(await h.runHosts([])).toEqual(['queued']);
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'queued', agent_queued_at: before });
    expect(listInboxRows(f.projectRoot, f.home)).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it('an agent no longer approved: blocked + a row', async () => {
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    revokeApproval(f.projectRoot, 'scout', f.home, 'agent');
    const target = getRunTarget(f.contextRoot, 'scout', 'agent');
    expect(target).not.toBeNull();
    expect(await h.runHosts([])).toEqual(['blocked']);
    expect(listInboxRows(f.projectRoot, f.home).filter((r) => r.kind === 'task-blocked')).toHaveLength(1);
  });

  it('a stall (no transcript growth) stops the run: stalled + a row; Continue re-queues and resumes the same session', async () => {
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(await h.runHosts([{ hang: true }], { stallMs: 10, transcriptSize: () => 100 })).toEqual(['stalled']);
    expect(listInboxRows(f.projectRoot, f.home).filter((r) => r.kind === 'task-stalled')).toHaveLength(1);
    // A stall-stopped task keeps its Continue row across ticks.
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(listInboxRows(f.projectRoot, f.home).filter((r) => r.kind === 'task-stalled')).toHaveLength(1);
    expect(continueTaskAction(f.contextRoot, 'fix', h.deps)).toEqual({ ok: true });
    await h.runHosts([delivers()]);
    expect(h.calls[1].args.slice(0, 2)).toEqual(['--resume', argAfter(h.calls[0].args, '--session-id')]);
    expect(taskData(f, 'fix').agent_state).toBe('delivered');
  });
});

describe('the level envelopes (M4, AC-C1-6)', () => {
  it.each([
    ['balanced', 'work', 'auto', false],
    ['free', 'work', 'bypassPermissions', false],
  ] as const)('%s %s step → --permission-mode %s', async (level, _step, mode) => {
    makeAgent(f, 'scout', level);
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers()]);
    expect(argAfter(h.calls[0].args, '--permission-mode')).toBe(mode);
    expect(h.calls[0].args).not.toContain('--disallowedTools');
  });

  it('a Free reviewer still cannot edit', async () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker', 'free');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers(), reviews('pass')]);
    expect(argAfter(h.calls[1].args, '--permission-mode')).toBe('bypassPermissions');
    expect(argAfter(h.calls[1].args, '--disallowedTools')).toBe('Write Edit MultiEdit NotebookEdit');
  });

  it('Ask: the plan step cannot write and its plan reaches a row; work starts only after Approve, resuming the plan\'s session', async () => {
    makeAgent(f, 'careful', 'ask');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'careful');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(await h.runHosts([{ result: '1. Read login.ts\n2. Fix the 500' }])).toEqual(['waiting_owner']);
    expect(argAfter(h.calls[0].args, '--permission-mode')).toBe('plan');
    expect(h.calls[0].args).toContain('--disallowedTools');
    const row = listInboxRows(f.projectRoot, f.home).find((r) => r.kind === 'task-plan');
    expect(row?.detail).toContain('Fix the 500');
    // Nothing else starts while the plan waits.
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(h.hosts).toHaveLength(1);
    expect(approvePlanAction(f.contextRoot, 'fix', h.deps)).toEqual({ ok: true });
    await h.runHosts([delivers()]);
    expect(argAfter(h.calls[1].args, '--permission-mode')).toBe('auto');
    expect(h.calls[1].args.slice(0, 2)).toEqual(['--resume', argAfter(h.calls[0].args, '--session-id')]);
  });

  it('the in-run account-switch continue carries the step\'s envelope', async () => {
    makeAgent(f, 'scout', 'free');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    upsertClaudeAccount({ id: 'first', accountUuid: 'u1', email: 'first@example.test', organizationUuid: 'o', organizationName: 'O', tier: 'max', configDir: null, preferred: true }, f.home);
    upsertClaudeAccount({ id: 'second', accountUuid: 'u2', email: 'second@example.test', organizationUuid: 'o', organizationName: 'O', tier: 'max', configDir: sandboxDirFor('second', f.home), preferred: false }, f.home);
    mkdirSync(sandboxDirFor('second', f.home), { recursive: true });
    writeFileSync(join(sandboxDirFor('second', f.home), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'second@example.test' } }));
    setSwitchPolicy({ strategy: 'sequential' }, f.home);
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([{ result: "You've hit your session limit · resets 2pm (Europe/Istanbul)", num_turns: 1 }, delivers()]);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].args[0]).toBe('--resume');
    expect(argAfter(h.calls[1].args, '--permission-mode')).toBe('bypassPermissions');
    expect(h.calls[1].cwd).toBe(h.calls[0].cwd);
  });
});

describe('deliver refusals: token and stale run (AC-C1-7)', () => {
  it('refuses a call with no run env, a wrong token, and a late delivery from a run whose claim closed', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    let env: NodeJS.ProcessEnv = {};
    let cwd = '';
    const live: Record<string, unknown> = {};
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([{ during: (c) => {
      env = c.env as NodeJS.ProcessEnv;
      cwd = c.cwd;
      live.none = deliverTask(f.contextRoot, 'task_fix', { note: 'x' }, { env: {}, home: f.home });
      live.wrong = deliverTask(f.contextRoot, 'task_fix', { note: 'x' }, { env: { ...env, DREAMCONTEXT_TASK_TOKEN: 'ab'.repeat(24) }, home: f.home });
      live.otherTask = deliverTask(f.contextRoot, 'nope', { note: 'x' }, { env, cwd, home: f.home });
    } }]);
    expect(live.none).toMatchObject({ ok: false, code: 'not_a_task_run' });
    expect(live.wrong).toMatchObject({ ok: false, code: 'wrong_token' });
    expect(live.otherTask).toMatchObject({ ok: false, code: 'wrong_task' });
    // The run ended without delivering (stopped, its claim closed): its late delivery is refused.
    expect(deliverTask(f.contextRoot, 'task_fix', { note: 'x' }, { env, cwd, home: f.home })).toMatchObject({ ok: false, code: 'stale_run' });
    expect(taskData(f, 'fix').agent_state).toBe('stopped');
  });
});

describe('deliver checks inside a live run (AC-C1-7)', () => {
  it('refuses symlinks, outside paths, ignored and .env files, secrets; accepts a clean file; the reviewer cannot deliver, the doer cannot review', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    execFileSync('git', ['init', '-q', f.projectRoot]);
    writeFileSync(join(f.projectRoot, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(f.projectRoot, 'ignored.txt'), 'x');
    writeFileSync(join(f.projectRoot, '.env.local'), 'A=1');
    writeFileSync(join(f.projectRoot, 'ok.txt'), 'fine');
    writeFileSync(join(f.projectRoot, 'leak.txt'), 'token ghp_' + 'a'.repeat(36));
    symlinkSync(join(f.projectRoot, 'ok.txt'), join(f.projectRoot, 'link.txt'));
    const outside = join(f.home, 'outside.txt');
    writeFileSync(outside, 'out');
    const results: Record<string, unknown> = {};
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([{
      during: (c) => {
        const e = c.env as NodeJS.ProcessEnv;
        const d = (more: Parameters<typeof deliverTask>[2]) => deliverTask(f.contextRoot, 'task_fix', more, { env: e, cwd: c.cwd, home: f.home, now: T0, notify: activeNotify });
        results.symlink = d({ note: 'n', files: ['link.txt'] });
        results.outside = d({ note: 'n', files: [outside] });
        results.ignored = d({ note: 'n', files: ['ignored.txt'] });
        results.env = d({ note: 'n', files: ['.env.local'] });
        results.secretFile = d({ note: 'n', files: ['leak.txt'] });
        results.secretNote = d({ note: 'here is sk-ant-' + 'b'.repeat(30) });
        results.badDoc = d({ note: 'n', docs: ['../outside.md'] });
        results.review = reviewTask(f.contextRoot, 'task_fix', { verdict: 'pass' }, { env: e, home: f.home });
        results.ok = d({ note: 'All done.', files: ['ok.txt'] });
      },
    }]);
    expect(results.symlink).toMatchObject({ ok: false, code: 'file_symlink' });
    expect(results.outside).toMatchObject({ ok: false, code: 'file_outside' });
    expect(results.ignored).toMatchObject({ ok: false, code: 'file_ignored' });
    expect(results.env).toMatchObject({ ok: false, code: 'file_env' });
    expect(results.secretFile).toMatchObject({ ok: false, code: 'file_secret' });
    expect(results.secretNote).toMatchObject({ ok: false, code: 'note_secret' });
    expect(results.badDoc).toMatchObject({ ok: false, code: 'ref_invalid' });
    expect(results.review).toMatchObject({ ok: false, code: 'wrong_step' });
    expect(results.ok).toMatchObject({ ok: true, state: 'delivered' });
    const del = (taskData(f, 'fix').deliveries as Array<{ refs: Array<{ kind: string; path: string }> }>)[0];
    expect(del.refs[0].kind).toBe('file');
    expect(del.refs[0].path).toMatch(/^automations\/output\/scout\/tasks\/task-[0-9a-f]{8}\/ok\.txt$/);
  });

  it('a workspace that is not a git repository refuses every file (fails closed)', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    writeFileSync(join(f.projectRoot, 'ok.txt'), 'fine');
    let res: unknown;
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([{ during: (c) => { res = deliverTask(f.contextRoot, 'task_fix', { note: 'n', files: ['ok.txt'] }, { env: c.env as NodeJS.ProcessEnv, cwd: c.cwd, home: f.home }); } }]);
    expect(res).toMatchObject({ ok: false, code: 'file_unchecked' });
  });

  it('a review for another round is refused', async () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout', { reviewer: 'checker' });
    let res: unknown;
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers(), { during: (c) => {
      writeFileSync(join(f.contextRoot, 'state', 'fix.md'), taskText(f, 'fix').replace('review_round: 1', 'review_round: 2'));
      res = reviewTask(f.contextRoot, 'task_fix', { verdict: 'pass' }, { env: c.env as NodeJS.ProcessEnv, home: f.home });
    } }]);
    expect(res).toMatchObject({ ok: false, code: 'wrong_round' });
  });
});

describe('the session gate (C1-14, AC-C1-12)', () => {
  async function askedTask(): Promise<{ h: Harness; sid: string }> {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([asksQuestion()]);
    const sid = argAfter(h.calls[0].args, '--session-id')!;
    return { h, sid };
  }

  it('the answer re-queues the step and spawns nothing; the next drain resumes the SAME session with the answer; a second answer is refused', async () => {
    const { h, sid } = await askedTask();
    expect(taskBindingOf(sid, f.home)).toEqual({ slug: 'scout', taskId: 'task_fix' });
    const q = pendingQuestion(f.contextRoot, 'scout')!;
    const spawn = standInClaude([]);
    const out = await resumeWithAnswer(f.contextRoot, q, 'The SSO one.', 'dashboard', { home: f.home, spawnImpl: spawn.impl });
    expect(out.status).toBe('ok');
    expect(spawn.calls).toHaveLength(0);
    expect(readQuestion(questionPath(f.contextRoot, 'scout', q.id))?.state).toBe('answered');
    expect(taskData(f, 'fix').agent_state).toBe('queued');
    const again = await resumeWithAnswer(f.contextRoot, q, 'Another answer.', 'telegram', { home: f.home, spawnImpl: spawn.impl });
    expect(again.status).toBe('refused');
    expect(spawn.calls).toHaveLength(0);
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers()]);
    expect(h.calls[1].args.slice(0, 2)).toEqual(['--resume', sid]);
    expect(argAfter(h.calls[1].args, '-p')).toContain('The SSO one.');
    expect(taskData(f, 'fix').status).toBe('in_review');
  });

  it('a thread or Telegram message never resumes a task session; the chat socket refuses it', async () => {
    const { sid } = await askedTask();
    expect(latestBoundSession('scout', f.home)).toBeNull();
    const spawn = standInClaude([]);
    const talk = await resumeWithMessage(f.contextRoot, 'scout', 'hello?', { home: f.home, spawnImpl: spawn.impl, surface: 'telegram' });
    expect(talk.status).toBe('refused');
    expect(spawn.calls).toHaveLength(0);
    expect(refusesTaskSession(f.contextRoot, [sid], f.home)).toBe(true);
    expect(refusesTaskSession(f.contextRoot, ['00000000-0000-4000-8000-000000000000'], f.home)).toBe(false);
  });

  it('after unassign the answer is refused and the session still never becomes the agent\'s conversation', async () => {
    const { sid } = await askedTask();
    const q = pendingQuestion(f.contextRoot, 'scout')!;
    unassignTaskJob(f.contextRoot, 'fix', f.home);
    const spawn = standInClaude([]);
    const out = await resumeWithAnswer(f.contextRoot, q, 'late', 'dashboard', { home: f.home, spawnImpl: spawn.impl });
    expect(out.status).toBe('refused');
    expect(spawn.calls).toHaveLength(0);
    // A later ordinary conversation of the agent is what a message resumes, never the task's.
    recordAutomationSession('scout', 'sess-own-chat', f.home);
    expect(latestBoundSession('scout', f.home)).toBe('sess-own-chat');
    expect(refusesTaskSession(f.contextRoot, [sid], f.home)).toBe(true);
  });
});

describe('a deleted agent stops its queued tasks', () => {
  it('queued → stopped "agent gone"', async () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'busy');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    removeAgent(f.contextRoot, 'scout', { home: f.home });
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'stopped', agent_stopped: 'agent gone' });
  });
});

describe('the remaining corners (AC-C1-4, -5, -7, -8, -12, -13)', () => {
  it('no-child refusals go back to queued at their place with no row: a live orphan of the agent, a pending question (the review gate)', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const before = taskData(f, 'fix').agent_queued_at;
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    // A previous child of the agent still alive with its runner gone: the orphan guard refuses before spawning.
    const { writeRunSidecar, clearRunSidecar } = await import('../../src/lib/automations/store.js');
    writeRunSidecar(f.contextRoot, 'scout', { slug: 'scout', runnerPid: 4_999_990, childPid: process.pid, childPgid: process.pid, fireAt: T0.toISOString(), startedAt: T0.toISOString(), timeoutAt: T0.toISOString() });
    expect(await h.runHosts([], { spawnImpl: standInClaude([]).impl })).toEqual(['queued']);
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'queued', agent_queued_at: before });
    clearRunSidecar(f.contextRoot, 'scout');
    // A question pending for the agent (asked elsewhere): the review gate refuses before spawning.
    createQuestion(f.contextRoot, { slug: 'scout', runFiredAt: T0.toISOString(), kind: 'flow-hitl', sessionId: null, channel: 'chat', question: 'Other run asks', target: 'agent' });
    const live = new Set<number>();
    const d2: TaskJobDeps = { ...h.deps, isAlive: (p) => live.has(p) };
    // The drain itself skips an agent with an open question; a claim made before the question still hits the gate in the runner.
    expect(startDueTaskJobs(f.contextRoot, d2)).toEqual([]);
    expect(listInboxRows(f.projectRoot, f.home)).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it('a code task whose brain would not resolve from the worktree is blocked up front; a blocked task restarts nothing on later ticks', async () => {
    const { updateSetupConfig } = await import('../../src/lib/setup-config.js');
    const { setLinkedRepoPath } = await import('../../src/lib/linked-repos.js');
    makeAgent(f, 'scout');
    writeTask(f, 'code', { id: 'task_code' });
    const repo = join(f.home, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'i']);
    updateSetupConfig(f.projectRoot, { linkedRepos: [{ name: 'repo', gitRemoteUrl: 'https://github.com/example/repo.git' }] });
    setLinkedRepoPath('https://github.com/example/repo.git', repo, f.home);
    assign('code', 'scout', { workspace: 'code', repo: 'repo' });
    // The scheduler no longer knows the project: the env brain could not be trusted from the worktree.
    writeFileSync(join(f.home, '.dreamcontext', 'automations.json'), JSON.stringify({ projects: {} }));
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(await h.runHosts([])).toEqual(['blocked']);
    expect(String(taskData(f, 'code').agent_blocked)).toMatch(/brain would not resolve/);
    startDueTaskJobs(f.contextRoot, h.deps);
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(h.hosts).toHaveLength(1);
  });

  it('the code reviewer\'s digest changes on any edit: a tracked file, a second edit of an already-modified file, a new untracked file', async () => {
    const { workspaceDigest } = await import('../../src/lib/agents/task-host.js');
    const repo = join(f.home, 'wt');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'i']);
    const view = { slug: 'x', id: 'task_x', name: 'X', status: 'in_review', agent: 'scout', reviewer: 'c', state: null, step: 'review', round: 1, claimedMachine: null, queuedAt: null, parent: null, raw: {} } as never;
    const meta = { taskId: 'task_x', taskSlug: 'x', doer: 'scout', reviewer: 'c', workspace: 'code', repo: 'r', startAt: null, queuedAt: '', reviewCap: 5, base: null, noVerdict: 0 } as never;
    const d0 = workspaceDigest(f.contextRoot, view, meta, repo);
    writeFileSync(join(repo, 'a.ts'), 'two\n');
    const d1 = workspaceDigest(f.contextRoot, view, meta, repo);
    writeFileSync(join(repo, 'a.ts'), 'three\n');
    const d2 = workspaceDigest(f.contextRoot, view, meta, repo);
    writeFileSync(join(repo, 'new.ts'), 'x\n');
    const d3 = workspaceDigest(f.contextRoot, view, meta, repo);
    expect(new Set([d0, d1, d2, d3]).size).toBe(4);
    expect(workspaceDigest(f.contextRoot, view, meta, repo)).toBe(d3);
  });

  it('the delivery banner opens the task in the app', async () => {
    const { addVault } = await import('../../src/lib/vaults.js');
    addVault('lumen', f.projectRoot, f.home);
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers()]);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(String(h.notify.mock.calls[0][2])).toBe('dreamcontext://project/lumen/page/tasks/fix');
  });

  it('a second question in the same task session resolves too, and resumes the same session again', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([asksQuestion()]);
    const sid = argAfter(h.calls[0].args, '--session-id');
    expect((await resumeWithAnswer(f.contextRoot, pendingQuestion(f.contextRoot, 'scout')!, 'First answer.', 'dashboard', { home: f.home })).status).toBe('ok');
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([asksQuestion()]);
    expect(taskData(f, 'fix').agent_state).toBe('waiting_owner');
    expect((await resumeWithAnswer(f.contextRoot, pendingQuestion(f.contextRoot, 'scout')!, 'Second answer.', 'dashboard', { home: f.home })).status).toBe('ok');
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers()]);
    expect(h.calls.map((c) => c.args.indexOf('--resume') >= 0 ? c.args[c.args.indexOf('--resume') + 1] : argAfter(c.args, '--session-id'))).toEqual([sid, sid, sid]);
    expect(taskData(f, 'fix').status).toBe('in_review');
  });

  it('the stage lists the agent\'s live task-job step (task steps no longer run as server jobs)', async () => {
    const { buildStageView } = await import('../../src/server/routes/agents.js');
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    let seen: unknown = null;
    await h.runHosts([{ during: () => { seen = buildStageView(f.contextRoot, 'scout')?.taskJobs; } }]);
    expect(seen).toEqual([expect.objectContaining({ taskId: 'task_fix', taskSlug: 'fix', step: 'work', role: 'doer', phase: 'active' })]);
  });
});

describe('end review r1 fixes (C1)', () => {
  it('a start refused before any child ran keeps its note, and the next attempt starts the session fresh (never --resume a session that was never created)', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout', { note: 'Start with the login test.' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    writeSleepState(f.contextRoot, { ...readSleepState(f.contextRoot), sleep_started_at: T0.toISOString() });
    expect(await h.runHosts([])).toEqual(['queued']);
    expect(readTaskJobs(f.projectRoot, f.home).sessions).toEqual([]);
    expect(readTaskJobs(f.projectRoot, f.home).notes).toEqual([expect.objectContaining({ kind: 'assign' })]);
    writeSleepState(f.contextRoot, { ...readSleepState(f.contextRoot), sleep_started_at: null });
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers()]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].args).not.toContain('--resume');
    expect(argAfter(h.calls[0].args, '--session-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(argAfter(h.calls[0].args, '-p')).toContain('Start with the login test.');
    expect(readTaskJobs(f.projectRoot, f.home).notes).toEqual([]);
    expect(taskData(f, 'fix').status).toBe('in_review');
  });

  it('Continue works on a blocked task (and clears why it was blocked)', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    revokeApproval(f.projectRoot, 'scout', f.home, 'agent');
    expect(await h.runHosts([])).toEqual(['blocked']);
    expect(taskData(f, 'fix').agent_blocked).toBeTruthy();
    const { approveAutomation } = await import('../../src/lib/automations/registry.js');
    approveAutomation(f.projectRoot, getRunTarget(f.contextRoot, 'scout', 'agent')!, T0, f.home);
    expect(continueTaskAction(f.contextRoot, 'fix', h.deps)).toEqual({ ok: true });
    expect(taskData(f, 'fix').agent_blocked ?? null).toBeNull();
    await h.runHosts([delivers()]);
    expect(taskData(f, 'fix').status).toBe('in_review');
  });

  it('a task its owner completed while the run was live is never reopened by the run\'s delivery or settle', async () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    let late: unknown;
    await h.runHosts([{ during: (c) => {
      writeFileSync(join(f.contextRoot, 'state', 'fix.md'), taskText(f, 'fix').replace('status: in_progress', 'status: completed'));
      late = deliverTask(f.contextRoot, 'task_fix', { note: 'Done anyway.' }, { env: c.env as NodeJS.ProcessEnv, cwd: c.cwd, home: f.home, notify: activeNotify });
    } }]);
    expect(late).toMatchObject({ ok: false, code: 'stale_run' });
    expect(taskData(f, 'fix').status).toBe('completed');
  });

  it('closing a task through the CLI path ends its job: the live claim goes', async () => {
    const { endTaskJobIfClosed } = await import('../../src/lib/agents/task-starter.js');
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(claimsForTask(f.projectRoot, 'task_fix', f.home)).toHaveLength(1);
    writeFileSync(join(f.contextRoot, 'state', 'fix.md'), taskText(f, 'fix').replace('status: in_progress', 'status: completed'));
    endTaskJobIfClosed(f.contextRoot, 'fix', h.deps);
    expect(claimsForTask(f.projectRoot, 'task_fix', f.home)).toEqual([]);
  });

  it('Stop spends the start ticket: a synced edit restoring queued starts nothing; a deleted agent leaves no ticket or ledger', async () => {
    const { stopTaskAction } = await import('../../src/lib/agents/task-starter.js');
    const { readAssignmentLedger } = await import('../../src/lib/agents/assignment-ledger.js');
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout', { startAt: '2099-01-01T00:00:00Z' });
    const h = harness();
    expect(stopTaskAction(f.contextRoot, 'fix', h.deps)).toEqual({ ok: true });
    expect(readAssignmentLedger(f.projectRoot, f.home).armed).toEqual([]);
    writeFileSync(join(f.contextRoot, 'state', 'fix.md'), taskText(f, 'fix').replace('agent_state: stopped', 'agent_state: queued'));
    expect(startDueTaskJobs(f.contextRoot, h.deps)).toEqual([]);
    makeAgent(f, 'gone');
    writeTask(f, 'other', { id: 'task_other' });
    assign('other', 'gone');
    removeAgent(f.contextRoot, 'gone', { home: f.home });
    const ledger = readAssignmentLedger(f.projectRoot, f.home);
    expect(ledger.armed.filter((a) => a.taskId === 'task_other')).toEqual([]);
    expect(ledger.records.filter((r) => r.taskId === 'task_other')).toEqual([]);
  });

  it('the review digest never runs a repo-configured external diff in the host', async () => {
    const { workspaceDigest } = await import('../../src/lib/agents/task-host.js');
    const repo = join(f.home, 'wt2');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'a.ts'), 'one\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'i']);
    const marker = join(f.home, 'ran-external-diff');
    const script = join(f.home, 'ext.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    execFileSync('chmod', ['+x', script]);
    execFileSync('git', ['-C', repo, 'config', 'diff.external', script]);
    execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', script]);
    writeFileSync(join(repo, 'a.ts'), 'two\n');
    const view = { raw: {} } as never;
    const meta = { workspace: 'code', doer: 'scout' } as never;
    workspaceDigest(f.contextRoot, view, meta, repo);
    expect(existsSync(marker)).toBe(false);
  });

  it('Stop never signals a live pid that is not this run\'s host', async () => {
    const { stopTaskAction } = await import('../../src/lib/agents/task-starter.js');
    const { spawn } = await import('node:child_process');
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    const stranger = spawn('sleep', ['30'], { stdio: 'ignore' });
    const { updateTaskJobs } = await import('../../src/lib/agents/task-jobs.js');
    updateTaskJobs(f.projectRoot, (j) => { j.claims = j.claims.map((c) => ({ ...c, hostPid: stranger.pid! })); }, f.home);
    stopTaskAction(f.contextRoot, 'fix', { home: f.home, now: () => T0, spawnHost: () => null, killGroup: () => {} });
    // A signalled child is a zombie until reaped, so ask how it ended, after a moment.
    await new Promise((r) => setTimeout(r, 300));
    expect(stranger.signalCode).toBeNull();
    expect(stranger.exitCode).toBeNull();
    stranger.kill('SIGKILL');
  });
});

describe('end review r2 fixes (C1)', () => {
  it('Continue on a blocked rework keeps the reviewer\'s findings for the resumed doer', async () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    // The reviewer fails it; before the rework's child runs, the doer stops being approved: the
    // rework is claimed and blocked with the findings still waiting.
    const failAndRevoke: ChildScript = { during: (c) => { reviews('fail', ['AC 1: the 500 is still there']).during!(c); revokeApproval(f.projectRoot, 'scout', f.home, 'agent'); } };
    expect(await h.runHosts([delivers(), failAndRevoke])).toEqual([null, 'queued', 'blocked']);
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'blocked', agent_step: 'rework' });
    const { approveAutomation } = await import('../../src/lib/automations/registry.js');
    approveAutomation(f.projectRoot, getRunTarget(f.contextRoot, 'scout', 'agent')!, T0, f.home);
    expect(continueTaskAction(f.contextRoot, 'fix', h.deps)).toEqual({ ok: true });
    expect(readTaskJobs(f.projectRoot, f.home).notes).toEqual([expect.objectContaining({ kind: 'findings' })]);
    await h.runHosts([delivers('Fixed the 500.')]);
    // The run after Continue is the doer's resumed session, carrying the findings (then the round-2 review runs).
    const rework = h.calls[2];
    expect(rework.args.slice(0, 2)).toEqual(['--resume', argAfter(h.calls[0].args, '--session-id')]);
    expect(argAfter(rework.args, '-p')).toContain('AC 1: the 500 is still there');
  });

  it('deleting a task\'s reviewer leaves its doer\'s record and ticket: the work still starts', async () => {
    const { readAssignmentLedger } = await import('../../src/lib/agents/assignment-ledger.js');
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout', { reviewer: 'checker', startAt: '2099-01-01T00:00:00Z' });
    removeAgent(f.contextRoot, 'checker', { home: f.home });
    const ledger = readAssignmentLedger(f.projectRoot, f.home);
    expect(ledger.records.map((r) => r.role)).toEqual(['doer']);
    expect(ledger.armed).toEqual([expect.objectContaining({ taskId: 'task_fix', step: 'work' })]);
    expect(taskData(f, 'fix').agent_state).toBe('scheduled');
  });
});

describe('end review r3 fixes (C1)', () => {
  it('a reviewer deleted during the work: the delivery goes straight to the owner, never a review nobody claims', async () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([{ during: (c) => {
      removeAgent(f.contextRoot, 'checker', { home: f.home });
      // Both copies forget it (the drain compares them): the machine-local one and the task's.
      expect(metaFor(f.projectRoot, 'task_fix', f.home)?.reviewer).toBeNull();
      delivers().during!(c);
    } }]);
    expect(taskData(f, 'fix')).toMatchObject({ status: 'in_review', agent_state: 'delivered', reviewer: null });
    expect(listInboxRows(f.projectRoot, f.home).map((r) => r.kind)).toEqual(['task-review']);
    expect(h.hosts).toHaveLength(1);
  });

  it('a reviewer deleted while its review waits: the delivery waits for the owner instead', async () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    // The reviewer is busy, so the review stays queued after the delivery.
    const { lockPathFor } = await import('../../src/lib/automations/store.js');
    mkdirSync(join(f.contextRoot, 'automations', 'cache'), { recursive: true });
    writeFileSync(lockPathFor(f.contextRoot, 'checker'), JSON.stringify({ pid: process.pid, at: T0.getTime() }));
    await h.runHosts([delivers()]);
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'queued', agent_step: 'review' });
    removeAgent(f.contextRoot, 'checker', { home: f.home });
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'delivered', reviewer: null, status: 'in_review' });
    expect(listInboxRows(f.projectRoot, f.home).map((r) => r.kind)).toEqual(['task-review']);
    expect(startDueTaskJobs(f.contextRoot, h.deps)).toEqual([]);
  });
});
