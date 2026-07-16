import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { migration0180 } from '../../src/migrations/0.18.0.js';
import { pendingMigrations } from '../../src/migrations/index.js';
import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';

/**
 * Migration 0.18.0 — heal a pull watermark poisoned by our own pushes (#185).
 *
 * The code fix stops NEW poisoning; it cannot un-hide what a poisoned watermark
 * already excluded, because a delta sync has no way to discover what it was told
 * to skip. So an upgrading project stays broken unless the upgrade clears the
 * number. That is what these tests pin — especially the last one, which proves an
 * already-broken project recovers, rather than merely that a field turned null.
 */

const SYNC_REL = join('state', '.tasks-sync.json');

describe('migration 0.18.0 — reset the poisoned pull watermark', () => {
  let root: string;
  const step = migration0180.steps[0];
  const ledgerPath = () => join(root, SYNC_REL);
  const readLedger = () => JSON.parse(readFileSync(ledgerPath(), 'utf-8'));
  const writeLedger = (o: unknown) => {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(ledgerPath(), JSON.stringify(o, null, 2));
  };

  beforeEach(() => {
    const raw = join(tmpdir(), `dc-mig180-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    root = realpathSync(raw);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('is registered and fires for a project upgrading from a pre-fix version', () => {
    expect(pendingMigrations('0.17.2', '0.18.0').map((m) => m.version)).toContain('0.18.0');
    // A project already on 0.18.0 has nothing pending.
    expect(pendingMigrations('0.18.0', '0.18.0').map((m) => m.version)).not.toContain('0.18.0');
  });

  it('nulls a set watermark and keeps the rest of the ledger intact', () => {
    writeLedger({
      watermark: 1_900_000_008_000,
      container: 'list:list1',
      tasks: { alpha: { last_synced_at: 1_900_000_004_000, pendingPush: false } },
      listStatuses: ['to do', 'complete'],
    });

    const r = step(root);
    expect(r.detected).toBe(false);
    expect(r.filesTouched).toEqual([ledgerPath()]);
    expect(r.failedCount).toBeUndefined();

    const after = readLedger();
    expect(after.watermark).toBeNull();
    // Only the watermark is the poisoned value — per-task state carries the echo
    // gate that keeps the forced re-read cheap, so it must survive.
    expect(after.tasks.alpha.last_synced_at).toBe(1_900_000_004_000);
    expect(after.container).toBe('list:list1');
    expect(after.listStatuses).toEqual(['to do', 'complete']);
  });

  it('is idempotent — a second run reports detected and writes nothing', () => {
    writeLedger({ watermark: 1_900_000_008_000, tasks: {} });
    expect(step(root).detected).toBe(false);

    const second = step(root);
    expect(second.detected).toBe(true);
    expect(second.filesTouched).toEqual([]);
    expect(readLedger().watermark).toBeNull();
  });

  it('no ledger (local backend / never synced) — detected, and it does NOT create the file', () => {
    const r = step(root);
    expect(r.detected).toBe(true);
    expect(r.filesTouched).toEqual([]);
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('a torn ledger needs no heal — it already reads as having no watermark', () => {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(ledgerPath(), '{ not json');

    // The ledger's reader contracts "unreadable → fresh default", so the sync
    // already behaves as if there were no watermark and re-reads in full. There
    // is nothing poisoned left to clear, and the migration must not rewrite a
    // file it cannot parse.
    const r = step(root);
    expect(r.detected).toBe(true);
    expect(r.filesTouched).toEqual([]);
    expect(readFileSync(ledgerPath(), 'utf-8')).toBe('{ not json');
  });
});

// ── The point of the whole exercise ─────────────────────────────────────────

describe('an ALREADY-BROKEN project recovers after upgrading (#185)', () => {
  const CONFIG: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0',
    disableNativeMemory: true, taskBackend: 'clickup', cloudTaskManagement: true,
    clickup: { teamId: 't', spaceId: 's', listId: 'list1', changelogTarget: 'comments' },
    people: [], peopleIdentity: {},
  } as SetupConfig;

  let fake: FakeClickUp;
  const roots: string[] = [];

  function makePerson() {
    const raw = join(tmpdir(), `dc-heal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    const projectRoot = realpathSync(raw);
    roots.push(projectRoot);
    const contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    let clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    return {
      contextRoot,
      backend: () => new ClickUpTaskBackend(contextRoot, CONFIG, {
        adapter: new ApiAdapter({
          baseUrl: 'https://api.clickup.com/api/v2',
          authHeaders: () => ({ Authorization: 'pk_test' }),
          fetchImpl: fake.fetchImpl, now, sleep,
        }), now, sleep,
      }),
      has: (slug: string) => existsSync(join(contextRoot, 'state', `${slug}.md`)),
      /** Poison the watermark exactly as a pre-0.18.0 push would have. */
      poisonWatermark: (at: number) => {
        const p = join(contextRoot, 'state', '.tasks-sync.json');
        const st = JSON.parse(readFileSync(p, 'utf-8'));
        st.watermark = at;
        writeFileSync(p, JSON.stringify(st, null, 2));
      },
    };
  }

  beforeEach(() => { delete process.env.DREAMCONTEXT_PERSON; fake = makeFakeClickUp(); });
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  it("a teammate's task hidden by a pre-fix push is recovered by the upgrade", async () => {
    const alice = makePerson();
    const bob = makePerson();
    await alice.backend().sync('both');
    await bob.backend().sync('both');

    // Alice's task lands on the list.
    const a = alice.backend();
    await a.create({ name: 'Alice Task', variant: 'cli' } as never);
    await a.sync('push');
    const aliceTaskTime = Number([...fake.tasks.values()].find((t) => t.name === 'Alice Task')!.date_updated);

    // Bob is running a PRE-FIX build: his own push jumped his watermark past it.
    const b = bob.backend();
    await b.create({ name: 'Bob Task', variant: 'cli' } as never);
    await b.sync('push');
    bob.poisonWatermark(aliceTaskTime + 1000);

    // Bob upgrades the CLI. The code is fixed now — but that alone does NOT help:
    // the poisoned number is still on disk and the delta pull still honours it.
    const stillBroken = await bob.backend().sync('pull');
    expect(stillBroken.pulled).toBe(0);
    expect(bob.has('alice-task')).toBe(false); // ← the fix alone leaves him broken

    // The migration is the part that actually reaches him.
    const r = migration0180.steps[0](bob.contextRoot);
    expect(r.detected).toBe(false);

    const healed = await bob.backend().sync('pull');
    expect(healed.errors).toEqual([]);
    expect(bob.has('alice-task')).toBe(true);
    expect(healed.pulled).toBe(1); // Bob's own task is echo — not re-counted
  });

  it('the forced re-read is a no-op for a healthy project (no churn, nothing lost)', async () => {
    const alice = makePerson();
    const a = alice.backend();
    await a.create({ name: 'Healthy One', variant: 'cli' } as never);
    await a.create({ name: 'Healthy Two', variant: 'cli' } as never);
    await a.sync('both');

    migration0180.steps[0](alice.contextRoot);

    // Clearing the watermark must not resurrect, delete, or churn anything —
    // the echo gate absorbs the full re-read.
    const after = await alice.backend().sync('both');
    expect(after.errors).toEqual([]);
    expect(after.pulled).toBe(0);
    expect(after.pushed).toBe(0);
    expect(after.mirrorDeleted).toBe(0);
    expect(alice.has('healthy-one')).toBe(true);
    expect(alice.has('healthy-two')).toBe(true);
  });
});
