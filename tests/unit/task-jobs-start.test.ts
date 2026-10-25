/**
 * Task jobs, the start side (AI Team v2 C1-2, C1-3, C1-4, M1): assigning, the drain's one claim
 * path, scheduled starts and their 12-hour window (with a DST change), the reconciler's crash
 * windows and dead hosts, the owner's actions, and the owner-inbox rows dying with their subject.
 *
 * Hosts are never spawned here: `spawnHost` records the claim it would have started, and pids
 * are fake (`isAlive` decides who lives).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeFixture, makeAgent, taskData, taskText, writeTask, type Fixture } from '../helpers/task-job-fixture.js';
import { commitAssignment, prepareAssignment } from '../../src/lib/agents/task-assignment.js';
import {
  CLAIM_GRACE_MS, LATE_START_MS, continueTaskAction, raiseTaskRow, letFinishAction, oneMoreRoundAction, parseStartAt, reconcileTaskJobs,
  reconcileTaskRows, rescheduleAction, startDueTaskJobs, startNowAction, stopTaskAction, takeOverAction, type TaskJobDeps,
} from '../../src/lib/agents/task-starter.js';
import { claimsForTask, metaFor, readTaskJobs, updateTaskJobs, type TaskClaim } from '../../src/lib/agents/task-jobs.js';
import { armStart, readAssignmentLedger } from '../../src/lib/agents/assignment-ledger.js';
import { listInboxRows } from '../../src/lib/owner-inbox.js';
import { lockPathFor, writeRunSidecar } from '../../src/lib/automations/store.js';
import { parseStatusHistory } from '../../src/lib/task-history.js';

let f: Fixture;
const T0 = new Date('2026-10-25T09:00:00.000Z');

beforeEach(() => { f = makeFixture(); });
afterEach(() => { f.cleanup(); });

/** A drain dependency set: hosts recorded, not spawned; `live` pids are alive. */
function deps(now: Date = T0, live: Set<number> = new Set()): TaskJobDeps & { spawned: Array<{ slug: string; runId: string }>; live: Set<number> } {
  const spawned: Array<{ slug: string; runId: string }> = [];
  let pid = 4_100_000;
  return {
    home: f.home,
    now: () => now,
    spawned,
    live,
    spawnHost: (_root, slug, runId) => { spawned.push({ slug, runId }); const p = pid++; live.add(p); return p; },
    isAlive: (p) => live.has(p),
    killGroup: () => {},
  };
}

function assign(slug: string, agent: string, opts: Parameters<typeof prepareAssignment>[3] = { source: 'dashboard' }, at: Date = T0) {
  const prep = prepareAssignment(f.contextRoot, slug, agent, { home: f.home, ...opts });
  if (!prep.ok) throw new Error(`${prep.code}: ${prep.message}`);
  return commitAssignment(f.contextRoot, prep, at, { home: f.home });
}

function claimOf(slug: string): TaskClaim | undefined {
  const id = String(taskData(f, slug).id);
  return claimsForTask(f.projectRoot, id, f.home)[0];
}

