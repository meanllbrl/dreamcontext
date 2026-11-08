/**
 * Wave 1 lane G (plan r10 1c): a task's review shows correctly, server side.
 *  - the reviewer's findings reach the task's changelog on a fail; a pass, a fail at the cap and
 *    a stuck review each leave their line, by the reviewer, the status unmoved;
 *  - the owner's send-back names its round;
 *  - the same pre-spawn refusal twice in a row blocks the task (counted in M0), no third drain;
 *    a lock wait (`deferred`) is never counted;
 *  - closing a task ends a queued or scheduled job state; unassign clears the review fields;
 *  - a start from outside the app keeps the reviewer the task already names;
 *  - a Codex/Antigravity doer or reviewer is refused at assignment, derived from the envelope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import {
  makeAgent, makeFixture, standInClaude, taskData, taskText, writeTask,
  type ChildScript, type Fixture,
} from '../helpers/task-job-fixture.js';
import { commitAssignment, prepareAssignment, taskStepToolRefusal } from '../../src/lib/agents/task-assignment.js';
import { endTaskJobIfClosed, sendBackAction, startDueTaskJobs, unassignTaskJob, type TaskJobDeps } from '../../src/lib/agents/task-starter.js';
import { runTaskJob, type TaskHostDeps, FINDINGS_ON_TASK_CHARS } from '../../src/lib/agents/task-host.js';
import { deliverTask, reviewTask } from '../../src/lib/agents/task-delivery.js';
import { metaFor, readTaskJobs } from '../../src/lib/agents/task-jobs.js';
import { parseStatusHistory } from '../../src/lib/task-history.js';
import { envelopeRefusal } from '../../src/lib/t3-bridge/headless-envelope.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { getRunTarget } from '../../src/lib/automations/store.js';
import type { RunOutcome } from '../../src/lib/automations/runner.js';

let f: Fixture;
const T0 = new Date('2026-10-25T09:00:00.000Z');
const probeUsage = async () => ({ status: 'ok' as const, limits: { limits: [{ key: 'session', percent: 10, resetsAt: T0.getTime() + 3_600_000 }, { key: 'weekly', percent: 10, resetsAt: T0.getTime() + 86_400_000 }], fetchedAtMs: T0.getTime() } });

beforeEach(() => { f = makeFixture('dc-taskreview'); });
afterEach(() => { f.cleanup(); });

function harness() {
  const hosts: Array<{ slug: string; runId: string }> = [];
  let pid = 4_700_000;
  const deps: TaskJobDeps = {
    home: f.home,
    now: () => T0,
    spawnHost: (_r, slug, runId) => { hosts.push({ slug, runId }); return pid++; },
    isAlive: (p) => p === process.pid,
    killGroup: () => {},
  };
  let ran = 0;
  /** Run the hosts the drains recorded, at most `max`, with the stand-in scripts or a fake runner. */
  const runHosts = async (scripts: ChildScript[], extra: Partial<TaskHostDeps> = {}, max = 20): Promise<Array<string | null>> => {
    const out: Array<string | null> = [];
    let n = 0;
    while (ran < hosts.length && out.length < max) {
      const h = hosts[ran++];
      const spawn = standInClaude(scripts.slice(n));
      const res = await runTaskJob(f.contextRoot, h.slug, h.runId, { ...deps, spawnImpl: spawn.impl, probeUsage, stallPollMs: 5, ...extra });
      n += spawn.calls.length;
      out.push(res.state);
    }
    return out;
  };
  return { hosts, deps, runHosts };
}

function assign(slug: string, agent: string, opts: Partial<Parameters<typeof prepareAssignment>[3]> = {}): void {
  const prep = prepareAssignment(f.contextRoot, slug, agent, { home: f.home, source: 'dashboard', ...opts });
  if (!prep.ok) throw new Error(`${prep.code}: ${prep.message}`);
  commitAssignment(f.contextRoot, prep, T0, { home: f.home });
}

