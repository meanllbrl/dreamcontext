import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverClickUpLists, ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { SyncLedger } from '../../src/lib/task-backend/sync-state.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import { makeFakeClickUp, type FakeClickUp } from './clickup-fake.js';

/**
 * Onboarding building blocks: workspace/list discovery (the picker's data)
 * and the ledger reset that powers list migration.
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

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-cob-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  localClock = 1000;
  fake = makeFakeClickUp();
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  backend = new ClickUpTaskBackend(contextRoot, CONFIG, { adapter, now, sleep });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('onboarding: workspace discovery + list-migration ledger reset', () => {
  it('discoverClickUpLists enumerates folderless AND foldered lists with full paths', async () => {
    const lists = await discoverClickUpLists('pk_test', { fetchImpl: fake.fetchImpl });
    expect(lists).toEqual([
      { teamId: 'team1', teamName: 'Fake Team', spaceId: 'space1', spaceName: 'Fake Space', listId: 'list1', listName: 'List' },
      { teamId: 'team1', teamName: 'Fake Team', spaceId: 'space1', spaceName: 'Fake Space', listId: 'list2', listName: 'Sprint 1', folderName: 'Sprint Klasoru' },
    ]);
  });

  it('ledger.reset backs up the id-map, drops sync state + queue, keeps mirrors', async () => {
    await backend.create({ name: 'Migrant', variant: 'cli' });
    await backend.sync('push');
    const ledger = new SyncLedger(contextRoot);
    expect(ledger.readMap()).toHaveLength(1);

    const { backupPath } = ledger.reset();
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
    expect(JSON.parse(readFileSync(backupPath!, 'utf-8'))).toHaveLength(1);
    expect(ledger.readMap()).toEqual([]);
    expect(ledger.readQueue()).toEqual([]);
    expect(ledger.readSyncState().tasks).toEqual({});
    // The mirror file survives — only the ledger resets.
    expect(existsSync(join(contextRoot, 'state', 'migrant.md'))).toBe(true);

    // Next sync treats the task as new → recreated remotely (migration).
    const report = await backend.sync('push');
    expect(report.errors).toEqual([]);
    expect(report.created).toBe(1);
    expect(ledger.readMap()).toHaveLength(1);
  });
});