describe('assigning (C1-2)', () => {
  it('writes the display fields, the ledger, the M0 copies and the armed first step; nothing runs', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'fix-login', { id: 'task_fix1' });
    const r = assign('fix-login', 'scout');
    expect(r).toMatchObject({ state: 'queued', step: 'work', statusMoved: true });
    const d = taskData(f, 'fix-login');
    expect(d).toMatchObject({ agent: 'scout', agent_state: 'queued', agent_step: 'work', status: 'in_progress', review_round: 0, review_cap: 5, agent_workspace: 'doc' });
    expect(readAssignmentLedger(f.projectRoot, f.home).records).toEqual([expect.objectContaining({ taskId: 'task_fix1', role: 'doer', agent: 'scout' })]);
    expect(readAssignmentLedger(f.projectRoot, f.home).armed).toEqual([expect.objectContaining({ taskId: 'task_fix1', step: 'work', round: 0 })]);
    expect(metaFor(f.projectRoot, 'task_fix1', f.home)).toMatchObject({ doer: 'scout', reviewer: null, reviewCap: 5, startAt: null });
    expect(parseStatusHistory(taskText(f, 'fix-login'))[0]).toMatchObject({ to: 'in_progress', by: 'owner' });
  });

  it('an Ask agent plans first; a future start is scheduled', () => {
    makeAgent(f, 'careful', 'ask');
    writeTask(f, 'later', { id: 'task_later' });
    const r = assign('later', 'careful', { source: 'dashboard', startAt: '2026-10-26T09:00:00+03:00' });
    expect(r).toMatchObject({ state: 'scheduled', step: 'plan' });
    expect(taskData(f, 'later').agent_start_at).toBe('2026-10-26T06:00:00.000Z');
  });

  it('refuses a naive start, a code task with no repo, the agent as its own reviewer, an unknown reviewer', () => {
    makeAgent(f, 'scout');
    writeTask(f, 't1');
    const p = (o: Parameters<typeof prepareAssignment>[3]) => prepareAssignment(f.contextRoot, 't1', 'scout', { home: f.home, ...o });
    expect(p({ source: 'cli', startAt: '2026-10-26 09:00' })).toMatchObject({ ok: false, code: 'invalid_start' });
    expect(p({ source: 'cli', workspace: 'code' })).toMatchObject({ ok: false, code: 'no_repo' });
    expect(p({ source: 'cli', reviewer: 'scout' })).toMatchObject({ ok: false, code: 'reviewer_is_agent' });
    expect(p({ source: 'cli', reviewer: 'ghost' })).toMatchObject({ ok: false, code: 'unknown_reviewer' });
  });
});

describe('the drain: one claim path (C1-3)', () => {
  it('two agents\' due tasks start in one pass; each gets a claim, a CAS to starting, and its armed entry is spent', () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'writer');
    writeTask(f, 'a', { id: 'task_a' });
    writeTask(f, 'b', { id: 'task_b' });
    assign('a', 'scout');
    assign('b', 'writer');
    const d = deps();
    const started = startDueTaskJobs(f.contextRoot, d);
    expect(started).toHaveLength(2);
    expect(d.spawned.map((s) => s.slug).sort()).toEqual(['a', 'b']);
    for (const slug of ['a', 'b']) {
      expect(taskData(f, slug).agent_state).toBe('starting');
      expect(claimOf(slug)).toMatchObject({ phase: 'claiming', step: 'work', role: 'doer', resume: false });
      expect(claimOf(slug)!.hostPid).not.toBeNull();
    }
    expect(readAssignmentLedger(f.projectRoot, f.home).armed).toEqual([]);
  });

  it('drains firing at once produce exactly one claim and one host for a step', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'a', { id: 'task_a' });
    assign('a', 'scout');
    const d = deps();
    const one = startDueTaskJobs(f.contextRoot, d);
    const two = startDueTaskJobs(f.contextRoot, d);
    const three = startDueTaskJobs(f.contextRoot, deps(T0, d.live));
    expect([...one, ...two, ...three]).toHaveLength(1);
    expect(readTaskJobs(f.projectRoot, f.home).claims).toHaveLength(1);
  });

  it('one agent starts one task per pass; the next waits queued, first in first out', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'first', { id: 'task_1' });
    writeTask(f, 'second', { id: 'task_2' });
    assign('second', 'scout', { source: 'dashboard' }, new Date(T0.getTime() + 1000));
    assign('first', 'scout', { source: 'dashboard' }, T0);
    const d = deps();
    startDueTaskJobs(f.contextRoot, d);
    expect(d.spawned.map((s) => s.slug)).toEqual(['first']);
    expect(taskData(f, 'second').agent_state).toBe('queued');
  });

  it('a busy agent (its run lock held by a live process) keeps the task queued', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'a', { id: 'task_a' });
    assign('a', 'scout');
    mkdirSync(dirname(lockPathFor(f.contextRoot, 'scout')), { recursive: true });
    writeFileSync(lockPathFor(f.contextRoot, 'scout'), JSON.stringify({ pid: 4_200_001, at: T0.getTime() }));
    const d = deps(T0, new Set([4_200_001]));
    expect(startDueTaskJobs(f.contextRoot, d)).toEqual([]);
    expect(taskData(f, 'a').agent_state).toBe('queued');
    // The holder dies with no child behind it: its lock is reclaimed whatever its age, and the task starts.
    d.live.delete(4_200_001);
    expect(startDueTaskJobs(f.contextRoot, d)).toHaveLength(1);
  });

  it('a hand-edited assignment (no ledger, no armed entry on this machine) starts nothing', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'synced', { id: 'task_s', extra: { agent: 'scout', agent_state: 'queued', agent_step: 'work' } });
    expect(startDueTaskJobs(f.contextRoot, deps())).toEqual([]);
    expect(taskData(f, 'synced').agent_state).toBe('queued');
  });
});

