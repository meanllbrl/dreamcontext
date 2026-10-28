import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

/**
 * A dreamcontext sub-task (`parent_task`) syncs as a real GitHub SUB-ISSUE of
 * its parent's issue — never as a second top-level issue. The task-list
 * reference in the parent body is only the fallback for a GitHub without the
 * sub-issues API. Mocked HTTP only.
 */

const CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.0.0',
  disableNativeMemory: true,
  taskBackend: 'github',
  cloudTaskManagement: true,
  github: { owner: 'example-org', repo: 'example-repo', changelogTarget: 'comments' },
};

const ISSUES = '/repos/example-org/example-repo/issues';

let projectRoot: string;
let contextRoot: string;
let fake: FakeGitHub;
let backend: GitHubTaskBackend;
let localClock: number;
let refuse: ((method: string, body: Record<string, unknown> | undefined) => boolean) | null;

function makeBackend(): GitHubTaskBackend {
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (refuse?.((init?.method ?? 'GET').toUpperCase(), body)) {
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => '{"message":"refused"}' } as unknown as Response;
    }
    return fake.fetchImpl(url, init);
  }) as typeof fetch;
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
    fetchImpl,
    now,
    sleep,
  });
  return new GitHubTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-ghsub-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  refuse = null;
  fake = makeFakeGitHub();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function numberOf(slug: string): number {
  const map = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8')) as Array<{ slug: string; remoteId: string }>;
  return Number(map.find((e) => e.slug === slug)!.remoteId);
}

