import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error -- plain .mjs build script, no type declarations
import { deriveShrinkwrap, lockSyncProblems, ShrinkwrapSyncError, SHRINKWRAP_FILE } from '../../scripts/shrinkwrap.mjs';

const REPO = resolve(__dirname, '../..');
const SCRIPT = join(REPO, 'scripts/shrinkwrap.mjs');

function fixture() {
  const pkg = {
    name: 'sample-cli',
    version: '1.2.3',
    dependencies: { alpha: '^1.0.0' },
    optionalDependencies: { beta: '^2.0.0' },
    devDependencies: { gamma: '^3.0.0' },
  };
  const lock = {
    name: 'sample-cli',
    version: '1.2.2',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'sample-cli', version: '1.2.2', dependencies: { alpha: '^1.0.0' }, optionalDependencies: { beta: '^2.0.0' }, devDependencies: { gamma: '^3.0.0' } },
      'node_modules/alpha': { version: '1.0.4', resolved: 'https://registry.example/alpha-1.0.4.tgz', integrity: 'sha512-a' },
      'node_modules/beta': { version: '2.0.1', optional: true },
      'node_modules/gamma': { version: '3.1.0', dev: true },
      'node_modules/gamma/node_modules/delta': { version: '0.1.0', dev: true },
      'node_modules/shared': { version: '4.0.0', devOptional: true },
      'dashboard': { name: 'dashboard', version: '0.0.0' },
    },
  };
  return { pkg, lock };
}

describe('deriveShrinkwrap', () => {
  it('copies every installable entry with its exact resolved version and flags', () => {
    const { pkg, lock } = fixture();
    const sw = deriveShrinkwrap(pkg, lock);
    expect(sw.name).toBe('sample-cli');
    expect(sw.lockfileVersion).toBe(3);
    expect(sw.packages['node_modules/alpha']).toEqual(lock.packages['node_modules/alpha']);
    expect(sw.packages['node_modules/beta']).toEqual({ version: '2.0.1', optional: true });
  });

  it('keeps dev entries only flagged dev, so consumer installs omit them', () => {
    const { pkg, lock } = fixture();
    const sw = deriveShrinkwrap(pkg, lock);
    expect(sw.packages['node_modules/gamma']).toEqual({ version: '3.1.0', dev: true });
    expect(sw.packages['node_modules/gamma/node_modules/delta'].dev).toBe(true);
    expect(sw.packages['node_modules/shared'].devOptional).toBe(true);
    for (const [path, entry] of Object.entries<any>(sw.packages)) {
      if (path === '' || path === 'node_modules/alpha' || path === 'node_modules/beta') continue;
      expect(entry.dev || entry.devOptional, path).toBe(true);
    }
  });

  it('drops in-repo workspace entries and stamps package.json version on the root', () => {
    const { pkg, lock } = fixture();
    const sw = deriveShrinkwrap(pkg, lock);
    expect(sw.packages.dashboard).toBeUndefined();
    expect(sw.version).toBe('1.2.3');
    expect(sw.packages[''].version).toBe('1.2.3');
    expect(sw.packages[''].dependencies).toEqual(pkg.dependencies);
  });

  it('fails loudly when a dependency range differs from the lock', () => {
    const { pkg, lock } = fixture();
    pkg.dependencies.alpha = '^1.1.0';
    expect(() => deriveShrinkwrap(pkg, lock)).toThrow(ShrinkwrapSyncError);
    expect(() => deriveShrinkwrap(pkg, lock)).toThrow(/dependencies: .*alpha.*\^1\.1\.0/);
  });

  it('fails when package.json adds a dependency the lock never installed', () => {
    const { pkg, lock } = fixture();
    (pkg.dependencies as Record<string, string>).epsilon = '^1.0.0';
    lock.packages[''].dependencies = { ...pkg.dependencies };
    const problems = lockSyncProblems(pkg, lock);
    expect(problems).toEqual(['dependencies.epsilon: no node_modules/epsilon entry in package-lock.json']);
  });

  it('fails when a devDependency drifts, or a production dep is locked as dev', () => {
    const { pkg, lock } = fixture();
    pkg.devDependencies.gamma = '^3.2.0';
    (lock.packages['node_modules/alpha'] as any).dev = true;
    const problems = lockSyncProblems(pkg, lock).join('\n');
    expect(problems).toMatch(/devDependencies:/);
    expect(problems).toMatch(/dependencies\.alpha: package-lock\.json flags node_modules\/alpha as dev/);
  });

  it('refuses a v1 lockfile', () => {
    const { pkg } = fixture();
    expect(() => deriveShrinkwrap(pkg, { lockfileVersion: 1, dependencies: {} })).toThrow(/lockfileVersion 2 or 3/);
  });

  it('the repo itself is in sync, so `npm pack` will not fail', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
    expect(lockSyncProblems(pkg, lock)).toEqual([]);
    expect(pkg.scripts.prepack).toBe('node scripts/shrinkwrap.mjs write');
    expect(pkg.scripts.postpack).toBe('node scripts/shrinkwrap.mjs remove');
    expect(pkg.files).toContain(SHRINKWRAP_FILE);
  });
});

describe('scripts/shrinkwrap.mjs CLI', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function stage(pkg: unknown, lock: unknown) {
    dir = mkdtempSync(join(tmpdir(), 'dc-shrinkwrap-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
    return (mode: string) => spawnSync(process.execPath, [SCRIPT, mode], { cwd: dir, encoding: 'utf8' });
  }

  it('write derives the file; remove deletes it; the lock is untouched', () => {
    const { pkg, lock } = fixture();
    const run = stage(pkg, lock);
    const lockBefore = readFileSync(join(dir, 'package-lock.json'), 'utf8');
    expect(run('write').status).toBe(0);
    const sw = JSON.parse(readFileSync(join(dir, SHRINKWRAP_FILE), 'utf8'));
    expect(sw.packages['node_modules/alpha'].version).toBe('1.0.4');
    expect(run('remove').status).toBe(0);
    expect(existsSync(join(dir, SHRINKWRAP_FILE))).toBe(false);
    expect(readFileSync(join(dir, 'package-lock.json'), 'utf8')).toBe(lockBefore);
  });

  it('write exits non-zero on a mismatch and leaves no shrinkwrap behind', () => {
    const { pkg, lock } = fixture();
    pkg.optionalDependencies.beta = '^2.5.0';
    const run = stage(pkg, lock);
    writeFileSync(join(dir, SHRINKWRAP_FILE), '{"stale":true}');
    const res = run('write');
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/out of sync.*\n.*optionalDependencies/);
    expect(existsSync(join(dir, SHRINKWRAP_FILE))).toBe(false);
  });
});