describe('scheduled starts, the 12-hour window, DST (C1-3, AC-C1-9)', () => {
  it('a scheduled start waits for its instant, then starts', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'later', { id: 'task_l' });
    assign('later', 'scout', { source: 'dashboard', startAt: '2026-10-25T13:00:00+03:00' });
    expect(taskData(f, 'later').agent_state).toBe('scheduled');
    expect(startDueTaskJobs(f.contextRoot, deps(new Date('2026-10-25T09:59:00.000Z')))).toEqual([]);
    expect(startDueTaskJobs(f.contextRoot, deps(new Date('2026-10-25T10:00:30.000Z')))).toHaveLength(1);
  });

  it('a teammate\'s edit of agent_start_at or review_cap changes no start and no cap', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'later', { id: 'task_l' });
    assign('later', 'scout', { source: 'dashboard', startAt: '2026-10-26T09:00:00Z' });
    const path = join(f.contextRoot, 'state', 'later.md');
    const text = taskText(f, 'later').replace("agent_start_at: '2026-10-26T09:00:00.000Z'", "agent_start_at: '2026-10-25T00:00:00.000Z'").replace('review_cap: 5', 'review_cap: 10');
    writeFileSync(path, text);
    expect(startDueTaskJobs(f.contextRoot, deps())).toEqual([]);
    expect(metaFor(f.projectRoot, 'task_l', f.home)).toMatchObject({ startAt: '2026-10-26T09:00:00.000Z', reviewCap: 5 });
  });

  it('missed by more than 12 hours: no start, one Start now / Reschedule row; Start now starts it', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'old', { id: 'task_o' });
    // Europe/Berlin falls back on 2026-10-25 at 03:00: 22:00 CEST the day before is 12.5 real hours before 09:30 CET.
    assign('old', 'scout', { source: 'dashboard', startAt: '2026-10-24T22:00:00+02:00' }, new Date('2026-10-24T19:00:00Z'));
    const now = new Date('2026-10-25T09:30:00+01:00');
    expect(now.getTime() - Date.parse('2026-10-24T22:00:00+02:00')).toBeGreaterThan(LATE_START_MS);
    const d = deps(now);
    expect(startDueTaskJobs(f.contextRoot, d)).toEqual([]);
    startDueTaskJobs(f.contextRoot, d);
    const rows = listInboxRows(f.projectRoot, f.home, now).filter((r) => r.kind === 'task-start-missed');
    expect(rows).toHaveLength(1);
    expect(rows[0].actions).toEqual(['start-now', 'reschedule']);
    expect(startNowAction(f.contextRoot, 'old', d)).toEqual({ ok: true });
    expect(d.spawned.map((s) => s.slug)).toEqual(['old']);
    expect(listInboxRows(f.projectRoot, f.home, now).filter((r) => r.kind === 'task-start-missed')).toHaveLength(0);
  });

  it('inside the window across the same DST change it starts (late, with a note)', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'late', { id: 'task_late' });
    assign('late', 'scout', { source: 'dashboard', startAt: '2026-10-25T02:30:00+02:00' }, new Date('2026-10-24T19:00:00Z'));
    // 02:30 CEST (00:30Z) to 11:00 CET (10:00Z) = 9.5 real hours.
    expect(startDueTaskJobs(f.contextRoot, deps(new Date('2026-10-25T11:00:00+01:00')))).toHaveLength(1);
  });

  it('parseStartAt keeps the instant and refuses a wall time with no zone', () => {
    expect(parseStartAt('2026-03-29T03:30:00+02:00')).toBe('2026-03-29T01:30:00.000Z');
    expect(parseStartAt('2026-03-29T02:30:00Z')).toBe('2026-03-29T02:30:00.000Z');
    expect(parseStartAt('2026-03-29T02:30:00')).toBeNull();
    expect(parseStartAt('tomorrow')).toBeNull();
  });

  it('Reschedule moves the instant (M0 and display)', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'r', { id: 'task_r' });
    assign('r', 'scout', { source: 'dashboard', startAt: '2026-10-26T09:00:00Z' });
    expect(rescheduleAction(f.contextRoot, 'r', '2026-10-27T10:00:00+03:00', deps())).toEqual({ ok: true });
    expect(metaFor(f.projectRoot, 'task_r', f.home)?.startAt).toBe('2026-10-27T07:00:00.000Z');
    expect(taskData(f, 'r').agent_start_at).toBe('2026-10-27T07:00:00.000Z');
  });
});

