import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import matter from 'gray-matter';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { checkCloseGate, baselinePath } from '../../src/lib/sleep-eval/report.js';

/**
 * Sub-tasks and waves from the CLI: `tasks create --parent/--basis`, `tasks parent`,
 * `tasks list --parent --json` (wave numbers over ALL siblings), the close gate (a parent with
 * open sub-tasks cannot complete), who counts as sleep during a live cycle, `tasks basis`,
 * the `tasks ready` note, and the sleep-eval exemption for a mapped wave.
 */

let projectRoot: string;
let ctx: string;
let prevCwd: string;
let out: string[];
let prevEnv: Record<string, string | undefined>;

async function cli(...argv: string[]): Promise<number> {
  process.exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', 'tasks', ...argv]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return code;
}

function fmOf(slug: string): Record<string, unknown> {
  return matter(readFileSync(join(ctx, 'state', `${slug}.md`), 'utf-8')).data;
}

function writeTask(slug: string, fm: Record<string, unknown>, body = '## Why\nBecause it matters to the owner.\n'): void {
  const front = { name: slug, status: 'todo', priority: 'medium', urgency: 'medium', parent_task: null, related_feature: null, version: null, ...fm };
  writeFileSync(join(ctx, 'state', `${slug}.md`), matter.stringify(body, front), 'utf-8');
}

const printed = (): string => out.join('\n');

