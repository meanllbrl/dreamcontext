import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * TAG-RETRY SEMANTICS (task: "tasks sync pull loses data silently", AC6).
 *
 * ClickUp's PUT carries no tags, so a tag change is one request per tag. That
 * loop used to be able to throw half-applied, aborting the push before its
 * ledger write and leaving `base_snapshot` at the PRE-push state — so the retry
 * recomputed the same delta and re-sent tag ops that had already landed.
 * The loop is now tolerant: a failure is recorded, the rest of the push
 * completes, the tag delta stays pending, and the replay is a no-op for
 * whatever already applied.
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
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeClickUp;
let backend: ClickUpTaskBackend;
let localClock: number;
/** Tag names whose per-tag endpoint fails (any method) while set. */
let failingTags: Set<string>;
/** Tag names whose per-tag endpoint answers 404 ("already applied" shape). */
let notFoundTags: Set<string>;
/** Every per-tag request the backend made, as `<METHOD> <tag>`. */
let tagCalls: string[];

function makeBackend(): ClickUpTaskBackend {
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const m = /^\/api\/v2\/task\/[^/]+\/tag\/(.+)$/.exec(path);
    if (m) {
      const tag = decodeURIComponent(m[1]);
      const method = (init?.method ?? 'GET').toUpperCase();
      tagCalls.push(`${method} ${tag}`);
      if (failingTags.has(tag)) {
        return {
          ok: false,
          status: 400,
          headers: { get: () => null },
          text: async () => JSON.stringify({ err: 'Tag op rejected' }),
        } as unknown as Response;
      }
      if (notFoundTags.has(tag)) {
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
          text: async () => JSON.stringify({ err: 'Tag not found' }),
        } as unknown as Response;
      }
    }
    return fake.fetchImpl(url, init);
  }) as typeof fetch;
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl,
    now,
    sleep,
    maxRetries: 0,
  });
  return new ClickUpTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
}

function remoteTags(): string[] {
  return [...fake.tasks.values()][0].tags
    .map((t) => t.name)
    .filter((n) => !n.startsWith('dcproject:'))
    .sort();
}

function syncEntry(slug: string): { pendingPush?: boolean; base_snapshot?: { body: string } } {
  return JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8')).tasks[slug];
}

function commentCount(): number {
  return [...fake.comments.values()].reduce((n, list) => n + list.length, 0);
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-tagretry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeClickUp();
  failingTags = new Set<string>();
  notFoundTags = new Set<string>();
  tagCalls = [];
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('AC6: a tag op that fails mid-loop leaves a RETRYABLE, replay-safe state', () => {
  it('the rest of the loop still runs, the push completes, and the delta is retried', async () => {
    await backend.create({ name: 'Tag Retry', tags: ['keep', 'drop-me'], variant: 'cli' });
    await backend.sync('push');
    expect(remoteTags()).toEqual(['drop-me', 'keep']);

    // Two adds + one remove; the FIRST add fails mid-loop.
    failingTags.add('alpha');
    await backend.updateFields('tag-retry', { tags: ['keep', 'alpha', 'beta'], updated_at: '2026-08-17' });
    const first = await backend.sync('push');

    // Not fatal: the push finished, and the ops after the failure still landed.
    expect(first.failedPushes).toEqual([]);
    expect(first.pushed).toBe(1);
    expect(remoteTags()).toEqual(['beta', 'keep']); // beta added, drop-me removed
    expect(first.warnings.some((w) => w.includes('tag op(s) failed') && w.includes('alpha'))).toBe(true);
    expect(syncEntry('tag-retry').pendingPush).toBe(true);
    // The base must still diff against the PRE-push tag set, or the failed add
    // is silently forgotten by the next push.
    expect(syncEntry('tag-retry').base_snapshot!.body).toContain('drop-me');

    // Retry with the endpoint healthy: the missing tag lands…
    failingTags.clear();
    tagCalls = [];
    const second = await backend.sync('push');
    expect(second.errors).toEqual([]);
    expect(remoteTags()).toEqual(['alpha', 'beta', 'keep']);
    expect(syncEntry('tag-retry').pendingPush).toBe(false);

    // …and the replayed ops that had ALREADY applied are harmless no-ops.
    expect(tagCalls).toContain('POST alpha');
    expect(remoteTags().filter((t) => t === 'beta')).toHaveLength(1);
  });

  it('a replayed REMOVE of an already-removed tag is not counted as a failure', async () => {
    await backend.create({ name: 'Ghost Tag', tags: ['keep', 'vanished'], variant: 'cli' });
    await backend.sync('push');

    // The tag is gone remotely already (a previous run's DELETE landed, or
    // someone removed it in the ClickUp UI), so the endpoint 404s — the exact
    // shape a replay re-sends.
    const task = [...fake.tasks.values()][0];
    task.tags = task.tags.filter((t) => t.name !== 'vanished');
    notFoundTags.add('vanished');

    await backend.updateFields('ghost-tag', { tags: ['keep'], updated_at: '2026-08-17' });
    const report = await backend.sync('push');

    expect(report.errors).toEqual([]);
    expect(report.warnings.some((w) => w.includes('tag op(s) failed'))).toBe(false);
    expect(syncEntry('ghost-tag').pendingPush).toBe(false);
  });

  it('a failed tag op does not re-post changelog comments on the retry', async () => {
    await backend.create({ name: 'No Dupes', tags: ['keep'], variant: 'cli' });
    await backend.sync('push');
    const baseline = commentCount();

    await backend.addChangelog('no-dupes', '### 2026-08-17 - Note\n- one entry only');
    await backend.updateFields('no-dupes', { tags: ['keep', 'gamma'], updated_at: '2026-08-17' });
    failingTags.add('gamma');
    await backend.sync('push');
    const afterFailure = commentCount();
    expect(afterFailure).toBe(baseline + 1);

    failingTags.clear();
    await backend.sync('push');
    expect(commentCount()).toBe(afterFailure); // the retry posts nothing new
    expect(remoteTags()).toEqual(['gamma', 'keep']);
  });
});
