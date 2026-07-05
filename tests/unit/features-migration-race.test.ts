import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Phase-2 unlink failure modes for migrateFeaturesToKnowledge. Lives in its own
// file because it mocks node:fs (unlinkSync only); everything else passes
// through to the real fs.
//
// The race being simulated: runMigrations is invoked from both update.ts and
// sleep.ts with no interprocess lock. Two concurrent runs can both verify the
// same dest and stage the same slug; the loser's phase-2 unlinkSync throws
// ENOENT. The source being gone IS the desired end state — counting it as a
// failure would spuriously pin setupVersion.
const fault = vi.hoisted(() => ({ mode: null as null | 'enoent' | 'eacces' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      if (fault.mode !== null && String(path).endsWith('.md')) {
        const mode = fault.mode;
        fault.mode = null;
        if (mode === 'enoent') {
          // The "other process" removed the source just before our unlink.
          actual.unlinkSync(path);
          const err = new Error(
            `ENOENT: no such file or directory, unlink '${String(path)}'`,
          ) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        const err = new Error(
          `EACCES: permission denied, unlink '${String(path)}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return actual.unlinkSync(path);
    },
  };
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { migrateFeaturesToKnowledge } from '../../src/lib/features-migration.js';

describe('migrateFeaturesToKnowledge — phase-2 unlink failure modes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-feat-race-'));
    fault.mode = null;
  });
  afterEach(() => {
    fault.mode = null;
    rmSync(root, { recursive: true, force: true });
  });

  function writeSource(slug: string) {
    const dir = join(root, 'core', 'features');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}.md`), '---\nid: feat_1\nstatus: planning\n---\n\nBody.\n', 'utf-8');
  }

  it('ENOENT on the phase-2 unlink (lost race) is success, not a failure', () => {
    writeSource('foo');
    fault.mode = 'enoent';

    const result = migrateFeaturesToKnowledge(root);

    expect(result.failed).toEqual([]);
    expect(result.migrated).toEqual(['foo']);
    expect(existsSync(join(root, 'core', 'features', 'foo.md'))).toBe(false);
    expect(existsSync(join(root, 'knowledge', 'features', 'foo.md'))).toBe(true);
  });

  it('a non-ENOENT unlink error is still a failure (source preserved, no rmdir)', () => {
    writeSource('foo');
    fault.mode = 'eacces';

    const result = migrateFeaturesToKnowledge(root);

    expect(result.migrated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/source unlink failed/);
    expect(existsSync(join(root, 'core', 'features', 'foo.md'))).toBe(true);
  });
});
