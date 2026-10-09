/**
 * Unit tests for the launcher quiz-onboarding scaffolder (scaffoldProject).
 *
 * Uses an INJECTED fake CLI runner (so no real `init`/`setup` child process is
 * spawned) and an injected tmp `home` (so the real ~/.dreamcontext/vaults.json is
 * never touched). Covers input validation, path-traversal rejection, the
 * idempotent already-a-vault path, and init→setup ordering.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Pass-through spies on every way a child process can start, so the pending-git test can
// prove that branch spawns neither git nor a login shell.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    exec: vi.fn(actual.exec),
    execSync: vi.fn(actual.execSync),
  };
});

import * as childProcess from 'node:child_process';
import {
  scaffoldProject,
  ScaffoldError,
  type CliRunner,
  type ScaffoldGitDeps,
} from '../../src/server/routes/launcher.js';
import { isFixActive, markFixActive, markFixDone } from '../../src/lib/onboarding/readiness.js';
import { recordPendingGitInit } from '../../src/lib/onboarding/pending-git.js';

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

  it('skips init for an already-a-dreamcontext folder but still runs setup for the chosen platforms', async () => {
    const proj = mkTmp('dc-proj');
    const home = mkTmp('dc-home');
    dirs.push(proj, home);
    makeContext(proj);
    const { runner, calls } = recordingRunner();

    const res = await scaffoldProject(
      { mode: 'existing', name: 'already', projectPath: proj, platforms: ['claude'] },
      runner,
      home,
    );

    // init is skipped (already a project); setup still runs to install the
    // platforms the user chose when connecting.
    expect(calls.some((c) => c[0] === 'init')).toBe(false);
    const setup = calls.find((c) => c[0] === 'setup');
    expect(setup).toBeTruthy();
    expect(setup![setup!.indexOf('--platforms') + 1]).toBe('claude');
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

// ─── platforms + skill packs (wizard enrichment) ──────────────────────────────

describe('scaffoldProject — platforms', () => {
  it('defaults to --platforms claude when none are given', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const { runner, calls } = recordingRunner();
    await scaffoldProject({ mode: 'new', name: 'p', parentDir: parent }, runner, home);
    const init = calls.find((c) => c[0] === 'init')!;
    const setup = calls.find((c) => c[0] === 'setup')!;
    expect(init[init.indexOf('--platforms') + 1]).toBe('claude');
    expect(setup[setup.indexOf('--platforms') + 1]).toBe('claude');
  });

  it('filters out unknown platform ids (including the now-unsupported codex)', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const { runner, calls } = recordingRunner();
    await scaffoldProject({ mode: 'new', name: 'p', parentDir: parent, platforms: ['claude', 'codex', 'bogus'] }, runner, home);
    const init = calls.find((c) => c[0] === 'init')!;
    expect(init[init.indexOf('--platforms') + 1]).toBe('claude');
  });
});

describe('scaffoldProject — skill packs', () => {
  it('runs install-skill with chosen packs AFTER setup', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const { runner, calls } = recordingRunner();
    await scaffoldProject(
      { mode: 'new', name: 'p', parentDir: parent, platforms: ['claude'], packs: ['engineering'] },
      runner,
      home,
    );
    const order = calls.map((c) => c[0]);
    expect(order).toEqual(['init', 'setup', 'install-skill']);
    const install = calls.find((c) => c[0] === 'install-skill')!;
    expect(install).toContain('engineering');
    expect(install[install.indexOf('--platforms') + 1]).toBe('claude');
  });

  it('drops unknown packs and skips install-skill when none remain', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const { runner, calls } = recordingRunner();
    await scaffoldProject(
      { mode: 'new', name: 'p', parentDir: parent, packs: ['definitely-not-a-pack'] },
      runner,
      home,
    );
    expect(calls.some((c) => c[0] === 'install-skill')).toBe(false);
  });

  it('does not run install-skill when no packs are chosen', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const { runner, calls } = recordingRunner();
    await scaffoldProject({ mode: 'new', name: 'p', parentDir: parent }, runner, home);
    expect(calls.some((c) => c[0] === 'install-skill')).toBe(false);
  });
});

// ─── parent folder auto-create, NFC, and "Track changes with Git" ─────────────

function fakeGitDeps(over: Partial<ScaffoldGitDeps> = {}): ScaffoldGitDeps & { inits: string[] } {
  const inits: string[] = [];
  return {
    gitAvailable: () => true,
    initRepo: (dir) => { inits.push(dir); mkdirSync(join(dir, '.git')); },
    isFixActive: () => false,
    recordPendingGitInit: () => true,
    ...over,
    inits,
  };
}

function spawnCallCount(): number {
  const cp = childProcess as unknown as Record<string, { mock?: { calls: unknown[] } }>;
  return ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']
    .reduce((n, k) => n + (cp[k]?.mock?.calls.length ?? 0), 0);
}

describe('scaffoldProject — parent folder', () => {
  it('creates a missing parent folder inside home (the fresh-Mac ~/projects case)', async () => {
    const home = mkTmp('dc-home');
    dirs.push(home);
    const parent = join(home, 'projects');
    expect(existsSync(parent)).toBe(false);
    const { runner } = recordingRunner();
    const res = await scaffoldProject({ mode: 'new', name: 'demo', parentDir: parent }, runner, home);
    expect(existsSync(join(parent, 'demo', '_dream_context'))).toBe(true);
    expect(res.vault.path).toBe(join(parent, 'demo'));
  });

  it('still refuses a missing parent outside home', async () => {
    const home = mkTmp('dc-home');
    const elsewhere = mkTmp('dc-elsewhere');
    dirs.push(home, elsewhere);
    const { runner } = recordingRunner();
    await expect(
      scaffoldProject({ mode: 'new', name: 'x', parentDir: join(elsewhere, 'missing') }, runner, home),
    ).rejects.toBeInstanceOf(ScaffoldError);
    expect(existsSync(join(elsewhere, 'missing'))).toBe(false);
  });

  it('NFC-normalises a Turkish name so the folder and the vault name agree', async () => {
    const parent = mkTmp();
    const home = mkTmp('dc-home');
    dirs.push(parent, home);
    const nfc = 'Öğretmen Notları';
    const { runner } = recordingRunner();
    const res = await scaffoldProject({ mode: 'new', name: nfc.normalize('NFD'), parentDir: parent }, runner, home);
    expect(res.vault.name).toBe(nfc);
    expect(res.vault.name).toBe(res.vault.name.normalize('NFC'));
    expect(res.vault.path).toBe(join(parent, nfc));
  });
});

describe('scaffoldProject — gitInit', () => {
  afterEach(() => markFixDone('git-install'));

  it('is not-requested by default and touches no git', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const deps = fakeGitDeps();
    const res = await scaffoldProject({ mode: 'new', name: 'p', parentDir: parent }, recordingRunner().runner, home, deps);
    expect(res.git).toEqual({ initialized: false, skipped: 'not-requested' });
    expect(deps.inits).toEqual([]);
  });

  it('runs git init after setup when Git is usable', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const deps = fakeGitDeps();
    const res = await scaffoldProject({ mode: 'new', name: 'p', parentDir: parent, gitInit: true }, recordingRunner().runner, home, deps);
    expect(res.git).toEqual({ initialized: true });
    expect(deps.inits).toEqual([join(parent, 'p')]);
  });

  it('reports already-repo for a folder that is already a repository', async () => {
    const proj = mkTmp('dc-proj'); const home = mkTmp('dc-home'); dirs.push(proj, home);
    mkdirSync(join(proj, '.git'));
    const deps = fakeGitDeps();
    const res = await scaffoldProject({ mode: 'existing', name: 'r', projectPath: proj, gitInit: true }, recordingRunner().runner, home, deps);
    expect(res.git).toEqual({ initialized: false, skipped: 'already-repo' });
    expect(deps.inits).toEqual([]);
  });

  it('reports no-git when Git is unusable and no Git install is running', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const deps = fakeGitDeps({ gitAvailable: () => false, isFixActive, recordPendingGitInit });
    const res = await scaffoldProject({ mode: 'new', name: 'p', parentDir: parent, gitInit: true }, recordingRunner().runner, home, deps);
    expect(res.git).toEqual({ initialized: false, skipped: 'no-git' });
    expect(existsSync(join(home, '.dreamcontext', 'onboarding.json'))).toBe(false);
  });

  it('records pending-git while a git-install run is active, spawning no git and no login shell', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    markFixActive('git-install');
    const deps = fakeGitDeps({ gitAvailable: () => false, isFixActive, recordPendingGitInit });
    const before = spawnCallCount();
    const res = await scaffoldProject({ mode: 'new', name: 'p', parentDir: parent, gitInit: true }, recordingRunner().runner, home, deps);
    expect(spawnCallCount()).toBe(before);
    expect(res.git).toEqual({ initialized: false, skipped: 'pending-git' });
    expect(deps.inits).toEqual([]);
    expect(existsSync(join(parent, 'p', '.git'))).toBe(false);
    const record = JSON.parse(readFileSync(join(home, '.dreamcontext', 'onboarding.json'), 'utf-8'));
    expect(record.pendingGitInits).toEqual([join(parent, 'p')]);
    expect(readdirSync(join(home, '.dreamcontext')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

// ─── GET /api/launcher/catalog ────────────────────────────────────────────────

describe('handleLauncherCatalog', () => {
  it('returns platforms (claude recommended) + available packs', async () => {
    const { handleLauncherCatalog } = await import('../../src/server/routes/launcher.js');
    let status = 0;
    let body: any = null;
    const res: any = {
      writeHead(code: number) { status = code; },
      setHeader() {},
      end(data: string) { try { body = JSON.parse(data); } catch { body = data; } },
    };
    await handleLauncherCatalog({} as any, res, {}, null);
    expect(status).toBe(200);
    const ids = body.platforms.map((p: any) => p.id);
    expect(ids).toContain('claude');
    const claude = body.platforms.find((p: any) => p.id === 'claude');
    expect(claude.recommended).toBe(true);
    expect(Array.isArray(body.packs)).toBe(true);
    // engineering pack ships in the repo catalog
    expect(body.packs.map((p: any) => p.name)).toContain('engineering');
  });
});

// ─── capture prompt (injection-safe, has the no-follow-ups injection) ──────────

