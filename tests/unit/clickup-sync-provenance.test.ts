import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { SyncLedger } from '../../src/lib/task-backend/sync-state.js';
import { canonicalizeVersion, tagsFromClickUp } from '../../src/lib/task-backend/clickup-map.js';
import { versionTokenMatches, VV_CURRENT, VV_COMPLETED } from '../../dashboard/src/components/tasks/boardModel.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import type { SyncReport } from '../../src/lib/task-backend/types.js';
import matter from 'gray-matter';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';
import { checkSharedTaskContainer } from '../../src/cli/commands/doctor.js';

/**
 * Issue #184 — ClickUp sync provenance + version round-trip (consolidates #177,
 * #178, #179).
 *
 * Two invariants, both of which used to fail SILENTLY (the defining property of
 * this bug family — every symptom was invisible scope-loss, never an error):
 *
 *  1. Derived remote caches (statuses/members/fields) and the pull watermark
 *     describe ONE remote container. Repointing the target must invalidate them
 *     no matter WHICH writer moved it — not just the one path that happened to
 *     drop the whole ledger.
 *  2. `version` must survive a round trip through ClickUp, which lowercases tag
 *     names, and must keep matching the sprint board's filter.
 */

// ── pure: version canonicalisation (#179 defect 2) ───────────────────────────

describe('canonicalizeVersion (pure)', () => {
  const KNOWN = ['S5 (Jul 13 - Jul 17)', 'v0.18.0', 'BACKLOG'];

  it("restores the canonical spelling of ClickUp's lowercased round-trip", () => {
    expect(canonicalizeVersion('s5 (jul 13 - jul 17)', KNOWN)).toBe('S5 (Jul 13 - Jul 17)');
    expect(canonicalizeVersion('backlog', KNOWN)).toBe('BACKLOG');
  });

  it('leaves an already-canonical version untouched', () => {
    expect(canonicalizeVersion('S5 (Jul 13 - Jul 17)', KNOWN)).toBe('S5 (Jul 13 - Jul 17)');
    expect(canonicalizeVersion('v0.18.0', KNOWN)).toBe('v0.18.0');
  });

  it('returns an unregistered version as-is rather than guessing at it', () => {
    expect(canonicalizeVersion('s9 (some ad-hoc sprint)', KNOWN)).toBe('s9 (some ad-hoc sprint)');
    expect(canonicalizeVersion('anything', [])).toBe('anything');
  });

  it('folds diacritics/Turkish letters, matching the status mapper', () => {
    expect(canonicalizeVersion('sürüm-ı', ['Sürüm-I'])).toBe('Sürüm-I');
  });

  it('null in → null out', () => {
    expect(canonicalizeVersion(null, KNOWN)).toBeNull();
  });
});

describe('tagsFromClickUp (pure)', () => {
  it('canonicalises the version tag against the known set and strips it from tags', () => {
    const { tags, version } = tagsFromClickUp(
      [{ name: 'kind:feature' }, { name: 'version:s5 (jul 13 - jul 17)' }],
      ['S5 (Jul 13 - Jul 17)'],
    );
    expect(version).toBe('S5 (Jul 13 - Jul 17)');
    expect(tags).toEqual(['kind:feature']);
  });

  it('without a known set, the version is still read (just not canonicalised)', () => {
    expect(tagsFromClickUp([{ name: 'version:s5' }]).version).toBe('s5');
  });
});

// ── pure: the board filter is the second line of defence (#179 defect 2) ─────

describe('versionTokenMatches — sprint board filter (dashboard)', () => {
  const meta = { active: 'S5 (Jul 13 - Jul 17)', released: ['v0.17.2'] };

  it('a lowercased round-tripped version still matches its own sprint', () => {
    // The exact-match filter is what made the task vanish from Current Sprint.
    expect(versionTokenMatches('s5 (jul 13 - jul 17)', VV_CURRENT, meta)).toBe(true);
    expect(versionTokenMatches('S5 (Jul 13 - Jul 17)', VV_CURRENT, meta)).toBe(true);
  });

  it('a genuinely different sprint still does not match', () => {
    expect(versionTokenMatches('S4 (Jul 6 - Jul 10)', VV_CURRENT, meta)).toBe(false);
  });

  it('released + literal tokens fold too', () => {
    expect(versionTokenMatches('V0.17.2', VV_COMPLETED, meta)).toBe(true);
    expect(versionTokenMatches('v0.18.0', 'V0.18.0', meta)).toBe(true);
    expect(versionTokenMatches('v0.18.0', 'v0.19.0', meta)).toBe(false);
  });

  it('no active sprint → @current matches nothing', () => {
    expect(versionTokenMatches('s5', VV_CURRENT, { active: null, released: [] })).toBe(false);
  });
});

