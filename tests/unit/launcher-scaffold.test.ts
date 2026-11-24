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

// ─── platforms (wizard enrichment) ──────────────────────────────

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

describe('scaffoldProject — skill packs are gone', () => {
  it('an old client that still sends packs never runs install-skill', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const { runner, calls } = recordingRunner();
    await scaffoldProject(
      { mode: 'new', name: 'p', parentDir: parent, platforms: ['claude'], packs: ['growth'] } as Parameters<typeof scaffoldProject>[0],
      runner,
      home,
    );
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
  it('returns platforms (claude recommended) and no packs (skill packs are gone)', async () => {
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
    expect(body.packs).toBeUndefined();
  });
});

// ─── capture prompt (injection-safe, has the no-follow-ups injection) ──────────


// ─── C14a: the "had files" fact is taken before dreamcontext writes, the marker at registration ──

describe('scaffoldProject — the first-run marker (C14a, D12)', () => {
  it('takes "had files" before the runner\'s first call: a folder that had a README stays pending', async () => {
    const { readFirstRunMarker } = await import('../../src/lib/first-read.js');
    const proj = mkTmp('dc-proj');
    const home = mkTmp('dc-home');
    dirs.push(proj, home);
    writeFileSync(join(proj, 'README'), 'hi');
    let markerAtFirstCall: unknown = 'unset';
    const calls: string[][] = [];
    const runner: CliRunner = async (args, cwd) => {
      if (calls.length === 0) markerAtFirstCall = readFirstRunMarker(home);
      calls.push(args);
      if (args[0] === 'init') makeContext(cwd);
      if (args[0] === 'setup') {
        mkdirSync(join(cwd, '.claude'), { recursive: true });
        writeFileSync(join(cwd, '.claude', 'settings.json'), '{}');
        writeFileSync(join(cwd, 'CLAUDE.md'), '# x');
      }
    };
    await scaffoldProject({ mode: 'existing', name: 'had', projectPath: proj }, runner, home);
    expect(markerAtFirstCall).toBeNull();
    expect(readFirstRunMarker(home)?.pending).toBe(proj);
  });

  it('an empty folder gets pending null even though the runner writes files into it', async () => {
    const { readFirstRunMarker } = await import('../../src/lib/first-read.js');
    const proj = mkTmp('dc-proj');
    const home = mkTmp('dc-home');
    dirs.push(proj, home);
    const runner: CliRunner = async (args, cwd) => {
      writeFileSync(join(cwd, `written-by-${args[0]}.txt`), 'x');
      if (args[0] === 'init') makeContext(cwd);
    };
    await scaffoldProject({ mode: 'existing', name: 'empty', projectPath: proj }, runner, home);
    const m = readFirstRunMarker(home);
    expect(m).not.toBeNull();
    expect(m!.pending).toBeNull();
  });

  it('a new project under the parent is never "had files"; only the first registration writes the marker', async () => {
    const { readFirstRunMarker, firstRunMarkerPath } = await import('../../src/lib/first-read.js');
    const parent = mkTmp();
    const home = mkTmp('dc-home');
    const other = mkTmp('dc-proj');
    dirs.push(parent, home, other);
    writeFileSync(join(other, 'README'), 'hi');
    const { runner } = recordingRunner();
    await scaffoldProject({ mode: 'new', name: 'first', parentDir: parent }, runner, home);
    expect(readFirstRunMarker(home)?.pending).toBeNull();
    const before = readFileSync(firstRunMarkerPath(home), 'utf-8');
    await scaffoldProject({ mode: 'existing', name: 'second', projectPath: other }, runner, home);
    expect(readFileSync(firstRunMarkerPath(home), 'utf-8')).toBe(before);
  });

  it('a later first registration on a machine that has projects writes no marker', async () => {
    const { readFirstRunMarker } = await import('../../src/lib/first-read.js');
    const { addVault } = await import('../../src/lib/vaults.js');
    const home = mkTmp('dc-home');
    const existing = mkTmp('dc-proj');
    const proj = mkTmp('dc-proj');
    dirs.push(home, existing, proj);
    makeContext(existing);
    addVault('existing', existing, home);
    writeFileSync(join(proj, 'README'), 'hi');
    const { runner } = recordingRunner();
    await scaffoldProject({ mode: 'existing', name: 'later', projectPath: proj }, runner, home);
    expect(readFirstRunMarker(home)).toBeNull();
  });
});

describe('handleLauncherRegister — writes the marker at the first registration (C14a)', () => {
  it('records pending = the real root for a folder with files, before addVault', async () => {
    const { handleLauncherRegister } = await import('../../src/server/routes/launcher.js');
    const { readFirstRunMarker } = await import('../../src/lib/first-read.js');
    const { OWNER_KEY_HEADER, setOwnerKey } = await import('../../src/server/owner-key.js');
    const { Readable } = await import('node:stream');
    const home = mkTmp('dc-home');
    const proj = mkTmp('dc-proj');
    dirs.push(home, proj);
    makeContext(proj);
    writeFileSync(join(proj, 'notes.md'), 'x');
    const KEY = 'test-owner-key-0123456789abcdefghijklmnop';
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    setOwnerKey(KEY);
    try {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ name: 'reg', path: proj }))]), {
        method: 'POST',
        url: '/api/launcher/register',
        headers: { 'content-type': 'application/json', host: '127.0.0.1', [OWNER_KEY_HEADER]: KEY },
        socket: { remoteAddress: '127.0.0.1' },
      }) as any;
      let status = 0;
      const res: any = { writeHead(c: number) { status = c; }, setHeader() {}, end() {} };
      await handleLauncherRegister(req, res, {}, null);
      expect(status).toBe(200);
      expect(readFirstRunMarker(home)?.pending).toBe(proj);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      delete process.env.DREAMCONTEXT_DESKTOP;
      setOwnerKey(null);
    }
  });
});