describe('the reconciler (C1-4, AC-C1-3, AC-C1-13)', () => {
  function started(slug: string, agent = 'scout'): { d: ReturnType<typeof deps>; claim: TaskClaim } {
    makeAgent(f, agent);
    writeTask(f, slug, { id: `task_${slug}` });
    assign(slug, agent);
    const d = deps();
    startDueTaskJobs(f.contextRoot, d);
    return { d, claim: claimOf(slug)! };
  }

  /** What a host does when it comes up: phase active, the task running. */
  function hostUp(slug: string, claim: TaskClaim, childPid: number, live: Set<number>): void {
    updateTaskJobs(f.projectRoot, (j) => { j.claims = j.claims.map((c) => (c.runId === claim.runId ? { ...c, phase: 'active', childPid } : c)); }, f.home);
    writeFileSync(join(f.contextRoot, 'state', `${slug}.md`), taskText(f, slug).replace('agent_state: starting', 'agent_state: running'));
    writeRunSidecar(f.contextRoot, claim.agent, {
      slug: claim.agent, runnerPid: claim.hostPid!, childPid, childPgid: childPid,
      fireAt: T0.toISOString(), startedAt: T0.toISOString(), timeoutAt: new Date(T0.getTime() + 3_600_000).toISOString(),
    });
    mkdirSync(dirname(lockPathFor(f.contextRoot, claim.agent)), { recursive: true });
    writeFileSync(lockPathFor(f.contextRoot, claim.agent), JSON.stringify({ pid: claim.hostPid, at: T0.getTime() }));
    live.add(childPid);
  }

  it('a starting task inside its grace is untouched', () => {
    const { d } = started('a');
    expect(reconcileTaskJobs(f.contextRoot, { ...d, now: () => new Date(T0.getTime() + 30_000) })).toBe(0);
    expect(taskData(f, 'a').agent_state).toBe('starting');
  });

  it('a crash between the CAS and the spawn (no host) is back in queued after the grace, armed again', () => {
    const { d, claim } = started('a');
    d.live.delete(claim.hostPid!);
    reconcileTaskJobs(f.contextRoot, { ...d, now: () => new Date(T0.getTime() + CLAIM_GRACE_MS + 1) });
    expect(taskData(f, 'a').agent_state).toBe('queued');
    expect(readTaskJobs(f.projectRoot, f.home).claims).toEqual([]);
    expect(readAssignmentLedger(f.projectRoot, f.home).armed).toEqual([expect.objectContaining({ taskId: 'task_a', step: 'work' })]);
  });

  it('a crash between the M0 claim and the task CAS leaves no stuck starting', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'a', { id: 'task_a' });
    assign('a', 'scout');
    updateTaskJobs(f.projectRoot, (j) => {
      j.claims.push({ runId: 'tr_crashed', taskId: 'task_a', taskSlug: 'a', step: 'work', round: 0, agent: 'scout', role: 'doer', hostPid: null, childPid: null, sessionId: null, resume: false, phase: 'claiming', claimedAt: T0.toISOString(), tokenHash: null, cwd: null });
    }, f.home);
    const d = deps(new Date(T0.getTime() + CLAIM_GRACE_MS + 1));
    reconcileTaskJobs(f.contextRoot, d);
    expect(readTaskJobs(f.projectRoot, f.home).claims).toEqual([]);
    expect(taskData(f, 'a').agent_state).toBe('queued');
    expect(startDueTaskJobs(f.contextRoot, d)).toHaveLength(1);
  });

  it('a starting task this machine claimed with no claim at all goes back to queued after the grace', () => {
    const { d, claim } = started('a');
    updateTaskJobs(f.projectRoot, (j) => { j.claims = j.claims.filter((c) => c.runId !== claim.runId); }, f.home);
    reconcileTaskJobs(f.contextRoot, { ...d, now: () => new Date(T0.getTime() + CLAIM_GRACE_MS + 1) });
    expect(taskData(f, 'a').agent_state).toBe('queued');
  });

  it('host killed, child alive: stalled "running without its host" + one row; Stop → stopped, lock freed, next queued starts', () => {
    const { d, claim } = started('a');
    writeTask(f, 'b', { id: 'task_b' });
    assign('b', 'scout', { source: 'dashboard' }, new Date(T0.getTime() + 5000));
    hostUp('a', claim, 4_300_001, d.live);
    d.live.delete(claim.hostPid!);
    reconcileTaskJobs(f.contextRoot, d);
    reconcileTaskJobs(f.contextRoot, d);
    expect(taskData(f, 'a').agent_state).toBe('stalled');
    expect(claimOf('a')).toMatchObject({ phase: 'orphaned', orphanedFrom: 'active' });
    const rows = listInboxRows(f.projectRoot, f.home).filter((r) => r.kind === 'task-orphaned');
    expect(rows).toHaveLength(1);
    expect(rows[0].actions).toEqual(['stop', 'let-finish']);
    // The drain skips the agent while its orphan lives.
    expect(startDueTaskJobs(f.contextRoot, d)).toEqual([]);
    const killed: number[] = [];
    const res = stopTaskAction(f.contextRoot, 'a', { ...d, killGroup: (pg) => { killed.push(pg); d.live.delete(pg); } });
    expect(res).toEqual({ ok: true });
    expect(killed).toEqual([4_300_001]);
    expect(taskData(f, 'a').agent_state).toBe('stopped');
    expect(existsSync(lockPathFor(f.contextRoot, 'scout'))).toBe(false);
    expect(d.spawned.map((s) => s.slug)).toEqual(['a', 'b']);
  });

  it('host and child both gone: stopped on the next pass, the lock reclaimed whatever its age, the next queued starts', () => {
    const { d, claim } = started('a');
    writeTask(f, 'b', { id: 'task_b' });
    assign('b', 'scout', { source: 'dashboard' }, new Date(T0.getTime() + 5000));
    hostUp('a', claim, 4_300_002, d.live);
    d.live.delete(claim.hostPid!);
    d.live.delete(4_300_002);
    reconcileTaskJobs(f.contextRoot, d);
    expect(taskData(f, 'a').agent_state).toBe('stopped');
    expect(existsSync(lockPathFor(f.contextRoot, 'scout'))).toBe(false);
    expect(listInboxRows(f.projectRoot, f.home).filter((r) => r.kind === 'task-stopped')).toHaveLength(1);
    expect(startDueTaskJobs(f.contextRoot, d)).toHaveLength(1);
    // Ticking again restarts nothing: a stopped task waits for the owner.
    reconcileTaskJobs(f.contextRoot, d);
    expect(d.spawned.map((s) => s.slug)).toEqual(['a', 'b']);
  });

  it('a delivered claim whose host died keeps its task as it is and frees the lock', () => {
    const { d, claim } = started('a');
    hostUp('a', claim, 4_300_003, d.live);
    updateTaskJobs(f.projectRoot, (j) => { j.claims = j.claims.map((c) => ({ ...c, phase: 'delivered' })); }, f.home);
    writeFileSync(join(f.contextRoot, 'state', 'a.md'), taskText(f, 'a').replace('agent_state: running', 'agent_state: delivered'));
    d.live.delete(claim.hostPid!);
    d.live.delete(4_300_003);
    reconcileTaskJobs(f.contextRoot, d);
    expect(taskData(f, 'a').agent_state).toBe('delivered');
    expect(readTaskJobs(f.projectRoot, f.home).claims).toEqual([]);
    expect(existsSync(lockPathFor(f.contextRoot, 'scout'))).toBe(false);
    // Ticking twice after a delivered task with no reviewer restarts nothing.
    expect(startDueTaskJobs(f.contextRoot, d)).toEqual([]);
    expect(startDueTaskJobs(f.contextRoot, d)).toEqual([]);
  });

  it('a review host that died with a verdict pending re-queues the review (the verdict is discarded)', () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'a', { id: 'task_a' });
    assign('a', 'scout', { source: 'dashboard', reviewer: 'checker' });
    writeFileSync(join(f.contextRoot, 'state', 'a.md'), taskText(f, 'a').replace('agent_state: queued', 'agent_state: running').replace('agent_step: work', 'agent_step: review').replace('review_round: 0', 'review_round: 1'));
    const live = new Set<number>([4_300_010]);
    updateTaskJobs(f.projectRoot, (j) => {
      j.claims.push({ runId: 'tr_rev', taskId: 'task_a', taskSlug: 'a', step: 'review', round: 1, agent: 'checker', role: 'reviewer', hostPid: 4_300_009, childPid: 4_300_010, sessionId: 's', resume: false, phase: 'active', claimedAt: T0.toISOString(), tokenHash: 'x', cwd: f.projectRoot });
      j.verdicts.push({ runId: 'tr_rev', taskId: 'task_a', round: 1, verdict: 'pass', findings: [], at: T0.toISOString() });
    }, f.home);
    live.delete(4_300_010);
    reconcileTaskJobs(f.contextRoot, { ...deps(T0, live) });
    expect(taskData(f, 'a')).toMatchObject({ agent_state: 'queued', agent_step: 'review' });
    expect(readTaskJobs(f.projectRoot, f.home).verdicts).toEqual([]);
    expect(readAssignmentLedger(f.projectRoot, f.home).armed).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'review', round: 1 })]));
  });

  it('a review is not claimed while the doer\'s host still runs', () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'a', { id: 'task_a' });
    assign('a', 'scout', { source: 'dashboard', reviewer: 'checker' });
    const d = deps();
    startDueTaskJobs(f.contextRoot, d);
    const doer = claimOf('a')!;
    // The doer delivered (step review queued, armed) but its host has not exited yet.
    updateTaskJobs(f.projectRoot, (j) => { j.claims = j.claims.map((c) => ({ ...c, phase: 'delivered' })); }, f.home);
    writeFileSync(join(f.contextRoot, 'state', 'a.md'), taskText(f, 'a').replace('agent_state: starting', 'agent_state: queued').replace('agent_step: work', 'agent_step: review').replace('review_round: 0', 'review_round: 1'));
    armStart(f.projectRoot, 'task_a', 'review', 1, f.home);
    expect(startDueTaskJobs(f.contextRoot, d)).toEqual([]);
    d.live.delete(doer.hostPid!);
    // Its host exits (its claim closes), then the review starts.
    updateTaskJobs(f.projectRoot, (j) => { j.claims = []; }, f.home);
    expect(startDueTaskJobs(f.contextRoot, d)).toHaveLength(1);
    expect(claimOf('a')).toMatchObject({ step: 'review', role: 'reviewer', agent: 'checker' });
  });
});

