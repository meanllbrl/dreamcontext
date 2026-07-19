import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';

import { ClickUpTaskBackend } from '../../src/lib/task-backend/clickup.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';
import {
  projectScopeId,
  projectTag,
  parseProjectTag,
  stripProjectTags,
  foreignProjectOf,
  PROJECT_TAG_PREFIX,
} from '../../src/lib/task-backend/provenance.js';
import { tagsFromClickUp } from '../../src/lib/task-backend/clickup-map.js';
import { toTaskRecord } from '../../src/lib/task-query.js';
import { makeFakeClickUp, type FakeClickUp, type FakeTask } from './clickup-fake.js';

/**
 * #177 — project provenance on synced tasks. A shared ClickUp list must never
 * present a sibling project's rows as native: they carry a `dcproject:` stamp on
 * the wire, become a `source_project` frontmatter field on pull, and can be
 * skipped outright under `scope: 'project'`.
 */

// ── Pure layer ──────────────────────────────────────────────────────────────

describe('provenance: projectScopeId derivation', () => {
  const base: SetupConfig = {
    platforms: [], packs: [], multiProduct: false, setupVersion: '0', disableNativeMemory: true,
  };

  it('prefers an explicit projectId (slugified)', () => {
    expect(projectScopeId({ ...base, projectId: 'Acme API' }, '/tmp/whatever')).toBe('acme-api');
  });

  it('derives from the first linkedRepos URL when no projectId', () => {
    expect(
      projectScopeId(
        { ...base, linkedRepos: [{ name: 'api', gitRemoteUrl: 'https://github.com/acme/backend.git' }] },
        '/tmp/whatever',
      ),
    ).toBe('acme-backend');
  });

  it('falls back to the project folder basename', () => {
    expect(projectScopeId(base, '/home/me/projects/My_Repo')).toBe('my-repo');
    expect(projectScopeId(base, '/home/me/projects/My_Repo/')).toBe('my-repo');
  });

  it('explicit projectId outranks linkedRepos', () => {
    expect(
      projectScopeId(
        { ...base, projectId: 'pinned', linkedRepos: [{ name: 'a', gitRemoteUrl: 'https://github.com/x/y.git' }] },
        '/tmp/z',
      ),
    ).toBe('pinned');
  });
});

describe('provenance: tag helpers', () => {
  it('projectTag / parseProjectTag round-trip and fold case', () => {
    expect(projectTag('acme-api')).toBe(`${PROJECT_TAG_PREFIX}acme-api`);
    expect(parseProjectTag(['a', 'dcproject:acme-api', 'b'])).toBe('acme-api');
    // ClickUp lowercases tags — the prefix match is case-insensitive, value folded.
    expect(parseProjectTag(['DCPROJECT:Acme-API'])).toBe('acme-api');
    expect(parseProjectTag(['no-stamp'])).toBe(null);
  });

  it('stripProjectTags removes only the stamp', () => {
    expect(stripProjectTags(['keep', 'dcproject:x', 'also'])).toEqual(['keep', 'also']);
  });

  it('foreignProjectOf: only a DIFFERENT stamp is foreign', () => {
    expect(foreignProjectOf(['dcproject:other'], 'mine')).toBe('other');
    expect(foreignProjectOf(['dcproject:mine'], 'mine')).toBe(null);   // our own → native
    expect(foreignProjectOf(['no-stamp'], 'mine')).toBe(null);          // unstamped → native
    expect(foreignProjectOf(['dcproject:Other'], 'mine')).toBe('other'); // case-folded
  });
});

describe('provenance: tagsFromClickUp strips the stamp and returns project', () => {
  it('splits version / project / plain tags', () => {
    const res = tagsFromClickUp([
      { name: 'backend' },
      { name: 'version:S5' },
      { name: 'dcproject:acme-api' },
    ]);
    expect(res.tags).toEqual(['backend']);
    expect(res.version).toBe('S5');
    expect(res.project).toBe('acme-api');
  });

  it('project is null when unstamped', () => {
    expect(tagsFromClickUp([{ name: 'x' }]).project).toBe(null);
  });
});

describe('provenance: toTaskRecord surfaces source_project', () => {
  it('parses source_project, defaulting to null', () => {
    expect(toTaskRecord({ source_project: 'sibling' }, 'slug').source_project).toBe('sibling');
    expect(toTaskRecord({}, 'slug').source_project).toBe(null);
  });
});

