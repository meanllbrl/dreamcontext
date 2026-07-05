import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findUnreleasedTasks,
  findUnreleasedFeatures,
  findUnreleasedChangelog,
  getExistingReleases,
  getLastRelease,
} from '../../src/lib/release-discovery.js';

function makeTmpContext(): string {
  const raw = join(tmpdir(), `ac-rel-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'knowledge', 'features'), { recursive: true });
  writeFileSync(join(root, 'core', 'RELEASES.json'), '[]', 'utf-8');
  writeFileSync(join(root, 'core', 'CHANGELOG.json'), '[]', 'utf-8');
  return root;
}

describe('release-discovery', () => {
  let root: string;

  beforeEach(() => { root = makeTmpContext(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  describe('getExistingReleases', () => {
    it('returns empty array when no releases', () => {
      expect(getExistingReleases(root)).toEqual([]);
    });

    it('returns releases from RELEASES.json', () => {
      writeFileSync(join(root, 'core', 'RELEASES.json'), JSON.stringify([
        { id: 'rel_1', version: '1.0.0', date: '2026-01-01', summary: 'First', breaking: false, features: [], tasks: [], changelog: [] },
      ]), 'utf-8');
      const releases = getExistingReleases(root);
      expect(releases).toHaveLength(1);
      expect(releases[0].version).toBe('1.0.0');
    });
  });

  describe('getLastRelease', () => {
    it('returns null when no releases', () => {
      expect(getLastRelease(root)).toBeNull();
    });

    it('returns first entry (LIFO)', () => {
      writeFileSync(join(root, 'core', 'RELEASES.json'), JSON.stringify([
        { id: 'rel_2', version: '1.1.0', date: '2026-02-25', summary: 'Latest', breaking: false, features: [], tasks: [], changelog: [] },
        { id: 'rel_1', version: '1.0.0', date: '2026-02-20', summary: 'First', breaking: false, features: [], tasks: [], changelog: [] },
      ]), 'utf-8');
      const last = getLastRelease(root);
      expect(last!.version).toBe('1.1.0');
    });
  });

  describe('findUnreleasedTasks', () => {
    it('finds completed unreleased tasks', () => {
      writeFileSync(join(root, 'state', 'done-task.md'), '---\nid: "task_abc"\nname: "Done Task"\nstatus: "completed"\n---\n', 'utf-8');
      writeFileSync(join(root, 'state', 'wip-task.md'), '---\nid: "task_def"\nname: "WIP Task"\nstatus: "in_progress"\n---\n', 'utf-8');
      const tasks = findUnreleasedTasks(root);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('task_abc');
      expect(tasks[0].slug).toBe('done-task');
    });

    it('excludes tasks already in a release', () => {
      writeFileSync(join(root, 'state', 'done-task.md'), '---\nid: "task_abc"\nstatus: "completed"\n---\n', 'utf-8');
      writeFileSync(join(root, 'core', 'RELEASES.json'), JSON.stringify([
        { id: 'rel_1', version: '1.0.0', date: '2026-01-01', summary: '', breaking: false, features: [], tasks: ['task_abc'], changelog: [] },
      ]), 'utf-8');
      const tasks = findUnreleasedTasks(root);
      expect(tasks).toHaveLength(0);
    });

    it('returns empty when no state directory', () => {
      rmSync(join(root, 'state'), { recursive: true, force: true });
      expect(findUnreleasedTasks(root)).toEqual([]);
    });
  });

  describe('findUnreleasedFeatures', () => {
    it('finds features with released_version: null', () => {
      writeFileSync(join(root, 'knowledge', 'features', 'auth.md'), '---\nid: "feat_abc"\nstatus: "active"\nreleased_version: null\n---\n', 'utf-8');
      const features = findUnreleasedFeatures(root);
      expect(features).toHaveLength(1);
      expect(features[0].id).toBe('feat_abc');
      expect(features[0].slug).toBe('auth');
    });

    it('excludes features with released_version set', () => {
      writeFileSync(join(root, 'knowledge', 'features', 'old.md'), '---\nid: "feat_def"\nstatus: "active"\nreleased_version: "0.9.0"\n---\n', 'utf-8');
      const features = findUnreleasedFeatures(root);
      expect(features).toHaveLength(0);
    });

    it('returns empty when no features directory', () => {
      rmSync(join(root, 'knowledge', 'features'), { recursive: true, force: true });
      expect(findUnreleasedFeatures(root)).toEqual([]);
    });
  });

  describe('findUnreleasedChangelog', () => {
    it('finds changelog entries not in any release', () => {
      writeFileSync(join(root, 'core', 'CHANGELOG.json'), JSON.stringify([
        { date: '2026-02-25', type: 'feat', scope: 'auth', description: 'New feature', breaking: false },
        { date: '2026-02-20', type: 'fix', scope: 'ui', description: 'Old fix', breaking: false },
      ]), 'utf-8');
      writeFileSync(join(root, 'core', 'RELEASES.json'), JSON.stringify([
        {
          id: 'rel_1', version: '1.0.0', date: '2026-02-21', summary: '', breaking: false, features: [], tasks: [],
          changelog: [{ date: '2026-02-20', type: 'fix', scope: 'ui', description: 'Old fix', breaking: false }],
        },
      ]), 'utf-8');
      const entries = findUnreleasedChangelog(root);
      expect(entries).toHaveLength(1);
      expect(entries[0].entry.description).toBe('New feature');
      expect(entries[0].index).toBe(0);
    });

    it('returns all entries when no releases exist', () => {
      writeFileSync(join(root, 'core', 'CHANGELOG.json'), JSON.stringify([
        { date: '2026-02-25', type: 'feat', scope: 'a', description: 'One', breaking: false },
        { date: '2026-02-24', type: 'fix', scope: 'b', description: 'Two', breaking: false },
      ]), 'utf-8');
      const entries = findUnreleasedChangelog(root);
      expect(entries).toHaveLength(2);
    });

    it('returns empty when all changelog entries are released', () => {
      const entry = { date: '2026-02-25', type: 'feat', scope: 'a', description: 'Done', breaking: false };
      writeFileSync(join(root, 'core', 'CHANGELOG.json'), JSON.stringify([entry]), 'utf-8');
      writeFileSync(join(root, 'core', 'RELEASES.json'), JSON.stringify([
        { id: 'rel_1', version: '1.0.0', date: '2026-02-25', summary: '', breaking: false, features: [], tasks: [], changelog: [entry] },
      ]), 'utf-8');
      expect(findUnreleasedChangelog(root)).toHaveLength(0);
    });
  });
});
