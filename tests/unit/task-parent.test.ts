/**
 * Sub-tasks (C2, AC1, AC2, AC8).
 *
 * Two levels, enforced: `tasks create --parent` and `tasks parent` refuse a
 * missing, nested or closed parent and a parent becoming a child; a child
 * inherits objectives, feature and cycle. The parent's status is computed from
 * its children and stored; it cannot close while a child is open, cannot be
 * deleted with a live child, needs a decision per open child to be cancelled,
 * and its children follow a rename. `parent_task` and every new path are
 * validated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { handleTasksDelete, handleTasksUpdate } from '../../src/server/routes/tasks.js';
import { readTaskFile } from '../../src/lib/task-backend/local.js';
import { readJournal } from '../../src/lib/task-journal.js';
import { buildFamily, checkParentLink, loadFamily, rolledUpStatus, type TaskBrief } from '../../src/lib/task-parent.js';
import { foldSubTasks } from '../../src/cli/commands/snapshot.js';
import { buildGraph } from '../../src/lib/graph.js';
import { buildRoadmapModel } from '../../src/lib/roadmap-model.js';
import { safeResolveInside, UnsafePathError } from '../../src/lib/safe-resolve.js';
import { DEFAULT_STATUSES, type StatusDef } from '../../src/lib/task-status.js';

let projectRoot: string;
let root: string;
let stateDir: string;
let prevCwd: string;
let logs: string[];
const origLog = console.log;
const origErr = console.error;
const AGENT_ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN'];
const savedEnv: Record<string, string | undefined> = {};
const STATUSES: StatusDef[] = [
  ...DEFAULT_STATUSES,
  { key: 'cancelled', label: 'Cancelled', kind: 'cancelled', order: 99 },
];

function card(slug: string, fm: Record<string, string> = {}, criteria: string[] = []): void {
  const lines = ['---', `id: task_${slug.replace(/\W/g, '_')}`, `name: ${slug}`, `status: ${fm.status ?? 'todo'}`,
    'created_at: "2026-10-01"', 'updated_at: "2026-10-01"'];
  for (const [k, v] of Object.entries(fm)) if (k !== 'status') lines.push(`${k}: ${v}`);
  lines.push('---', '', '## Why', '', 'Because.', '');
  if (criteria.length > 0) lines.push('## Acceptance Criteria', '', ...criteria, '');
  writeFileSync(join(stateDir, `${slug}.md`), lines.join('\n'));
}
function fm(slug: string): Record<string, unknown> {
  return readTaskFile(join(stateDir, `${slug}.md`)).raw;
}
function statusOf(slug: string): string {
  return String(fm(slug).status);
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
function said(re: RegExp): boolean {
  return logs.some((l) => re.test(l));
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  root = join(projectRoot, '_dream_context');
  stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, 'overrides'), { recursive: true });
  writeFileSync(join(root, 'overrides', 'task.md'), [
    '---', 'statuses:', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }', '---', '',
  ].join('\n'));
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

describe('create --parent and tasks parent (AC1)', () => {
  it('a child inherits objectives, feature and cycle from its parent', async () => {
    mkdirSync(join(root, 'knowledge', 'features'), { recursive: true });
    writeFileSync(join(root, 'knowledge', 'features', 'area.md'),
      '---\nid: feat_area\ntype: feature\nname: area\nstatus: planning\nrelated_tasks: []\n---\n\n## Why\n\nBody.\n');
    card('epic', { objectives: '[ship-it]', related_feature: 'area', cycle: 'cy_abc12345', status: 'in_progress' });
    expect(await cli('tasks', 'create', 'Step one', '-w', 'first step', '--parent', 'epic')).toBe(0);
    const child = fm('step-one');
    expect(child.parent_task).toBe('epic');
    expect(child.objectives).toEqual(['ship-it']);
    expect(child.related_feature).toBe('area');
    expect(child.cycle).toBe('cy_abc12345');
  });

  it('refuses a missing parent, a nested parent, a closed parent and self', async () => {
    card('epic');
    card('step', { parent_task: 'epic' });
    card('done-one', { status: 'completed' });
    expect(await cli('tasks', 'create', 'Ghost child', '-w', 'x', '--parent', 'nope-no-such')).toBe(1);
    expect(existsSync(join(stateDir, 'ghost-child.md'))).toBe(false);
    expect(await cli('tasks', 'create', 'Grandchild', '-w', 'x', '--parent', 'step')).toBe(1);
    expect(said(/two levels only/)).toBe(true);
    expect(existsSync(join(stateDir, 'grandchild.md'))).toBe(false);
    expect(await cli('tasks', 'create', 'Late child', '-w', 'x', '--parent', 'done-one')).toBe(1);
    expect(said(/closed task takes no new sub-tasks/)).toBe(true);
    expect(await cli('tasks', 'parent', 'epic', 'epic')).toBe(1);
  });

  it('tasks parent links, refuses a parent becoming a child, and clears', async () => {
    card('epic', { objectives: '[ship-it]' });
    card('other');
    card('step');
    expect(await cli('tasks', 'parent', 'step', 'epic')).toBe(0);
    expect(fm('step').parent_task).toBe('epic');
    expect(fm('step').objectives).toEqual(['ship-it']);
    // epic now has a child → it cannot sit under another task
    expect(await cli('tasks', 'parent', 'epic', 'other')).toBe(1);
    expect(fm('epic').parent_task ?? null).toBeNull();
    expect(await cli('tasks', 'parent', 'step', 'clear')).toBe(0);
    expect(fm('step').parent_task).toBeNull();
    expect(readJournal(stateDir, 'step').some((e) => /detached from epic/.test(e.body))).toBe(true);
  });
});

describe('parent status and guards (AC2)', () => {
  it('the parent status is computed from its children and stored (journaled)', async () => {
    card('epic', {}, ['- [ ] Children closed']);
    card('a', { parent_task: 'epic' }, ['- [ ] A works']);
    card('b', { parent_task: 'epic' }, ['- [ ] B works']);
    expect(await cli('tasks', 'status', 'a', 'in_progress')).toBe(0);
    expect(statusOf('epic')).toBe('in_progress');
    expect(readJournal(stateDir, 'epic').some((e) => /computed from its sub-tasks/.test(e.body))).toBe(true);
    // both children done; the parent's own criterion is unproven → it stays active, never done
    card('a', { parent_task: 'epic', status: 'completed' });
    card('b', { parent_task: 'epic', status: 'in_progress' }, ['- [x] B works (evidence: commit:abc1234)']);
    expect(await cli('tasks', 'status', 'b', 'completed', '--force', '--reason', 'test fixture')).toBe(0);
    expect(statusOf('epic')).toBe('in_progress');
  });

  it('every child done and the parent proven → the parent reaches review, not done', () => {
    const kids: TaskBrief[] = [
      { slug: 'a', id: null, name: 'a', status: 'completed', parent: 'epic', rank: null },
      { slug: 'b', id: null, name: 'b', status: 'cancelled', parent: 'epic', rank: null },
    ];
    expect(rolledUpStatus(STATUSES, 'in_progress', '## Acceptance Criteria\n\n- [x] ok (evidence: commit:abc1234)\n', kids)).toBe('in_review');
    expect(rolledUpStatus(STATUSES, 'completed', '', kids)).toBeNull();
    expect(rolledUpStatus(STATUSES, 'in_progress', '', [{ ...kids[0], status: 'todo' }])).toBe('todo');
  });

  it('a parent cannot complete or be approved while a child is open', async () => {
    card('epic', { status: 'in_review' }, ['- [x] All good (evidence: commit:abc1234)']);
    card('a', { parent_task: 'epic', status: 'in_progress' });
    expect(await cli('tasks', 'status', 'epic', 'completed')).toBe(1);
    expect(said(/open sub-task/)).toBe(true);
    expect(await cli('tasks', 'complete', 'epic', 'done')).toBe(1);
    expect(await cli('tasks', 'approve', 'epic')).toBe(1);
    expect(statusOf('epic')).toBe('in_review');
  });

  it('a parent with a live child is not deleted; closed children are detached', async () => {
    card('epic');
    card('a', { parent_task: 'epic', status: 'in_progress' });
    card('z', { parent_task: 'epic', status: 'completed' });
    expect(await cli('tasks', 'delete', 'epic', '--yes')).toBe(1);
    expect(existsSync(join(stateDir, 'epic.md'))).toBe(true);
    card('a', { parent_task: 'epic', status: 'completed' });
    expect(await cli('tasks', 'delete', 'epic', '--yes')).toBe(0);
    expect(fm('a').parent_task).toBeNull();
    expect(fm('z').parent_task).toBeNull();
  });

  it('cancelling a parent needs a decision for every open child', async () => {
    card('epic');
    card('other');
    card('a', { parent_task: 'epic', status: 'in_progress' });
    card('b', { parent_task: 'epic' });
    card('c', { parent_task: 'epic' });
    expect(await cli('tasks', 'status', 'epic', 'cancelled')).toBe(1);
    expect(said(/needs a decision for each/)).toBe(true);
    expect(statusOf('epic')).toBe('todo');
    expect(await cli('tasks', 'status', 'epic', 'cancelled', '--child', 'a=move:other', '--child', 'b=detach', '--child', 'c=cancel')).toBe(0);
    expect(statusOf('epic')).toBe('cancelled');
    expect(fm('a').parent_task).toBe('other');
    expect(fm('b').parent_task).toBeNull();
    expect(statusOf('c')).toBe('cancelled');
  });

  it('children follow a parent rename (slug and legacy id refs)', async () => {
    card('epic');
    card('a', { parent_task: 'epic' });
    card('b', { parent_task: 'task_epic' });
    expect(await cli('tasks', 'rename', 'epic', 'Epic renamed')).toBe(0);
    expect(fm('a').parent_task).toBe('epic-renamed');
    expect(fm('b').parent_task).toBe('epic-renamed');
  });

  it('the dashboard PATCH refuses closing a parent with an open child, and deleting it', async () => {
    card('epic', { status: 'in_review' }, ['- [x] All good (evidence: commit:abc1234)']);
    card('a', { parent_task: 'epic', status: 'in_progress' });
    const r = await call(handleTasksUpdate, { slug: 'epic' }, { status: 'completed' });
    expect(r.status).toBe(409);
    expect(r.body).toMatch(/subtasks_open/);
    expect(statusOf('epic')).toBe('in_review');
    const d = await call(handleTasksDelete, { slug: 'epic' });
    expect(d.status).toBe(409);
    expect(existsSync(join(stateDir, 'epic.md'))).toBe(true);
    const bad = await call(handleTasksUpdate, { slug: 'epic' }, { parent_task: 'a' });
    expect(bad.status).toBe(400);
  });
});

describe('reading families (AC1, AC8)', () => {
  it('a legacy id ref and a folded-YAML slug both resolve; the graph draws the link', () => {
    // A real name, unlike the slug: the graph must resolve the FILE slug.
    writeFileSync(join(stateDir, 'epic.md'), '---\nid: task_epic\nname: The Epic Deliverable\nstatus: todo\n---\n\n## Why\n\nx\n');
    writeFileSync(join(stateDir, 'a.md'), '---\nid: task_a\nname: a\nstatus: todo\nparent_task: >-\n  epic\n---\n\n## Why\n\nx\n');
    card('b', { parent_task: 'task_epic' });
    const fam = loadFamily(stateDir);
    expect(fam.children.get('epic')!.map((c) => c.slug).sort()).toEqual(['a', 'b']);
    const graph = buildGraph(root);
    const parentLinks = graph.links.filter((l) => l.kind === 'parent_task');
    expect(parentLinks).toHaveLength(2);
  });

  it('an unsafe parent_task reads as none and never joins a family', () => {
    card('epic');
    card('a', { parent_task: '"../epic"' });
    expect(readTaskFile(join(stateDir, 'a.md')).parent_task).toBeNull();
    expect(loadFamily(stateDir).children.size).toBe(0);
    expect(checkParentLink(buildFamily([]), STATUSES, 'a', '../x').ok).toBe(false);
  });

  it('safeResolveInside refuses escapes and symlinked components', () => {
    expect(() => safeResolveInside(stateDir, '../outside.md')).toThrow(UnsafePathError);
    expect(() => safeResolveInside(stateDir, '/etc/passwd')).toThrow(UnsafePathError);
    const outside = join(projectRoot, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(stateDir, '.session-task'));
    expect(() => safeResolveInside(stateDir, '.session-task/x.json')).toThrow(UnsafePathError);
    expect(safeResolveInside(stateDir, 'journal/x.md')).toBe(join(stateDir, 'journal', 'x.md'));
  });
});

describe('roll-ups count leaves (AC1)', () => {
  it('the snapshot folds children into the parent with n/m', () => {
    const fam = buildFamily([
      { slug: 'epic', id: null, name: 'Epic', status: 'in_progress', parent: null, rank: null },
      { slug: 'a', id: null, name: 'Step A', status: 'completed', parent: 'epic', rank: null },
      { slug: 'b', id: null, name: 'Step B', status: 'todo', parent: 'epic', rank: null },
    ]);
    const entries = [
      { text: '- **Epic**', slug: 'epic', name: 'Epic', status: 'in_progress', priority: '-', updated: '' },
      { text: '- **Step B**', slug: 'b', name: 'Step B', status: 'todo', priority: '-', updated: '' },
    ];
    const out = foldSubTasks(entries, fam, STATUSES);
    expect(out.map((e) => e.slug)).toEqual(['epic']);
    expect(out[0].text).toContain('Sub-tasks: 1/2 done');
    expect(out[0].text).toContain('Step B [todo] -> b');
    // no families → untouched
    const plain = [{ text: '- **X**', slug: 'x', name: 'X', status: 'todo', priority: '-', updated: '' }];
    expect(foldSubTasks(plain, buildFamily([]), STATUSES)).toBe(plain);
  });

  it('objective progress counts the children, not the parent on top of them', () => {
    mkdirSync(join(root, 'core', 'objectives'), { recursive: true });
    writeFileSync(join(root, 'core', 'objectives', 'ship-it.md'), '---\nid: obj_ship\nname: Ship it\n---\n\nShip.\n');
    card('epic', { objectives: '[ship-it]', status: 'in_progress' });
    card('a', { objectives: '[ship-it]', parent_task: 'epic', status: 'completed' });
    card('b', { objectives: '[ship-it]', parent_task: 'epic' });
    card('solo', { objectives: '[ship-it]', status: 'completed' });
    const o = buildRoadmapModel(root).objectives.find((x) => x.slug === 'ship-it')!;
    expect(o.progress.total).toBe(3);
    expect(o.progress.done).toBe(2);
  });
});

// ─── route harness ──────────────────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string) => Promise<void>;
async function call(h: Handler, params: Record<string, string>, body?: unknown): Promise<{ status: number; body: string }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = { 'content-type': 'application/json' };
  (req as unknown as { method: string }).method = body === undefined ? 'DELETE' : 'PATCH';
  let status = 0;
  let out = '';
  const res = {
    writeHead(s: number) { status = s; return res; },
    setHeader() { return res; },
    end(chunk?: string) { out += chunk ?? ''; },
    statusCode: 0,
  } as unknown as ServerResponse;
  await h(req, res, params, root);
  return { status: status || (res as unknown as { statusCode: number }).statusCode, body: out };
}
