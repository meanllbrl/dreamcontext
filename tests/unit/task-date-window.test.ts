import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Command } from 'commander';

/**
 * End-to-end cover for the date-window rules across BOTH surfaces that can move
 * a task's start/due dates — the CLI verbs and the dashboard PATCH route.
 *
 * The bug this pins: entering `in_progress` stamped `start_date` without looking
 * at `due_date`, so any task whose due date had already passed landed in an
 * invalid start>due window and every later edit (CLI, dashboard, ClickUp push)
 * failed with "start_date cannot be after due_date". Moving a start now
 * reschedules the due date instead, and completing a task records the real end.
 */

vi.mock('../../src/lib/id.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/id.js')>();
  let counter = 0;
  return {
    ...actual,
    generateId: (prefix: string) => `${prefix}_date${String(++counter).padStart(3, '0')}`,
    today: () => '2026-06-11',
  };
});

import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { handleTasksUpdate } from '../../src/server/routes/tasks.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import { readSleepState } from '../../src/cli/commands/sleep.js';

const TODAY = '2026-06-11';

let projectRoot: string;
let contextRoot: string;
let prevCwd: string;

async function cli(...argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}

function makeRes(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code: number) { res.statusCode = code; return res; },
    end(chunk?: unknown) { if (chunk !== undefined) res.body = String(chunk); return res; },
    setHeader() { return res; },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string };
}

async function patch(slug: string, body: unknown): Promise<{ statusCode: number; body: string }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as unknown as Record<string, unknown>).headers = {};
  (req as unknown as Record<string, unknown>).method = 'PATCH';
  const res = makeRes();
  await handleTasksUpdate(req, res, { slug }, contextRoot);
  return res;
}

/** Every field change the dashboard route recorded for rem-sleep, flattened. */
function recordedFieldChanges(): Array<{ field: string; to: unknown }> {
  const changes = readSleepState(contextRoot).dashboard_changes ?? [];
  return changes.flatMap((c) => (c.fields ?? []) as Array<{ field: string; to: unknown }>);
}