describe('the owner\'s actions', () => {
  it('Continue re-queues a stopped task on the same step, resumed; I\'ll take it clears the agent', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'a', { id: 'task_a' });
    assign('a', 'scout');
    writeFileSync(join(f.contextRoot, 'state', 'a.md'), taskText(f, 'a').replace('agent_state: queued', 'agent_state: stopped'));
    expect(continueTaskAction(f.contextRoot, 'a', deps())).toEqual({ ok: true });
    expect(taskData(f, 'a').agent_state).toBe('starting');
    expect(readTaskJobs(f.projectRoot, f.home).notes).toEqual([expect.objectContaining({ kind: 'continue' })]);
    expect(takeOverAction(f.contextRoot, 'a', deps())).toEqual({ ok: true });
    expect(taskData(f, 'a')).toMatchObject({ agent: null, agent_state: null, status: 'in_progress' });
    expect(parseStatusHistory(taskText(f, 'a'))[0]).toMatchObject({ by: 'owner' });
    expect(metaFor(f.projectRoot, 'task_a', f.home)).toBeNull();
  });

  it('One more round raises the binding cap by one and queues the rework', () => {
    makeAgent(f, 'scout');
    makeAgent(f, 'checker');
    writeTask(f, 'a', { id: 'task_a' });
    assign('a', 'scout', { source: 'dashboard', reviewer: 'checker', reviewCap: 2 });
    writeFileSync(join(f.contextRoot, 'state', 'a.md'), taskText(f, 'a').replace('agent_state: queued', 'agent_state: stuck').replace('review_round: 0', 'review_round: 2'));
    const d = deps();
    expect(oneMoreRoundAction(f.contextRoot, 'a', d)).toEqual({ ok: true });
    expect(metaFor(f.projectRoot, 'task_a', f.home)?.reviewCap).toBe(3);
    expect(taskData(f, 'a')).toMatchObject({ review_cap: 3, agent_step: 'rework' });
    expect(d.spawned).toHaveLength(1);
  });

  it('Let it finish only closes the row', () => {
    makeAgent(f, 'scout');
    writeTask(f, 'a', { id: 'task_a' });
    assign('a', 'scout');
    expect(letFinishAction(f.contextRoot, 'a', deps())).toEqual({ ok: true });
  });
});