// ── ledger: container provenance (#178) ─────────────────────────────────────

describe('SyncLedger.adoptContainer (#184)', () => {
  let root: string, ledger: SyncLedger;

  beforeEach(() => {
    root = realpathSync(mkdirSync(join(tmpdir(), `dc-prov-${Date.now()}-${Math.random().toString(36).slice(2)}`), { recursive: true })!);
    mkdirSync(join(root, 'state'), { recursive: true });
    ledger = new SyncLedger(root);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('the first stamp is not a switch (nothing to invalidate)', () => {
    ledger.writeListStatuses(['to do', 'complete']);
    const r = ledger.adoptContainer('list:1');
    expect(r).toEqual({ switched: false, from: null });
    // A first-ever stamp must not throw away a cache the backend just filled.
    expect(ledger.readListStatuses()).toEqual(['to do', 'complete']);
  });

  it('re-adopting the same container is a no-op (cache survives)', () => {
    ledger.adoptContainer('list:1');
    ledger.writeListStatuses(['to do', 'complete']);
    ledger.writeThrottle('lastMetaRefreshAt', 12345);
    expect(ledger.adoptContainer('list:1')).toEqual({ switched: false, from: 'list:1' });
    expect(ledger.readListStatuses()).toEqual(['to do', 'complete']);
    expect(ledger.readThrottle('lastMetaRefreshAt')).toBe(12345);
  });

  it('a switch drops the stale statuses/members/fields, the throttle, and the watermark', () => {
    ledger.adoptContainer('list:1');
    ledger.writeListStatuses(['to do', 'in progress', 'complete']);
    ledger.writeMembers({ alice: { id: '501', name: 'Alice' } });
    ledger.writeCustomFields([{ id: 'f1', name: 'Urgency' }]);
    ledger.writeThrottle('lastMetaRefreshAt', 12345);
    const st = ledger.readSyncState();
    st.watermark = 1_700_000_000_000;
    ledger.writeSyncState(st);

    expect(ledger.adoptContainer('list:2')).toEqual({ switched: true, from: 'list:1' });

    expect(ledger.readListStatuses()).toEqual([]);
    expect(ledger.readMembers()).toEqual({});
    expect(ledger.readCustomFields()).toEqual([]);
    expect(ledger.readThrottle('lastMetaRefreshAt')).toBeNull();
    // The watermark timestamps the OLD container's update axis — carrying it over
    // silently skips everything in the new one untouched since (#179).
    expect(ledger.readSyncState().watermark).toBeNull();
  });

  it('a switch preserves the id-map (a `--keep` migration must not lose its mappings)', () => {
    ledger.recordMapping({ slug: 'a', remoteId: 'r1', backend: 'clickup', dcId: 'd1' });
    ledger.adoptContainer('list:1');
    ledger.adoptContainer('list:2');
    expect(ledger.readMap().map((e) => e.slug)).toEqual(['a']);
  });
});

// ── backend: the writers that used to leak (#178) ───────────────────────────

describe('ClickUp sync target moves (#184/#178)', () => {
  const baseConfig = (listId: string): SetupConfig => ({
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0',
    disableNativeMemory: true, taskBackend: 'clickup', cloudTaskManagement: true,
    clickup: { teamId: 'team1', spaceId: 'space1', listId, changelogTarget: 'comments' },
    people: [], peopleIdentity: {},
  });

  let projectRoot: string, contextRoot: string, fake: FakeClickUp, clock: number;

  function makeBackend(listId: string): ClickUpTaskBackend {
    clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    const adapter = new ApiAdapter({
      baseUrl: 'https://api.clickup.com/api/v2',
      authHeaders: () => ({ Authorization: 'pk_test' }),
      fetchImpl: fake.fetchImpl, now, sleep,
    });
    return new ClickUpTaskBackend(contextRoot, baseConfig(listId), { adapter, now, sleep });
  }

  beforeEach(() => {
    delete process.env.DREAMCONTEXT_PERSON;
    const raw = join(tmpdir(), `dc-prov-cu-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    fake = makeFakeClickUp();
  });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  const cachedStatuses = () => new SyncLedger(contextRoot).readListStatuses();

  it('repointing the list WITHOUT resetting the ledger drops the old list\'s cached statuses', async () => {
    // This is the `--keep` / dashboard-PATCH / hand-edited-config shape: the
    // config moves but nothing calls SyncLedger.reset(). Before #184 the cache
    // survived and every status mapped against the OLD list's set.
    const a = makeBackend('list1');
    await a.create({ name: 'Some Task', variant: 'cli' });
    await a.sync('both');
    expect(cachedStatuses()).toEqual(['to do', 'in progress', 'review', 'complete']);

    // The new list inherited the Space defaults — a totally different set.
    fake.listStatuses = ['backlog', 'do', 'project', 'complete'];
    const b = makeBackend('list2');
    const report = await b.sync('pull');

    expect(cachedStatuses()).toEqual(['backlog', 'do', 'project', 'complete']);
    expect(report.warnings.some((w) => w.includes('sync target moved'))).toBe(true);
  });

  it('the ledger records the container, so a same-target sync keeps its cache', async () => {
    const a = makeBackend('list1');
    await a.sync('both');
    expect(new SyncLedger(contextRoot).readSyncState().container).toBe('list:list1');
    const b = makeBackend('list1');
    await b.sync('pull');
    expect(cachedStatuses()).toEqual(['to do', 'in progress', 'review', 'complete']);
  });

  it('a status the list cannot represent WARNS instead of silently landing in the first open status', async () => {
    // The reported symptom: every non-completed task landed in 'backlog'. The
    // push genuinely cannot do better — but it must not stay quiet.
    fake.listStatuses = ['backlog', 'someday', 'complete'];
    const backend = makeBackend('list1');
    await backend.create({ name: 'Review Me', variant: 'cli', status: 'in_review' });
    const report = await backend.sync('push');

    const warned = report.warnings.find((w) => w.includes("status 'in_review' matches none"));
    expect(warned).toBeTruthy();
    expect(warned).toContain('backlog, someday, complete');
    expect(warned).toContain('--refresh-meta');
  });

  it('--refresh-meta re-reads statuses the hourly throttle would otherwise hide', async () => {
    const backend = makeBackend('list1');
    await backend.sync('both');
    expect(cachedStatuses()).toEqual(['to do', 'in progress', 'review', 'complete']);

    // The user adds the missing status in the ClickUp UI. The throttle has not
    // lapsed, so a plain sync keeps mapping against the hour-old set.
    fake.listStatuses = ['to do', 'in progress', 'in review', 'complete'];
    const plain = makeBackend('list1');
    await plain.sync('pull');
    expect(cachedStatuses()).toEqual(['to do', 'in progress', 'review', 'complete']);

    const forced = makeBackend('list1');
    await forced.sync('pull', { refreshMeta: true });
    expect(cachedStatuses()).toEqual(['to do', 'in progress', 'in review', 'complete']);
  });
});

// ── backend: a target switch must never delete local mirrors (task_NL91yjF2) ─

describe('ClickUp target switch never deletes local mirrors (task_NL91yjF2)', () => {
  const baseConfig = (listId: string): SetupConfig => ({
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0',
    disableNativeMemory: true, taskBackend: 'clickup', cloudTaskManagement: true,
    clickup: { teamId: 'team1', spaceId: 'space1', listId, changelogTarget: 'comments' },
    people: [], peopleIdentity: {},
  });

  let projectRoot: string, contextRoot: string, fake: FakeClickUp, clock: number;

  function makeBackend(listId: string): ClickUpTaskBackend {
    clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    const adapter = new ApiAdapter({
      baseUrl: 'https://api.clickup.com/api/v2',
      authHeaders: () => ({ Authorization: 'pk_test' }),
      fetchImpl: fake.fetchImpl, now, sleep,
    });
    return new ClickUpTaskBackend(contextRoot, baseConfig(listId), { adapter, now, sleep });
  }

  const mirrorExists = (slug: string) => existsSync(join(contextRoot, 'state', `${slug}.md`));
  const readMap = () => new SyncLedger(contextRoot).readMap();
  const remoteIdOf = (slug: string) => readMap().find((e) => e.slug === slug)?.remoteId ?? null;

  beforeEach(() => {
    delete process.env.DREAMCONTEXT_PERSON;
    const raw = join(tmpdir(), `dc-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    fake = makeFakeClickUp();
  });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it('repointing at a DIFFERENT list keeps the mirrors (not delete) and re-creates them in the new list', async () => {
    // Seed two tasks in list1 and sync them out.
    const a = makeBackend('list1');
    await a.create({ name: 'Task One', variant: 'cli' });
    await a.create({ name: 'Task Two', variant: 'cli' });
    await a.sync('both');
    expect(readMap().map((e) => e.slug).sort()).toEqual(['task-one', 'task-two']);
    const oldIds = new Set([remoteIdOf('task-one'), remoteIdOf('task-two')]);

    // Repoint at a genuinely different, EMPTY list without resetting the ledger —
    // the `--keep` / dashboard-PATCH / hand-edited-config shape. Before the fix
    // the deletion sweep read the stale old-list mappings as remote deletions and
    // nuked every mirror; now they are kept and re-created in the new list.
    const b = makeBackend('list2');
    const report = await b.sync('both');

    expect(report.errors).toEqual([]);
    expect(report.mirrorDeleted).toBe(0);
    expect(report.mirrorRemapped).toBe(2);
    // Mirrors survive on disk.
    expect(mirrorExists('task-one')).toBe(true);
    expect(mirrorExists('task-two')).toBe(true);
    // …and were re-created in the NEW list (fresh ids, in list2).
    expect(report.created).toBe(2);
    for (const slug of ['task-one', 'task-two']) {
      const id = remoteIdOf(slug)!;
      expect(oldIds.has(id)).toBe(false);
      expect(fake.tasks.get(id)?.listId).toBe('list2');
    }
    // The one-shot remap intent is consumed.
    expect(new SyncLedger(contextRoot).pendingContainerRemap()).toBe(false);
  });

  it('a genuine ClickUp move (`--keep` truthful — same ids in the new list) preserves the mappings', async () => {
    const a = makeBackend('list1');
    await a.create({ name: 'Moved Task', variant: 'cli' });
    await a.sync('both');
    const id = remoteIdOf('moved-task')!;

    // The task really was moved within ClickUp: same task id, now living in list2.
    fake.tasks.get(id)!.listId = 'list2';

    const b = makeBackend('list2');
    const report = await b.sync('both');

    expect(report.errors).toEqual([]);
    expect(report.mirrorDeleted).toBe(0);
    // Present in the new list → not stale → mapping kept, id unchanged.
    expect(report.mirrorRemapped).toBe(0);
    expect(remoteIdOf('moved-task')).toBe(id);
    expect(mirrorExists('moved-task')).toBe(true);
  });

  it('the remap intent survives a switch sync that dies mid-pull (a later sync still keeps, not deletes)', async () => {
    const a = makeBackend('list1');
    await a.create({ name: 'Fragile Task', variant: 'cli' });
    await a.sync('both');

    // Switch the target, but the network dies before the pull can reconcile.
    fake.setFailMode({ kind: 'network' });
    const b = makeBackend('list2');
    await b.sync('both'); // sync swallows the failure — must not delete anything
    expect(mirrorExists('fragile-task')).toBe(true);
    // The persisted intent is what stops the NEXT (non-switch) sync from mistaking
    // the still-stale map for a mass remote deletion.
    expect(new SyncLedger(contextRoot).pendingContainerRemap()).toBe(true);

    // Network recovers. This sync sees no container switch, but the intent persists.
    fake.setFailMode(null);
    const c = makeBackend('list2');
    const report = await c.sync('both');

    expect(report.errors).toEqual([]);
    expect(report.mirrorDeleted).toBe(0);
    expect(report.mirrorRemapped).toBe(1);
    expect(mirrorExists('fragile-task')).toBe(true);
    expect(fake.tasks.get(remoteIdOf('fragile-task')!)?.listId).toBe('list2');
    expect(new SyncLedger(contextRoot).pendingContainerRemap()).toBe(false);
  });

  it('an ORDINARY remote deletion (no switch) still removes the mirror', async () => {
    const a = makeBackend('list1');
    await a.create({ name: 'Doomed Task', variant: 'cli' });
    await a.sync('both');
    const id = remoteIdOf('doomed-task')!;

    // Delete it remotely (no target switch), then sync the SAME list.
    fake.tasks.delete(id);
    const b = makeBackend('list1');
    const report = await b.sync('both');

    expect(report.mirrorRemapped).toBe(0);
    expect(report.mirrorDeleted).toBe(1);
    expect(mirrorExists('doomed-task')).toBe(false);
  });
});

// ── backend: version round-trip + reconcile (#179) ──────────────────────────

describe('ClickUp version round-trip (#184/#179)', () => {
  const SPRINT = 'S5 (Jul 13 - Jul 17)';

  const CONFIG: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0',
    disableNativeMemory: true, taskBackend: 'clickup', cloudTaskManagement: true,
    clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' },
    people: [], peopleIdentity: {},
  };

  let projectRoot: string, contextRoot: string, fake: FakeClickUp, backend: ClickUpTaskBackend, clock: number;

  function makeBackend(): ClickUpTaskBackend {
    clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    const adapter = new ApiAdapter({
      baseUrl: 'https://api.clickup.com/api/v2',
      authHeaders: () => ({ Authorization: 'pk_test' }),
      fetchImpl: fake.fetchImpl, now, sleep,
    });
    return new ClickUpTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
  }

  const mirror = (slug: string) => readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
  /** The task's version as DATA — quoting differs between locally-authored and pull-rendered mirrors. */
  const versionOf = (slug: string): string | null =>
    (matter(mirror(slug)).data.version as string | null) ?? null;
  const remoteIdOf = (slug: string) =>
    JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-map.json'), 'utf-8'))
      .find((e: { slug: string }) => e.slug === slug).remoteId;

  function jamWatermarkAhead(): void {
    const p = join(contextRoot, 'state', '.tasks-sync.json');
    const st = JSON.parse(readFileSync(p, 'utf-8'));
    st.watermark = 2_000_000_000_000;
    writeFileSync(p, JSON.stringify(st, null, 2));
  }

  /** ClickUp lowercases tag names — the fake doesn't, so do it explicitly. */
  function addLowercasedVersionTag(remoteId: string, version: string): void {
    const task = fake.tasks.get(remoteId)!;
    fake.editTask(remoteId, { tags: [...task.tags, { name: `version:${version}`.toLowerCase() }] });
  }

  beforeEach(() => {
    delete process.env.DREAMCONTEXT_PERSON;
    const raw = join(tmpdir(), `dc-prov-ver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'core'), { recursive: true });
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    // The canonical spellings live in RELEASES.json — that IS the known set.
    writeFileSync(
      join(contextRoot, 'core', 'RELEASES.json'),
      JSON.stringify([{ version: SPRINT, status: 'planning', summary: 'sprint 5', date: '2026-07-13' }], null, 2),
    );
    writeFileSync(
      join(contextRoot, 'state', '.active-version.json'),
      JSON.stringify({ active_planning_version: SPRINT }, null, 2),
    );
    fake = makeFakeClickUp();
    backend = makeBackend();
  });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it("a version lowercased by ClickUp comes back canonical, not as 's5 (jul 13 - jul 17)'", async () => {
    await backend.create({ name: 'Sprint Task', variant: 'cli', version: SPRINT });
    await backend.sync('both');

    // Simulate the real round trip: ClickUp stores the tag lowercased.
    const id = remoteIdOf('sprint-task');
    fake.editTask(id, { tags: [{ name: `version:${SPRINT}`.toLowerCase() }] });
    await makeBackend().sync('pull');

    // Before #184 this landed as the lowercased string, which no longer matched
    // active_planning_version and dropped the task off the Current Sprint board.
    expect(versionOf('sprint-task')).toBe(SPRINT);
  });

  it('a version tag added in ClickUp below the watermark: a normal pull misses it, --reconcile heals it', async () => {
    await backend.create({ name: 'Imported Task', variant: 'cli' });
    await backend.sync('both');
    expect(versionOf('imported-task')).toBeNull();

    // Tagged in the ClickUp UI after import, then the watermark moves past it.
    addLowercasedVersionTag(remoteIdOf('imported-task'), SPRINT);
    jamWatermarkAhead();

    // The gap: the delta pull never revisits it.
    const plain = await makeBackend().sync('pull');
    expect(plain.errors).toEqual([]);
    expect(plain.reconciled).toBe(0);
    expect(versionOf('imported-task')).toBeNull();

    // --reconcile heals it, canonically.
    const healed = await makeBackend().sync('pull', { reconcile: true });
    expect(healed.errors).toEqual([]);
    expect(healed.reconciled).toBe(1);
    expect(versionOf('imported-task')).toBe(SPRINT);

    // Idempotent: a second reconcile finds nothing left to do.
    const again = await makeBackend().sync('pull', { reconcile: true });
    expect(again.errors).toEqual([]);
    expect(again.reconciled).toBe(0);
  });

  it('--reconcile does NOT overwrite a version the local task already has', async () => {
    await backend.create({ name: 'Owned Task', variant: 'cli', version: 'v0.18.0' });
    await backend.sync('both');
    addLowercasedVersionTag(remoteIdOf('owned-task'), SPRINT);
    jamWatermarkAhead();

    const report = await makeBackend().sync('pull', { reconcile: true });
    expect(report.errors).toEqual([]);
    // Real divergence belongs to the normal merge, not to a silent adopt.
    expect(versionOf('owned-task')).toBe('v0.18.0');
  });

  it('both reconcile passes share ONE full list fetch (the cost that makes it opt-in)', async () => {
    await backend.create({ name: 'Shared Fetch', variant: 'cli' });
    await backend.sync('both');

    // Drive the two passes directly rather than diffing whole syncs: the pull leg
    // does its own list fetches AND its deletion sweep is time-throttled, so a
    // sync-level count measures the throttle as much as the thing under test.
    const b = makeBackend() as unknown as {
      reconcileAssignees: (r: SyncReport) => Promise<void>;
      reconcileVersions: (r: SyncReport) => Promise<void>;
    };
    const report = { errors: [], warnings: [], reconciled: 0 } as unknown as SyncReport;

    fake.requests.length = 0;
    await b.reconcileAssignees(report);
    await b.reconcileVersions(report);

    expect(report.errors).toEqual([]);
    // Assignees (#78) and version (#184) are two facets of the same payload.
    const listFetches = fake.requests.filter(
      (r) => r.method === 'GET' && /^\/list\/list1\/task$/.test(r.path),
    );
    expect(listFetches.length).toBe(1);
  });
});

// ── doctor: two projects, one container (#177) ──────────────────────────────

describe('doctor — shared task container (#184/#177)', () => {
  let home: string, originalHome: string | undefined;

  /** A registered vault with a _dream_context/ and the given backend config. */
  function makeVault(name: string, cfg: Record<string, unknown>): string {
    const path = join(home, name);
    mkdirSync(join(path, '_dream_context', 'state'), { recursive: true });
    writeFileSync(
      join(path, '_dream_context', 'state', '.config.json'),
      JSON.stringify({
        platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0',
        disableNativeMemory: true, cloudTaskManagement: true, ...cfg,
      }, null, 2),
    );
    return path;
  }
  function register(paths: Array<{ name: string; path: string }>): void {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: paths }, null, 2));
  }

  beforeEach(() => {
    originalHome = process.env.HOME;
    const raw = join(tmpdir(), `dc-prov-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    home = realpathSync(raw);
    process.env.HOME = home;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  const clickup = (listId: string) => ({ taskBackend: 'clickup', clickup: { teamId: 't', spaceId: 's', listId, changelogTarget: 'comments' } });

  it('WARNS, naming the sibling, when two registered projects share one ClickUp list', () => {
    const a = makeVault('ai-bf', clickup('list-shared'));
    const b = makeVault('ai-gf', clickup('list-shared'));
    register([{ name: 'ai-bf', path: a }, { name: 'ai-gf', path: b }]);

    const [result] = checkSharedTaskContainer(join(a, '_dream_context'));
    expect(result.status).toBe('warn');
    expect(result.message).toContain('ai-gf');
    expect(result.message).toContain('list-shared');
  });

  it('passes when each project has its own list', () => {
    const a = makeVault('ai-bf', clickup('list-a'));
    const b = makeVault('ai-gf', clickup('list-b'));
    register([{ name: 'ai-bf', path: a }, { name: 'ai-gf', path: b }]);

    const [result] = checkSharedTaskContainer(join(a, '_dream_context'));
    expect(result.status).toBe('ok');
  });

  it('catches a shared GitHub repo on the same footing', () => {
    const cfg = { taskBackend: 'github', github: { owner: 'acme', repo: 'monorepo' } };
    const a = makeVault('svc-a', cfg);
    const b = makeVault('svc-b', cfg);
    register([{ name: 'svc-a', path: a }, { name: 'svc-b', path: b }]);

    const [result] = checkSharedTaskContainer(join(a, '_dream_context'));
    expect(result.status).toBe('warn');
    expect(result.message).toContain('svc-b');
  });

  it('is silent for a local backend and for a lone registered project', () => {
    const local = makeVault('solo', { taskBackend: 'local' });
    register([{ name: 'solo', path: local }, { name: 'other', path: makeVault('other', clickup('x')) }]);
    expect(checkSharedTaskContainer(join(local, '_dream_context'))).toEqual([]);

    const only = makeVault('only', clickup('list-1'));
    register([{ name: 'only', path: only }]);
    expect(checkSharedTaskContainer(join(only, '_dream_context'))).toEqual([]);
  });
});
