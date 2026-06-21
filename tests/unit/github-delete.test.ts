import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

/**
 * GitHub SOFT-delete (A4 — the one divergence from ClickUp): delete removes the
 * mirror + ledger and, on the next sync, CLOSES the issue as `not_planned` —
 * never a hard HTTP DELETE. Inbound not_planned removes the local mirror.
 */

const CONFIG: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.0.0',
  disableNativeMemory: true,
  taskBackend: 'github',
  cloudTaskManagement: true,
  github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' },
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeGitHub;
let backend: GitHubTaskBackend;
let localClock: number;

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-ghdel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeGitHub();
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  // fetchImpl is passed too so discoverContainers() — which builds its OWN
  // adapter from deps.fetchImpl — also routes through the fake.
  backend = new GitHubTaskBackend(contextRoot, CONFIG, { adapter, fetchImpl: fake.fetchImpl, now, sleep });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('github SOFT-delete propagation (A4)', () => {
  it('deleting a synced task removes the mirror + ledger and CLOSES the issue as not_planned (no DELETE ever)', async () => {
    await backend.create({ name: 'Bye Bye', variant: 'cli' });
    await backend.sync('push');
    expect(fake.issues.size).toBe(1);
    const number = [...fake.issues.keys()][0];

    await backend.delete('bye-bye');
    expect(existsSync(join(contextRoot, 'state', 'bye-bye.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'))).toEqual([]);
    // The issue still EXISTS until the soft-close replays.
    expect(fake.issues.has(number)).toBe(true);

    fake.requests.length = 0;
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.deleted).toBe(1);
    expect(report.pendingQueue).toBe(0);

    // The issue is preserved (history intact) and closed as not_planned.
    const issue = fake.issues.get(number)!;
    expect(issue.state).toBe('closed');
    expect(issue.state_reason).toBe('not_planned');
    // CRITICAL: not a single HTTP DELETE was ever issued.
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
    const patch = fake.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
  });

  it('pull never resurrects a task whose soft-delete is pending', async () => {
    await backend.create({ name: 'No Zombie', variant: 'cli' });
    await backend.sync('push');
    const number = [...fake.issues.keys()][0];

    await backend.delete('no-zombie');
    fake.editIssue(number, { body: '## Why\n\nremote touched\n' });

    const report = await backend.sync('both'); // pull runs BEFORE push
    expect(report.errors).toEqual([]);
    expect(existsSync(join(contextRoot, 'state', 'no-zombie.md'))).toBe(false);
    expect(report.deleted).toBe(1);
    expect(fake.issues.get(number)!.state_reason).toBe('not_planned');
  });

  it('deleting a never-synced task queues no remote op', async () => {
    await backend.create({ name: 'Local Only', variant: 'cli' });
    await backend.delete('local-only');
    const queue = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-queue.json'), 'utf-8'));
    expect(queue.filter((q: { kind: string }) => q.kind === 'delete')).toEqual([]);
    const report = await backend.sync('push');
    expect(report.deleted).toBe(0);
    expect(fake.issues.size).toBe(0);
  });

  it('an inbound not_planned close removes the local mirror (mirrorDeleted++)', async () => {
    await backend.create({ name: 'Closed Out There', variant: 'cli' });
    await backend.sync('push');
    const number = [...fake.issues.keys()][0];

    // Someone closes it as not_planned on GitHub.
    fake.editIssue(number, { state: 'closed', state_reason: 'not_planned' });
    const report = await backend.sync('pull');
    expect(report.errors).toEqual([]);
    expect(report.mirrorDeleted).toBe(1);
    expect(existsSync(join(contextRoot, 'state', 'closed-out-there.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'))).toEqual([]);

    const sleep = JSON.parse(readFileSync(join(contextRoot, 'state', '.sleep.json'), 'utf-8'));
    const entry = (sleep.dashboard_changes ?? []).find(
      (c: { action: string; target: string }) => c.action === 'delete' && c.target === 'state/closed-out-there.md',
    );
    expect(entry).toBeTruthy();
  });

  it('unsaved local edits are preserved to .conflicts/ when the remote issue is closed not_planned', async () => {
    await backend.create({ name: 'Edited Then Closed', why: 'precious text', variant: 'cli' });
    await backend.sync('push');
    const number = [...fake.issues.keys()][0];

    await backend.addChangelog('edited-then-closed', '### 2026-06-21 - Update\n- unpushed note');
    fake.editIssue(number, { state: 'closed', state_reason: 'not_planned' });

    const report = await backend.sync('pull');
    expect(report.mirrorDeleted).toBe(1);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].reason).toBe('remote_deleted');
    const saved = readFileSync(report.conflicts[0].savedTo, 'utf-8');
    expect(saved).toContain('unpushed note');
    expect(saved).toContain('precious text');
    expect(existsSync(join(contextRoot, 'state', 'edited-then-closed.md'))).toBe(false);
  });

  it('offline soft-delete stays queued and replays; an already-gone remote issue is a clean no-op', async () => {
    await backend.create({ name: 'Offline Del', variant: 'cli' });
    await backend.sync('push');
    const number = [...fake.issues.keys()][0];

    fake.setFailMode({ kind: 'network' });
    await backend.delete('offline-del');
    const failed = await backend.sync('push');
    expect(failed.pendingQueue).toBe(1);

    // The issue vanishes on GitHub (e.g. transferred); we come back online.
    fake.setFailMode(null);
    fake.issues.delete(number);
    const replay = await backend.sync('push');
    expect(replay.errors).toEqual([]);
    expect(replay.pendingQueue).toBe(0); // 404 → dequeued, done
  });
});

describe('github remote ops (A6)', () => {
  it('provisionRemote creates the recommended dc:* / convention labels that are missing', async () => {
    const res = await backend.provisionRemote();
    expect(res.errors).toEqual([]);
    expect(res.created).toContain('dc:in-progress');
    expect(res.created).toContain('dc:in-review');
    expect(res.created).toContain('priority:high');
    expect(fake.labels.has('dc:in-progress')).toBe(true);

    // Idempotent: a second run creates nothing new (all already exist).
    const second = await backend.provisionRemote();
    expect(second.created).toEqual([]);
    expect(second.existing.length).toBeGreaterThan(0);
  });

  it('discoverContainers lists the token-visible repos as owner/repo containers', async () => {
    // discoverContainers resolves the token internally (env → secrets) and
    // talks through the injected fake fetch; provide a token for the duration.
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_discover';
    try {
      const containers = await backend.discoverContainers();
      const paths = containers.map((c) => c.path);
      expect(paths).toContain('meanllbrl/dreamcontext');
      const dc = containers.find((c) => c.path === 'meanllbrl/dreamcontext')!;
      expect(dc.ids).toEqual({ owner: 'meanllbrl', repo: 'dreamcontext' });
    } finally {
      if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
      else delete process.env.GITHUB_TOKEN;
    }
  });

  it('listMembers returns the repo collaborators (login is the assignee id)', async () => {
    const members = await backend.listMembers();
    expect(members.map((m) => m.slug).sort()).toEqual(['alice', 'mehmet']);
    expect(members.find((m) => m.slug === 'alice')!.id).toBe('alice');
  });

  it('testConnection authenticates via GET /user', async () => {
    const res = await backend.testConnection();
    expect(res).toEqual({ ok: true, user: 'api-user' });
  });
});
