import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBrainRepo } from '../../src/cli/commands/doctor.js';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { buildBrainGitignore } from '../../src/lib/git-sync/brain-repo.js';

/**
 * C1 (github-cloud-collaboration-brain-repo-sync M3): `taskBackend=github`
 * means GitHub issues are the source of truth — `state/*.md` mirrors must
 * never sync into the shared brain repo. `checkBrainRepo` flags the drift
 * case: a brain repo bootstrapped/hand-edited before that gitignore entry
 * landed (or after it was removed).
 */

let projectRoot: string;
let root: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-brain-doctor-'));
  root = join(projectRoot, '_dream_context');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('checkBrainRepo — silent when not applicable', () => {
  it('returns [] when taskBackend is not github', () => {
    expect(checkBrainRepo(root)).toEqual([]);
  });

  it('returns [] under taskBackend=github when the brain is in-tree (covered elsewhere by ensureRemoteBackendGitignore)', () => {
    updateSetupConfig(projectRoot, { taskBackend: 'github' });
    expect(checkBrainRepo(root)).toEqual([]);
  });

  it('returns [] under taskBackend=github + separate mode when the brain repo has not been bootstrapped yet (no .gitignore)', () => {
    updateSetupConfig(projectRoot, { taskBackend: 'github', brainRepo: { mode: 'separate' } });
    expect(checkBrainRepo(root)).toEqual([]);
  });
});

describe('checkBrainRepo — misconfig detection (C1)', () => {
  it('FLAGS an error when the brain repo .gitignore does not exclude state/*.md', () => {
    updateSetupConfig(projectRoot, { taskBackend: 'github', brainRepo: { mode: 'separate' } });
    // A brain repo bootstrapped under taskBackend=local, THEN switched to github —
    // the gitignore never picked up the new entry (buildBrainGitignore only
    // writes once, at bootstrap).
    writeFileSync(join(root, '.gitignore'), buildBrainGitignore('local'), 'utf-8');

    const results = checkBrainRepo(root);
    expect(results.some((r) => r.name === 'Brain repo' && r.status === 'error')).toBe(true);
  });

  it('PASSES when the brain repo .gitignore correctly excludes state/*.md', () => {
    updateSetupConfig(projectRoot, { taskBackend: 'github', brainRepo: { mode: 'separate' } });
    writeFileSync(join(root, '.gitignore'), buildBrainGitignore('github'), 'utf-8');

    const results = checkBrainRepo(root);
    expect(results.some((r) => r.status === 'error')).toBe(false);
    expect(results.some((r) => r.name === 'Brain repo' && r.status === 'ok')).toBe(true);
  });
});
