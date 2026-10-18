/**
 * Cycles over HTTP for the Planning screen and the Close deck (plan r3 § W4): create,
 * start, the close plan, a close whose decisions match `cycle close` exactly, an
 * interrupted close that resumes, the capacity hint; plan and rank by slug.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import {
  handleCyclesList, handleCyclesCreate, handleCycleStart, handleCycleClosePlan, handleCycleClose, capacityHint,
} from '../../src/server/routes/cycles.js';
import { handleTaskPlan, handleTaskRank } from '../../src/server/routes/tasks.js';
import { registerCycleCommand } from '../../src/cli/commands/cycle.js';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { markClosing, newCycle, readCycles, startCycle, type CycleView } from '../../src/lib/cycles.js';
import { readTaskFile, resetTaskReadMemo } from '../../src/lib/task-backend/local.js';
import { call } from '../helpers/fake-http.js';

let projectRoot: string;
let ctx: string;
let stateDir: string;
let prevCwd: string;
const origLog = console.log;
const origErr = console.error;

function vault(): void {
  const raw = join(tmpdir(), `dc-cycles-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(join(ctx, 'overrides'), { recursive: true });
  writeFileSync(join(ctx, 'overrides', 'task.md'), ['---', 'statuses:', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }', '---', ''].join('\n'));
  resetTaskReadMemo();
  process.chdir(projectRoot);
}

function seed(slug: string, fm: Record<string, string> = {}): void {
  const lines = ['---', `id: task_${slug.replace(/\W/g, '_')}`, `name: ${slug}`, `status: ${fm.status ?? 'todo'}`, 'created_at: "2026-10-01"', 'updated_at: "2026-10-01"'];
  for (const [k, v] of Object.entries(fm)) if (k !== 'status') lines.push(`${k}: ${v}`);
  lines.push('---', '', '## Why', '', 'Because.', '');
  writeFileSync(join(stateDir, `${slug}.md`), lines.join('\n'));
}
const fm = (slug: string) => readTaskFile(join(stateDir, `${slug}.md`)).raw;

/** An active cycle with three unfinished leaves (one under a parent), one done leaf, and a planned next cycle. */
function closingFixture(): { active: CycleView; next: CycleView } {
  const active = newCycle(ctx, { goal: 'Week one', today: '2026-10-12', start: '2026-10-12', weeks: 1 });
  const next = newCycle(ctx, { goal: 'Week two', today: '2026-10-12', start: '2026-10-19', weeks: 1 });
  startCycle(ctx, active.id, '2026-10-12');
  seed('epic', { cycle: active.id });
  seed('carry-me', { cycle: active.id, parent_task: 'epic', rank: '10' });
  seed('back-me', { cycle: active.id, rank: '20' });
  seed('cancel-me', { cycle: active.id, rank: '30' });
  seed('done-one', { cycle: active.id, status: 'completed' });
  return { active, next };
}

