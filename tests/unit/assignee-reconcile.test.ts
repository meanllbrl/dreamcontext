import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { planAssigneeHeal } from '../../src/lib/task-backend/merge.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

/**
 * Issue #78 — assignee reconcile (`tasks sync --reconcile`).
 *
 * The forward assignee pull-back already works (covered in clickup-pull.test
 * and github-pull.test). What these tests pin is the REMAINING gap: assignee
 * drift that sits BELOW the sync watermark is never re-examined by a normal
 * delta pull, so it never self-heals — and `--reconcile` heals it in one pass,
 * idempotently, without clobbering a pending local change.
 */

// ── pure decision ───────────────────────────────────────────────────────────

describe('planAssigneeHeal (pure)', () => {
  it('local == remote → in_sync (nothing to do)', () => {
    expect(planAssigneeHeal(['a'], [], ['a'], false)).toBe('in_sync');
    expect(planAssigneeHeal(['a', 'b'], ['a'], ['b', 'a'], false)).toBe('in_sync'); // order-insensitive
  });
  it('remote moved, local == base → heal', () => {
    expect(planAssigneeHeal([], [], ['a'], false)).toBe('heal');
    expect(planAssigneeHeal(['a'], ['a'], ['a', 'b'], false)).toBe('heal');
  });
  it('a local push is pending → pending (let normal sync push first)', () => {
    expect(planAssigneeHeal(['b'], [], ['a'], true)).toBe('pending');
  });
  it('local diverged from base (two-sided change) → local_diverged (not auto-healed)', () => {
    expect(planAssigneeHeal(['b'], [], ['a'], false)).toBe('local_diverged');
  });
  it('no base recorded but remote differs → heal (best effort)', () => {
    expect(planAssigneeHeal([], null, ['a'], false)).toBe('heal');
  });
});

// ── ClickUp ─────────────────────────────────────────────────────────────────