const delivers = (note = 'Did the work.'): ChildScript => ({
  during: (c) => {
    const r = deliverTask(f.contextRoot, String(c.env.DREAMCONTEXT_TASK_ID), { note }, { env: c.env as NodeJS.ProcessEnv, cwd: c.cwd, home: f.home, now: T0 });
    if (!r.ok) throw new Error(r.message);
  },
});
const reviews = (verdict: 'pass' | 'fail', findings: string[] = []): ChildScript => ({
  during: (c) => {
    const r = reviewTask(f.contextRoot, String(c.env.DREAMCONTEXT_TASK_ID), { verdict, findings }, { env: c.env as NodeJS.ProcessEnv, home: f.home });
    if (!r.ok) throw new Error(r.message);
  },
});

/** Put a member on another tool, approved as it is now (the tool is hashed). */
function onTool(slug: string, tool: 'codex' | 'antigravity'): void {
  const path = join(f.contextRoot, 'agents', `${slug}.md`);
  const doc = matter(readFileSync(path, 'utf-8'));
  writeFileSync(path, matter.stringify(doc.content, { ...doc.data, tool }));
  const target = getRunTarget(f.contextRoot, slug, 'agent');
  if (!target) throw new Error('no target');
  approveAutomation(f.projectRoot, target, T0, f.home);
}

function refusal(status: RunOutcome['status'], error: string): () => Promise<RunOutcome> {
  return async () => ({
    slug: 'scout', status, error, outputPath: null, durationMs: 0, event: null, cache: null, denials: 0, costUsd: null,
    reviewCardId: null, spawned: false, sessionId: null, result: null,
  });
}

describe('the review result reaches the task (findings, passed, failed, stuck)', () => {
  beforeEach(() => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'fix', { id: 'task_fix' });
  });

  it('a fail writes the reviewer and its findings; a pass writes passed; the status stays the project\'s In Review', async () => {
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers(), reviews('fail', ['AC 1: the login still 500s', 'AC 2: no test']), delivers('Fixed the 500.'), reviews('pass')]);
    const hist = parseStatusHistory(taskText(f, 'fix'));
    expect(hist[0]).toMatchObject({ to: 'in_review', by: 'reviewer:checker', reason: 'Review round 2: passed (Agent checker).' });
    const sentBack = hist.find((r) => r.reason?.startsWith('Review round 1: sent back'));
    expect(sentBack).toMatchObject({ to: 'in_progress', by: 'reviewer:checker' });
    expect(sentBack!.reason).toBe('Review round 1: sent back (Agent checker): AC 1: the login still 500s AC 2: no test');
    expect(taskData(f, 'fix')).toMatchObject({ status: 'in_review', agent_state: 'delivered', review_passed: true });
  });

  it('the findings on the task are cut to their first 300 characters', async () => {
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    const long = 'x'.repeat(900);
    await h.runHosts([delivers(), reviews('fail', [long]), delivers(), reviews('pass')]);
    const line = parseStatusHistory(taskText(f, 'fix')).find((r) => r.reason?.startsWith('Review round 1: sent back'))!.reason!;
    const findings = line.slice('Review round 1: sent back (Agent checker): '.length);
    expect(findings.length).toBe(FINDINGS_ON_TASK_CHARS);
    expect(findings.endsWith('…')).toBe(true);
  });

  it('a fail at the cap writes failed with the findings; the task stays In Review, stuck', async () => {
    assign('fix', 'scout', { reviewer: 'checker', reviewCap: 1 });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers(), reviews('fail', ['still broken'])]);
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'stuck', status: 'in_review' });
    expect(parseStatusHistory(taskText(f, 'fix'))[0]).toMatchObject({ to: 'in_review', by: 'reviewer:checker', reason: 'Review round 1: failed (Agent checker): still broken' });
  });

  it('no usable verdict twice writes stuck', async () => {
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers(), { result: 'looked, said nothing' }, { result: 'again nothing' }]);
    expect(taskData(f, 'fix').agent_state).toBe('stuck');
    expect(parseStatusHistory(taskText(f, 'fix'))[0]).toMatchObject({ by: 'reviewer:checker', reason: 'Review round 1: stuck (Agent checker): no usable verdict.' });
  });

  it('the owner\'s send-back names the round it sent back', async () => {
    assign('fix', 'scout');
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers()]);
    expect(sendBackAction(f.contextRoot, 'fix', 'Add the test.', h.deps)).toEqual({ ok: true });
    const owner = parseStatusHistory(taskText(f, 'fix')).find((r) => r.by === 'owner' && r.to === 'in_progress' && r.reason?.startsWith('Review round'));
    expect(owner?.reason).toBe('Review round 1: sent back by the owner.');
  });
});