describe('M1: task rows die with their subject (reconciler table per kind)', () => {
  it.each([
    ['task-stopped', 'stopped', 'queued'],
    ['task-blocked', 'blocked', 'queued'],
    ['task-stalled', 'stalled', 'queued'],
    ['task-stuck', 'stuck', 'queued'],
    ['task-question', 'waiting_owner', 'queued'],
    ['task-start-missed', 'scheduled', 'queued'],
  ])('%s lives while the task is %s and dies when it moves to %s', (kind, alive, moved) => {
    makeAgent(f, 'scout');
    writeTask(f, 'a', { id: 'task_a' });
    assign('a', 'scout');
    const set = (state: string) => writeFileSync(join(f.contextRoot, 'state', 'a.md'), taskText(f, 'a').replace(/agent_state: \w+/, `agent_state: ${state}`));
    set(alive);
    raiseTaskRow(f.projectRoot, kind as never, { slug: 'a', id: 'task_a', name: 'A' }, 'scout', 'x', ['dismiss', 'continue'], undefined, f.home);
    reconcileTaskRows(f.contextRoot, f.home);
    expect(listInboxRows(f.projectRoot, f.home).filter((r) => r.kind === kind)).toHaveLength(1);
    set(moved);
    reconcileTaskRows(f.contextRoot, f.home);
    expect(listInboxRows(f.projectRoot, f.home).filter((r) => r.kind === kind)).toHaveLength(0);
  });

  it('task-review dies when the task leaves review; every row dies when the task is deleted; a renamed task keeps its row, re-pointed', () => {
    makeAgent(f, 'scout');
    for (const slug of ['r', 'gone', 'moved']) {
      writeTask(f, slug, { id: `task_${slug}`, status: 'in_review', extra: { agent: 'scout', agent_state: 'delivered' } });
      raiseTaskRow(f.projectRoot, 'task-review', { slug, id: `task_${slug}`, name: slug }, 'scout', 'x', ['complete', 'send-back'], undefined, f.home);
    }
    reconcileTaskRows(f.contextRoot, f.home);
    expect(listInboxRows(f.projectRoot, f.home)).toHaveLength(3);
    writeFileSync(join(f.contextRoot, 'state', 'r.md'), taskText(f, 'r').replace('status: in_review', 'status: completed'));
    rmSync(join(f.contextRoot, 'state', 'gone.md'));
    renameSync(join(f.contextRoot, 'state', 'moved.md'), join(f.contextRoot, 'state', 'moved-elsewhere.md'));
    // Another task now holds the old slug: the row still follows its own task, by id.
    writeTask(f, 'moved', { id: 'task_other', status: 'in_review', extra: { agent: 'scout', agent_state: 'delivered' } });
    reconcileTaskRows(f.contextRoot, f.home);
    expect(listInboxRows(f.projectRoot, f.home).map((r) => [r.ref, r.dedupeKey])).toEqual([['moved-elsewhere', 'task-review:task_moved']]);
  });
});