beforeEach(() => {
  const raw = join(tmpdir(), `tcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  ctx = join(projectRoot, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(ctx, 'overrides'), { recursive: true });
  mkdirSync(join(ctx, 'knowledge', 'features'), { recursive: true });
  writeFileSync(join(ctx, 'knowledge', 'features', 'checkout.md'), '---\nname: Checkout\ntype: feature\nrelated_tasks: []\n---\n## Why\nx\n', 'utf-8');
  writeFileSync(join(ctx, 'overrides', 'task.md'), '---\nstatuses:\n  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }\n---\n', 'utf-8');
  writeTask('the-parent', { name: 'The Parent', version: '1.2.0', related_feature: 'checkout' });
  writeTask('closed-parent', { name: 'Closed Parent', status: 'completed' });
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  prevEnv = {
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    DREAMCONTEXT_AUTO_SLEEP: process.env.DREAMCONTEXT_AUTO_SLEEP,
    DREAMCONTEXT_FILING_BAR_SEMANTIC: process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC,
  };
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.DREAMCONTEXT_AUTO_SLEEP;
  process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC = '0';
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('tasks create --parent', () => {
  it('writes the link in the create, inherits version + feature + Why, stamps the agent', async () => {
    expect(await cli('create', 'A Step', '--parent', 'the-parent')).toBe(0);
    const fm = fmOf('a-step');
    expect(fm).toMatchObject({ parent_task: 'the-parent', version: '1.2.0', related_feature: 'checkout', filed_by: 'agent' });
    expect(fm.filing_basis).toMatchObject({ kind: 'note', quote: 'Part of The Parent (`the-parent`).', verified: false });
  });

  it('refuses a closed parent, a sub-task as parent, and a missing parent', async () => {
    expect(await cli('create', 'Late Step', '-w', 'A reason that is long enough here.', '--parent', 'closed-parent')).toBe(1);
    expect(printed()).toMatch(/closed task takes no new subtasks/);
    await cli('create', 'Child', '-w', 'A reason that is long enough here.', '--parent', 'the-parent');
    expect(await cli('create', 'Grandchild', '-w', 'A reason that is long enough here.', '--parent', 'child')).toBe(1);
    expect(printed()).toMatch(/two levels deep/);
  });
});

describe('tasks parent', () => {
  it('sets, prints and clears; refuses a closed parent', async () => {
    writeTask('loose', { name: 'Loose' });
    expect(await cli('parent', 'loose', 'the-parent')).toBe(0);
    expect(fmOf('loose').parent_task).toBe('the-parent');
    await cli('parent', 'the-parent');
    expect(printed()).toMatch(/sub-tasks: loose \(todo\)/);
    expect(await cli('parent', 'loose', 'clear')).toBe(0);
    expect(fmOf('loose').parent_task).toBeNull();
    expect(await cli('parent', 'loose', 'closed-parent')).toBe(1);
  });
});

describe('waves: list --parent --json, the close gate, readiness', () => {
  const map = 'WAVE MAP: EXECUTION: lead | W1 1-dalga-api (src/a.ts) | W2 2-dalga-ui (src/b.tsx)';

  async function plan(): Promise<void> {
    await cli('insert', 'the-parent', 'technical_details', 'WAVE MAP: EXECUTION: lead | W1 (src/a.ts) | W2 (src/b.tsx)');
    await cli('create', '1. dalga: api', '--parent', 'the-parent', '--basis', 'plan', '--quote', 'W1 (src/a.ts)');
    await cli('create', '2. dalga: ui', '--parent', 'the-parent', '--basis', 'plan', '--quote', 'W2 (src/b.tsx)');
    await cli('insert', 'the-parent', 'technical_details', map);
    writeTask('sleep-found', { name: 'Sleep found', parent_task: 'the-parent', filed_by: 'sleep' });
  }

  async function listJson(...extra: string[]): Promise<Array<{ name: string; wave: number | null; filed_by: string | null }>> {
    out = [];
    await cli('list', '--parent', 'the-parent', '--json', ...extra);
    return JSON.parse(out.join('\n'));
  }

  it('wave numbers come from the newest map; a sleep child is not a wave; closed waves keep their number', async () => {
    await plan();
    expect(fmOf('1-dalga-api')).toMatchObject({ filed_by: 'plan', parent_task: 'the-parent' });
    let rows = await listJson();
    expect(rows.map((r) => [r.name, r.wave, r.filed_by])).toEqual([
      ['1-dalga-api', 1, 'plan'],
      ['2-dalga-ui', 2, 'plan'],
      ['sleep-found', null, 'sleep'],
    ]);
    expect(await cli('complete', '1-dalga-api', 'wave one green')).toBe(0);
    rows = await listJson();
    expect(rows.map((r) => [r.name, r.wave])).toEqual([['2-dalga-ui', 2], ['sleep-found', null]]);
  });

  it('a parent with open sub-tasks cannot complete; cancelled children never block', async () => {
    await plan();
    expect(await cli('complete', 'the-parent', 'done')).toBe(1);
    expect(printed()).toMatch(/3 open sub-task\(s\)/);
    expect(await cli('status', 'the-parent', 'completed')).toBe(1);
    expect(fmOf('the-parent').status).toBe('todo');
    await cli('complete', '1-dalga-api', 'ok');
    await cli('complete', '2-dalga-ui', 'ok');
    await cli('status', 'sleep-found', 'cancelled', 'not needed');
    expect(await cli('complete', 'the-parent', 'done')).toBe(0);
    expect(fmOf('the-parent').status).toBe('completed');
  });

  it('tasks ready never refuses an old map; it notes the missing wave sub-tasks only when there are none', async () => {
    writeTask('old-plan', { name: 'Old Plan' }, '## Why\nx\n\n## Acceptance Criteria\n\n- [ ] works\n- [ ] Validation method: tests\n\n## Technical Details\n\nWAVE MAP: EXECUTION: lead | W1 (src/a.ts) | W2 (src/b.ts)\n');
    expect(await cli('ready', 'old-plan')).toBe(0);
    expect(printed()).toMatch(/no wave sub-tasks exist yet; Develop opens them/);
    out = [];
    await cli('create', '1. dalga: a', '--parent', 'old-plan', '--basis', 'plan');
    expect(await cli('ready', 'old-plan')).toBe(0);
    expect(printed()).not.toMatch(/no wave sub-tasks/);
  });

  it('a mapped wave is exempt from the sleep-eval close gate; an unmapped plan child is not', async () => {
    await plan();
    mkdirSync(dirname(baselinePath(ctx)), { recursive: true });
    writeFileSync(baselinePath(ctx), JSON.stringify({ runId: 'run-x', parents: ['the-parent'], at: '2026-10-23' }));
    expect(checkCloseGate(ctx, '2-dalga-ui', 'the-parent')).toMatchObject({ applies: true, ok: false });
    expect(checkCloseGate(ctx, '2-dalga-ui', 'the-parent', { exempt: true })).toMatchObject({ applies: false });
    // through the CLI: the mapped wave closes, the sleep child is still gated
    expect(await cli('complete', '2-dalga-ui', 'green')).toBe(0);
    expect(await cli('complete', 'sleep-found', 'done')).toBe(1);
    // `tasks basis --basis plan` alone is no escape: the map must name the child
    expect(await cli('basis', 'sleep-found', '--basis', 'plan', '--quote', 'sneaky')).toBe(0);
    expect(await cli('complete', 'sleep-found', 'done')).toBe(1);
  });
});

describe('who files during a live sleep cycle (DREAMCONTEXT_AUTO_SLEEP=1)', () => {
  beforeEach(() => { process.env.DREAMCONTEXT_AUTO_SLEEP = '1'; });

  it('no --by and no basis is sleep: refused, with the --parent and criterion escapes', async () => {
    expect(await cli('create', 'Something New', '-w', 'A reason that is long enough for the bar to read.')).toBe(1);
    expect(printed()).toMatch(/needs a basis/);
    expect(printed()).toMatch(/--parent <slug>/);
  });

  it('--basis plan --parent quoting a wave of the parent\'s map is the plan and never meets the bar', async () => {
    process.env.DREAMCONTEXT_AUTO_SLEEP = '';
    await cli('insert', 'the-parent', 'technical_details', 'WAVE MAP: EXECUTION: lead | W1 (src/a.ts) | W2 (src/b.ts)');
    process.env.DREAMCONTEXT_AUTO_SLEEP = '1';
    expect(await cli('create', '1. dalga: x', '--parent', 'the-parent', '--basis', 'plan', '--quote', 'W1 (src/a.ts)')).toBe(0);
    expect(fmOf('1-dalga-x').filed_by).toBe('plan');
  });

  it('--basis plan --parent quoting no wave is refused like any sleep filing', async () => {
    expect(await cli('create', 'Sneaky sub-task', '--parent', 'the-parent', '--basis', 'plan', '--quote', 'not on any map')).toBe(1);
    expect(printed()).toMatch(/needs a basis/);
  });

  it('tasks basis is refused while a cycle is live', async () => {
    writeTask('kid2', { name: 'Kid 2', parent_task: 'the-parent' });
    expect(await cli('basis', 'kid2', '--basis', 'plan', '--quote', 'W1')).toBe(1);
    expect(printed()).toMatch(/refused while a sleep cycle is live/);
  });

  it('--by agent passes and is recorded as an agent', async () => {
    expect(await cli('create', 'Agent Work', '-w', 'short', '--by', 'agent')).toBe(0);
    expect(fmOf('agent-work').filed_by).toBe('agent');
  });

  it('--by human is the owner', async () => {
    expect(await cli('create', 'Mine', '-w', 'short', '--by', 'human')).toBe(0);
    expect(fmOf('mine').filed_by).toBe('human');
    expect(fmOf('mine').filing_basis).toBeUndefined();
  });
});

describe('tasks basis', () => {
  it('--basis plan needs a parent and writes filed_by plan; other kinds keep filed_by', async () => {
    writeTask('loose', { name: 'Loose' });
    expect(await cli('basis', 'loose', '--basis', 'plan')).toBe(1);
    writeTask('kid', { name: 'Kid', parent_task: 'the-parent' });
    expect(await cli('basis', 'kid', '--basis', 'plan', '--quote', 'W1 (a.ts)')).toBe(0);
    expect(fmOf('kid')).toMatchObject({ filed_by: 'plan', filing_basis: { kind: 'plan', quote: 'W1 (a.ts)' } });
    writeTask('by-sleep', { name: 'By Sleep', filed_by: 'sleep' });
    expect(await cli('basis', 'by-sleep', '--basis', 'ask', '--quote', 'the owner said so clearly')).toBe(0);
    expect(fmOf('by-sleep')).toMatchObject({ filed_by: 'sleep', filing_basis: { kind: 'ask', verified: false } });
  });
});

describe('tasks object → objections --unlearned → rules set / revert (the CLI loop)', () => {
  it('an objection is listed as unlearned until a rule rests on it; revert dismisses it', async () => {
    writeTask('sleep-made', { name: 'Sleep Made', filed_by: 'sleep' }, '## Why\nx\n\n## Changelog\n');
    expect(await cli('object', 'sleep-made', '--as', 'criterion-on', '--target', 'the-parent', '--note', 'This was a step of The Parent all along.')).toBe(0);
    expect(fmOf('sleep-made').status).toBe('cancelled');
    out = [];
    await cli('objections', '--unlearned', '--json');
    const unlearned = JSON.parse(out.join('\n')) as Array<{ id: string; task: string }>;
    expect(unlearned.map((r) => r.task)).toEqual(['sleep-made']);
    const id = unlearned[0].id;

    expect(await cli('rules', 'set', '--title', 'Steps are criteria', '--dont', 'open a task for a step', '--do', 'add a criterion', '--rests-on', 'obj_nope')).toBe(1);
    expect(await cli('rules', 'set', '--title', 'Steps are criteria', '--dont', 'open a task for a step', '--do', 'add a criterion', '--rests-on', id)).toBe(0);
    out = [];
    await cli('objections', '--unlearned', '--json');
    expect(JSON.parse(out.join('\n'))).toEqual([]);

    expect(await cli('rules', 'revert', 'R1')).toBe(0);
    out = [];
    await cli('objections', '--unlearned', '--json');
    expect(JSON.parse(out.join('\n'))).toEqual([]);

    // a broken rules file: --unlearned refuses loudly instead of reading it as "no rules"
    writeFileSync(join(ctx, 'knowledge', 'patterns', 'task-filing-rules.md'), '---\nname: x\n---\n## bad heading\n', 'utf-8');
    expect(await cli('objections', '--unlearned')).toBe(1);
    expect(printed()).toMatch(/Rules could not be read/);
  });
});