describe('a pre-spawn refusal cannot loop', () => {
  beforeEach(() => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix', { id: 'task_fix' });
    assign('fix', 'scout');
  });

  it('the same refusal twice in a row blocks the task; nothing drains a third time', async () => {
    const h = harness();
    const run = vi.fn(refusal('failed', 'No Codex account is signed in on this Mac.'));
    startDueTaskJobs(f.contextRoot, h.deps);
    const states = await h.runHosts([], { run: run as unknown as TaskHostDeps['run'] });
    expect(states).toEqual(['queued', 'blocked']);
    expect(run).toHaveBeenCalledTimes(2);
    expect(taskData(f, 'fix')).toMatchObject({ agent_state: 'blocked', agent_blocked: 'No Codex account is signed in on this Mac.' });
    expect(metaFor(f.projectRoot, 'task_fix', f.home)?.lastRefusal ?? null).toBeNull();
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(h.hosts).toHaveLength(2);
  });

  it('two different refusals in a row only requeue; the count lives in the machine-local record', async () => {
    const h = harness();
    const errors = ['first reason', 'second reason'];
    let i = 0;
    const run = vi.fn(async () => (await refusal('failed', errors[Math.min(i++, 1)])()));
    startDueTaskJobs(f.contextRoot, h.deps);
    const states = await h.runHosts([], { run: run as unknown as TaskHostDeps['run'] }, 2);
    expect(states).toEqual(['queued', 'queued']);
    expect(metaFor(f.projectRoot, 'task_fix', f.home)?.lastRefusal).toEqual({ key: 'failed:second reason', count: 1 });
  });

  it('a lock wait (the sleep lock) is never counted', async () => {
    const h = harness();
    const run = vi.fn(refusal('deferred', 'a sleep consolidation is in progress'));
    startDueTaskJobs(f.contextRoot, h.deps);
    const states = await h.runHosts([], { run: run as unknown as TaskHostDeps['run'] }, 3);
    expect(states).toEqual(['queued', 'queued', 'queued']);
    expect(metaFor(f.projectRoot, 'task_fix', f.home)?.lastRefusal ?? null).toBeNull();
  });

  it('a runner refusal that is already blocked blocks at once', async () => {
    const h = harness();
    const run = vi.fn(refusal('blocked', '"scout" cannot run on Codex. A task step pins a Claude session id before its first turn.'));
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(await h.runHosts([], { run: run as unknown as TaskHostDeps['run'] })).toEqual(['blocked']);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('closing and unassigning leave no stale job', () => {
  beforeEach(() => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'fix', { id: 'task_fix' });
  });

  function close(slug: string): void {
    const path = join(f.contextRoot, 'state', `${slug}.md`);
    const doc = matter(readFileSync(path, 'utf-8'));
    writeFileSync(path, matter.stringify(doc.content, { ...doc.data, status: 'completed' }));
  }

  it('closing a task whose step is only queued ends the job state; nothing starts later', () => {
    assign('fix', 'scout');
    expect(taskData(f, 'fix').agent_state).toBe('queued');
    close('fix');
    const h = harness();
    endTaskJobIfClosed(f.contextRoot, 'fix', h.deps);
    expect(taskData(f, 'fix').agent_state ?? null).toBeNull();
    startDueTaskJobs(f.contextRoot, h.deps);
    expect(h.hosts).toHaveLength(0);
  });

  it('closing a task whose start is scheduled ends it too', () => {
    assign('fix', 'scout', { startAt: '2026-10-26T09:00:00Z' });
    expect(taskData(f, 'fix').agent_state).toBe('scheduled');
    close('fix');
    endTaskJobIfClosed(f.contextRoot, 'fix', harness().deps);
    expect(taskData(f, 'fix').agent_state ?? null).toBeNull();
  });

  it('an open task keeps its queued state', () => {
    assign('fix', 'scout');
    endTaskJobIfClosed(f.contextRoot, 'fix', harness().deps);
    expect(taskData(f, 'fix').agent_state).toBe('queued');
  });

  it('unassign clears the review and delivery fields with the agent', async () => {
    assign('fix', 'scout', { reviewer: 'checker' });
    const h = harness();
    startDueTaskJobs(f.contextRoot, h.deps);
    await h.runHosts([delivers(), reviews('pass')]);
    expect(taskData(f, 'fix')).toMatchObject({ review_round: 1, review_passed: true });
    unassignTaskJob(f.contextRoot, 'fix', f.home);
    const d = taskData(f, 'fix');
    for (const k of ['agent', 'reviewer', 'agent_state', 'agent_step', 'review_round', 'review_cap', 'review_passed', 'deliveries', 'agent_start_at', 'agent_queued_at', 'agent_workspace', 'agent_repo']) {
      expect(d[k] ?? null, k).toBeNull();
    }
    expect(readTaskJobs(f.projectRoot, f.home).meta).toEqual([]);
  });
});

describe('a start from outside the app keeps the reviewer', () => {
  beforeEach(() => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
  });

  it('a reviewer the task file names stays on the job; without keepReviewer it is dropped as before', () => {
    writeTask(f, 'fix', { id: 'task_fix', extra: { agent: 'scout', reviewer: 'checker' } });
    const kept = prepareAssignment(f.contextRoot, 'fix', 'scout', { home: f.home, source: 'dashboard', keepReviewer: true });
    expect(kept.ok && kept.job.reviewer).toEqual({ slug: 'checker', title: 'Agent checker' });
    const plain = prepareAssignment(f.contextRoot, 'fix', 'scout', { home: f.home, source: 'dashboard' });
    expect(plain.ok && plain.job.reviewer).toBeNull();
  });

  it('an explicit reviewer still wins, and the doer never becomes its own reviewer', () => {
    makeAgent(f, 'critic');
    writeTask(f, 'fix', { id: 'task_fix', extra: { agent: 'scout', reviewer: 'scout' } });
    const self = prepareAssignment(f.contextRoot, 'fix', 'scout', { home: f.home, source: 'dashboard', keepReviewer: true });
    expect(self.ok && self.job.reviewer).toBeNull();
    const explicit = prepareAssignment(f.contextRoot, 'fix', 'scout', { home: f.home, source: 'dashboard', keepReviewer: true, reviewer: 'critic' });
    expect(explicit.ok && explicit.job.reviewer?.slug).toBe('critic');
  });
});

