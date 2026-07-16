import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';
import { makeFakeGitHub, type FakeGitHub } from './github-fake.js';

/**
 * Issue #185 — a push must not advance the PULL watermark.
 *
 * Two people share one remote container. Each has their own gitignored ledger,
 * so each has their own pull watermark — that part is right. What was wrong: the
 * push advanced that watermark to the server time of its OWN write.
 *
 * The watermark's contract is "I have PULLED everything up to T"; it gates
 * `date_updated_gt`. A push only proves "I WROTE at T". Conflating them meant:
 * teammate pushes at T1 → I push at T2 > T1 without pulling → my watermark is now
 * past their task → every future delta pull excludes it. Forever, silently: the
 * pull just reports `pulled 0`.
 *
 * The asymmetry that made this so confusing to hit in practice: whoever pushed
 * LAST goes blind, while their own task still reaches everyone else. So the same
 * pair of people would see it work in one direction and not the other.
 *
 * Echo suppression (the reason the push touched the watermark at all) is now
 * per-task, keyed on `last_synced_at` — which is what "I already have this exact
 * remote state" was always about. See the ECHO GATE in applyRemoteTask.
 */

// ── ClickUp ─────────────────────────────────────────────────────────────────

describe('ClickUp — two people, one list (#185)', () => {
  const CONFIG: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0',
    disableNativeMemory: true, taskBackend: 'clickup', cloudTaskManagement: true,
    clickup: { teamId: 't', spaceId: 's', listId: 'list1', changelogTarget: 'comments' },
    people: [], peopleIdentity: {},
  } as SetupConfig;

  let fake: FakeClickUp;
  const roots: string[] = [];

  interface Person {
    backend: () => ClickUpTaskBackend;
    has: (slug: string) => boolean;
    read: (slug: string) => string;
    watermark: () => number | null;
  }

  function makePerson(): Person {
    const raw = join(tmpdir(), `dc-2p-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    const projectRoot = realpathSync(raw);
    roots.push(projectRoot);
    const contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    let clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    return {
      backend: () => new ClickUpTaskBackend(contextRoot, CONFIG, {
        adapter: new ApiAdapter({
          baseUrl: 'https://api.clickup.com/api/v2',
          authHeaders: () => ({ Authorization: 'pk_test' }),
          fetchImpl: fake.fetchImpl, now, sleep,
        }), now, sleep,
      }),
      has: (slug) => existsSync(join(contextRoot, 'state', `${slug}.md`)),
      read: (slug) => readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8'),
      watermark: () => {
        const p = join(contextRoot, 'state', '.tasks-sync.json');
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')).watermark : null;
      },
    };
  }

  beforeEach(() => { delete process.env.DREAMCONTEXT_PERSON; fake = makeFakeClickUp(); });
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  it("my own push must not hide a teammate's earlier task from me", async () => {
    const alice = makePerson();
    const bob = makePerson();
    await alice.backend().sync('both');
    await bob.backend().sync('both');

    // Alice pushes first.
    const a = alice.backend();
    await a.create({ name: 'Alice Task', variant: 'cli' } as never);
    await a.sync('push');

    // Bob pushes his own WITHOUT pulling first — a `tasks sync push`, a git hook,
    // or `sleep done`. This is what used to jump his watermark past Alice's task.
    const b = bob.backend();
    await b.create({ name: 'Bob Task', variant: 'cli' } as never);
    await b.sync('push');

    const report = await bob.backend().sync('pull');
    expect(report.errors).toEqual([]);
    expect(bob.has('alice-task')).toBe(true);
    // Only Alice's task counts — Bob's own write is echo, not a pull.
    expect(report.pulled).toBe(1);
  });

  it('propagation is symmetric — neither person goes blind', async () => {
    const alice = makePerson();
    const bob = makePerson();
    await alice.backend().sync('both');
    await bob.backend().sync('both');

    const a = alice.backend();
    await a.create({ name: 'From Alice', variant: 'cli' } as never);
    await a.sync('push');
    const b = bob.backend();
    await b.create({ name: 'From Bob', variant: 'cli' } as never);
    await b.sync('push');

    await bob.backend().sync('pull');
    await alice.backend().sync('pull');

    // The old bug was asymmetric: whoever pushed LAST lost the other's task,
    // which is why the same pair saw it work one way and not the other.
    expect(bob.has('from-alice')).toBe(true);
    expect(alice.has('from-bob')).toBe(true);
  });

  it('a push leaves the pull watermark alone; only a pull advances it', async () => {
    const alice = makePerson();
    const a = alice.backend();
    await a.create({ name: 'Watermark Proof', variant: 'cli' } as never);
    await a.sync('push');
    expect(alice.watermark()).toBeNull();

    await alice.backend().sync('pull');
    expect(alice.watermark()).toBeGreaterThan(1_800_000_000_000); // server time
  });

  it('still converges: re-syncing after a push pulls nothing (echo stays suppressed)', async () => {
    const alice = makePerson();
    const a = alice.backend();
    await a.create({ name: 'Converge', variant: 'cli' } as never);
    await a.sync('both');

    // The echo gate — not the watermark — is what keeps this a no-op now.
    const again = await alice.backend().sync('both');
    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
    expect(again.errors).toEqual([]);
  });

  it("a teammate's REAL edit is still pulled (the gate suppresses echo, not changes)", async () => {
    const alice = makePerson();
    const bob = makePerson();
    const a = alice.backend();
    await a.create({ name: 'Shared Task', variant: 'cli' } as never);
    await a.sync('both');
    await bob.backend().sync('both');
    expect(bob.has('shared-task')).toBe(true);

    // Alice edits and pushes; her write advances date_updated past what Bob has.
    const a2 = alice.backend();
    await a2.updateFields('shared-task', { status: 'in_progress', updated_at: '2026-07-16' });
    await a2.sync('push');

    const report = await bob.backend().sync('pull');
    expect(report.pulled).toBe(1);
    expect(bob.read('shared-task')).toContain('in_progress');
  });
});

// ── GitHub (same rule, same fix) ────────────────────────────────────────────

describe('GitHub — two people, one repo (#185)', () => {
  const CONFIG: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0',
    disableNativeMemory: true, taskBackend: 'github', cloudTaskManagement: true,
    github: { owner: 'acme', repo: 'app' },
    people: [], peopleIdentity: {},
  } as SetupConfig;

  let fake: FakeGitHub;
  const roots: string[] = [];

  function makePerson() {
    const raw = join(tmpdir(), `dc-2p-gh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    const projectRoot = realpathSync(raw);
    roots.push(projectRoot);
    const contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    let clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    return {
      backend: () => new GitHubTaskBackend(contextRoot, CONFIG, {
        adapter: new ApiAdapter({
          baseUrl: 'https://api.github.com',
          authHeaders: () => ({ Authorization: 'token gh_test' }),
          fetchImpl: fake.fetchImpl, now, sleep,
        }), now, sleep,
      }),
      has: (slug: string) => existsSync(join(contextRoot, 'state', `${slug}.md`)),
    };
  }

  beforeEach(() => { delete process.env.DREAMCONTEXT_PERSON; fake = makeFakeGitHub(); });
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  it("my own push must not hide a teammate's earlier issue from me", async () => {
    const alice = makePerson();
    const bob = makePerson();
    await alice.backend().sync('both');
    await bob.backend().sync('both');

    const a = alice.backend();
    await a.create({ name: 'Alice Issue', variant: 'cli' } as never);
    await a.sync('push');

    const b = bob.backend();
    await b.create({ name: 'Bob Issue', variant: 'cli' } as never);
    await b.sync('push');

    const report = await bob.backend().sync('pull');
    expect(report.errors).toEqual([]);
    expect(bob.has('alice-issue')).toBe(true);
  });
});
