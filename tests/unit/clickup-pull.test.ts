import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { buildCorpus } from '../../src/lib/recall.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp, type FakeTask } from './clickup-fake.js';

/**
 * Issue #11 M4 — PULL (delta by server time) + two-way merge rules + conflicts.
 */

const CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.0.0',
  disableNativeMemory: true,
  taskBackend: 'clickup',
  cloudTaskManagement: true,
  clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' },
  people: ['Alice'],
  peopleIdentity: { alice: { clickupMemberId: '501' } },
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeClickUp;
let backend: ClickUpTaskBackend;
let localClock: number;
let seedN = 0;

function makeBackend(clockStart = 1000): ClickUpTaskBackend {
  localClock = clockStart;
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  return new ClickUpTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
}

function seedRemote(name: string, extra: Partial<Omit<FakeTask, 'id'>> = {}): FakeTask {
  fake.advanceServer(1000);
  const id = `cu_seed_${++seedN}`;
  const task: FakeTask = {
    id,
    name,
    description: '## Why\n\nremote why\n',
    status: { status: 'to do' },
    priority: { id: '3' },
    tags: [],
    assignees: [],
    date_created: String(fake.serverNow()),
    date_updated: String(fake.serverNow()),
    ...extra,
  };
  fake.tasks.set(id, task);
  return task;
}

function mirror(slug: string): string {
  return readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
}

function syncStateFile(): { watermark: number | null; tasks: Record<string, any> } {
  return JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8'));
}

