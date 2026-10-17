/**
 * Sub-tasks on the wire (C2, AC7): GitHub sub-issues and ClickUp subtasks, both
 * ways, through the fakes. Push links a child under its parent (parents pushed
 * first) and detaches it; pull applies a remote link, flattens a grandchild
 * onto its top-level ancestor, never clears a local link because a remote is
 * silent, and keeps a parent open that the remote closed while its children are
 * open (journaled, then reopened by the next push). ClickUp's full sweep lists
 * subtasks, so a pushed child is never read as remotely deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { readTaskFile } from '../../src/lib/task-backend/local.js';
import { readJournal } from '../../src/lib/task-journal.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

const BASE = { platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true, cloudTaskManagement: true, people: ['Alice'] };
const GH: SetupConfig = { ...BASE, taskBackend: 'github', github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' } } as SetupConfig;
const CU: SetupConfig = { ...BASE, taskBackend: 'clickup', clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' }, peopleIdentity: { alice: { clickupMemberId: '501' } } } as SetupConfig;

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
const parentOf = (slug: string) => readTaskFile(join(stateDir, `${slug}.md`)).parent_task;
const statusOf = (slug: string) => readTaskFile(join(stateDir, `${slug}.md`)).status;
function mapOf(): Record<string, string> {
  const rows = JSON.parse(readFileSync(join(stateDir, '.tasks-map.json'), 'utf-8')) as Array<{ slug: string; remoteId: string }> | { entries: Array<{ slug: string; remoteId: string }> };
  const list = Array.isArray(rows) ? rows : rows.entries;
  return Object.fromEntries(list.map((r) => [r.slug, r.remoteId]));
}

/** Fail the create of one task (by its title/name) while `blocked.on`: a parent whose own push keeps failing. */
const blocked = { on: true };
function blockCreate(inner: typeof fetch, name: string, field: 'title' | 'name'): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (blocked.on && init?.method === 'POST' && String(init.body ?? '').includes(`"${field}":"${name}"`)) {
      return new Response(JSON.stringify({ message: 'rejected (test)' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return inner(input, init);
  }) as typeof fetch;
}
const stuckOf = (slug: string) =>
  (JSON.parse(readFileSync(join(stateDir, '.tasks-sync.json'), 'utf-8')).tasks[slug] ?? {}).parent_link_stuck;

beforeEach(() => {
  blocked.on = true;
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-subsync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  clock = 1000;
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('GitHub sub-issues', () => {
  let fake: FakeGitHub;
  let gh: GitHubTaskBackend;
  beforeEach(() => {
    fake = makeFakeGitHub();
    const a = adapter('https://api.github.com', fake.fetchImpl);
    gh = new GitHubTaskBackend(contextRoot, GH, a);
  });

  it('push links the child under its parent (parent first), once; a local detach unlinks it', async () => {
    card('zz-epic');
    card('aa-step', { parent_task: 'zz-epic' });
    const r = await gh.sync('push');
    expect(r.errors).toEqual([]);
    const map = mapOf();
    expect(fake.parentOf.get(Number(map['aa-step']))).toBe(Number(map['zz-epic']));
    const linkCalls = () => fake.requests.filter((q) => /\/sub_issues?$/.test(q.path) && q.method !== 'GET').length;
    expect(linkCalls()).toBe(1);
    await gh.sync('push');
    expect(linkCalls()).toBe(1);
    await gh.updateFields('aa-step', { parent_task: null });
    await gh.sync('push');
    expect(fake.parentOf.has(Number(map['aa-step']))).toBe(false);
    expect(fake.requests.some((q) => q.method === 'DELETE' && q.path.endsWith('/sub_issue'))).toBe(true);
  });

  it('pull applies a remote link; a remote that drops the link never clears the local one', async () => {
    card('epic');
    card('step');
    await gh.sync('push');
    const map = mapOf();
    fake.parentOf.set(Number(map.step), Number(map.epic));
    fake.editIssue(Number(map.epic), {});
    await gh.sync('pull');
    expect(parentOf('step')).toBe('epic');
    fake.parentOf.delete(Number(map.step));
    fake.editIssue(Number(map.epic), {});
    fake.editIssue(Number(map.step), {});
    await gh.sync('pull');
    expect(parentOf('step')).toBe('epic');
  });

  it('a grandchild on the remote flattens onto its top-level ancestor, with a warning', async () => {
    card('top');
    card('mid', { parent_task: 'top' });
    card('leaf');
    await gh.sync('push');
    const map = mapOf();
    fake.parentOf.set(Number(map.leaf), Number(map.mid));
    fake.editIssue(Number(map.mid), {});
    const r = await gh.sync('pull');
    expect(parentOf('leaf')).toBe('top');
    expect(r.warnings.some((w) => /flattened onto top/.test(w))).toBe(true);
  });

  it('a remote close of a parent with open children keeps it open, journals it, and the next push reopens', async () => {
    card('epic', { status: 'in_progress' });
    card('step', { parent_task: 'epic', status: 'in_progress' });
    await gh.sync('push');
    const map = mapOf();
    fake.editIssue(Number(map.epic), { state: 'closed', state_reason: 'completed' });
    const r = await gh.sync('pull');
    expect(statusOf('epic')).toBe('in_progress');
    expect(r.warnings.some((w) => /closed on GitHub while 1 sub-task/.test(w))).toBe(true);
    expect(readJournal(stateDir, 'epic').some((e) => e.label === 'held open')).toBe(true);
    await gh.sync('push');
    expect(fake.issues.get(Number(map.epic))!.state).toBe('open');
  });

  it('children closed on GitHub roll their parent up on the pull', async () => {
    card('epic');
    card('step', { parent_task: 'epic' });
    await gh.sync('push');
    expect(statusOf('epic')).toBe('todo');
    const map = mapOf();
    fake.editIssue(Number(map.step), { state: 'closed', state_reason: 'completed' });
    await gh.sync('pull');
    expect(statusOf('step')).toBe('completed');
    // Every live child is done: the parent moves on (never to done by itself) instead of staying todo.
    expect(statusOf('epic')).toMatch(/^(in_progress|in_review)$/);
  });

  it('a local detach survives the default sync (pull runs first) and reaches GitHub', async () => {
    card('zz-epic');
    card('aa-step', { parent_task: 'zz-epic' });
    await gh.sync('both');
    const map = mapOf();
    await gh.updateFields('aa-step', { parent_task: null });
    await gh.sync('both');
    expect(parentOf('aa-step')).toBeFalsy();
    expect(fake.parentOf.has(Number(map['aa-step']))).toBe(false);
    await gh.sync('both');
    expect(parentOf('aa-step')).toBeFalsy();
  });

  it('a parent that is not on GitHub yet never counts toward giving up its child link', async () => {
    card('aa-step');
    await gh.sync('push');
    card('zz-epic');
    await gh.updateFields('aa-step', { parent_task: 'zz-epic' });
    const g2 = new GitHubTaskBackend(contextRoot, GH, adapter('https://api.github.com', blockCreate(fake.fetchImpl, 'zz-epic', 'title')));
    for (let i = 0; i < 4; i++) {
      await g2.sync('push');
      expect(stuckOf('aa-step')).toBeUndefined();
    }
    blocked.on = false;
    await g2.sync('push');
    await g2.sync('push');
    const map = mapOf();
    expect(fake.parentOf.get(Number(map['aa-step']))).toBe(Number(map['zz-epic']));
  });

  it('a sub-issue link GitHub keeps refusing is retried a bounded number of times', async () => {
    card('zz-epic');
    card('aa-step', { parent_task: 'zz-epic' });
    fake.subIssueFail.status = 500;
    const posts = () => fake.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/sub_issues')).length;
    const before = posts();
    let warned = 0;
    for (let i = 0; i < 6; i++) {
      const r = await gh.sync('push');
      warned += r.warnings.filter((w) => /no more retries/.test(w)).length;
    }
    expect(posts() - before).toBeLessThanOrEqual(3 * 4); // the adapter retries a 5xx inside one call
    const afterGiveUp = posts();
    await gh.sync('push');
    expect(posts()).toBe(afterGiveUp);
    expect(warned).toBe(1);
    // A 422 gives up at once; changing the parent tries again.
    card('yy-other');
    fake.subIssueFail.status = 422;
    await gh.updateFields('aa-step', { parent_task: 'yy-other' });
    await gh.sync('push');
    const at422 = posts();
    await gh.sync('push');
    expect(posts()).toBe(at422);
    fake.subIssueFail.status = null;
    await gh.updateFields('aa-step', { parent_task: 'zz-epic' });
    await gh.sync('push');
    expect(fake.parentOf.get(Number(mapOf()['aa-step']))).toBe(Number(mapOf()['zz-epic']));
  });
});

describe('ClickUp subtasks', () => {
  let fake: FakeClickUp;
  let cu: ClickUpTaskBackend;
  beforeEach(() => {
    fake = makeFakeClickUp();
    const a = adapter('https://api.clickup.com/api/v2', fake.fetchImpl);
    cu = new ClickUpTaskBackend(contextRoot, CU, a);
  });

  it('push creates the child as a subtask of its parent; the full sweep keeps it (subtasks listed)', async () => {
    card('zz-epic');
    card('aa-step', { parent_task: 'zz-epic' });
    const r = await cu.sync('push');
    expect(r.errors).toEqual([]);
    const map = mapOf();
    expect(fake.tasks.get(map['aa-step'])!.parent).toBe(map['zz-epic']);
    // A full re-read (watermark reset) must not read the subtask as deleted remotely.
    const syncPath = join(stateDir, '.tasks-sync.json');
    const st = JSON.parse(readFileSync(syncPath, 'utf-8'));
    st.watermark = null;
    writeFileSync(syncPath, JSON.stringify(st));
    await cu.sync('pull');
    expect(existsSync(join(stateDir, 'aa-step.md'))).toBe(true);
    expect(parentOf('aa-step')).toBe('zz-epic');
  });

  it('pull applies a subtask link made on ClickUp; a later local move wins until pushed', async () => {
    card('epic');
    card('other');
    card('step');
    await cu.sync('push');
    const map = mapOf();
    fake.tasks.get(map.step)!.parent = map.epic;
    fake.advanceServer(1000);
    fake.tasks.get(map.step)!.date_updated = String(fake.serverNow());
    await cu.sync('pull');
    expect(parentOf('step')).toBe('epic');
    await cu.updateFields('step', { parent_task: 'other' });
    fake.advanceServer(1000);
    fake.tasks.get(map.step)!.date_updated = String(fake.serverNow());
    await cu.sync('pull');
    expect(parentOf('step')).toBe('other');
    await cu.sync('push');
    expect(fake.tasks.get(map.step)!.parent).toBe(map.other);
  });

  it('a local detach is not undone by the default sync either (pull runs first)', async () => {
    card('zz-epic');
    card('aa-step', { parent_task: 'zz-epic' });
    await cu.sync('both');
    await cu.updateFields('aa-step', { parent_task: null });
    await cu.sync('both');
    expect(parentOf('aa-step')).toBeFalsy();
    await cu.sync('both');
    expect(parentOf('aa-step')).toBeFalsy();
  });

  it('a child waiting for its parent to reach ClickUp links once the parent is pushed', async () => {
    card('aa-step');
    await cu.sync('push');
    card('zz-epic');
    await cu.updateFields('aa-step', { parent_task: 'zz-epic' });
    const c2 = new ClickUpTaskBackend(contextRoot, CU, adapter('https://api.clickup.com/api/v2', blockCreate(fake.fetchImpl, 'zz-epic', 'name')));
    await c2.sync('push'); // the child's own edit goes up once
    const childPuts = () => fake.requests.filter((q) => q.method === 'PUT' && q.path === `/task/${mapOf()['aa-step']}`).length;
    const putsBefore = childPuts();
    for (let i = 0; i < 4; i++) {
      await c2.sync('push');
      expect(stuckOf('aa-step')).toBeUndefined();
    }
    // While the parent cannot reach ClickUp, no sync spends a call on the waiting child.
    expect(childPuts()).toBe(putsBefore);
    blocked.on = false;
    await c2.sync('push');
    await c2.sync('push');
    const map = mapOf();
    expect(fake.tasks.get(map['aa-step'])!.parent).toBe(map['zz-epic']);
  });

  it('a local detach ClickUp cannot make is not undone by the next pull, nor retried', async () => {
    card('zz-epic');
    card('aa-step', { parent_task: 'zz-epic' });
    await cu.sync('push');
    const map = mapOf();
    await cu.updateFields('aa-step', { parent_task: null });
    const r = await cu.sync('push');
    expect(r.warnings.filter((w) => /no more retries/.test(w))).toHaveLength(1);
    expect(fake.tasks.get(map['aa-step'])!.parent).toBe(map['zz-epic']);
    fake.advanceServer(1000);
    fake.tasks.get(map['aa-step'])!.date_updated = String(fake.serverNow());
    await cu.sync('pull');
    expect(parentOf('aa-step')).toBeFalsy();
    const puts = () => fake.requests.filter((q) => q.method === 'PUT').length;
    const before = puts();
    const r2 = await cu.sync('push');
    expect(puts()).toBe(before);
    expect(r2.warnings.filter((w) => /aa-step/.test(w))).toEqual([]);
  });
});