// ── Sync layer (fake transport) ──────────────────────────────────────────────

const CONFIG: SetupConfig = {
  platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true,
  taskBackend: 'clickup', cloudTaskManagement: true,
  clickup: { teamId: 'team1', spaceId: 'space1', listId: 'list1', changelogTarget: 'comments' },
  projectId: 'my-project',
};

let projectRoot: string;
let contextRoot: string;
let fake: FakeClickUp;
let localClock: number;
let seedN = 0;

function makeBackend(config: SetupConfig = CONFIG): ClickUpTaskBackend {
  localClock = 1000;
  const now = () => (localClock += 7);
  const sleep = async () => { localClock += 1; };
  const adapter = new ApiAdapter({
    baseUrl: 'https://api.clickup.com/api/v2',
    authHeaders: () => ({ Authorization: 'pk_test' }),
    fetchImpl: fake.fetchImpl,
    now,
    sleep,
  });
  return new ClickUpTaskBackend(contextRoot, config, { adapter, now, sleep });
}

function seedRemote(name: string, tags: string[] = []): FakeTask {
  fake.advanceServer(1000);
  const id = `cu_seed_${++seedN}`;
  const task: FakeTask = {
    id,
    listId: 'list1',
    name,
    description: '## Why\n\nremote why\n',
    status: { status: 'complete' },
    priority: { id: '3' },
    tags: tags.map((name) => ({ name })),
    assignees: [],
    date_created: String(fake.serverNow()),
    date_updated: String(fake.serverNow()),
    custom_fields: [],
  };
  fake.tasks.set(id, task);
  return task;
}

function mirror(slug: string): Record<string, unknown> | null {
  const path = join(contextRoot, 'state', `${slug}.md`);
  if (!existsSync(path)) return null;
  return matter(readFileSync(path, 'utf-8')).data;
}

beforeEach(() => {
  delete process.env.DREAMCONTEXT_PERSON;
  const raw = join(tmpdir(), `dc-prov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  fake = makeFakeClickUp();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('provenance PULL: foreign vs native marking (scope: all)', () => {
  it('a foreign-stamped row is imported with source_project', async () => {
    seedRemote('Sibling Work', ['dcproject:sibling-repo']);
    const report = await makeBackend().sync('pull');
    expect(report.errors).toEqual([]);
    const fm = mirror('sibling-work');
    expect(fm).not.toBeNull();
    expect(fm!.source_project).toBe('sibling-repo');
    // the stamp is NOT leaked into the local plain tags
    expect(fm!.tags).not.toContain('dcproject:sibling-repo');
  });

  it('a row stamped with OUR own id is native (no source_project)', async () => {
    seedRemote('Our Work', ['dcproject:my-project']);
    await makeBackend().sync('pull');
    const fm = mirror('our-work')!;
    expect(fm.source_project).toBeUndefined();
  });

  it('an unstamped row is native (no false positive)', async () => {
    seedRemote('Legacy Row', []);
    await makeBackend().sync('pull');
    const fm = mirror('legacy-row')!;
    expect(fm.source_project).toBeUndefined();
  });
});

describe('provenance PULL: scope=project filter', () => {
  it('skips importing a foreign row entirely, still imports unstamped + native', async () => {
    seedRemote('Foreign One', ['dcproject:sibling-repo']);
    seedRemote('Unstamped One', []);
    seedRemote('Mine One', ['dcproject:my-project']);

    const scoped: SetupConfig = { ...CONFIG, clickup: { ...CONFIG.clickup!, scope: 'project' } };
    const report = await makeBackend(scoped).sync('pull');
    expect(report.errors).toEqual([]);

    expect(mirror('foreign-one')).toBeNull();     // dropped
    expect(mirror('unstamped-one')).not.toBeNull(); // never silently dropped
    expect(mirror('mine-one')).not.toBeNull();
  });
});

describe('provenance PUSH: rows are stamped with this project id', () => {
  it('a created task carries dcproject:<id> on the remote', async () => {
    const backend = makeBackend();
    await backend.create({ name: 'Pushed Task', variant: 'cli' });
    await backend.sync('push');

    const remote = [...fake.tasks.values()].find((t) => t.name === 'Pushed Task');
    expect(remote).toBeDefined();
    expect(remote!.tags.map((t) => t.name)).toContain('dcproject:my-project');
  });
});
