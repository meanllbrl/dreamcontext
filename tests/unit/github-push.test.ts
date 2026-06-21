import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

/**
 * GitHub PUSH (A3 / A7): status → state+state_reason+dc:* labels, soft-delete,
 * assignees, server-time watermark, idempotent re-run. Mocked HTTP transport.
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
  people: ['Alice'],
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeGitHub;
let backend: GitHubTaskBackend;
let localClock: number;

function makeBackend(config: SetupConfig = CONFIG): GitHubTaskBackend {
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  return new GitHubTaskBackend(contextRoot, config, { adapter, now, sleep });
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-ghp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeGitHub();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function mapFile(): Array<{ slug: string; dcId: string; backend: string; remoteId: string }> {
  return JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'));
}

function syncStateFile(): { watermark: number | null; tasks: Record<string, any> } {
  return JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8'));
}

function labelNames(issue: { labels: Array<{ name: string }> }): string[] {
  return issue.labels.map((l) => l.name).sort();
}

describe('github PUSH (A3/A7, mocked transport)', () => {
  it('creates unmapped tasks as OPEN issues with priority/version/tags labels (no Changelog in body)', async () => {
    await backend.create({ name: 'Push One', priority: 'high', tags: ['a'], version: 'v1', variant: 'cli' });

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(1);
    expect(fake.issues.size).toBe(1);

    const map = mapFile();
    expect(map[0].slug).toBe('push-one');
    expect(map[0].backend).toBe('github');
    expect(map[0].remoteId).toMatch(/^\d+$/);

    const issue = [...fake.issues.values()][0];
    expect(issue.state).toBe('open');
    expect(labelNames(issue)).toEqual(['a', 'priority:high', 'urgency:medium', 'version:v1']);
    expect(issue.body).toContain('## Why');
    expect(issue.body).not.toContain('## Changelog'); // changelog → comments
  });

  it('completed → closed/completed (the ONLY status that closes an issue)', async () => {
    await backend.create({ name: 'Finish Me', variant: 'cli' });
    await backend.sync('push');
    await backend.updateFields('finish-me', { status: 'completed', updated_at: '2026-06-21' });
    await backend.sync('push');

    const issue = [...fake.issues.values()][0];
    expect(issue.state).toBe('closed');
    expect(issue.state_reason).toBe('completed');
  });

  it('in_progress → open + dc:in-progress label; in_review → open + dc:in-review; todo → no dc: label', async () => {
    await backend.create({ name: 'Prog', variant: 'cli' });
    await backend.create({ name: 'Rev', variant: 'cli' });
    await backend.create({ name: 'Plain Todo', variant: 'cli' });
    await backend.sync('push');

    await backend.updateFields('prog', { status: 'in_progress', updated_at: '2026-06-21' });
    await backend.updateFields('rev', { status: 'in_review', updated_at: '2026-06-21' });
    await backend.sync('push');

    const byTitle = (t: string) => [...fake.issues.values()].find((i) => i.title === t)!;
    expect(byTitle('Prog').state).toBe('open');
    expect(labelNames(byTitle('Prog'))).toContain('dc:in-progress');
    expect(byTitle('Rev').state).toBe('open');
    expect(labelNames(byTitle('Rev'))).toContain('dc:in-review');
    expect(labelNames(byTitle('Plain Todo')).some((l) => l.startsWith('dc:'))).toBe(false);
  });

  it('reopen (completed → active) sends state:open + state_reason:reopened and re-applies the sub-status label', async () => {
    await backend.create({ name: 'Comeback', variant: 'cli' });
    await backend.sync('push');
    await backend.updateFields('comeback', { status: 'completed', updated_at: '2026-06-21' });
    await backend.sync('push');
    expect([...fake.issues.values()][0].state).toBe('closed');

    // Clear the request log, then reopen by moving back to in_progress.
    fake.requests.length = 0;
    await backend.updateFields('comeback', { status: 'in_progress', updated_at: '2026-06-22' });
    await backend.sync('push');

    const issue = [...fake.issues.values()][0];
    expect(issue.state).toBe('open');
    expect(issue.state_reason).toBe('reopened');
    expect(labelNames(issue)).toContain('dc:in-progress');
    const patch = fake.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toMatchObject({ state: 'open', state_reason: 'reopened' });
  });

  it('PATCH always sends the FULL label set (labels REPLACE on GitHub)', async () => {
    await backend.create({ name: 'Labeled', priority: 'low', tags: ['keep'], variant: 'cli' });
    await backend.sync('push');

    fake.requests.length = 0;
    await backend.updateFields('labeled', { status: 'in_progress', updated_at: '2026-06-21' });
    await backend.sync('push');
    const patch = fake.requests.find((r) => r.method === 'PATCH')!;
    expect((patch.body as { labels: string[] }).labels.sort()).toEqual(
      ['dc:in-progress', 'keep', 'priority:low', 'urgency:medium'],
    );
  });

  it('changelog entries push as issue comments', async () => {
    await backend.create({ name: 'Logged', variant: 'cli' });
    await backend.addChangelog('logged', '### 2026-06-21 - Session Update\n- did a thing');
    await backend.addChangelog('logged', '### 2026-06-21 - Session Update\n- did another');

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    const number = Number(mapFile()[0].remoteId);
    const cmts = fake.comments.get(number) ?? [];
    // 3 = template "Created" + the two log entries.
    expect(cmts).toHaveLength(3);
    expect(report.commentsAdded).toBe(3);
    expect(cmts.some((c) => c.body.includes('did a thing'))).toBe(true);
    expect(cmts.some((c) => c.body.includes('did another'))).toBe(true);
  });

  it('PUSH re-run is idempotent: no duplicate issues, no duplicate comments, zero writes', async () => {
    await backend.create({ name: 'Idem', variant: 'cli' });
    await backend.addChangelog('idem', '### 2026-06-21 - Update\n- once only');
    await backend.sync('push');

    const issueCount = fake.issues.size;
    const commentCount = [...fake.comments.values()].flat().length;
    fake.requests.length = 0;

    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(0);
    expect(report.pushed).toBe(0);
    expect(report.commentsAdded).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    expect(fake.issues.size).toBe(issueCount);
    expect([...fake.comments.values()].flat()).toHaveLength(commentCount);
  });

  it('watermarks use GitHub server time (updated_at), never the local clock', async () => {
    await backend.create({ name: 'Clock Proof', variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);

    const state = syncStateFile();
    const entry = state.tasks['clock-proof'];
    // Server clock lives at ~1.9e12; the injected local clock stays ~1e3.
    expect(entry.last_synced_at).toBeGreaterThan(1_800_000_000_000);
    expect(state.watermark).toBeGreaterThan(1_800_000_000_000);
    const issue = [...fake.issues.values()][0];
    expect(entry.last_synced_at).toBe(Date.parse(issue.updated_at));
  });

  it('assignees: a person tag for a collaborator round-trips to the issue login', async () => {
    await backend.create({ name: 'Owned', tags: ['person:alice'], variant: 'cli' });
    await backend.sync('both'); // refreshes the collaborator cache first
    const issue = [...fake.issues.values()][0];
    expect(issue.assignees.map((a) => a.login)).toEqual(['alice']);
  });

  it('A7: a non-collaborator assignee is dropped on write — sync never aborts', async () => {
    await backend.create({ name: 'Ghost Owner', tags: ['person:nobody', 'person:alice'], variant: 'cli' });
    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);
    const issue = [...fake.issues.values()][0];
    // Only the real collaborator landed; the unknown login silently dropped.
    expect(issue.assignees.map((a) => a.login)).toEqual(['alice']);
  });

  it('offline (network down): mutations enqueue, sync reports errors, queue replays on reconnect', async () => {
    await backend.create({ name: 'Offline Born', variant: 'cli' });
    fake.setFailMode({ kind: 'network' });

    const failed = await backend.sync('push');
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(failed.pendingQueue).toBeGreaterThan(0);
    expect(syncStateFile().tasks['offline-born'].pendingPush).toBe(true);
    expect(fake.issues.size).toBe(0);

    fake.setFailMode(null);
    const replayed = await backend.sync('push');
    expect(replayed.errors).toEqual([]);
    expect(replayed.created).toBe(1);
    expect(replayed.pendingQueue).toBe(0);
    expect(fake.issues.size).toBe(1);
    expect(syncStateFile().tasks['offline-born'].pendingPush).toBe(false);
  });

  it('sync() never throws when token/repo are missing — it reports', async () => {
    const noRepo = makeBackend({ ...CONFIG, github: { owner: 'o' } });
    await noRepo.create({ name: 'Unconfigured', variant: 'cli' });
    const report = await noRepo.sync('push');
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]).toMatch(/repo/i);

    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      const noToken = new GitHubTaskBackend(contextRoot, CONFIG, {});
      const tokenReport = await noToken.sync('push');
      expect(tokenReport.errors.length).toBeGreaterThan(0);
      expect(tokenReport.errors[0]).toMatch(/token/i);
    } finally {
      if (saved.GITHUB_TOKEN !== undefined) process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN;
      if (saved.GH_TOKEN !== undefined) process.env.GH_TOKEN = saved.GH_TOKEN;
    }
  });
});