describe('a Codex or Antigravity member is refused at assignment (derived from the envelope)', () => {
  beforeEach(() => {
    makeAgent(f, 'scout');
    makeAgent(f, 'coder');
    writeTask(f, 'fix', { id: 'task_fix' });
  });

  it('as the doer: 409-class tool_unsupported with the envelope\'s reason; nothing written', () => {
    onTool('coder', 'codex');
    const prep = prepareAssignment(f.contextRoot, 'fix', 'coder', { home: f.home, source: 'dashboard' });
    expect(prep).toMatchObject({ ok: false, code: 'tool_unsupported' });
    expect(!prep.ok && prep.message).toContain(envelopeRefusal('task-step', 'codex'));
    expect(taskData(f, 'fix').agent ?? null).toBeNull();
  });

  it('as the reviewer, on Antigravity too', () => {
    onTool('coder', 'antigravity');
    const prep = prepareAssignment(f.contextRoot, 'fix', 'scout', { home: f.home, source: 'dashboard', reviewer: 'coder' });
    expect(prep).toMatchObject({ ok: false, code: 'tool_unsupported' });
    expect(!prep.ok && prep.message).toContain(envelopeRefusal('task-step', 'antigravity'));
  });

  it('an envelope with a task-step mode for the tool lets it through', () => {
    onTool('coder', 'codex');
    const withMode = (tool: 'codex' | 'antigravity') => (tool === 'codex' ? null : 'refused');
    const prep = prepareAssignment(f.contextRoot, 'fix', 'coder', { home: f.home, source: 'dashboard', toolCheck: withMode });
    expect(prep.ok).toBe(true);
  });

  it('the default check is the envelope row itself', () => {
    expect(taskStepToolRefusal('codex')).toBe(envelopeRefusal('task-step', 'codex'));
    expect(taskStepToolRefusal('antigravity')).toBe(envelopeRefusal('task-step', 'antigravity'));
  });
});