function mirror(slug: string): matter.GrayMatterFile<string> {
  return matter(readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8'));
}

async function makeParentAndChild(): Promise<void> {
  await backend.create({ name: 'Parent Job', variant: 'cli' });
  await backend.create({ name: 'Child Step', variant: 'cli', local_fields: { parent_task: 'parent-job' } });
}

describe('github sub-tasks', () => {
  it('push create: a sub-task becomes a sub-issue of its parent issue, parent created first', async () => {
    await makeParentAndChild();
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(2);

    const creates = fake.requests.filter((r) => r.method === 'POST' && r.path === ISSUES);
    expect(creates.map((c) => (c.body as { title: string }).title)).toEqual(['Parent Job', 'Child Step']);
    const parent = numberOf('parent-job');
    const child = numberOf('child-step');
    const link = fake.requests.find((r) => r.method === 'POST' && r.path === `${ISSUES}/${parent}/sub_issues`);
    expect(link?.body).toEqual({ sub_issue_id: fake.issues.get(child)!.id });
    expect(fake.parentOf.get(child)).toBe(parent);
    expect(fake.parentOf.has(parent)).toBe(false);
    // The real API was used, so the parent body carries no fallback list.
    expect(fake.issues.get(parent)!.body).not.toContain('dc:subtasks');
  });

  it('push update: an edited sub-issue is patched in place, with no second link call', async () => {
    await makeParentAndChild();
    await backend.sync('push');
    fake.requests.length = 0;

    await backend.updateFields('child-step', { status: 'in_progress', updated_at: '2026-10-28' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.pushed).toBe(1);
    const writes = fake.requests.filter((r) => r.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(fake.parentOf.get(numberOf('child-step'))).toBe(numberOf('parent-job'));
  });

  it('pull: a sub-issue added in GitHub under a synced issue lands as a sub-task of that task', async () => {
    await backend.create({ name: 'Parent Job', variant: 'cli' });
    await backend.sync('push');
    await backend.sync('pull'); // settle the watermark past our own push
    const parent = numberOf('parent-job');

    const made = fake.seedIssue({ title: 'Made On GitHub' });
    fake.linkSubIssue(parent, made.number);

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(mirror('made-on-github').data.parent_task).toBe('parent-job');
  });

  it('parent not yet synced: the sub-task waits instead of landing top-level, then links under it', async () => {
    await makeParentAndChild();
    refuse = (method, body) => method === 'POST' && body?.title === 'Parent Job';

    const first = await backend.sync('push');
    expect(first.failedPushes).toContain('parent-job');
    expect(fake.issues.size).toBe(0); // the child was NOT created as a separate issue
    expect(first.warnings.some((w) => w.includes('child-step') && w.includes('waits for its parent'))).toBe(true);

    refuse = null;
    const second = await backend.sync('push');
    expect(second.errors).toEqual([]);
    expect(second.created).toBe(2);
    expect(fake.parentOf.get(numberOf('child-step'))).toBe(numberOf('parent-job'));
  });

  it('re-link: a sub-task pushed earlier as a separate issue becomes a sub-issue, never closed or re-created', async () => {
    await makeParentAndChild();
    await backend.sync('push');
    const parent = numberOf('parent-job');
    const child = numberOf('child-step');

    // The pre-0.36 shape: a separate issue, and no remote parent in the ledger.
    fake.parentOf.delete(child);
    const syncPath = join(contextRoot, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
    delete state.tasks['child-step'].remote_parent;
    writeFileSync(syncPath, JSON.stringify(state, null, 2));
    fake.requests.length = 0;

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(0);
    expect(fake.issues.get(child)!.state).toBe('open');
    expect(fake.parentOf.get(child)).toBe(parent);
    expect(report.warnings.some((w) => w.startsWith('relinked: child-step'))).toBe(true);

    fake.requests.length = 0;
    const again = await backend.sync('push');
    expect(again.pushed).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('a refused link is reported once and not re-sent on every sync', async () => {
    await makeParentAndChild();
    refuse = (method, body) => method === 'POST' && body?.sub_issue_id !== undefined;
    const first = await backend.sync('push');
    expect(first.warnings.some((w) => w.includes('child-step') && w.includes('not retried until its parent changes'))).toBe(true);
    expect(fake.parentOf.size).toBe(0);

    fake.requests.length = 0;
    const second = await backend.sync('push');
    expect(second.pushed).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('unlink: clearing the local parent takes the sub-issue out; one already gone counts as done', async () => {
    await makeParentAndChild();
    await backend.sync('push');
    const child = numberOf('child-step');

    await backend.updateFields('child-step', { parent_task: null, updated_at: '2026-10-28' });
    await backend.sync('push');
    expect(fake.parentOf.has(child)).toBe(false);

    // Linked again, then removed on GitHub behind our back before a local clear.
    await backend.updateFields('child-step', { parent_task: 'parent-job', updated_at: '2026-10-28' });
    await backend.sync('push');
    expect(fake.parentOf.get(child)).toBe(numberOf('parent-job'));
    fake.parentOf.delete(child);
    await backend.updateFields('child-step', { parent_task: null, updated_at: '2026-10-28' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    fake.requests.length = 0;
    const again = await backend.sync('push');
    expect(again.pushed).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('fallback unlink: the old parent body drops the sub-task, with no request loop', async () => {
    fake.subIssuesUnavailable = true;
    await makeParentAndChild();
    await backend.sync('push');
    const parent = numberOf('parent-job');
    expect(fake.issues.get(parent)!.body).toContain(`#${numberOf('child-step')}`);

    await backend.updateFields('child-step', { parent_task: null, updated_at: '2026-10-28' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(fake.issues.get(parent)!.body).not.toContain('dc:subtasks');
    fake.requests.length = 0;
    const again = await backend.sync('push');
    expect(again.pushed).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('unlink after the fallback window: the old task list is rewritten, so a pull cannot bring the link back', async () => {
    fake.subIssuesUnavailable = true;
    await makeParentAndChild();
    await backend.sync('push');
    const parent = numberOf('parent-job');
    const child = numberOf('child-step');

    // The fallback window is over (the server still has no sub-issues API).
    const syncPath = join(contextRoot, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
    state.subIssuesUnavailableAt = -10 * 24 * 60 * 60 * 1000;
    writeFileSync(syncPath, JSON.stringify(state, null, 2));

    await backend.updateFields('child-step', { parent_task: null, updated_at: '2026-10-28' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(fake.issues.get(parent)!.body).not.toContain('dc:subtasks');

    fake.editIssue(parent, { title: 'Parent Job' });
    fake.editIssue(child, { title: 'Child Step' });
    await backend.sync('pull');
    expect(mirror('child-step').data.parent_task ?? null).toBeNull();
  });

  it('a parent in ANOTHER repo is never read as this repo\'s issue with the same number', async () => {
    await backend.create({ name: 'Unrelated', variant: 'cli' });
    await backend.sync('push');
    await backend.sync('pull');
    expect(numberOf('unrelated')).toBe(1);

    const made = fake.seedIssue({ title: 'Cross Repo Child' });
    fake.editIssue(made.number, {
      parent_issue_url: 'https://api.github.com/repos/example-org/other-repo/issues/1',
    } as never);
    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(mirror('cross-repo-child').data.parent_task ?? null).toBeNull();
  });

  it('a link made through the fallback list survives a pull that sees "no parent" on the child', async () => {
    fake.subIssuesUnavailable = true;
    await makeParentAndChild();
    await backend.sync('push');
    await backend.sync('pull');

    // The child alone changes remotely; GitHub's own field says no parent.
    fake.editIssue(numberOf('child-step'), { title: 'Child Step', parent_issue_url: null } as never);
    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(mirror('child-step').data.parent_task).toBe('parent-job');
  });

  it('a local unlink is still pushed when the same issue changed on GitHub first', async () => {
    await makeParentAndChild();
    await backend.sync('push');
    await backend.sync('pull');
    const child = numberOf('child-step');

    await backend.updateFields('child-step', { parent_task: null, updated_at: '2026-10-28' });
    fake.editIssue(child, { title: 'Child Step' });
    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);
    expect(mirror('child-step').data.parent_task ?? null).toBeNull();
    expect(fake.parentOf.has(child)).toBe(false);
  });

  it('a fallback link stays in the parent body after the window, through a later parent edit', async () => {
    fake.subIssuesUnavailable = true;
    await makeParentAndChild();
    await backend.sync('push');
    const syncPath = join(contextRoot, 'state', '.tasks-sync.json');
    const state = JSON.parse(readFileSync(syncPath, 'utf-8'));
    state.subIssuesUnavailableAt = -10 * 24 * 60 * 60 * 1000;
    writeFileSync(syncPath, JSON.stringify(state, null, 2));

    await backend.updateFields('parent-job', { status: 'in_progress', updated_at: '2026-10-28' });
    await backend.sync('push');
    expect(fake.issues.get(numberOf('parent-job'))!.body).toContain(`#${numberOf('child-step')}`);
  });

  it('an unlink from a parent in another repo is not re-pushed every sync', async () => {
    await makeParentAndChild();
    await backend.sync('push');
    const child = numberOf('child-step');
    // Moved on GitHub under an issue of another repo; the ledger still names #1.
    fake.parentOf.delete(child);
    fake.editIssue(child, { parent_issue_url: 'https://api.github.com/repos/example-org/other-repo/issues/1' } as never);

    await backend.updateFields('child-step', { parent_task: null, updated_at: '2026-10-28' });
    const first = await backend.sync('push');
    expect(first.errors).toEqual([]);
    fake.requests.length = 0;
    await backend.sync('push');
    await backend.sync('push');
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('a three-level tree on GitHub is mirrored two levels deep and never unlinked by the push', async () => {
    const a = fake.seedIssue({ title: 'Epic A' });
    const b = fake.seedIssue({ title: 'Feature B' });
    const c = fake.seedIssue({ title: 'Task C' });
    fake.linkSubIssue(a.number, b.number);
    fake.linkSubIssue(b.number, c.number);

    const pulled = await backend.sync('pull');
    expect(pulled.errors).toEqual([]);
    expect(mirror('feature-b').data.parent_task).toBe('epic-a');
    expect(mirror('task-c').data.parent_task ?? null).toBeNull();

    fake.requests.length = 0;
    const pushed = await backend.sync('push');
    expect(pushed.errors).toEqual([]);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(fake.parentOf.get(c.number)).toBe(b.number);
    expect(fake.parentOf.get(b.number)).toBe(a.number);

    // Even a local edit of that task leaves the teammate's link alone.
    await backend.updateFields('task-c', { status: 'in_progress', updated_at: '2026-10-28' });
    await backend.sync('push');
    expect(fake.parentOf.get(c.number)).toBe(b.number);
  });

  it('a refused parent the user later accepts can still be unlinked', async () => {
    const a = fake.seedIssue({ title: 'Epic A' });
    const b = fake.seedIssue({ title: 'Feature B' });
    const c = fake.seedIssue({ title: 'Task C' });
    fake.linkSubIssue(a.number, b.number);
    fake.linkSubIssue(b.number, c.number);
    await backend.sync('pull');
    expect(mirror('task-c').data.parent_task ?? null).toBeNull();

    // Flatten as the warning suggests: B leaves A, C goes under B.
    await backend.updateFields('feature-b', { parent_task: null, updated_at: '2026-10-28' });
    await backend.updateFields('task-c', { parent_task: 'feature-b', updated_at: '2026-10-28' });
    await backend.sync('push');
    expect(fake.parentOf.get(c.number)).toBe(b.number);

    await backend.updateFields('task-c', { parent_task: null, updated_at: '2026-10-28' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(fake.parentOf.has(c.number)).toBe(false);
  });

  it('push-only: a sub-issue link a teammate made on GitHub is never removed, and the next pull adopts it', async () => {
    await backend.create({ name: 'Parent Job', variant: 'cli' });
    await backend.create({ name: 'Loose Task', variant: 'cli' });
    await backend.sync('push');
    const parent = numberOf('parent-job');
    const loose = numberOf('loose-task');

    fake.linkSubIssue(parent, loose);
    fake.editIssue(loose, { parent_issue_url: `https://api.github.com/repos/example-org/example-repo/issues/${parent}` } as never);
    await backend.updateFields('loose-task', { status: 'in_progress', updated_at: '2026-10-28' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(fake.parentOf.get(loose)).toBe(parent);

    fake.editIssue(loose, { title: 'Loose Task' });
    await backend.sync('pull');
    expect(mirror('loose-task').data.parent_task).toBe('parent-job');
  });

  it('a refused link does not hold back a later return to the same parent', async () => {
    await makeParentAndChild();
    refuse = (method, body) => method === 'POST' && body?.sub_issue_id !== undefined;
    await backend.sync('push');
    const parent = numberOf('parent-job');
    const child = numberOf('child-step');
    expect(fake.parentOf.has(child)).toBe(false);
    refuse = null;

    await backend.updateFields('child-step', { parent_task: null, updated_at: '2026-10-28' });
    await backend.sync('both');
    await backend.updateFields('child-step', { parent_task: 'parent-job', updated_at: '2026-10-28' });
    fake.editIssue(child, { title: 'Child Step' });
    await backend.sync('both');
    await backend.sync('both');
    expect(mirror('child-step').data.parent_task).toBe('parent-job');
    expect(fake.parentOf.get(child)).toBe(parent);
  });

  it('a declined parent the user later links and then unlinks is really unlinked', async () => {
    const a = fake.seedIssue({ title: 'Epic A' });
    const b = fake.seedIssue({ title: 'Feature B' });
    const c = fake.seedIssue({ title: 'Task C' });
    fake.linkSubIssue(a.number, b.number);
    fake.linkSubIssue(b.number, c.number);
    await backend.sync('pull'); // C under B is declined (three levels)

    // A teammate takes C out of B on GitHub.
    fake.parentOf.delete(c.number);
    fake.editIssue(c.number, { parent_issue_url: null } as never);
    await backend.sync('pull');

    // Locally: flatten, link C under B, then unlink it.
    await backend.updateFields('feature-b', { parent_task: null, updated_at: '2026-10-28' });
    await backend.updateFields('task-c', { parent_task: 'feature-b', updated_at: '2026-10-28' });
    await backend.sync('push');
    expect(fake.parentOf.get(c.number)).toBe(b.number);
    await backend.updateFields('task-c', { parent_task: null, updated_at: '2026-10-28' });
    await backend.sync('push');
    await backend.sync('both');
    expect(fake.parentOf.has(c.number)).toBe(false);
  });

  it('a local unlink racing a teammate\'s move never removes the link the teammate made', async () => {
    await backend.create({ name: 'Parent One', variant: 'cli' });
    await backend.create({ name: 'Parent Two', variant: 'cli' });
    await backend.create({ name: 'Kid', variant: 'cli', local_fields: { parent_task: 'parent-one' } });
    await backend.sync('push');
    await backend.sync('pull');
    const kid = numberOf('kid');
    const two = numberOf('parent-two');

    fake.linkSubIssue(two, kid); // teammate moves it under Parent Two
    fake.editIssue(kid, { parent_issue_url: `https://api.github.com/repos/example-org/example-repo/issues/${two}` } as never);
    await backend.updateFields('kid', { parent_task: null, updated_at: '2026-10-28' });
    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);
    expect(fake.parentOf.get(kid)).toBe(two);
  });

  it('a local re-parent survives several pulls before its push, then lands', async () => {
    await backend.create({ name: 'Parent One', variant: 'cli' });
    await backend.create({ name: 'Parent Two', variant: 'cli' });
    await backend.create({ name: 'Kid', variant: 'cli', local_fields: { parent_task: 'parent-one' } });
    await backend.sync('push');
    await backend.sync('pull');
    const kid = numberOf('kid');
    const one = numberOf('parent-one');
    const two = numberOf('parent-two');
    fake.editIssue(kid, { parent_issue_url: `https://api.github.com/repos/example-org/example-repo/issues/${one}` } as never);
    await backend.sync('pull');

    await backend.updateFields('kid', { parent_task: 'parent-two', updated_at: '2026-10-28' });
    // A teammate takes it out of One and keeps editing it; two pulls run before any push.
    fake.parentOf.delete(kid);
    fake.editIssue(kid, { title: 'Kid', parent_issue_url: null } as never);
    await backend.sync('pull');
    expect(mirror('kid').data.parent_task).toBe('parent-two');
    fake.editIssue(kid, { title: 'Kid' });
    await backend.sync('pull');
    expect(mirror('kid').data.parent_task).toBe('parent-two');

    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);
    expect(fake.parentOf.get(kid)).toBe(two);
    expect(mirror('kid').data.parent_task).toBe('parent-two');
  });

  it('fallback: a teammate who pulled the task list keeps it in the parent body when editing the parent', async () => {
    fake.subIssuesUnavailable = true;
    await makeParentAndChild();
    await backend.sync('push');
    const parent = numberOf('parent-job');
    const child = numberOf('child-step');

    const otherRoot = join(projectRoot, 'teammate', '_dream_context');
    mkdirSync(join(otherRoot, 'state'), { recursive: true });
    const now = () => (localClock += 7);
    const sleep = async () => { localClock += 1; };
    const other = new GitHubTaskBackend(otherRoot, CONFIG, {
      adapter: new ApiAdapter({ baseUrl: 'https://api.github.com', authHeaders: () => ({}), fetchImpl: fake.fetchImpl, now, sleep }),
      now,
      sleep,
    });
    await other.sync('pull');
    expect(matter(readFileSync(join(otherRoot, 'state', 'child-step.md'), 'utf-8')).data.parent_task).toBe('parent-job');

    await other.updateFields('parent-job', { status: 'in_progress', updated_at: '2026-10-28' });
    const report = await other.sync('push');
    expect(report.errors).toEqual([]);
    expect(fake.issues.get(parent)!.body).toContain(`#${child}`);
  });

  it('fallback: without the sub-issues API the parent body lists the sub-task, and the pull reads it back', async () => {
    fake.subIssuesUnavailable = true;
    await makeParentAndChild();
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.warnings.some((w) => w.includes('sub-issues API is not available'))).toBe(true);

    const parent = numberOf('parent-job');
    const child = numberOf('child-step');
    const body = fake.issues.get(parent)!.body;
    expect(body).toContain('<!-- dc:subtasks -->');
    expect(body).toContain(`- [ ] #${child}`);

    // A teammate's machine pulls both: the child is a sub-task, and the list
    // never leaks into the parent's local body.
    const otherRoot = join(projectRoot, 'other', '_dream_context');
    mkdirSync(join(otherRoot, 'state'), { recursive: true });
    const now = () => (localClock += 7);
    const sleep = async () => { localClock += 1; };
    const other = new GitHubTaskBackend(otherRoot, CONFIG, {
      adapter: new ApiAdapter({ baseUrl: 'https://api.github.com', authHeaders: () => ({}), fetchImpl: fake.fetchImpl, now, sleep }),
      now,
      sleep,
    });
    const pulled = await other.sync('pull');
    expect(pulled.errors).toEqual([]);
    const childMirror = matter(readFileSync(join(otherRoot, 'state', 'child-step.md'), 'utf-8'));
    const parentMirror = matter(readFileSync(join(otherRoot, 'state', 'parent-job.md'), 'utf-8'));
    expect(childMirror.data.parent_task).toBe('parent-job');
    expect(parentMirror.content).not.toContain('dc:subtasks');
  });
});