function remoteIdOf(slug: string): string {
  const map = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'));
  return map.find((e: any) => e.slug === slug).remoteId;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-cupl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  fake = makeFakeClickUp();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('clickup PULL + merge (M4, mocked transport)', () => {
  it('PULL is a delta sync: only tasks with date_updated > watermark are re-mirrored', async () => {
    const t1 = seedRemote('Remote One');
    seedRemote('Remote Two');

    const first = await backend.sync('pull');
    expect(first.errors).toEqual([]);
    expect(first.pulled).toBe(2);
    expect(existsSync(join(contextRoot, 'state', 'remote-one.md'))).toBe(true);
    expect(existsSync(join(contextRoot, 'state', 'remote-two.md'))).toBe(true);

    // Second pull with nothing changed remotely: the delta query excludes both.
    fake.requests.length = 0;
    const second = await backend.sync('pull');
    expect(second.pulled).toBe(0);
    const listCalls = fake.requests.filter((r) => r.path === '/list/list1/task');
    expect(listCalls.length).toBeGreaterThan(0);

    // Remote edit → only that task is re-mirrored.
    fake.editTask(t1.id, { status: { status: 'in progress' } });
    fake.requests.length = 0;
    const third = await backend.sync('pull');
    expect(third.pulled).toBe(1);
    // exactly one per-task comment fetch happened (only the changed task applied)
    expect(fake.requests.filter((r) => r.path.endsWith('/comment'))).toHaveLength(1);
    expect(mirror('remote-one')).toContain('status: in_progress');
    expect(mirror('remote-two')).toContain('status: todo');
  });

  it('PULL updates existing mirror files and creates new ones', async () => {
    await backend.create({ name: 'Born Local', variant: 'cli' });
    await backend.sync('push');

    seedRemote('Born Remote', { description: '## Why\n\nmade in the cloud\n' });
    fake.editTask(remoteIdOf('born-local'), { name: 'Born Local', priority: { id: '1' } });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.pulled).toBe(2);
    expect(mirror('born-remote')).toContain('made in the cloud');
    expect(mirror('born-local')).toContain('priority: critical');
  });

  it('comment/changelog union merge is conflict-free: no duplicates, all entries kept', async () => {
    await backend.create({ name: 'Union Task', variant: 'cli' });
    await backend.sync('push');

    // diverge: remote comment + local changelog entry
    fake.addRemoteComment(remoteIdOf('union-task'), '### 2026-06-11 - Remote note\n- from clickup');
    fake.editTask(remoteIdOf('union-task'), {}); // bump date_updated
    await backend.addChangelog('union-task', '### 2026-06-11 - Local note\n- from disk');

    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);
    expect(report.conflicts).toEqual([]);

    const merged = mirror('union-task');
    expect(occurrences(merged, 'from clickup')).toBe(1);
    expect(occurrences(merged, 'from disk')).toBe(1);
    expect(occurrences(merged, 'Task created.')).toBe(1);

    // the local-only entry reached the remote as a comment, exactly once
    const comments = fake.comments.get(remoteIdOf('union-task'))!;
    expect(comments.filter((c) => c.comment_text.includes('from disk'))).toHaveLength(1);

    // and a re-sync stays stable (idempotent union)
    await backend.sync('both');
    const again = mirror('union-task');
    expect(occurrences(again, 'from clickup')).toBe(1);
    expect(occurrences(again, 'from disk')).toBe(1);
    const commentsAfter = fake.comments.get(remoteIdOf('union-task'))!;
    expect(commentsAfter.filter((c) => c.comment_text.includes('from disk'))).toHaveLength(1);
  });

  it('status/assignee resolve last-write-wins by SERVER time; updated_by records the winner', async () => {
    await backend.create({ name: 'LWW Task', variant: 'cli' });
    await backend.sync('push');

    // Case A: BOTH changed — remote is later (server clock ≫ local clock) → remote wins.
    await backend.updateFields('lww-task', { status: 'in_review', updated_at: '2026-06-11' });
    fake.editTask(remoteIdOf('lww-task'), { status: { status: 'complete' }, assignees: [{ id: 501 }] });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    const merged = mirror('lww-task');
    expect(merged).toContain('status: completed');
    expect(merged).toContain('updated_by: clickup'); // the winner is recorded
    expect(merged).toContain('assignee: alice'); // ClickUp-authoritative assignee → member map

    // Case B: only LOCAL changed (remote bump is just a comment) → local wins, stays pending push.
    await backend.updateFields('lww-task', { status: 'in_progress', updated_at: '2026-06-11' });
    fake.addRemoteComment(remoteIdOf('lww-task'), 'just a remote comment');
    fake.editTask(remoteIdOf('lww-task'), {});
    const second = await backend.sync('pull');
    expect(second.errors).toEqual([]);
    const merged2 = mirror('lww-task');
    expect(merged2).toContain('status: in_progress'); // local won
    expect(merged2).toContain('updated_by: alice');
    expect(merged2).toContain('just a remote comment'); // remote comment still merged in
    expect(syncStateFile().tasks['lww-task'].pendingPush).toBe(true);
  });

  it('LWW honors a LATER local change (local timestamp beyond the server clock)', async () => {
    await backend.create({ name: 'Late Local', variant: 'cli' });
    await backend.sync('push');

    // Remote changes first (server ~1.9e12) …
    fake.editTask(remoteIdOf('late-local'), { status: { status: 'complete' } });
    // … then a LATER local change (local clock far beyond the server clock).
    const lateBackend = makeBackend(9_000_000_000_000);
    await lateBackend.updateFields('late-local', { status: 'in_review', updated_at: '2026-06-11' });

    const report = await lateBackend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(mirror('late-local')).toContain('status: in_review'); // local was last
  });

  it('prose body sections 3-way merge using base_snapshot (disjoint edits both survive)', async () => {
    await backend.create({ name: 'Prose Task', why: 'original why', variant: 'cli' });
    await backend.sync('push');
    const rid = remoteIdOf('prose-task');

    // local edits Notes; remote edits Why
    await backend.insertSection('prose-task', 'Notes', 'local note addition', { position: 'bottom', replacePlaceholders: true });
    const remoteDesc = fake.tasks.get(rid)!.description.replace('original why', 'remote-edited why');
    fake.editTask(rid, { description: remoteDesc });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.conflicts).toEqual([]);
    const merged = mirror('prose-task');
    expect(merged).toContain('remote-edited why');
    expect(merged).toContain('local note addition');

    // the surviving local edit pushes afterwards
    const push = await backend.sync('push');
    expect(push.errors).toEqual([]);
    expect(fake.tasks.get(rid)!.description).toContain('local note addition');
    expect(fake.tasks.get(rid)!.description).toContain('remote-edited why');
  });

  it('missing base_snapshot → ClickUp wins; local copy saved to state/.conflicts/ and surfaced (never silent loss)', async () => {
    await backend.create({ name: 'No Base', why: 'precious local prose', variant: 'cli' });
    await backend.sync('push');
    const rid = remoteIdOf('no-base');

    // Lose the (gitignored) sync state — e.g. a fresh clone of the repo.
    rmSync(join(contextRoot, 'state', '.tasks-sync.json'));

    await backend.insertSection('no-base', 'Why', 'locally divergent line', { position: 'bottom' });
    fake.editTask(rid, { description: '## Why\n\nremote rewrote everything\n' });

    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toMatchObject({ slug: 'no-base', reason: 'missing_base' });

    // ClickUp won the mirror…
    const merged = mirror('no-base');
    expect(merged).toContain('remote rewrote everything');
    expect(merged).not.toContain('locally divergent line');

    // …but the local copy is preserved and surfaced.
    const savedTo = report.conflicts[0].savedTo;
    expect(savedTo).toContain(join('state', '.conflicts'));
    expect(existsSync(savedTo)).toBe(true);
    expect(readFileSync(savedTo, 'utf-8')).toContain('locally divergent line');
    expect(readFileSync(savedTo, 'utf-8')).toContain('precious local prose');
  });

  it('same-section divergence with base → remote wins + conflict copy (both_changed)', async () => {
    await backend.create({ name: 'Clash', why: 'original why', variant: 'cli' });
    await backend.sync('push');
    const rid = remoteIdOf('clash');

    await backend.insertSection('clash', 'Why', 'local why addition', { position: 'bottom' });
    fake.editTask(rid, { description: fake.tasks.get(rid)!.description.replace('original why', 'remote why rewrite') });

    const report = await backend.sync('pull');
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].reason).toBe('both_changed');
    expect(mirror('clash')).toContain('remote why rewrite');
    expect(mirror('clash')).not.toContain('local why addition');
    expect(readFileSync(report.conflicts[0].savedTo, 'utf-8')).toContain('local why addition');
  });

  it('local mirror keeps recall working with taskBackend=clickup (no edits to recall.ts)', async () => {
    seedRemote('Cloud Knowledge Task', { description: '## Why\n\nsearchable cloud prose\n' });
    await backend.sync('pull');

    // recall.ts reads state/*.md exactly as before — the mirror feeds it.
    const corpus = buildCorpus(contextRoot);
    const doc = corpus.find((d) => d.slug === 'cloud-knowledge-task');
    expect(doc).toBeTruthy();
    expect(doc!.body).toContain('searchable cloud prose');
  });

  it('ledger split: committed state/.tasks-map.json + gitignored state/.tasks-sync.json', async () => {
    await backend.create({ name: 'Ledger Task', variant: 'cli' });
    await backend.sync('push');

    expect(existsSync(join(contextRoot, 'state', '.tasks-map.json'))).toBe(true);
    expect(existsSync(join(contextRoot, 'state', '.tasks-sync.json'))).toBe(true);

    const { REMOTE_BACKEND_GITIGNORE_ENTRIES } = await import('../../src/lib/task-backend/paths.js');
    expect(REMOTE_BACKEND_GITIGNORE_ENTRIES).toContain('_dream_context/state/.tasks-sync.json');
    expect(REMOTE_BACKEND_GITIGNORE_ENTRIES).toContain('_dream_context/state/.tasks-queue.json');
    // The id-map is the committed half of the ledger — it must NOT be ignored.
    expect(REMOTE_BACKEND_GITIGNORE_ENTRIES.some((e: string) => e.includes('.tasks-map'))).toBe(false);
  });

  it('"pending push" is visible in the sync state for offline writes', async () => {
    await backend.create({ name: 'Pending Vis', variant: 'cli' });
    expect(syncStateFile().tasks['pending-vis'].pendingPush).toBe(true);
    await backend.sync('push');
    expect(syncStateFile().tasks['pending-vis'].pendingPush).toBe(false);
  });
});
