import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClickUpTaskBackend, memberSlug } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * Issue #11 follow-up — member discovery + person-tag ↔ assignee bridge.
 * NO manual peopleIdentity mapping in this config: everything resolves
 * through the member cache fetched from the remote during sync.
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

function makeBackend(): ClickUpTaskBackend {
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

function mirror(slug: string): string {
  return readFileSync(join(contextRoot, 'state', `${slug}.md`), 'utf-8');
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-cum-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeClickUp();
  backend = makeBackend();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('clickup members + person-tag assignee bridge', () => {
  it('memberSlug ascii-folds display names (Turkish chars + diacritics)', () => {
    expect(memberSlug('Mehmet Nuraydın')).toBe('mehmet-nuraydin');
    expect(memberSlug('Alice Smith')).toBe('alice-smith');
    expect(memberSlug('Şule Çağrı Öztürk')).toBe('sule-cagri-ozturk');
    expect(memberSlug('René François')).toBe('rene-francois');
  });

  it('sync fetches and caches list members in the gitignored sync state', async () => {
    await backend.sync('pull');
    const state = JSON.parse(readFileSync(join(contextRoot, 'state', '.tasks-sync.json'), 'utf-8'));
    expect(state.members['alice-smith']).toMatchObject({ id: '501', name: 'Alice Smith' });
    expect(state.members['mehmet-nuraydin']).toMatchObject({ id: '502', name: 'Mehmet Nuraydın' });
  });

  it('listMembers returns assignee candidates (slug, id, name)', async () => {
    const members = await backend.listMembers!();
    expect(members).toEqual([
      { slug: 'alice-smith', id: '501', name: 'Alice Smith', email: 'alice@example.test' },
      { slug: 'mehmet-nuraydin', id: '502', name: 'Mehmet Nuraydın', email: 'mehmet@example.test' },
    ]);
  });

  it('a person:<slug> tag drives the remote assignee on push (no manual mapping needed)', async () => {
    await backend.create({ name: 'Tagged Owner', tags: ['x', 'person:mehmet-nuraydin'], variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);

    const remote = [...fake.tasks.values()][0];
    expect(remote.assignees.map((a) => a.id)).toEqual([502]);
    // person: tags stay local — the remote has a real assignee instead.
    expect(remote.tags.map((t) => t.name)).toEqual(['x']);
  });

  it('an explicit assignee field wins over the person tag', async () => {
    await backend.create({ name: 'Field Owner', tags: ['person:mehmet-nuraydin'], variant: 'cli' });
    await backend.updateFields('field-owner', { assignee: 'alice-smith', updated_at: '2026-06-11' });
    await backend.sync('push');
    const remote = [...fake.tasks.values()][0];
    expect(remote.assignees.map((a) => a.id)).toEqual([501]);
  });

  it('an unknown person slug pushes without an assignee (no crash, no bogus id)', async () => {
    await backend.create({ name: 'Ghost Owner', tags: ['person:nobody-here'], variant: 'cli' });
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect([...fake.tasks.values()][0].assignees).toEqual([]);
  });

  it('pull maps a remote assignee to assignee field + person:<slug> tag, and stays convergent', async () => {
    await backend.create({ name: 'Assigned Remotely', variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];

    // Someone assigns it on ClickUp.
    fake.editTask(rid, { assignees: [{ id: 502 }] });
    const report = await backend.sync('both');
    expect(report.errors).toEqual([]);

    const merged = mirror('assigned-remotely');
    expect(merged).toContain('assignee: mehmet-nuraydin');
    expect(merged).toContain('person:mehmet-nuraydin');

    // Convergence: the derived person tag must not register as local drift.
    fake.requests.length = 0;
    const again = await backend.sync('both');
    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('round-trip: person tag → push assignee → remote reassign → pull updates tag', async () => {
    await backend.create({ name: 'Handover', tags: ['person:alice-smith'], variant: 'cli' });
    await backend.sync('push');
    const rid = [...fake.tasks.keys()][0];
    expect(fake.tasks.get(rid)!.assignees.map((a) => a.id)).toEqual([501]);

    // Remote hands it over to Mehmet.
    fake.editTask(rid, { assignees: [{ id: 502 }] });
    await backend.sync('both');

    const merged = mirror('handover');
    expect(merged).toContain('assignee: mehmet-nuraydin');
    expect(merged).toContain('person:mehmet-nuraydin');
    expect(merged).not.toContain('person:alice-smith');
  });
});
