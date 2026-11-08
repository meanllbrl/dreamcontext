/**
 * Wave 1 lane G (plan r10 1c): a task step on a tool the envelope cannot hold ends `blocked`, the
 * real runner and the real host together, and nothing respawns it. Only the task step's refusal
 * changes: the account refusal on a plain run stays `failed` (pinned in
 * `automation-tool-choice.test.ts`), and team jobs are never task steps.
 *
 * The member reaches the runner only because the assignment's tool check is handed an envelope
 * with a mode (as a member assigned before this check would): the run itself must still refuse.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { makeAgent, makeFixture, standInClaude, taskData, writeTask, type Fixture } from '../helpers/task-job-fixture.js';
import { commitAssignment, prepareAssignment } from '../../src/lib/agents/task-assignment.js';
import { startDueTaskJobs, type TaskJobDeps } from '../../src/lib/agents/task-starter.js';
import { runTaskJob } from '../../src/lib/agents/task-host.js';
import { envelopeRefusal } from '../../src/lib/t3-bridge/headless-envelope.js';
import { approveAutomation } from '../../src/lib/automations/registry.js';
import { getRunTarget } from '../../src/lib/automations/store.js';

let f: Fixture;
const T0 = new Date('2026-10-25T09:00:00.000Z');

beforeEach(() => { f = makeFixture('dc-tasktool'); });
afterEach(() => { f.cleanup(); });

function onTool(slug: string, tool: 'codex' | 'antigravity'): void {
  const path = join(f.contextRoot, 'agents', `${slug}.md`);
  const doc = matter(readFileSync(path, 'utf-8'));
  writeFileSync(path, matter.stringify(doc.content, { ...doc.data, tool }));
  approveAutomation(f.projectRoot, getRunTarget(f.contextRoot, slug, 'agent')!, T0, f.home);
}

describe('the runner\'s tool refusal on a task step', () => {
  it('ends blocked with the envelope\'s reason; one host, no requeue, no third drain', async () => {
    makeAgent(f, 'coder');
    onTool('coder', 'antigravity');
    writeTask(f, 'fix', { id: 'task_fix' });
    const prep = prepareAssignment(f.contextRoot, 'fix', 'coder', { home: f.home, source: 'dashboard', toolCheck: () => null });
    if (!prep.ok) throw new Error(prep.message);
    commitAssignment(f.contextRoot, prep, T0, { home: f.home });

    const hosts: Array<{ slug: string; runId: string }> = [];
    let pid = 4_800_000;
    const deps: TaskJobDeps = {
      home: f.home, now: () => T0,
      spawnHost: (_r, slug, runId) => { hosts.push({ slug, runId }); return pid++; },
      isAlive: (p) => p === process.pid, killGroup: () => {},
    };
    startDueTaskJobs(f.contextRoot, deps);
    expect(hosts).toHaveLength(1);
    const spawn = standInClaude([]);
    const res = await runTaskJob(f.contextRoot, hosts[0].slug, hosts[0].runId, { ...deps, spawnImpl: spawn.impl, stallPollMs: 5 });

    expect(res.outcome?.status).toBe('blocked');
    expect(res.outcome?.spawned).toBeFalsy();
    expect(res.state).toBe('blocked');
    expect(spawn.calls).toHaveLength(0);
    const d = taskData(f, 'fix');
    expect(d.agent_state).toBe('blocked');
    expect(String(d.agent_blocked)).toContain(envelopeRefusal('task-step', 'antigravity').slice(0, 40));
    startDueTaskJobs(f.contextRoot, deps);
    expect(hosts).toHaveLength(1);
  });
});
