/**
 * Order and releases (C3, AC4-AC5).
 *
 * Priority, urgency and BACKLOG are not written by the new paths; the order is
 * Now / Next / Later plus a rank, and a remote's priority maps both ways. A
 * release is compiled from what closed since the previous one; a planning
 * release is no longer created; the snapshot shows the Cycle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { registerCycleCommand } from '../../src/cli/commands/cycle.js';
import { registerCoreCommand } from '../../src/cli/commands/core.js';
import { renderCycleLines } from '../../src/cli/commands/snapshot.js';
import { readTaskFile } from '../../src/lib/task-backend/local.js';
import { addDays, readCycles } from '../../src/lib/cycles.js';
import { today } from '../../src/lib/id.js';
import {
  orderFromPriority, orderOf, placementForOrder, priorityForPlacement, wirePriority, type Order,
} from '../../src/lib/task-order.js';

let projectRoot: string;
let root: string;
let stateDir: string;
let prevCwd: string;
let logs: string[];
const origLog = console.log;
const origErr = console.error;

function card(slug: string, fm: Record<string, string> = {}): void {
  const lines = ['---', `id: task_${slug.replace(/\W/g, '_')}`, `name: ${slug}`, `status: ${fm.status ?? 'todo'}`,
    'created_at: "2026-10-01"', `updated_at: "${fm.updated_at ?? '2026-10-01'}"`];
  for (const [k, v] of Object.entries(fm)) if (k !== 'status' && k !== 'updated_at') lines.push(`${k}: ${v}`);
  lines.push('---', '', '## Why', '', 'Because.', '');
  writeFileSync(join(stateDir, `${slug}.md`), lines.join('\n'));
}
function fm(slug: string): Record<string, unknown> {
  return readTaskFile(join(stateDir, `${slug}.md`)).raw;
}
async function cli(...argv: string[]): Promise<number> {
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  registerCycleCommand(program);
  registerCoreCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}
function said(re: RegExp): boolean {
  return logs.some((l) => re.test(l));
}
function releases(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(root, 'core', 'RELEASES.json'), 'utf-8'));
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-order-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  root = join(projectRoot, '_dream_context');
  stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
  writeFileSync(join(root, 'core', 'RELEASES.json'), '[]\n');
  writeFileSync(join(root, 'core', 'CHANGELOG.json'), '[]\n');
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.exitCode = undefined;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('priority, urgency and BACKLOG are not written by the new paths (AC4)', () => {
  it('tasks create writes no priority, urgency or version, and needs none', async () => {
    expect(await cli('tasks', 'create', 'Plain task', '-w', 'because')).toBe(0);
    const raw = readFileSync(join(stateDir, 'plain-task.md'), 'utf-8');
    expect(raw).not.toMatch(/^(priority|urgency|version):/m);
    expect(fm('plain-task').cycle ?? null).toBeNull();
  });

  it('-p/-u are accepted, warned about, and ignored', async () => {
    expect(await cli('tasks', 'create', 'Loud task', '-w', 'because', '-p', 'critical', '-u', 'high')).toBe(0);
    expect(said(/-p\/--priority is retired/)).toBe(true);
    expect(said(/-u\/--urgency is retired/)).toBe(true);
    expect(fm('loud-task').priority).toBeUndefined();
    expect(fm('loud-task').urgency).toBeUndefined();
  });

  it('-v BACKLOG means Later; -v naming a cycle plans into it; anything else is a legacy label', async () => {
    expect(await cli('tasks', 'create', 'Someday', '-w', 'x', '-v', 'BACKLOG')).toBe(0);
    expect([fm('someday').queue, fm('someday').version]).toEqual(['later', undefined]);
    await cli('cycle', 'new', '--goal', 'Week');
    expect(await cli('tasks', 'create', 'In cycle', '-w', 'x', '-v', '1')).toBe(0);
    expect(fm('in-cycle').cycle).toBe(readCycles(root).cycles[0].id);
    expect(await cli('tasks', 'create', 'Old label', '-w', 'x', '-v', 'v0.32.0')).toBe(0);
    expect(fm('old-label').version).toBe('v0.32.0');
    expect(said(/-v is deprecated: "v0.32.0" is kept as a legacy version label/)).toBe(true);
  });

  it('tasks version BACKLOG sends the task to Later instead of writing BACKLOG', async () => {
    card('t1');
    expect(await cli('tasks', 'version', 't1', 'BACKLOG')).toBe(0);
    expect([fm('t1').queue, fm('t1').version ?? null]).toEqual(['later', null]);
  });

  it('the order is Now / Next / Later with a rank inside each bucket', () => {
    expect(orderOf({ cycle: 'cy_active01' }, 'cy_active01')).toBe('now');
    expect(orderOf({ cycle: 'cy_planned1' }, 'cy_active01')).toBe('next');
    expect(orderOf({ queue: 'later' }, 'cy_active01')).toBe('later');
    expect(orderOf({}, null)).toBe('next');
  });

  it('remote priority maps both ways and survives a round trip', () => {
    const active = 'cy_active01';
    const cases: Array<[Order, { cycle?: string | null; queue?: string | null }]> = [
      ['now', { cycle: active }], ['next', { queue: 'next' }], ['later', { queue: 'later' }],
    ];
    for (const [order, card] of cases) {
      const wire = wirePriority(card, active);
      expect(wire).toBe({ now: 'high', next: 'medium', later: 'low' }[order]);
      const back = orderFromPriority(wire, card.cycle === active)!;
      expect(back).toBe(order);
      expect(orderOf(placementForOrder(card, back, active), active)).toBe(order);
    }
    // Lossy by design: high outside the active cycle is Next (a remote cannot plan into a cycle).
    expect(orderFromPriority('urgent', false)).toBe('next');
    expect(orderFromPriority('critical', true)).toBe('now');
    expect(orderFromPriority('normal', true)).toBe('next');
    expect(orderFromPriority(null, true)).toBeNull();
    // A remote "low" takes a task out of the active cycle; "normal" keeps a planned cycle.
    expect(placementForOrder({ cycle: active }, 'later', active)).toEqual({ cycle: null, queue: 'later' });
    expect(placementForOrder({ cycle: 'cy_planned1' }, 'next', active)).toEqual({ cycle: 'cy_planned1', queue: null });
    // Owner decision: a task in ANY cycle is high (a planned or not-yet-synced one too), so no
    // machine sends normal for a task in a cycle; it still reads as Next until that cycle is active.
    expect(priorityForPlacement({ cycle: 'cy_planned1' })).toBe('high');
    expect(wirePriority({ cycle: 'cy_unknown1' }, active)).toBe('high');
    expect(orderOf({ cycle: 'cy_planned1' }, active)).toBe('next');
    expect(orderFromPriority('high', false)).toBe('next');
    // A legacy card (priority only) still sends its own priority.
    expect(wirePriority({ priority: 'critical' }, active)).toBe('critical');
    // A card with neither reads as Next and sends medium.
    expect(wirePriority({}, active)).toBe('medium');
  });
});

describe('releases and the snapshot Cycle section (AC5)', () => {
  it('a planning release is no longer created', async () => {
    expect(await cli('core', 'releases', 'add', '--ver', '9.9.9', '--status', 'planning', '--summary', 's', '-y')).toBe(1);
    expect(said(/Planning releases are retired/)).toBe(true);
    expect(releases()).toEqual([]);
  });

  it('a release is compiled from what closed since the previous release, and links its cycles', async () => {
    writeFileSync(join(root, 'core', 'RELEASES.json'), JSON.stringify([
      { id: 'rel_old', version: '1.0.0', date: '2026-10-10', summary: 'old', breaking: false, status: 'released', features: [], tasks: ['task_shipped'], changelog: [] },
      { id: 'rel_plan', version: '1.1.0', date: '', summary: 'legacy plan', breaking: false, status: 'planning', features: [], tasks: [], changelog: [] },
    ]));
    card('shipped', { status: 'completed', updated_at: '2026-10-08' });
    card('stale', { status: 'completed', updated_at: '2026-10-05' });
    card('fresh', { status: 'completed', updated_at: '2026-10-12', cycle: 'cy_week0001' });
    card('fresh-too', { status: 'completed', updated_at: '2026-10-10' });
    card('open-one', { status: 'in_progress', updated_at: '2026-10-12' });
    expect(await cli('core', 'releases', 'add', '--ver', '1.2.0', '--summary', 'new', '-y')).toBe(0);
    const rel = releases()[0];
    expect(rel.version).toBe('1.2.0');
    expect([...(rel.tasks as string[])].sort()).toEqual(['task_fresh', 'task_fresh_too']);
    expect(rel.cycles).toEqual(['cy_week0001']);
    expect(rel.status).toBe('released');
  });

  it('the snapshot shows the Cycle: number, goal, days left, done/total', async () => {
    const now = today();
    await cli('cycle', 'new', '--goal', 'Ship the queue', '--start', now);
    await cli('cycle', 'start', '1');
    const id = readCycles(root).cycles[0].id;
    card('a', { cycle: id, status: 'completed' });
    card('b', { cycle: id });
    card('epic', { cycle: id });
    card('c', { cycle: id, parent_task: 'epic' });
    const lines = renderCycleLines(root, now);
    expect(lines[0]).toBe(`- #1: Ship the queue — 7 day(s) left (${now} → ${addDays(now, 6)}), 1/3 done`);
  });

  it('without an active cycle it names the next planned one, and nothing at all without cycles', async () => {
    expect(renderCycleLines(root)).toEqual([]);
    await cli('cycle', 'new', '--goal', 'Later week', '--start', '2030-01-07');
    expect(renderCycleLines(root, '2030-01-01')[0]).toMatch(/^- No active cycle\. Next: #1: Later week \(2030-01-07 → 2030-01-13\)/);
  });
});
