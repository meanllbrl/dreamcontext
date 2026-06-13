/**
 * Unit tests for the launcher quiz-onboarding scaffolder (scaffoldProject).
 *
 * Uses an INJECTED fake CLI runner (so no real `init`/`setup` child process is
 * spawned) and an injected tmp `home` (so the real ~/.dreamcontext/vaults.json is
 * never touched). Covers input validation, path-traversal rejection, the
 * idempotent already-a-vault path, and init→setup ordering.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scaffoldProject, ScaffoldError, type CliRunner } from '../../src/server/routes/launcher.js';

let dirs: string[] = [];

function mkTmp(prefix = 'dc-scaffold'): string {
  const raw = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function makeContext(dir: string): void {
  mkdirSync(join(dir, '_dream_context', 'core'), { recursive: true });
  writeFileSync(join(dir, '_dream_context', 'core', '0.soul.md'), '# soul\n');
}

/** Records calls and simulates `init` by creating `_dream_context/`. */
function recordingRunner(): { runner: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CliRunner = async (args, cwd) => {
    calls.push(args);
    if (args[0] === 'init') makeContext(cwd);
  };
  return { runner, calls };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('scaffoldProject — new project', () => {
  it('creates the folder, runs init then setup, and registers the vault', async () => {
    const parent = mkTmp();
    const home = mkTmp('dc-home');
    dirs.push(parent, home);
    const { runner, calls } = recordingRunner();

    const res = await scaffoldProject(
      { mode: 'new', name: 'my-app', parentDir: parent, stack: 'TypeScript' },
      runner,
      home,
    );

    const target = join(parent, 'my-app');
    expect(existsSync(join(target, '_dream_context'))).toBe(true);
    expect(res.vault.name).toBe('my-app');
    expect(res.vault.path).toBe(target);
    expect(res.vaults.map((v) => v.name)).toContain('my-app');
    // init first (with quiz flags), then setup.
    expect(calls[0][0]).toBe('init');
    expect(calls[0]).toContain('--stack');
    expect(calls[0]).toContain('TypeScript');
    expect(calls[1][0]).toBe('setup');
  });

  it('rejects a name containing path separators', async () => {
    const parent = mkTmp();
    const home = mkTmp('dc-home');
    dirs.push(parent, home);
    const { runner } = recordingRunner();
    await expect(
      scaffoldProject({ mode: 'new', name: '../evil', parentDir: parent }, runner, home),
    ).rejects.toBeInstanceOf(ScaffoldError);
  });

  it('rejects a relative parentDir', async () => {
    const home = mkTmp('dc-home');
    dirs.push(home);
    const { runner } = recordingRunner();
    await expect(
      scaffoldProject({ mode: 'new', name: 'x', parentDir: 'relative/path' }, runner, home),
    ).rejects.toBeInstanceOf(ScaffoldError);
  });

  it('rejects a non-existent parentDir', async () => {
    const home = mkTmp('dc-home');
    dirs.push(home);
    const { runner } = recordingRunner();
    await expect(
      scaffoldProject({ mode: 'new', name: 'x', parentDir: '/no/such/parent/dir-xyz' }, runner, home),
    ).rejects.toBeInstanceOf(ScaffoldError);
  });

  it('rejects creating into a non-empty existing folder', async () => {
    const parent = mkTmp();
    const home = mkTmp('dc-home');
    dirs.push(parent, home);
    const target = join(parent, 'taken');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'README.md'), 'hi');
    const { runner } = recordingRunner();
    await expect(
      scaffoldProject({ mode: 'new', name: 'taken', parentDir: parent }, runner, home),
    ).rejects.toBeInstanceOf(ScaffoldError);
  });
});

describe('scaffoldProject — existing folder', () => {
  it('initializes a bare folder then registers it', async () => {
    const proj = mkTmp('dc-proj');
    const home = mkTmp('dc-home');
    dirs.push(proj, home);
    const { runner, calls } = recordingRunner();

    const res = await scaffoldProject(
      { mode: 'existing', name: 'legacy', projectPath: proj },
      runner,
      home,
    );

    expect(existsSync(join(proj, '_dream_context'))).toBe(true);
    expect(res.vault.path).toBe(proj);
    expect(calls[0][0]).toBe('init');
  });

  it('is idempotent when the folder is already a dreamcontext project (no scaffold)', async () => {
    const proj = mkTmp('dc-proj');
    const home = mkTmp('dc-home');
    dirs.push(proj, home);
    makeContext(proj);
    const { runner, calls } = recordingRunner();

    const res = await scaffoldProject(
      { mode: 'existing', name: 'already', projectPath: proj },
      runner,
      home,
    );

    expect(calls.length).toBe(0); // init/setup never run
    expect(res.vault.name).toBe('already');
  });

  it('rejects a non-existent projectPath', async () => {
    const home = mkTmp('dc-home');
    dirs.push(home);
    const { runner } = recordingRunner();
    await expect(
      scaffoldProject({ mode: 'existing', name: 'ghost', projectPath: '/no/such/folder-xyz' }, runner, home),
    ).rejects.toBeInstanceOf(ScaffoldError);
  });
});
