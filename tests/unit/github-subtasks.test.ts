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
