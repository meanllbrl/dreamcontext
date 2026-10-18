/**
 * The close gates run in one order (merge of main into the task-system stack):
 * missing fields → open sub-tasks → the sleep-eval gate → the evidence gate.
 *
 * The order is load-bearing. A `--force` pass of the evidence gate journals its
 * "forced" entry as it passes, so any gate that can still refuse must come
 * before it: otherwise a refused close leaves a forced entry behind for a
 * close that never happened. `tasks approve` (review → done) runs the sleep
 * gate too; without it the owner's verdict would skip the eval.
 *
 * The fixture gates the parent with a baseline and gives the child no eval
 * run, so the sleep gate must refuse every close of the child, and the child's
 * card and journal must be byte-identical afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { writeBaseline } from '../../src/lib/sleep-eval/report.js';
import { sleepEvalRoot } from '../../src/lib/sleep-eval/types.js';

let projectRoot: string;
let contextRoot: string;
let stateDir: string;
let prevCwd: string;
let logs: string[];
const origLog = console.log;
const origErr = console.error;
const AGENT_ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN'];
const savedEnv: Record<string, string | undefined> = {};

function cardOf(slug: string, name: string, status: string, extra: string[], criteria: string[]): string {
  return [
    '---', `id: task_${slug.replace(/-/g, '').slice(0, 8)}`, `name: ${name}`, `status: ${status}`,
    'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', ...extra, '---', '',
    '## Why', '', 'Because.', '',
    '## Acceptance Criteria', '', ...criteria, '',
  ].join('\n');
}

function seed(childStatus: string): void {
  writeFileSync(join(stateDir, 'parent-task.md'), cardOf('parent-task', 'Parent task', 'in_progress', [], ['- [ ] The whole thing ships']));
  writeFileSync(
    join(stateDir, 'child-task.md'),
    cardOf('child-task', 'Child task', childStatus, ['parent_task: parent-task'], ['- [ ] Unproven step']),
  );
}

const cardPath = () => join(stateDir, 'child-task.md');
const journalPath = () => join(stateDir, 'journal', 'child-task.md');

/** Card bytes plus journal bytes (or its absence), the state a refusal must not touch. */
function snapshot(): { card: string; journal: string | null } {
  return {
    card: readFileSync(cardPath(), 'utf-8'),
    journal: existsSync(journalPath()) ? readFileSync(journalPath(), 'utf-8') : null,
  };
}

async function cli(...argv: string[]): Promise<number> {
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-gate-order-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  // The parent is gated: a baseline names it, and the child has no eval run.
  mkdirSync(sleepEvalRoot(contextRoot), { recursive: true });
  writeBaseline(contextRoot, { runId: 'run-20261018-0000', parents: ['parent-task'], at: '2026-10-18T00:00:00.000Z' });
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  for (const k of AGENT_ENVS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  for (const k of AGENT_ENVS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  process.exitCode = undefined;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('close gate order: the sleep-eval gate refuses before a forced evidence pass journals', () => {
  it('tasks complete --force on a gated child is refused and writes nothing', async () => {
    seed('in_progress');
    const before = snapshot();
    expect(await cli('tasks', 'complete', 'child-task', 'done', '--force', '--reason', 'trust me')).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(logs.join('\n')).toContain('gated by the sleep eval');
  });

  it('tasks status <done> --force on a gated child is refused and writes nothing', async () => {
    seed('in_progress');
    const before = snapshot();
    expect(await cli('tasks', 'status', 'child-task', 'completed', '--force', '--reason', 'trust me')).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(logs.join('\n')).toContain('gated by the sleep eval');
  });

  it('tasks approve on a gated child in review is refused and writes nothing', async () => {
    seed('in_review');
    const before = snapshot();
    expect(await cli('tasks', 'approve', 'child-task', '--note', 'looked at it')).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(/^status: (.+)$/m.exec(readFileSync(cardPath(), 'utf-8'))![1]).toBe('in_review');
    expect(logs.join('\n')).toContain('gated by the sleep eval');
  });

  it('a move to review is not a close: the sleep gate does not apply, only the evidence gate', async () => {
    seed('in_progress');
    expect(await cli('tasks', 'status', 'child-task', 'in_review', '--force', '--reason', 'spike, no tests')).toBe(0);
    expect(/^status: (.+)$/m.exec(readFileSync(cardPath(), 'utf-8'))![1]).toBe('in_review');
    expect(logs.join('\n')).not.toContain('gated by the sleep eval');
  });
});
