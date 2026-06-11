/**
 * Integration tests for setup version drift directive in generateSnapshot.
 *
 * AC2  (test: drift-directive integration 'directive present when behind / absent when equal')
 * AC3  (test: drift-directive integration 'directive survives over-budget snapshot')
 * AC6  (test: drift-directive integration 'e2e upgrade->directive->update->clean')
 *
 * Strategy: run `node dist/index.js snapshot` in a temp dir with seeded
 * _dream_context/state/.config.json setupVersion and assert directive presence.
 *
 * Integration tests require dist/ to be built first (npm run build:cli).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI_PATH = join(__dirname, '..', '..', 'dist', 'index.js');

// Read installed CLI version
const PKG = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
const INSTALLED_VERSION: string = PKG.version;

function lowerVersion(v: string): string {
  const parts = v.split('.');
  const patch = parseInt(parts[2] ?? '0', 10);
  if (patch > 0) return `${parts[0]}.${parts[1]}.${patch - 1}`;
  const minor = parseInt(parts[1] ?? '0', 10);
  if (minor > 0) return `${parts[0]}.${minor - 1}.0`;
  return '0.0.1';
}

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-drift-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

/** Scaffold a minimal _dream_context/ so snapshot doesn't exit early. */
function scaffoldContext(root: string): string {
  const ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'core', 'features'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });

  writeFileSync(
    join(ctx, 'core', '0.soul.md'),
    '---\nname: test\ntype: soul\n---\n\n## Identity\n\nTest project.\n',
  );

  return ctx;
}

/** Write a setup config with the given setupVersion. */
function seedSetupConfig(ctx: string, setupVersion: string): void {
  writeFileSync(
    join(ctx, 'state', '.config.json'),
    JSON.stringify({
      platforms: ['claude'],
      packs: [],
      multiProduct: false,
      setupVersion,
      disableNativeMemory: true,
    }, null, 2) + '\n',
  );
}

function runSnapshot(cwd: string, env?: Record<string, string>): string {
  try {
    const envString = env
      ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
      : '';
    return execSync(`${envString}node ${CLI_PATH} snapshot`, { cwd, encoding: 'utf-8' });
  } catch (e: unknown) {
    return (e as { stdout?: string }).stdout ?? '';
  }
}

function runSnapshotWithEnv(cwd: string, envVars: Record<string, string>): string {
  try {
    return execSync(`node ${CLI_PATH} snapshot`, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...envVars },
    });
  } catch (e: unknown) {
    return (e as { stdout?: string }).stdout ?? '';
  }
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI_PATH} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 60000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function scaffoldClaudeInstall(tmp: string): void {
  run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmp);
  run('install-skill --platforms claude', tmp);
}

// ─── AC2: directive present when behind / absent when equal ──────────────────

describe('drift-directive integration', () => {
  let tmpDir: string;
  let ctx: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ctx = scaffoldContext(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("directive present when behind / absent when equal", () => {
    // Seed setupVersion LOWER than installed CLI — directive should appear
    const staleVersion = lowerVersion(INSTALLED_VERSION);
    seedSetupConfig(ctx, staleVersion);

    const stalOutput = runSnapshotWithEnv(tmpDir, {});
    expect(stalOutput).toContain('⚠ Stale Project Assets');
    expect(stalOutput).toMatch(/dreamcontext update/);

    // Now seed setupVersion EQUAL to installed CLI — directive should be absent
    seedSetupConfig(ctx, INSTALLED_VERSION);

    const currentOutput = runSnapshotWithEnv(tmpDir, {});
    expect(currentOutput).not.toContain('⚠ Stale Project Assets');
  });

  // AC3: directive survives over-budget snapshot (neverEvict tier)
  it("directive survives over-budget snapshot", () => {
    const staleVersion = lowerVersion(INSTALLED_VERSION);
    seedSetupConfig(ctx, staleVersion);

    // Add a large body to push snapshot over budget by writing a large memory file
    // This forces the budget demotion ladder to engage
    const bigContent = Array(300).fill('- This is a very long knowledge entry that adds many tokens to the snapshot output and should trigger budget demotion logic in the snapshot budget module.').join('\n');
    writeFileSync(
      join(ctx, 'core', '2.memory.md'),
      `# Memory\n\n## Technical Decisions\n\n${bigContent}\n`,
    );

    // Set a very small budget (500 tokens) to force demotions
    const output = runSnapshotWithEnv(tmpDir, { DREAMCONTEXT_SNAPSHOT_BUDGET: '500' });

    // Directive must survive despite over-budget (it's in the neverEvict tier)
    expect(output).toContain('⚠ Stale Project Assets');
    expect(output).toMatch(/dreamcontext update/);
  });

  // AC6: e2e upgrade -> directive -> update -> clean
  it("e2e upgrade->directive->update->clean", () => {
    // Use a real scaffolded project
    const e2eDir = makeTmpDir();
    try {
      scaffoldClaudeInstall(e2eDir);
      const configPath = join(e2eDir, '_dream_context', 'state', '.config.json');
      expect(existsSync(configPath)).toBe(true);

      // Seed stale setupVersion below installed
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      config.setupVersion = lowerVersion(INSTALLED_VERSION);
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

      // 1. Snapshot shows directive
      const snapshotBefore = runSnapshotWithEnv(e2eDir, {});
      expect(snapshotBefore).toContain('⚠ Stale Project Assets');
      expect(snapshotBefore).toMatch(/dreamcontext update/);

      // 2. Run real dreamcontext update
      run('update --yes', e2eDir);

      // 3. Next snapshot is clean (no directive)
      const snapshotAfter = runSnapshotWithEnv(e2eDir, {});
      expect(snapshotAfter).not.toContain('⚠ Stale Project Assets');
    } finally {
      rmSync(e2eDir, { recursive: true, force: true });
    }
  });
});
