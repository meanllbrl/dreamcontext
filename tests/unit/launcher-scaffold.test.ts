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

  it('passes the selected platforms as a comma list', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const { runner, calls } = recordingRunner();
    await scaffoldProject({ mode: 'new', name: 'p', parentDir: parent, platforms: ['claude', 'codex'] }, runner, home);
    const init = calls.find((c) => c[0] === 'init')!;
    expect(init[init.indexOf('--platforms') + 1]).toBe('claude,codex');
  });

  it('filters out unknown platform ids', async () => {
    const parent = mkTmp(); const home = mkTmp('dc-home'); dirs.push(parent, home);
    const { runner, calls } = recordingRunner();
    await scaffoldProject({ mode: 'new', name: 'p', parentDir: parent, platforms: ['claude', 'bogus'] }, runner, home);
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
    expect(ids).toContain('codex');
    const claude = body.platforms.find((p: any) => p.id === 'claude');
    expect(claude.recommended).toBe(true);
    expect(Array.isArray(body.packs)).toBe(true);
    // engineering pack ships in the repo catalog
    expect(body.packs.map((p: any) => p.name)).toContain('engineering');
  });
});
