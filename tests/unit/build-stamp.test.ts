/**
 * kesim-geri-donus K6 (C10): the build stamp says which commit a dist came from; outside git it
 * is `sha: null`, never a failure. A symlinked stamp, or one leaving its package, is no stamp.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs build helper (tsup.config.ts imports it)
import { buildStamp, writeBuildStamp } from '../../scripts/build-stamp.mjs';
import { readBuildStamp } from '../../src/lib/super/returns.js';

let dir: string;
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'build-stamp-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('build stamp', () => {
  it('names HEAD, its branch and whether the tree was dirty', () => {
    g(dir, 'init', '-q', '-b', 'super/cut');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    g(dir, 'add', '.');
    g(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'a');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, '.gitignore'), 'dist\n');
    g(dir, 'add', '.');
    g(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'ignore');
    const s = writeBuildStamp(join(dir, 'dist'), dir);
    expect(s).toMatchObject({ sha: g(dir, 'rev-parse', 'HEAD'), branch: 'super/cut', dirty: false });
    expect(JSON.parse(readFileSync(join(dir, 'dist', 'build-commit.json'), 'utf-8')).sha).toBe(s.sha);
    expect(readBuildStamp(dir)).toMatchObject({ sha: s.sha, branch: 'super/cut', dirty: false });
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    expect(buildStamp(dir).dirty).toBe(true);
  });

  it('outside git: sha null, no failure', () => {
    mkdirSync(join(dir, 'dist'));
    const s = writeBuildStamp(join(dir, 'dist'), dir);
    expect(s.sha).toBeNull();
    expect(readBuildStamp(dir)).toMatchObject({ sha: null });
  });

  it('a symlinked stamp is no stamp', () => {
    mkdirSync(join(dir, 'dist'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'build-stamp-other-'));
    writeFileSync(join(elsewhere, 'x.json'), JSON.stringify({ sha: 'a'.repeat(40), builtAt: 'x' }));
    symlinkSync(join(elsewhere, 'x.json'), join(dir, 'dist', 'build-commit.json'));
    expect(readBuildStamp(dir)).toBeNull();
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
