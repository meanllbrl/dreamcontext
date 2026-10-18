/**
 * Cycles (C3, AC1-AC3).
 *
 * A cycle is a date range with a one-sentence goal, a random stable id and a
 * derived display number; one is active at a time, and a merge that leaves two
 * active keeps the earlier start and says so. `cycle new|start|close|list|show`
 * with a 1-week default that remembers the last length; an empty cycle closes.
 * `tasks plan` brings a parent's open children; capacity and progress count
 * leaves only; the close decides every unfinished leaf and counts carries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { registerCycleCommand } from '../../src/cli/commands/cycle.js';
import { readTaskFile } from '../../src/lib/task-backend/local.js';
import { readJournal } from '../../src/lib/task-journal.js';
import { loadFamily } from '../../src/lib/task-parent.js';
import { DEFAULT_STATUSES, type StatusDef } from '../../src/lib/task-status.js';
import {
  carryCount, cycleProgress, enforceOneActive, mergeCyclesJson, newCycle, parseCycles, readCycles,
  serializeCycles, startCycle, CycleError, type Cycle,
} from '../../src/lib/cycles.js';
import { classifyPath } from '../../src/lib/git-sync/semantic-merge.js';
import { UnsafePathError } from '../../src/lib/safe-resolve.js';
import { printable } from '../../src/lib/format.js';

let projectRoot: string;
let root: string;
let stateDir: string;
let prevCwd: string;
let logs: string[];
const origLog = console.log;
const origErr = console.error;
const STATUSES: StatusDef[] = [...DEFAULT_STATUSES, { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99 }];

function card(slug: string, fm: Record<string, string> = {}): void {
  const lines = ['---', `id: task_${slug.replace(/\W/g, '_')}`, `name: ${slug}`, `status: ${fm.status ?? 'todo'}`,
    'created_at: "2026-10-01"', 'updated_at: "2026-10-01"'];
  for (const [k, v] of Object.entries(fm)) if (k !== 'status') lines.push(`${k}: ${v}`);
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
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}
async function json<T = Record<string, unknown>>(...argv: string[]): Promise<T> {
  logs = [];
  expect(await cli(...argv, '--json')).toBe(0);
  return JSON.parse(logs.join('\n')) as T;
}
function said(re: RegExp): boolean {
  return logs.some((l) => re.test(l));
}
function cyc(over: Partial<Cycle> & { id: string; start: string }): Cycle {
  return { goal: 'g', end: over.start, status: 'planned', created_at: over.start, ...over } as Cycle;
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-cycles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  root = join(projectRoot, '_dream_context');
  stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'overrides'), { recursive: true });
  writeFileSync(join(root, 'overrides', 'task.md'), [
    '---', 'statuses:', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }', '---', '',
  ].join('\n'));
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

describe('the cycle model (AC1)', () => {
  it('has a date range, a one-sentence goal, a random stable id and a derived number', () => {
    const a = newCycle(root, { goal: 'Ship the card standard', today: '2026-10-19' });
    const b = newCycle(root, { goal: 'Ship sub-tasks', today: '2026-10-19' });
    expect(a.id).toMatch(/^cy_[A-Za-z0-9_-]{8}$/);
    expect(a.id).not.toBe(b.id);
    expect([a.start, a.end]).toEqual(['2026-10-19', '2026-10-25']);
    expect([b.start, b.end]).toEqual(['2026-10-26', '2026-11-01']);
    expect([a.number, b.number]).toEqual([1, 2]);
    const stored = JSON.parse(readFileSync(join(root, 'core', 'CYCLES.json'), 'utf-8'));
    expect(stored.cycles[0]).not.toHaveProperty('number');
    expect(() => newCycle(root, { goal: '  ' })).toThrow(CycleError);
    expect(() => newCycle(root, { goal: 'x'.repeat(201) })).toThrow(/one sentence/);
  });

  it('keeps exactly one active: a second start is refused', () => {
    newCycle(root, { goal: 'One', today: '2026-10-19' });
    newCycle(root, { goal: 'Two', today: '2026-10-19' });
    startCycle(root, '1', '2026-10-19');
    expect(() => startCycle(root, '2', '2026-10-19')).toThrow(/still active/);
  });

  it('two active cycles after a merge: the earlier start stays active, the other is planned, and it is reported', () => {
    const base = serializeCycles([]);
    const ours = serializeCycles([cyc({ id: 'cy_mine0001', start: '2026-10-20', end: '2026-10-26', status: 'active' })]);
    const theirs = serializeCycles([cyc({ id: 'cy_your0001', start: '2026-10-19', end: '2026-10-25', status: 'active' })]);
    const { merged, notes } = mergeCyclesJson(base, ours, theirs);
    const out = parseCycles(merged).cycles;
    expect(out.map((c) => [c.id, c.status])).toEqual([['cy_your0001', 'active'], ['cy_mine0001', 'planned']]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/kept #1 \(cy_your0001.*#2 \(cy_mine0001.*planned again/);
    expect(classifyPath('_dream_context/core/CYCLES.json')).toBe('cycles-json');
  });

  it('the same rule holds when a textual git merge never reached the merge driver', () => {
    writeFileSync(join(root, 'core', 'CYCLES.json'), serializeCycles([
      cyc({ id: 'cy_late0001', start: '2026-10-21', status: 'active' }),
      cyc({ id: 'cy_earl0001', start: '2026-10-20', status: 'active' }),
    ]));
    const { cycles, notes } = readCycles(root);
    expect(cycles.find((c) => c.status === 'active')!.id).toBe('cy_earl0001');
    expect(notes.join('\n')).toMatch(/kept #1 \(cy_earl0001/);
  });

  it('merges one cycle edited on both sides field by field, status only moving forward', () => {
    const was = cyc({ id: 'cy_same0001', start: '2026-10-19', end: '2026-10-25', status: 'active', goal: 'old' });
    const { merged } = mergeCyclesJson(
      serializeCycles([was]),
      serializeCycles([{ ...was, goal: 'new goal' }]),
      serializeCycles([{ ...was, status: 'closed', closed_at: '2026-10-25', carried: ['a'], result: { done: 2, total: 3 } }]),
    );
    const [c] = parseCycles(merged).cycles;
    expect(c).toMatchObject({ goal: 'new goal', status: 'closed', closed_at: '2026-10-25', carried: ['a'], result: { done: 2, total: 3 } });
    expect(enforceOneActive([c]).notes).toEqual([]);
  });
});

describe('cycle new / start / close / list / show (AC2)', () => {
  it('defaults to one week, then remembers the last length used', async () => {
    expect(await cli('cycle', 'new', '--goal', 'First')).toBe(0);
    expect(await cli('cycle', 'new', '--goal', 'Second', '--weeks', '2')).toBe(0);
    expect(await cli('cycle', 'new', '--goal', 'Third')).toBe(0);
    const { cycles } = readCycles(root);
    expect(cycles.map((c) => c.end > c.start ? (Date.parse(c.end) - Date.parse(c.start)) / 86_400_000 + 1 : 1)).toEqual([7, 14, 14]);
  });

  it('takes the configured default length when no cycle exists yet', async () => {
    writeFileSync(join(stateDir, '.config.json'), JSON.stringify({ tasks: { cycleDefaultWeeks: 2 } }));
    expect(await cli('cycle', 'new', '--goal', 'Two weeks')).toBe(0);
    const [c] = readCycles(root).cycles;
    expect((Date.parse(c.end) - Date.parse(c.start)) / 86_400_000 + 1).toBe(14);
  });

  it('starts, lists, shows, and closes an empty cycle as 0/0', async () => {
    expect(await cli('cycle', 'new', '--goal', 'Empty week')).toBe(0);
    expect(await cli('cycle', 'start', '1')).toBe(0);
    const list = await json<{ cycles: Array<{ status: string; goal: string }> }>('cycle', 'list');
    expect(list.cycles.map((c) => [c.status, c.goal])).toEqual([['active', 'Empty week']]);
    const shown = await json<{ number: number; days_left: number; progress: { done: number; total: number } }>('cycle', 'show');
    expect(shown.number).toBe(1);
    expect(shown.days_left).toBeGreaterThan(0);
    expect(shown.progress).toEqual({ done: 0, total: 0 });
    expect(await cli('cycle', 'close')).toBe(0);
    const [c] = readCycles(root).cycles;
    expect(c.status).toBe('closed');
    expect(c.result).toEqual({ done: 0, total: 0 });
  });

  it('refuses a goal-less cycle and a second active one', async () => {
    expect(await cli('cycle', 'new', '--goal', ' ')).toBe(1);
    await cli('cycle', 'new', '--goal', 'A');
    await cli('cycle', 'new', '--goal', 'B');
    expect(await cli('cycle', 'start', '1')).toBe(0);
    expect(await cli('cycle', 'start', '2')).toBe(1);
    expect(said(/still active/)).toBe(true);
  });
});

describe('planning, leaves, and the close ritual (AC3)', () => {
  function family3plus1(): void {
    card('epic', { status: 'in_progress' });
    for (const s of ['step-a', 'step-b', 'step-c']) card(s, { parent_task: 'epic' });
    card('step-done', { parent_task: 'epic', status: 'completed' });
  }

  it('tasks plan brings a parent\'s open children; the done child stays put; each move is journaled', async () => {
    family3plus1();
    await cli('cycle', 'new', '--goal', 'Ship epic');
    await cli('cycle', 'start', '1');
    const id = readCycles(root).cycles[0].id;
    expect(await cli('tasks', 'plan', 'epic', 'now')).toBe(0);
    for (const s of ['epic', 'step-a', 'step-b', 'step-c']) expect(fm(s).cycle).toBe(id);
    expect(fm('step-done').cycle ?? null).toBeNull();
    for (const s of ['step-a', 'step-b', 'step-c']) {
      expect(readJournal(stateDir, s)[0].body).toMatch(/planned into cycle #1 \(now\) with its parent epic/);
    }
    expect(fm('epic').priority).toBeUndefined();
    expect(fm('epic').version).toBeUndefined();
  });

  it('capacity and progress count leaves only', async () => {
    family3plus1();
    const c = newCycle(root, { goal: 'Ship epic' });
    await cli('tasks', 'plan', 'epic', c.id);
    card('loner', { cycle: c.id });
    let p = cycleProgress(loadFamily(stateDir), STATUSES, c.id);
    expect([p.done, p.total]).toEqual([0, 4]);
    card('step-a', { parent_task: 'epic', cycle: c.id, status: 'completed' });
    p = cycleProgress(loadFamily(stateDir), STATUSES, c.id);
    expect([p.done, p.total]).toEqual([1, 4]);
    expect(p.open.map((b) => b.slug).sort()).toEqual(['loner', 'step-b', 'step-c']);
  });

  it('a lone child planned shows its parent as the header, and the parent\'s place follows its children', async () => {
    card('epic');
    card('step-a', { parent_task: 'epic' });
    card('step-b', { parent_task: 'epic' });
    await cli('cycle', 'new', '--goal', 'Week');
    await cli('cycle', 'start', '1');
    expect(await cli('tasks', 'plan', 'step-a', 'now')).toBe(0);
    expect(fm('epic').cycle).toBe(readCycles(root).cycles[0].id);
    logs = [];
    await cli('cycle', 'show');
    const out = logs.join('\n');
    expect(out).toMatch(/epic — epic[\s\S]*step-a/);
    expect(out).not.toMatch(/step-b/);
  });

  it('the close asks for every unfinished leaf, then carries, sends back, cancels and counts carries', async () => {
    family3plus1();
    card('loner');
    await cli('cycle', 'new', '--goal', 'Week one');
    await cli('cycle', 'new', '--goal', 'Week two');
    await cli('cycle', 'start', '1');
    await cli('tasks', 'plan', 'epic', 'now');
    await cli('tasks', 'plan', 'loner', 'now');
    const [one, two] = readCycles(root).cycles;

    logs = [];
    expect(await cli('cycle', 'close')).toBe(1);
    expect(said(/4 unfinished/)).toBe(true);
    expect(readCycles(root).cycles[0].status).toBe('active');

    expect(await cli('cycle', 'close', '--carry', 'step-a,step-b', '--back', 'loner', '--cancel', 'step-c')).toBe(0);
    expect(fm('step-a').cycle).toBe(two.id);
    expect(fm('step-b').cycle).toBe(two.id);
    expect(fm('loner').cycle).toBeNull();
    expect(fm('loner').queue).toBe('next');
    expect(fm('step-c').status).toBe('cancelled');
    expect(fm('epic').cycle).toBe(two.id);
    const closed = readCycles(root).cycles.find((c) => c.id === one.id)!;
    expect(closed).toMatchObject({ status: 'closed', carried: ['step-a', 'step-b'], backed: ['loner'], cancelled: ['step-c'], result: { done: 0, total: 4 } });
    expect(carryCount(readCycles(root).cycles, 'step-a')).toBe(1);
    expect(readJournal(stateDir, 'step-a')[0].body).toMatch(/carried from cycle #1 into #2 \(carried 1×\)/);

    await cli('cycle', 'new', '--goal', 'Week three');
    await cli('cycle', 'start', '2');
    expect(await cli('cycle', 'close', '--all', 'carry')).toBe(0);
    expect(carryCount(readCycles(root).cycles, 'step-a')).toBe(2);
    logs = [];
    await cli('cycle', 'show', '3');
    expect(said(/step-a\s+carried 2×/)).toBe(true);
  });

  it('a close that stops halfway keeps its decisions and resumes them; carries are counted once (review M2)', async () => {
    card('step-a'); card('step-b'); card('step-c');
    await cli('cycle', 'new', '--goal', 'Week one');
    await cli('cycle', 'new', '--goal', 'Week two');
    await cli('cycle', 'start', '1');
    for (const s2 of ['step-a', 'step-b', 'step-c']) await cli('tasks', 'plan', s2, 'now');
    const [one, two] = readCycles(root).cycles;
    // step-b cannot be written: the close dies after moving step-a.
    chmodSync(join(stateDir, 'step-b.md'), 0o444);
    let crashed = false;
    try {
      await cli('cycle', 'close', '--carry', 'step-a,step-b', '--cancel', 'step-c');
    } catch {
      crashed = true;
    } finally {
      chmodSync(join(stateDir, 'step-b.md'), 0o644);
    }
    expect(crashed).toBe(true);
    const mid = readCycles(root).cycles.find((c) => c.id === one.id)!;
    expect(mid.status).toBe('active');
    expect(mid.closing).toMatchObject({ carried: ['step-a', 'step-b'], cancelled: ['step-c'], into: two.id, result: { done: 0, total: 3 } });
    expect(fm('step-a').cycle).toBe(two.id);

    // The re-run needs no flags (step-a is no longer an open leaf of cycle 1) and finishes the same decisions.
    expect(await cli('cycle', 'close')).toBe(0);
    const closed = readCycles(root).cycles.find((c) => c.id === one.id)!;
    expect(closed).toMatchObject({ status: 'closed', carried: ['step-a', 'step-b'], cancelled: ['step-c'], result: { done: 0, total: 3 } });
    expect(closed.closing).toBeUndefined();
    expect(fm('step-b').cycle).toBe(two.id);
    expect(fm('step-c').status).toBe('cancelled');
    expect(carryCount(readCycles(root).cycles, 'step-a')).toBe(1);
    expect(readJournal(stateDir, 'step-a').filter((e) => /carried from cycle #1/.test(e.body))).toHaveLength(1);
  });

  // End review, open question (b): the cancel wrote the status, then the journal entry. A close
  // that stopped between the two skipped the cancelled task on resume and lost its entry.
  it('a close that stops between a cancel\'s status and its journal entry writes the entry on resume, once', async () => {
    card('step-c');
    await cli('cycle', 'new', '--goal', 'Week one');
    await cli('cycle', 'start', '1');
    await cli('tasks', 'plan', 'step-c', 'now');
    const [one] = readCycles(root).cycles;
    // The journal file cannot be written (a directory sits at its path): the status lands, the entry does not.
    const journalFile = join(stateDir, 'journal', 'step-c.md');
    const hadJournal = existsSync(journalFile) ? readFileSync(journalFile, 'utf-8') : null;
    rmSync(journalFile, { force: true });
    mkdirSync(journalFile, { recursive: true });
    let crashed = false;
    try {
      await cli('cycle', 'close', '--cancel', 'step-c');
    } catch {
      crashed = true;
    } finally {
      rmSync(journalFile, { recursive: true, force: true });
      if (hadJournal !== null) writeFileSync(journalFile, hadJournal);
    }
    expect(crashed).toBe(true);
    expect(fm('step-c').status).toBe('cancelled');
    expect(readCycles(root).cycles.find((c) => c.id === one.id)!.closing).toMatchObject({ cancelled: ['step-c'] });
    const cancelEntries = () => readJournal(stateDir, 'step-c').filter((e) => e.kind === 'status' && /cancelled at the close of cycle #1/.test(e.body));
    expect(cancelEntries()).toHaveLength(0);

    expect(await cli('cycle', 'close')).toBe(0);
    expect(readCycles(root).cycles.find((c) => c.id === one.id)!.status).toBe('closed');
    expect(cancelEntries()).toHaveLength(1);
  });

  it('a resumed close whose carry target was closed meanwhile takes --into (review round 2, minor)', async () => {
    writeFileSync(join(root, 'core', 'CYCLES.json'), serializeCycles([
      cyc({ id: 'cy_open0001', start: '2026-10-12', end: '2026-10-18', status: 'active',
        closing: { carried: ['loner'], backed: [], cancelled: [], result: { done: 0, total: 1 }, into: 'cy_gone0001' } } as Partial<Cycle> & { id: string; start: string }),
      cyc({ id: 'cy_gone0001', start: '2026-10-19', end: '2026-10-25', status: 'closed' }),
    ]));
    card('loner', { cycle: 'cy_open0001' });
    logs = [];
    expect(await cli('cycle', 'close')).toBe(1);
    expect(said(/--into <n>/)).toBe(true);
    await cli('cycle', 'new', '--goal', 'Rescue', '--start', '2026-10-26');
    expect(await cli('cycle', 'close', '1', '--into', '3')).toBe(0);
    const third = readCycles(root).cycles.find((c) => c.number === 3)!;
    expect(fm('loner').cycle).toBe(third.id);
    expect(readCycles(root).cycles[0]).toMatchObject({ status: 'closed', carried: ['loner'] });
  });

  it('carrying needs a cycle to carry into', async () => {
    card('loner');
    await cli('cycle', 'new', '--goal', 'Only');
    await cli('cycle', 'start', '1');
    await cli('tasks', 'plan', 'loner', 'now');
    logs = [];
    expect(await cli('cycle', 'close', '--all', 'carry')).toBe(1);
    expect(said(/No planned cycle to carry into/)).toBe(true);
  });

  it('tasks plan next|later sets the queue; a closed cycle is refused', async () => {
    card('t1');
    expect(await cli('tasks', 'plan', 't1', 'later')).toBe(0);
    expect([fm('t1').cycle, fm('t1').queue]).toEqual([null, 'later']);
    expect(await cli('tasks', 'plan', 't1', 'now')).toBe(1);
    expect(said(/No cycle is active/)).toBe(true);
    await cli('cycle', 'new', '--goal', 'W');
    await cli('cycle', 'start', '1');
    await cli('cycle', 'close');
    expect(await cli('tasks', 'plan', 't1', '1')).toBe(1);
    expect(said(/is closed/)).toBe(true);
  });

  it('tasks rank orders inside one bucket and refuses across buckets', async () => {
    card('a'); card('b'); card('c'); card('d');
    for (const s of ['a', 'b', 'c']) await cli('tasks', 'plan', s, 'next');
    await cli('tasks', 'plan', 'd', 'later');
    expect(await cli('tasks', 'rank', 'c', '--before', 'a')).toBe(0);
    const order = ['a', 'b', 'c'].sort((x, y) => Number(fm(x).rank) - Number(fm(y).rank));
    expect(order).toEqual(['c', 'a', 'b']);
    expect(await cli('tasks', 'rank', 'd', '--after', 'a')).toBe(1);
    expect(said(/Plan it there first/)).toBe(true);
  });

  it('tasks rank writes only the moved card; done and legacy closed cards in the bucket are never touched (review M1)', async () => {
    card('a'); card('b'); card('c');
    card('done-1', { status: 'completed' });
    card('old-closed', { status: 'cancelled', priority: 'high' });
    const bytes = (s: string) => readFileSync(join(stateDir, `${s}.md`), 'utf-8');
    const before = { a: bytes('a'), b: bytes('b'), d: bytes('done-1'), o: bytes('old-closed') };
    expect(await cli('tasks', 'rank', 'c', '--before', 'a')).toBe(0);
    expect(fm('c').rank).toBe(10);
    expect([bytes('a'), bytes('b'), bytes('done-1'), bytes('old-closed')]).toEqual([before.a, before.b, before.d, before.o]);
    expect(await cli('tasks', 'rank', 'b', '--after', 'c')).toBe(0);
    expect(fm('b').rank).toBe(20);
    expect(bytes('a')).toBe(before.a);
    expect(await cli('tasks', 'rank', 'a', '--before', 'b')).toBe(0);
    expect(fm('a').rank).toBe(15);
    expect(['a', 'b', 'c'].sort((x, y) => Number(fm(x).rank) - Number(fm(y).rank))).toEqual(['c', 'a', 'b']);
    expect(await cli('tasks', 'rank', 'a', '--before', 'done-1')).toBe(1);
    expect(said(/not open/)).toBe(true);
  });

  it('the CYCLES.json temp write refuses a symlink planted at its name (security M1)', () => {
    const outside = join(projectRoot, 'outside.txt');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, join(root, 'core', `CYCLES.json.${process.pid}.tmp`));
    expect(() => newCycle(root, { goal: 'Planted' })).toThrow(UnsafePathError);
    expect(readFileSync(outside, 'utf-8')).toBe('untouched');
  });

  it('text from data is printed without control characters (security M2/M3)', async () => {
    expect(printable('ok\u001b]52;c;ZXZpbA==\u0007done\u009b')).toBe('ok]52;c;ZXZpbA==done');
    writeFileSync(join(root, 'core', 'CYCLES.json'), serializeCycles([
      cyc({ id: 'cy_ctrl0001', start: '2026-10-19', end: '2026-10-25', status: 'active', goal: 'evil\u001b[2Jgoal' }),
    ]));
    logs = [];
    await cli('cycle', 'list');
    expect(logs.join('\n')).toContain('evil[2Jgoal');
    expect(logs.join('\n')).not.toContain('\u001b[2J');
  });

  it('no cycle file is written until a cycle is opened', () => {
    expect(existsSync(join(root, 'core', 'CYCLES.json'))).toBe(false);
    expect(readCycles(root).cycles).toEqual([]);
  });
});