/** The task's persisted date window, read back through the backend. */
async function window(slug: string): Promise<{ start: string | null; due: string | null; status: string }> {
  const task = await new LocalTaskBackend(join(contextRoot, 'state')).get(slug);
  return {
    start: (task?.start_date ?? null) as string | null,
    due: (task?.due_date ?? null) as string | null,
    status: String(task?.status ?? ''),
  };
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-dates-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('CLI date window', () => {
  it('reschedules a passed due date when in_progress stamps the start', async () => {
    await cli('tasks', 'create', 'Late Start', '-w', 'why', '--due', '2026-06-05');
    await cli('tasks', 'status', 'late-start', 'in_progress');
    // Was: start=2026-06-11 with due still 2026-06-05 — an invalid window that
    // then rejected every later edit.
    expect(await window('late-start')).toEqual({ start: TODAY, due: TODAY, status: 'in_progress' });
  });

  it('leaves a still-valid due date untouched when stamping the start', async () => {
    await cli('tasks', 'create', 'Roomy', '-w', 'why', '--due', '2026-07-01');
    await cli('tasks', 'status', 'roomy', 'in_progress');
    expect(await window('roomy')).toEqual({ start: TODAY, due: '2026-07-01', status: 'in_progress' });
  });

  it('preserves the window length when `tasks start` moves the start past the due date', async () => {
    await cli('tasks', 'create', 'Slip', '-w', 'why', '--start', '2026-06-01', '--due', '2026-06-06');
    await cli('tasks', 'start', 'slip', '2026-06-10');
    // A 5-day job that starts 9 days late is still a 5-day job.
    expect(await window('slip')).toMatchObject({ start: '2026-06-10', due: '2026-06-15' });
  });

  it('still refuses a due date set before the start', async () => {
    await cli('tasks', 'create', 'Contradiction', '-w', 'why', '--start', '2026-06-10', '--due', '2026-06-20');
    await cli('tasks', 'due', 'contradiction', '2026-06-01');
    expect(await window('contradiction')).toMatchObject({ start: '2026-06-10', due: '2026-06-20' });
  });

  it('stamps the real end date on completion, over the planned one', async () => {
    await cli('tasks', 'create', 'Shipped', '-w', 'why', '--start', '2026-06-02', '--due', '2026-08-01');
    await cli('tasks', 'complete', 'shipped', 'Done early.');
    expect(await window('shipped')).toEqual({ start: '2026-06-02', due: TODAY, status: 'completed' });
  });

  it('stamps the real end date via `tasks status completed` too', async () => {
    await cli('tasks', 'create', 'Shipped Two', '-w', 'why', '--start', '2026-06-02', '--due', '2026-08-01');
    await cli('tasks', 'status', 'shipped-two', 'completed');
    expect(await window('shipped-two')).toEqual({ start: '2026-06-02', due: TODAY, status: 'completed' });
  });

  it('closes a never-started task same-day, on both ends', async () => {
    // No start on a finished task means it went not-started → done in one move,
    // so it gets a real (same-day) window rather than half a range.
    await cli('tasks', 'create', 'Straight To Done', '-w', 'why');
    await cli('tasks', 'complete', 'straight-to-done', 'Never picked up separately.');
    expect(await window('straight-to-done')).toEqual({ start: TODAY, due: TODAY, status: 'completed' });
  });

  it('drops the backlog tag when completion dates a backlog task', async () => {
    // Dates and `backlog` are mutually exclusive; a done task is not backlog.
    await cli('tasks', 'create', 'Parked', '-w', 'why', '-t', 'backlog');
    await cli('tasks', 'complete', 'parked', 'Closed straight out of the backlog.');
    const task = await new LocalTaskBackend(join(contextRoot, 'state')).get('parked');
    expect(task?.tags).toEqual([]);
    expect(await window('parked')).toEqual({ start: TODAY, due: TODAY, status: 'completed' });
  });

  it('announces the end date it stamped over a planned one', async () => {
    const lines: string[] = [];
    (console.log as unknown as { mockImplementation: (f: (m?: unknown) => void) => void })
      .mockImplementation((m?: unknown) => { lines.push(String(m)); });
    await cli('tasks', 'create', 'Loud', '-w', 'why', '--start', '2026-06-02', '--due', '2026-08-01');
    await cli('tasks', 'complete', 'loud', 'Done.');
    expect(lines.join('\n')).toContain(`due date set to ${TODAY} (work finished), replacing the planned 2026-08-01`);
  });
});

describe('dashboard PATCH date window', () => {
  it('reschedules the due date for a start-only patch instead of 400ing', async () => {
    await cli('tasks', 'create', 'Gantt Drag', '-w', 'why', '--start', '2026-06-01', '--due', '2026-06-06');
    const res = await patch('gantt-drag', { start_date: '2026-06-10' });
    expect(res.statusCode).toBe(200);
    expect(await window('gantt-drag')).toMatchObject({ start: '2026-06-10', due: '2026-06-15' });
  });

  it('still rejects a patch that names both ends and inverts them', async () => {
    await cli('tasks', 'create', 'Both Ends', '-w', 'why', '--start', '2026-06-01', '--due', '2026-06-06');
    const res = await patch('both-ends', { start_date: '2026-06-20', due_date: '2026-06-10' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_date_range');
    expect(await window('both-ends')).toMatchObject({ start: '2026-06-01', due: '2026-06-06' });
  });

  it('stamps start (and reschedules due) when the board moves a card to in_progress', async () => {
    await cli('tasks', 'create', 'Board Move', '-w', 'why', '--due', '2026-06-05');
    const res = await patch('board-move', { status: 'in_progress' });
    expect(res.statusCode).toBe(200);
    expect(await window('board-move')).toEqual({ start: TODAY, due: TODAY, status: 'in_progress' });
  });

  it('stamps the real end when the board moves a card to completed', async () => {
    await cli('tasks', 'create', 'Board Done', '-w', 'why', '--due', '2026-08-01');
    const res = await patch('board-done', { status: 'completed' });
    expect(res.statusCode).toBe(200);
    // Never started, so the board close gives it a real same-day window.
    expect(await window('board-done')).toEqual({ start: TODAY, due: TODAY, status: 'completed' });
  });

  it('lets an explicit due date in the same patch win over the completion stamp', async () => {
    await cli('tasks', 'create', 'Explicit', '-w', 'why', '--start', '2026-06-02', '--due', '2026-08-01');
    const res = await patch('explicit', { status: 'completed', due_date: '2026-06-09' });
    expect(res.statusCode).toBe(200);
    expect(await window('explicit')).toMatchObject({ due: '2026-06-09', status: 'completed' });
  });

  it('rejects a status change paired with a due date the stamped start would invert', async () => {
    // The stamp is validated like any caller-supplied date, so this can no longer
    // write the exact start>due corruption the rest of this PR removes.
    await cli('tasks', 'create', 'Stamp Clash', '-w', 'why');
    const res = await patch('stamp-clash', { status: 'in_progress', due_date: '2026-01-01' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_date_range');
    expect(await window('stamp-clash')).toEqual({ start: null, due: null, status: 'todo' });
  });

  it('records one due_date change, not the intermediate value, when both rules fire', async () => {
    await cli('tasks', 'create', 'Tracked', '-w', 'why', '--start', '2026-06-01', '--due', '2026-06-03');
    const res = await patch('tracked', { start_date: '2026-06-10', status: 'completed' });
    expect(res.statusCode).toBe(200);
    // The reschedule (→ 2026-06-12) never hits disk; only the completion stamp does.
    expect(await window('tracked')).toMatchObject({ start: '2026-06-10', due: TODAY });
    const dueEntries = recordedFieldChanges().filter((c) => c.field === 'due_date');
    expect(dueEntries).toHaveLength(1);
    expect(dueEntries[0].to).toBe(TODAY);
  });
});

/**
 * The rescheduled due date is DERIVED, not sent — so it skipped the format
 * check every client-supplied date on these surfaces passes. Past year 9999
 * the shift overflows into `toISOString()`'s extended ±YYYYYY form and the
 * 10-character slice yields "+019996-01", a string no later `isCalendarDate`
 * accepts. Both surfaces now refuse instead of persisting it.
 */
describe('a reschedule that runs off the end of the calendar', () => {
  it('is refused by the PATCH route instead of written to disk', async () => {
    await cli('tasks', 'create', 'Far Future', '-w', 'why', '--start', '0001-01-01', '--due', '9998-01-01');
    expect((await window('far-future')).due).toBe('9998-01-01');

    const res = await patch('far-future', { start_date: '9999-01-02' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('invalid_date_range');
    const after = await window('far-future');
    expect(after.due).toBe('9998-01-01');
    expect(after.start).toBe('0001-01-01');
  });

  it('is refused by the CLI instead of written to disk', async () => {
    await cli('tasks', 'create', 'Far Future Cli', '-w', 'why', '--start', '0001-01-01', '--due', '9998-01-01');

    await cli('tasks', 'start', 'far-future-cli', '9999-01-02');

    const after = await window('far-future-cli');
    expect(after.due).toBe('9998-01-01');
    expect(after.start).toBe('0001-01-01');
  });
});