async function cli(...argv: string[]): Promise<number> {
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  registerCycleCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

/** What a close must leave behind, the same for the route and for `cycle close`. */
function expectClosed(activeId: string, nextId: string): void {
  expect(fm('carry-me')).toMatchObject({ cycle: nextId });
  expect(fm('back-me').cycle ?? null).toBeNull();
  expect(fm('back-me').queue).toBe('next');
  expect(fm('cancel-me').status).toBe('cancelled');
  const closed = readCycles(ctx).cycles.find((c) => c.id === activeId)!;
  expect(closed.status).toBe('closed');
  expect(closed.carried).toEqual(['carry-me']);
  expect(closed.backed).toEqual(['back-me']);
  expect(closed.cancelled).toEqual(['cancel-me']);
  expect(closed.result).toEqual({ done: 1, total: 4 });
}

beforeEach(() => {
  prevCwd = process.cwd();
  console.log = () => {};
  console.error = () => {};
  vault();
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.exitCode = undefined;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('creating and starting a cycle', () => {
  it('lists nothing at first, then creates and starts one', async () => {
    const empty = await call(handleCyclesList, ctx, {}, { method: 'GET' });
    expect(empty.body).toMatchObject({ cycles: [], active: null, capacityHint: null, defaultWeeks: 1 });
    const created = await call(handleCyclesCreate, ctx, {}, { body: { goal: 'Ship the Inbox', weeks: 2 } });
    expect(created.code).toBe(200);
    const id = (created.body.cycle as CycleView).id;
    expect((await call(handleCyclesCreate, ctx, {}, { body: { goal: '   ' } })).code).toBe(400);
    expect((await call(handleCycleStart, ctx, { id }, {})).code).toBe(200);
    const list = await call(handleCyclesList, ctx, {}, { method: 'GET' });
    expect(list.body.active).toBe(id);
    expect((list.body.cycles as Array<Record<string, unknown>>)[0]).toMatchObject({ id, status: 'active', progress: { total: 0, done: 0 } });
  });
});

describe('the close plan and the close', () => {
  it('the close plan groups the unfinished leaves by parent, with carry counts and the target', async () => {
    const { active, next } = closingFixture();
    const plan = await call(handleCycleClosePlan, ctx, { id: active.id }, { method: 'GET' });
    expect(plan.code).toBe(200);
    expect((plan.body.into as CycleView).id).toBe(next.id);
    const groups = plan.body.groups as Array<{ parent: { slug: string } | null; leaves: Array<{ slug: string; carried: number }> }>;
    expect(groups[0].parent?.slug).toBe('epic');
    expect(groups[0].leaves.map((l) => l.slug)).toEqual(['carry-me']);
    expect(groups[1].parent).toBeNull();
    expect(groups[1].leaves.map((l) => l.slug)).toEqual(['back-me', 'cancel-me']);
    expect(groups.flatMap((g) => g.leaves).every((l) => l.carried === 0)).toBe(true);
  });

  it('an undecided leaf refuses the close (400, named); a decision for a non-leaf is ignored', async () => {
    const { active } = closingFixture();
    const r = await call(handleCycleClose, ctx, { id: active.id }, { body: { decisions: { 'carry-me': 'carry', epic: 'cancel', 'not-a-task': 'carry' } } });
    expect(r.code).toBe(400);
    expect(r.body.error).toBe('undecided');
    expect((r.body.slugs as string[]).sort()).toEqual(['back-me', 'cancel-me']);
    expect(readCycles(ctx).cycles.find((c) => c.id === active.id)!.status).toBe('active');
    expect(fm('epic').status).toBe('todo');
  });

  it('carry, back and cancel do exactly what `cycle close` does', async () => {
    const route = closingFixture();
    const r = await call(handleCycleClose, ctx, { id: route.active.id }, {
      body: { decisions: { 'carry-me': 'carry', 'back-me': 'back', 'cancel-me': 'cancel', epic: 'cancel' } },
    });
    expect(r.code).toBe(200);
    expect(r.body.moved).toEqual({ carry: ['carry-me'], back: ['back-me'], cancel: ['cancel-me'] });
    expectClosed(route.active.id, route.next.id);
    expect(fm('epic').status).toBe('todo');

    // the same fixture, closed by the CLI
    rmSync(projectRoot, { recursive: true, force: true });
    vault();
    const viaCli = closingFixture();
    expect(await cli('cycle', 'close', viaCli.active.id, '--carry', 'carry-me', '--back', 'back-me', '--cancel', 'cancel-me')).toBe(0);
    expectClosed(viaCli.active.id, viaCli.next.id);
  });

  it('an interrupted close resumes with its recorded decisions and ignores new ones', async () => {
    const { active, next } = closingFixture();
    markClosing(ctx, active.id, { carried: ['carry-me'], backed: ['back-me'], cancelled: ['cancel-me'], result: { done: 1, total: 4 }, into: next.id });
    const r = await call(handleCycleClose, ctx, { id: active.id }, { body: { decisions: { 'carry-me': 'cancel' } } });
    expect(r.code).toBe(200);
    expectClosed(active.id, next.id);
  });

  it('a closed cycle refuses (409); an unknown one is 404', async () => {
    const { active } = closingFixture();
    await call(handleCycleClose, ctx, { id: active.id }, { body: { decisions: { 'carry-me': 'carry', 'back-me': 'back', 'cancel-me': 'cancel' } } });
    expect((await call(handleCycleClose, ctx, { id: active.id }, { body: { decisions: {} } })).code).toBe(409);
    expect((await call(handleCycleClosePlan, ctx, { id: 'cy_missing01' }, { method: 'GET' })).code).toBe(404);
  });
});

describe('the capacity hint', () => {
  it('averages the done leaves of the last three closed cycles', () => {
    const c = (start: string, status: CycleView['status'], done: number): CycleView =>
      ({ id: `cy_${start}`, number: 1, goal: 'g', start, end: start, status, created_at: start, result: { done, total: done } }) as CycleView;
    const doneOf = (x: CycleView) => x.result!.done;
    expect(capacityHint([], doneOf)).toBeNull();
    expect(capacityHint([c('2026-09-01', 'closed', 2), c('2026-09-08', 'closed', 4), c('2026-09-15', 'closed', 6), c('2026-09-22', 'closed', 100), c('2026-09-29', 'active', 0)], doneOf))
      .toBe(Math.round((4 + 6 + 100) / 3));
  });
});

describe('plan and rank by slug', () => {
  it('plans a task into Next or Later; refuses an unknown target', async () => {
    seed('a');
    const r = await call(handleTaskPlan, ctx, { slug: 'a' }, { body: { target: 'later' } });
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ placement: { cycle: null, queue: 'later' }, moved: ['a'] });
    expect(fm('a').queue).toBe('later');
    expect((await call(handleTaskPlan, ctx, { slug: 'a' }, { body: { target: 'cy_nowhere' } })).code).toBe(400);
    expect((await call(handleTaskPlan, ctx, { slug: 'a' }, { body: {} })).code).toBe(400);
  });

  it('ranks within one queue; refuses an unsafe or missing anchor', async () => {
    seed('a', { queue: 'next', rank: '10' });
    seed('b', { queue: 'next', rank: '20' });
    const r = await call(handleTaskRank, ctx, { slug: 'b' }, { body: { before: 'a' } });
    expect(r.code).toBe(200);
    expect((fm('b').rank as number)).toBeLessThan(fm('a').rank as number);
    expect((await call(handleTaskRank, ctx, { slug: 'b' }, { body: { before: '../x' } })).code).toBe(400);
    expect((await call(handleTaskRank, ctx, { slug: 'b' }, { body: { before: 'a', after: 'a' } })).code).toBe(400);
    expect((await call(handleTaskRank, ctx, { slug: 'b' }, { body: {} })).code).toBe(400);
  });
});