describe('ClickUp assignee reconcile (#78)', () => {
  const CONFIG: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0',
    disableNativeMemory: true, taskBackend: 'clickup', cloudTaskManagement: true,
    clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' },
    people: ['Alice'], peopleIdentity: { alice: { clickupMemberId: '501' } },
  };
  let projectRoot: string, contextRoot: string, fake: FakeClickUp, backend: ClickUpTaskBackend, clock: number;

  function makeBackend(): ClickUpTaskBackend {
    clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    const adapter = new ApiAdapter({ baseUrl: 'https://api.clickup.com/api/v2', authHeaders: () => ({ Authorization: 'pk_test' }), fetchImpl: fake.fetchImpl, now, sleep });
    return new ClickUpTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
  }
  const mirror = (slug: string) => readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
  const remoteIdOf = (slug: string) => JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8')).find((e: any) => e.slug === slug).remoteId;
  function jamWatermarkAhead(): void {
    const p = join(contextRoot, 'state', '.tasks-sync.json');
    const st = JSON.parse(readFileSync(p, 'utf-8'));
    st.watermark = 2_000_000_000_000; // ahead of the fake clock (~2030), still a valid Date for GitHub `since`
    writeFileSync(p, JSON.stringify(st, null, 2));
  }

  beforeEach(() => {
    delete process.env.DREAMCONTEXT_PERSON;
    const raw = join(tmpdir(), `dc-arec-cu-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    fake = makeFakeClickUp();
    backend = makeBackend();
  });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it('a normal pull MISSES below-watermark drift; --reconcile heals it, idempotently', async () => {
    await backend.create({ name: 'Drift Task', variant: 'cli' });
    await backend.sync('both');
    // Assigned in the ClickUp UI, then the watermark moves past it.
    fake.editTask(remoteIdOf('drift-task'), { assignees: [{ id: 501 }] });
    jamWatermarkAhead();

    // Normal pull can't see it (the gap).
    const plain = await backend.sync('pull');
    expect(plain.errors).toEqual([]);
    expect(plain.reconciled).toBe(0);
    expect(mirror('drift-task')).not.toContain('person:alice');

    // --reconcile heals it.
    const healed = await backend.sync('pull', { reconcile: true });
    expect(healed.errors).toEqual([]);
    expect(healed.reconciled).toBe(1);
    expect(mirror('drift-task')).toContain('person:alice');

    // Idempotent: a second reconcile finds nothing.
    const again = await backend.sync('pull', { reconcile: true });
    expect(again.errors).toEqual([]);
    expect(again.reconciled).toBe(0);
    expect(mirror('drift-task')).toContain('person:alice');
  });

  it('detectAssigneeDrift surfaces the drift read-only (drives `tasks doctor --remote`)', async () => {
    await backend.create({ name: 'Doctor Task', variant: 'cli' });
    await backend.sync('both');
    fake.editTask(remoteIdOf('doctor-task'), { assignees: [{ id: 501 }] });

    const drift = await backend.detectAssigneeDrift();
    expect(drift).toEqual([{ slug: 'doctor-task', local: [], remote: ['alice'] }]);
    // Read-only: the mirror is untouched.
    expect(mirror('doctor-task')).not.toContain('person:alice');
  });

  it('does NOT clobber a pending local assignment (skips pendingPush)', async () => {
    await backend.create({ name: 'Pending Task', variant: 'cli' });
    await backend.sync('both');
    // Local assigns bob (pending push); remote assigns alice.
    await backend.updateFields('pending-task', { tags: ['person:bob'] });
    fake.editTask(remoteIdOf('pending-task'), { assignees: [{ id: 501 }] });
    jamWatermarkAhead();

    const report = await backend.sync('pull', { reconcile: true });
    expect(report.reconciled).toBe(0);
    expect(mirror('pending-task')).toContain('person:bob'); // local change preserved
    expect(mirror('pending-task')).not.toContain('person:alice');
  });
});

// ── GitHub ──────────────────────────────────────────────────────────────────

describe('GitHub assignee reconcile (#78)', () => {
  const CONFIG: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0',
    disableNativeMemory: true, taskBackend: 'github', cloudTaskManagement: true,
    github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' },
  };
  let projectRoot: string, contextRoot: string, fake: FakeGitHub, backend: GitHubTaskBackend, clock: number;

  function makeBackend(): GitHubTaskBackend {
    clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    const adapter = new ApiAdapter({ baseUrl: 'https://api.github.com', authHeaders: () => ({ Authorization: 'Bearer ghp_test' }), fetchImpl: fake.fetchImpl, now, sleep });
    return new GitHubTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
  }
  const mirror = (slug: string) => readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
  const remoteIdOf = (slug: string) => JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8')).find((e: any) => e.slug === slug).remoteId;
  function jamWatermarkAhead(): void {
    const p = join(contextRoot, 'state', '.tasks-sync.json');
    const st = JSON.parse(readFileSync(p, 'utf-8'));
    st.watermark = 2_000_000_000_000; // ahead of the fake clock (~2030), still a valid Date for GitHub `since`
    writeFileSync(p, JSON.stringify(st, null, 2));
  }

  beforeEach(() => {
    delete process.env.DREAMCONTEXT_PERSON;
    const raw = join(tmpdir(), `dc-arec-gh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    fake = makeFakeGitHub();
    backend = makeBackend();
  });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it('a normal pull MISSES below-watermark drift; --reconcile heals it, idempotently', async () => {
    await backend.create({ name: 'Drift Task', variant: 'cli' });
    await backend.sync('both');
    // Assigned via the GitHub UI, then the watermark moves past it.
    fake.editIssue(Number(remoteIdOf('drift-task')), { assignees: [{ login: 'alice' }] });
    jamWatermarkAhead();

    const plain = await backend.sync('pull');
    expect(plain.errors).toEqual([]);
    expect(plain.reconciled).toBe(0);
    expect(mirror('drift-task')).not.toContain('person:alice');

    const healed = await backend.sync('pull', { reconcile: true });
    expect(healed.errors).toEqual([]);
    expect(healed.reconciled).toBe(1);
    expect(mirror('drift-task')).toContain('person:alice');

    const again = await backend.sync('pull', { reconcile: true });
    expect(again.errors).toEqual([]);
    expect(again.reconciled).toBe(0);
  });

  it('detectAssigneeDrift surfaces the drift read-only', async () => {
    await backend.create({ name: 'Doctor Task', variant: 'cli' });
    await backend.sync('both');
    fake.editIssue(Number(remoteIdOf('doctor-task')), { assignees: [{ login: 'alice' }] });

    const drift = await backend.detectAssigneeDrift();
    expect(drift).toEqual([{ slug: 'doctor-task', local: [], remote: ['alice'] }]);
    expect(mirror('doctor-task')).not.toContain('person:alice');
  });
});
