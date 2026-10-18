/**
 * The owner's verdict on a task in review (plan r3 § W4; r3 security S2; orchestrator
 * additions 1 and 4): approve or send back with a note, one library for the dashboard
 * route and the CLI. The route refuses an Origin-less write (403); every verdict is
 * journaled and audited with its `via`; the audit's ignore entries are ensured before
 * anything moves, so a verdict is never left done and unaudited. The PATCH approval
 * still accepts an Origin-less write and records it as `no-origin`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { handleTaskVerdict, handleTasksUpdate } from '../../src/server/routes/tasks.js';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { listAudit } from '../../src/lib/task-audit.js';
import { readJournal } from '../../src/lib/task-journal.js';
import { writeBaseline } from '../../src/lib/sleep-eval/report.js';
import { sleepEvalRoot } from '../../src/lib/sleep-eval/types.js';
import { resetTaskReadMemo } from '../../src/lib/task-backend/local.js';
import { call } from '../helpers/fake-http.js';

let projectRoot: string;
let ctx: string;
let stateDir: string;
let prevCwd: string;
const AGENT_ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN'];
const savedEnv: Record<string, string | undefined> = {};
const origLog = console.log;
const origErr = console.error;

function seed(slug: string, status: string, extra: string[] = [], criteria = ['- [x] Parser works (evidence: commit:abc)']): void {
  writeFileSync(join(stateDir, `${slug}.md`), [
    '---', `id: task_${slug.replace(/[^a-z]/g, '').slice(0, 8)}`, `name: ${slug}`, `status: ${status}`,
    'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', ...extra, '---', '',
    '## Why', '', 'Because.', '', '## Acceptance Criteria', '', ...criteria, '',
  ].join('\n'));
}
const statusOf = (slug: string) => /^status: (.+)$/m.exec(readFileSync(join(stateDir, `${slug}.md`), 'utf-8'))![1];
const snapshot = (slug: string) => ({
  card: readFileSync(join(stateDir, `${slug}.md`), 'utf-8'),
  journal: existsSync(join(stateDir, 'journal', `${slug}.md`)) ? readFileSync(join(stateDir, 'journal', `${slug}.md`), 'utf-8') : null,
});

async function cli(...argv: string[]): Promise<number> {
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  try {
    await program.parseAsync(['node', 'dreamcontext', ...argv]);
  } catch {
    process.exitCode = undefined;
    return 1;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-verdict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(stateDir, { recursive: true });
  resetTaskReadMemo();
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  for (const k of AGENT_ENVS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  for (const k of AGENT_ENVS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  process.exitCode = undefined;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('POST /api/tasks/:slug/verdict', () => {
  it('approve closes a task in review, journals it and audits it via the dashboard', async () => {
    seed('in-review', 'in_review');
    const { code, body } = await call(handleTaskVerdict, ctx, { slug: 'in-review' }, { body: { verdict: 'approve', note: 'looked at it' } });
    expect(code).toBe(200);
    expect((body.task as Record<string, unknown>).status).toBe('completed');
    expect(statusOf('in-review')).toBe('completed');
    const je = readJournal(stateDir, 'in-review').find((e) => e.kind === 'approval')!;
    expect(je.body).toContain('looked at it');
    expect(listAudit(ctx)).toEqual([expect.objectContaining({ kind: 'approval', slug: 'in-review', via: 'dashboard', journalId: je.id })]);
  });

  it('a verdict with no Origin is refused (403) and changes nothing', async () => {
    seed('in-review', 'in_review');
    const before = snapshot('in-review');
    const { code, body } = await call(handleTaskVerdict, ctx, { slug: 'in-review' }, { body: { verdict: 'approve' }, origin: null });
    expect(code).toBe(403);
    expect(body.error).toBe('origin_required');
    expect(snapshot('in-review')).toEqual(before);
    expect(listAudit(ctx)).toEqual([]);
  });

  it('a verdict from the phone is audited via phone', async () => {
    seed('in-review', 'in_review');
    expect((await call(handleTaskVerdict, ctx, { slug: 'in-review' }, { body: { verdict: 'approve' }, phone: true })).code).toBe(200);
    expect(listAudit(ctx)[0].via).toBe('phone');
  });

  it('send back needs a note (400); with one it returns the task to work, journaled and audited', async () => {
    seed('in-review', 'in_review');
    const none = await call(handleTaskVerdict, ctx, { slug: 'in-review' }, { body: { verdict: 'send_back' } });
    expect(none.code).toBe(400);
    expect(none.body.error).toBe('note_required');
    expect(statusOf('in-review')).toBe('in_review');
    const ok = await call(handleTaskVerdict, ctx, { slug: 'in-review' }, { body: { verdict: 'send_back', note: 'the parser drops dates' } });
    expect(ok.code).toBe(200);
    expect(statusOf('in-review')).toBe('in_progress');
    expect(readJournal(stateDir, 'in-review').find((e) => e.label === 'sent back')?.body).toContain('the parser drops dates');
    expect(listAudit(ctx)[0]).toMatchObject({ kind: 'send_back', note: 'the parser drops dates', via: 'dashboard' });
  });

  it('refuses a task not in review, a parent with open sub-tasks, and a child the sleep eval gates (409)', async () => {
    seed('working', 'in_progress');
    expect((await call(handleTaskVerdict, ctx, { slug: 'working' }, { body: { verdict: 'approve' } })).body.error).toBe('not_in_review');

    seed('the-parent', 'in_review');
    seed('open-child', 'todo', ['parent_task: the-parent']);
    const parent = await call(handleTaskVerdict, ctx, { slug: 'the-parent' }, { body: { verdict: 'approve' } });
    expect(parent.code).toBe(409);
    expect(parent.body.error).toBe('subtasks_open');

    seed('gated-parent', 'in_progress');
    seed('gated-child', 'in_review', ['parent_task: gated-parent']);
    mkdirSync(sleepEvalRoot(ctx), { recursive: true });
    writeBaseline(ctx, { runId: 'run-20261018-0000', parents: ['gated-parent'], at: '2026-10-18T00:00:00.000Z' });
    const gated = await call(handleTaskVerdict, ctx, { slug: 'gated-child' }, { body: { verdict: 'approve' } });
    expect(gated.code).toBe(409);
    expect(gated.body.error).toBe('sleep_eval_gate');
    expect(statusOf('gated-child')).toBe('in_review');
    expect(listAudit(ctx)).toEqual([]);
  });

  it('preflight: with an unwritable ignore the verdict is refused (500) and nothing changes', async () => {
    seed('in-review', 'in_review');
    mkdirSync(join(ctx, '.gitignore'));
    const before = snapshot('in-review');
    const r = await call(handleTaskVerdict, ctx, { slug: 'in-review' }, { body: { verdict: 'approve' } });
    expect(r.code).toBe(500);
    expect(snapshot('in-review')).toEqual(before);
    expect(existsSync(join(stateDir, '.task-audit.json'))).toBe(false);
  });
});

describe('the CLI verdicts are the same verdicts', () => {
  it('tasks approve and tasks send-back move the task the same way and audit via cli', async () => {
    seed('one', 'in_review');
    seed('two', 'in_review');
    expect(await cli('tasks', 'approve', 'one', '--note', 'checked')).toBe(0);
    expect(statusOf('one')).toBe('completed');
    expect(await cli('tasks', 'send-back', 'two', '--note', 'missing the docs')).toBe(0);
    expect(statusOf('two')).toBe('in_progress');
    const kinds = listAudit(ctx).map((e) => `${e.kind}:${e.slug}:${e.via}`).sort();
    expect(kinds).toEqual(['approval:one:cli', 'send_back:two:cli']);
  });

  it('send-back needs --note and is refused from an agent environment', async () => {
    seed('two', 'in_review');
    expect(await cli('tasks', 'send-back', 'two')).toBe(1);
    process.env.CLAUDECODE = '1';
    expect(await cli('tasks', 'send-back', 'two', '--note', 'x')).toBe(1);
    expect(statusOf('two')).toBe('in_review');
  });

  it('preflight: with an unwritable ignore, approve and --force are refused and nothing changes', async () => {
    seed('one', 'in_review');
    seed('forced', 'in_progress', [], ['- [ ] Unproven']);
    mkdirSync(join(ctx, '.gitignore'));
    const one = snapshot('one');
    const forced = snapshot('forced');
    expect(await cli('tasks', 'approve', 'one')).toBe(1);
    expect(await cli('tasks', 'status', 'forced', 'in_review', '--force', '--reason', 'spike')).toBe(1);
    expect(snapshot('one')).toEqual(one);
    expect(snapshot('forced')).toEqual(forced);
  });

  it('a --force is audited with its reason, under the journal entry it writes', async () => {
    seed('forced', 'in_progress', [], ['- [ ] Unproven']);
    expect(await cli('tasks', 'status', 'forced', 'in_review', '--force', '--reason', 'spike, no tests')).toBe(0);
    const je = readJournal(stateDir, 'forced').find((e) => e.label.startsWith('forced'))!;
    expect(listAudit(ctx)).toEqual([expect.objectContaining({ kind: 'force', slug: 'forced', via: 'cli', note: 'spike, no tests', journalId: je.id })]);
  });
});

describe('the PATCH approvals stay open to an Origin-less write, and say so (R4-2 item 1)', () => {
  it('a review → done drag with no Origin succeeds and is recorded as no-origin', async () => {
    seed('in-review', 'in_review');
    const r = await call(handleTasksUpdate, ctx, { slug: 'in-review' }, { method: 'PATCH', body: { status: 'completed' }, origin: null });
    expect(r.code).toBe(200);
    expect(statusOf('in-review')).toBe('completed');
    expect(listAudit(ctx)).toEqual([expect.objectContaining({ kind: 'approval', slug: 'in-review', via: 'no-origin' })]);
  });

  it('an owner tick from the dashboard is audited via dashboard', async () => {
    seed('ticky', 'in_progress', [], ['- [ ] Board looks right']);
    const body = readFileSync(join(stateDir, 'ticky.md'), 'utf-8').split('\n---\n').slice(1).join('\n---\n').replace('- [ ] Board', '- [x] Board');
    const r = await call(handleTasksUpdate, ctx, { slug: 'ticky' }, { method: 'PATCH', body: { body } });
    expect(r.code).toBe(200);
    expect(listAudit(ctx)).toEqual([expect.objectContaining({ kind: 'approval', slug: 'ticky', via: 'dashboard' })]);
  });

  it('preflight: with an unwritable ignore a PATCH approval is refused (500) and nothing changes', async () => {
    seed('in-review', 'in_review');
    mkdirSync(join(ctx, '.gitignore'));
    const before = snapshot('in-review');
    const r = await call(handleTasksUpdate, ctx, { slug: 'in-review' }, { method: 'PATCH', body: { status: 'completed' } });
    expect(r.code).toBe(500);
    expect(snapshot('in-review')).toEqual(before);
  });
});
