/**
 * Cycle and order on the wire (C3, AC4 remote half, AC6).
 *
 * GitHub carries the cycle as `cycle:cy_<id>` (the id, never the number) and
 * the order as the priority label; ClickUp carries the order as its native
 * priority. An id this machine does not know yet is kept on the card and shown
 * as not yet synced, a push never drops it, and it resolves once
 * core/CYCLES.json arrives. `version:` labels are never removed. A card still
 * on legacy priority syncs exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { readTaskFile } from '../../src/lib/task-backend/local.js';
import { loadFamily } from '../../src/lib/task-parent.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import {
  cycleProgress, newCycle, readCycles, serializeCycles, startCycle, unresolvedCycleRefs, type Cycle,
} from '../../src/lib/cycles.js';
import { DEFAULT_STATUSES } from '../../src/lib/task-status.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

const BASE = { platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true, cloudTaskManagement: true };
const GH: SetupConfig = { ...BASE, taskBackend: 'github', github: { owner: 'acme', repo: 'widgets', changelogTarget: 'comments' } } as SetupConfig;
const CU: SetupConfig = { ...BASE, taskBackend: 'clickup', clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' } } as SetupConfig;

let projectRoot: string;
let contextRoot: string;
let stateDir: string;
let clock: number;

function adapter(baseUrl: string, fetchImpl: typeof fetch): { adapter: ApiAdapter; now: () => number; sleep: () => Promise<void> } {
  const now = () => (clock += 7);
  const sleep = async () => { clock += 1; };
  return { adapter: new ApiAdapter({ baseUrl, authHeaders: () => ({ Authorization: 'x' }), fetchImpl, now, sleep }), now, sleep };
}
function card(slug: string, fm: Record<string, string> = {}): void {
  const lines = ['---', `id: task_${slug.replace(/\W/g, '_')}`, `name: ${slug}`, `status: ${fm.status ?? 'todo'}`,
    'created_at: "2026-10-01"', 'updated_at: "2026-10-01"'];
  for (const [k, v] of Object.entries(fm)) if (k !== 'status') lines.push(`${k}: ${v}`);
  lines.push('---', '', '## Why', '', `Why ${slug}.`, '');
  writeFileSync(join(stateDir, `${slug}.md`), lines.join('\n'));
}
const fm = (slug: string) => readTaskFile(join(stateDir, `${slug}.md`)).raw;
const raw = (slug: string) => readFileSync(join(stateDir, `${slug}.md`), 'utf-8');
function remoteId(slug: string): string {
  const rows = JSON.parse(readFileSync(join(stateDir, '.tasks-map.json'), 'utf-8')) as Array<{ slug: string; remoteId: string }> | { entries: Array<{ slug: string; remoteId: string }> };
  const list = Array.isArray(rows) ? rows : rows.entries;
  return list.find((r) => r.slug === slug)!.remoteId;
}
function activeCycleId(): string {
  newCycle(contextRoot, { goal: 'This week' });
  return startCycle(contextRoot, '1').id;
}

beforeEach(() => {
  const dir = join(tmpdir(), `dc-cycsync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  projectRoot = realpathSync(dir);
  contextRoot = join(projectRoot, '_dream_context');
  stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(contextRoot, 'core'), { recursive: true });
  clock = 1000;
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('GitHub: the cycle label and the order (AC6)', () => {
  let fake: FakeGitHub;
  let gh: GitHubTaskBackend;
  const labels = (slug: string) => fake.issues.get(Number(remoteId(slug)))!.labels.map((l) => l.name).sort();
  beforeEach(() => {
    fake = makeFakeGitHub();
    gh = new GitHubTaskBackend(contextRoot, GH, adapter('https://api.github.com', fake.fetchImpl));
  });

  it('a planned card carries cycle:cy_<id> and its order as the priority; its version: label stays', async () => {
    const id = activeCycleId();
    card('now-task', { cycle: id, version: 'v0.32.0' });
    card('later-task', { queue: 'later' });
    expect((await gh.sync('push')).errors).toEqual([]);
    expect(labels('now-task')).toEqual([`cycle:${id}`, 'priority:high', 'version:v0.32.0']);
    expect(labels('later-task')).toEqual(['priority:low']);
    // Moving it out of the cycle drops the stale cycle label; the version label is never removed.
    await gh.updateFields('now-task', { cycle: null, queue: 'next' });
    await gh.sync('push');
    expect(labels('now-task')).toEqual(['priority:medium', 'version:v0.32.0']);
  });

  it('a push then pulls move nothing: no priority appears, the cycle stays, the bytes settle', async () => {
    const id = activeCycleId();
    card('stable', { cycle: id });
    await gh.sync('push');
    fake.editIssue(Number(remoteId('stable')), { title: 'stable' });
    await gh.sync('pull');
    expect(fm('stable').cycle).toBe(id);
    expect(fm('stable').priority).toBeUndefined();
    expect(fm('stable').queue).toBeUndefined();
    const settled = raw('stable');
    const patches = () => fake.requests.filter((q) => q.method === 'PATCH').length;
    const before = patches();
    fake.editIssue(Number(remoteId('stable')), { title: 'stable' });
    await gh.sync();
    expect(raw('stable')).toBe(settled);
    expect(patches()).toBe(before);
  });

  it('an unknown cycle id is kept, shown as not yet synced, survives a push, and resolves when CYCLES.json arrives', async () => {
    card('pulled');
    await gh.sync('push');
    const n = Number(remoteId('pulled'));
    fake.editIssue(n, { labels: [{ name: 'cycle:cy_teammate' }, { name: 'priority:high' }, { name: 'version:v0.32.0' }] });
    const r = await gh.sync('pull');
    expect(fm('pulled').cycle).toBe('cy_teammate');
    expect(r.warnings.some((w) => /cycle cy_teammate is not in core\/CYCLES\.json yet/.test(w))).toBe(true);
    expect(unresolvedCycleRefs(loadFamily(stateDir), readCycles(contextRoot).cycles).get('cy_teammate')).toEqual(['pulled']);
    expect(Object.keys(readCycles(contextRoot).cycles)).toEqual([]);

    await gh.updateFields('pulled', { status: 'in_progress' });
    await gh.sync('push');
    expect(labels('pulled')).toContain('cycle:cy_teammate');
    expect(labels('pulled')).toContain('version:v0.32.0');

    // The brain repo syncs: the teammate's cycle arrives by git.
    const arrived: Cycle = { id: 'cy_teammate', goal: 'Their week', start: '2026-10-19', end: '2026-10-25', status: 'active', created_at: '2026-10-18' };
    writeFileSync(join(contextRoot, 'core', 'CYCLES.json'), serializeCycles([arrived]));
    expect(unresolvedCycleRefs(loadFamily(stateDir), readCycles(contextRoot).cycles).size).toBe(0);
    expect(cycleProgress(loadFamily(stateDir), DEFAULT_STATUSES, 'cy_teammate').total).toBe(1);
    await gh.sync('push');
    expect(labels('pulled')).toContain('cycle:cy_teammate');
  });

  it('a renumber after a merge does not move the task: the label is the id, never the number', async () => {
    const id = activeCycleId();
    card('kept', { cycle: id });
    await gh.sync('push');
    const earlier: Cycle = { id: 'cy_earlier1', goal: 'Older', start: '2026-01-05', end: '2026-01-11', status: 'closed', created_at: '2026-01-05' };
    writeFileSync(join(contextRoot, 'core', 'CYCLES.json'), serializeCycles([earlier, ...readCycles(contextRoot).cycles]));
    expect(readCycles(contextRoot).cycles.find((c) => c.id === id)!.number).toBe(2);
    fake.editIssue(Number(remoteId('kept')), { title: 'kept' });
    await gh.sync('pull');
    expect(fm('kept').cycle).toBe(id);
  });

  it('a remote priority change maps back to the order (lossy): low takes it out of the cycle', async () => {
    const id = activeCycleId();
    card('demoted', { cycle: id });
    card('queued', { queue: 'next' });
    await gh.sync('push');
    fake.editIssue(Number(remoteId('demoted')), { labels: [{ name: `cycle:${id}` }, { name: 'priority:low' }] });
    fake.editIssue(Number(remoteId('queued')), { labels: [{ name: 'priority:critical' }] });
    await gh.sync('pull');
    expect([fm('demoted').cycle, fm('demoted').queue]).toEqual([null, 'later']);
    // critical outside the active cycle is Next: a remote cannot plan into a cycle.
    expect([fm('queued').cycle ?? null, fm('queued').queue]).toEqual([null, 'next']);
    expect(fm('demoted').priority).toBeUndefined();
    await gh.sync('push');
    expect(labels('demoted')).toEqual(['priority:low']);
  });

  it('a legacy card (priority only) syncs exactly as before', async () => {
    card('legacy', { priority: 'critical', urgency: 'high' });
    await gh.sync('push');
    expect(labels('legacy')).toEqual(['priority:critical', 'urgency:high']);
    fake.editIssue(Number(remoteId('legacy')), { labels: [{ name: 'priority:low' }, { name: 'urgency:high' }] });
    await gh.sync('pull');
    expect(fm('legacy').priority).toBe('low');
    expect(fm('legacy').queue).toBeUndefined();
  });
});

describe('ClickUp: the order rides the native priority (AC4)', () => {
  let fake: FakeClickUp;
  let cu: ClickUpTaskBackend;
  beforeEach(() => {
    fake = makeFakeClickUp();
    cu = new ClickUpTaskBackend(contextRoot, CU, adapter('https://api.clickup.com/api/v2', fake.fetchImpl));
  });

  it('now → high (2), later → low (4); a remote urgent keeps a now task in its cycle, a remote low sends it to Later', async () => {
    const id = activeCycleId();
    card('cu-now', { cycle: id });
    card('cu-later', { queue: 'later' });
    expect((await cu.sync('push')).errors).toEqual([]);
    expect(fake.tasks.get(remoteId('cu-now'))!.priority.id).toBe('2');
    expect(fake.tasks.get(remoteId('cu-later'))!.priority.id).toBe('4');
    fake.editTask(remoteId('cu-now'), { priority: { id: '1' } });
    await cu.sync('pull');
    expect(fm('cu-now').cycle).toBe(id);
    fake.editTask(remoteId('cu-now'), { priority: { id: '4' } });
    await cu.sync('pull');
    expect([fm('cu-now').cycle, fm('cu-now').queue]).toEqual([null, 'later']);
    expect(fm('cu-now').priority).toBeUndefined();
  });
});

describe('two machines that disagree on the active cycle (review C1)', () => {
  // Machine B shares the remote but has no CYCLES.json yet (or a stale one): it
  // reads A's active cycle as unknown. B must never rewrite A's order.
  let rootB: string;
  let stateB: string;
  beforeEach(() => {
    rootB = join(projectRoot, 'machine-b', '_dream_context');
    stateB = join(rootB, 'state');
    mkdirSync(stateB, { recursive: true });
    mkdirSync(join(rootB, 'core'), { recursive: true });
  });
  const fmB = (slug: string) => readTaskFile(join(stateB, `${slug}.md`)).raw;

  it('GitHub: B pulls and pushes a task A planned into its active cycle; it stays high and stays in A\'s cycle', async () => {
    const fake = makeFakeGitHub();
    const a = new GitHubTaskBackend(contextRoot, GH, adapter('https://api.github.com', fake.fetchImpl));
    const b = new GitHubTaskBackend(rootB, GH, adapter('https://api.github.com', fake.fetchImpl));
    const id = activeCycleId();
    card('shared');
    await a.sync('push');
    await b.sync('pull');
    await a.updateFields('shared', { cycle: id, queue: null });
    await a.sync('push');
    const labels = () => fake.issues.get(Number(remoteId('shared')))!.labels.map((l) => l.name).sort();
    expect(labels()).toEqual([`cycle:${id}`, 'priority:high']);

    const pulled = await b.sync('pull');
    expect(fmB('shared').cycle).toBe(id);
    expect(pulled.pushed ?? 0).toBe(0);
    await b.updateFields('shared', { status: 'in_progress' });
    await b.sync();
    expect(labels()).toEqual(expect.arrayContaining([`cycle:${id}`, 'dc:in-progress', 'priority:high']));
    expect(labels().filter((l) => l.startsWith('priority:'))).toEqual(['priority:high']);

    await a.sync('pull');
    expect(fm('shared').cycle).toBe(id);
    expect(fm('shared').status).toBe('in_progress');
  });

  it('ClickUp: a second machine with no cycles never flattens a Now task to normal', async () => {
    const fake = makeFakeClickUp();
    const a = new ClickUpTaskBackend(contextRoot, CU, adapter('https://api.clickup.com/api/v2', fake.fetchImpl));
    const b = new ClickUpTaskBackend(rootB, CU, adapter('https://api.clickup.com/api/v2', fake.fetchImpl));
    const id = activeCycleId();
    // Born on B with the new card shape (no priority key): B is on the new model.
    await b.create({ name: 'CU shared', why: 'a card B filed itself', variant: 'cli' });
    await b.sync('push');
    await a.sync('pull');
    await a.updateFields('cu-shared', { cycle: id, queue: null });
    await a.sync('push');
    const rid = () => {
      const rows = JSON.parse(readFileSync(join(stateB, '.tasks-map.json'), 'utf-8')) as Array<{ slug: string; remoteId: string }> | { entries: Array<{ slug: string; remoteId: string }> };
      return (Array.isArray(rows) ? rows : rows.entries).find((r) => r.slug === 'cu-shared')!.remoteId;
    };
    const prio = () => fake.tasks.get(rid())!.priority.id;
    expect(prio()).toBe('2');

    await b.sync('pull');
    expect(fmB('cu-shared').priority).toBeUndefined();
    await b.updateFields('cu-shared', { status: 'in_progress' });
    await b.sync();
    expect(prio()).toBe('2');

    await a.sync('pull');
    expect(fm('cu-shared').cycle).toBe(id);
  });

  it('GitHub: B, reading A\'s active cycle as planned, plans work into it; A keeps it there (review round 2)', async () => {
    const fake = makeFakeGitHub();
    const a = new GitHubTaskBackend(contextRoot, GH, adapter('https://api.github.com', fake.fetchImpl));
    const b = new GitHubTaskBackend(rootB, GH, adapter('https://api.github.com', fake.fetchImpl));
    const id = activeCycleId();
    // B's CYCLES.json is behind: the same cycle, still planned.
    const stale = readCycles(contextRoot).cycles.map(({ number: _n, ...c }) => ({ ...c, status: 'planned' as const }));
    writeFileSync(join(rootB, 'core', 'CYCLES.json'), serializeCycles(stale));
    card('was-later', { queue: 'later' });
    card('legacy-hot', { priority: 'high' });
    await a.sync('push');
    await b.sync('pull');
    for (const s2 of ['was-later', 'legacy-hot']) await b.updateFields(s2, { cycle: id, queue: null });
    await b.sync();
    const labelsOf = (slug: string) => fake.issues.get(Number(remoteId(slug)))!.labels.map((l) => l.name);
    // B reads the cycle as planned, yet sends high: a task in any cycle is high (owner decision).
    expect(labelsOf('was-later')).toEqual(expect.arrayContaining([`cycle:${id}`, 'priority:high']));

    await a.sync();
    for (const s2 of ['was-later', 'legacy-hot']) {
      expect(fm(s2).cycle).toBe(id);
      expect(labelsOf(s2)).toContain(`cycle:${id}`);
    }
    expect(fm('legacy-hot').priority).toBe('high');
    await b.sync();
    for (const s2 of ['was-later', 'legacy-hot']) expect(fmB(s2).cycle).toBe(id);
  });

  it('GitHub: both machines plan the same task into the cycle (one reads it as planned); it stays on both (review round 3)', async () => {
    const fake = makeFakeGitHub();
    const a = new GitHubTaskBackend(contextRoot, GH, adapter('https://api.github.com', fake.fetchImpl));
    const b = new GitHubTaskBackend(rootB, GH, adapter('https://api.github.com', fake.fetchImpl));
    const id = activeCycleId();
    const stale = readCycles(contextRoot).cycles.map(({ number: _n, ...c }) => ({ ...c, status: 'planned' as const }));
    writeFileSync(join(rootB, 'core', 'CYCLES.json'), serializeCycles(stale));
    card('both', { queue: 'later' });
    await a.sync('push');
    await b.sync('pull');
    await a.updateFields('both', { cycle: id, queue: null });
    await b.updateFields('both', { cycle: id, queue: null });
    await b.sync();
    await a.sync();
    await b.sync();
    expect(fm('both').cycle).toBe(id);
    expect(fmB('both').cycle).toBe(id);
    expect(fake.issues.get(Number(remoteId('both')))!.labels.map((l) => l.name)).toEqual(expect.arrayContaining([`cycle:${id}`, 'priority:high']));
  });

  it('ClickUp: B, reading A\'s active cycle as planned, plans a task into it; A keeps it in the cycle (review round 2, ClickUp)', async () => {
    const fake = makeFakeClickUp();
    const a = new ClickUpTaskBackend(contextRoot, CU, adapter('https://api.clickup.com/api/v2', fake.fetchImpl));
    const b = new ClickUpTaskBackend(rootB, CU, adapter('https://api.clickup.com/api/v2', fake.fetchImpl));
    const id = activeCycleId();
    const stale = readCycles(contextRoot).cycles.map(({ number: _n, ...c }) => ({ ...c, status: 'planned' as const }));
    writeFileSync(join(rootB, 'core', 'CYCLES.json'), serializeCycles(stale));
    await b.create({ name: 'CU planned twice', why: 'a card B filed itself', variant: 'cli' });
    await b.sync('push');
    await a.sync('pull');
    await a.updateFields('cu-planned-twice', { cycle: id, queue: null });
    await a.sync('push');
    await b.sync('pull');
    await b.updateFields('cu-planned-twice', { cycle: id, queue: null });
    await b.sync();
    const rows = JSON.parse(readFileSync(join(stateB, '.tasks-map.json'), 'utf-8')) as Array<{ slug: string; remoteId: string }> | { entries: Array<{ slug: string; remoteId: string }> };
    const rid = (Array.isArray(rows) ? rows : rows.entries).find((r) => r.slug === 'cu-planned-twice')!.remoteId;
    expect(fake.tasks.get(rid)!.priority.id).toBe('2');
    await a.sync('pull');
    expect(fm('cu-planned-twice').cycle).toBe(id);
  });

  it('a machine that moves the task itself still sends the mapped priority', async () => {
    const fake = makeFakeGitHub();
    const b = new GitHubTaskBackend(rootB, GH, adapter('https://api.github.com', fake.fetchImpl));
    const a = new GitHubTaskBackend(contextRoot, GH, adapter('https://api.github.com', fake.fetchImpl));
    const id = activeCycleId();
    card('moved', { cycle: id });
    await a.sync('push');
    await b.sync('pull');
    await b.updateFields('moved', { cycle: null, queue: 'later' });
    await b.sync();
    const moved = fake.issues.get(Number(remoteId('moved')))!.labels.map((l) => l.name);
    expect(moved.filter((l) => /^(priority|cycle):/.test(l))).toEqual(['priority:low']);
    await a.sync('pull');
    expect([fm('moved').cycle, fm('moved').queue]).toEqual([null, 'later']);
  });
});
