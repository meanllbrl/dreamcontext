/**
 * Regression: the app-bundled CLI must report its REAL version, not '0.0.0'.
 *
 * The Tauri .app lays the CLI out as `Contents/Resources/dist/index.js` and
 * ships NO package.json at any path `readDreamcontextVersionFromDisk()` probes.
 * Every probe missed and the lookup fell through to the '0.0.0' sentinel, which
 * sorts below every migration version — so `pendingMigrations` /
 * `unfinishedAgentTasks` returned nothing and NO migration could ever fire
 * through the bundled CLI. That is the exact path `resolve_cli` takes on
 * first run, before a global npm CLI exists (desktop/src-tauri/src/lib.rs).
 *
 * Strategy: rebuild that layout in a temp dir from the real dist/index.js and
 * run the CLI out of it. Only index.js is copied — the bug is the ABSENCE of a
 * package.json, which holds either way, and copying the whole dist/ would drag
 * the dashboard bundle along for nothing.
 *
 * These tests need a CURRENT `npm run build:cli`; CI builds before vitest runs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '..', '..');
const BUILT_CLI = join(REPO_ROOT, 'dist', 'index.js');

function packageVersion(): string {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).version as string;
}

/** `<tmp>/dreamcontext-beta.app/Contents/Resources/dist/index.js` — no package.json anywhere. */
function stageAppBundle(): string {
  const dist = join(
    mkdtempSync(join(tmpdir(), 'dc-bundle-')),
    'dreamcontext-beta.app', 'Contents', 'Resources', 'dist',
  );
  mkdirSync(dist, { recursive: true });
  const cli = join(dist, 'index.js');
  copyFileSync(BUILT_CLI, cli);
  return cli;
}

function run(cli: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf-8' });
  } catch (e: unknown) {
    return (e as { stdout?: string }).stdout ?? '';
  }
}

describe('app-bundled CLI version', () => {
  beforeAll(() => {
    expect(
      existsSync(BUILT_CLI),
      'dist/index.js is missing — run `npm run build:cli` before this suite',
    ).toBe(true);
  });

  it('reports the real version from a .app layout with no package.json in sight', () => {
    const version = run(stageAppBundle(), ['--version']).trim();

    expect(version).not.toBe('0.0.0');
    expect(version).toBe(packageVersion()); // stale dist/ → rebuild with `npm run build:cli`
  });

  it('lets version-gated migrations fire through the bundled CLI', () => {
    const cli = stageAppBundle();
    const project = mkdtempSync(join(tmpdir(), 'dc-proj-'));
    mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
    // Code steps ran, the agent step never did → an unfinished agentTask, which
    // `migrations pending` exists to print. Under the '0.0.0' sentinel every
    // migration compared as NEWER than the CLI and this printed nothing.
    writeFileSync(
      join(project, '_dream_context', 'state', '.migrations.json'),
      JSON.stringify([{
        version: '0.23.0',
        step: 'people-first',
        executor: 'code',
        timestamp: '2026-07-30T00:00:00.000Z',
        filesTouched: [],
        summary: 'code steps ran',
      }]),
    );

    const out = run(cli, ['migrations', 'pending'], project);

    expect(out).toContain('distribute-user-md-residue');
    expect(out).not.toContain('No pending agent migration tasks');
  });

  it('still prefers the on-disk package.json over the build stamp', () => {
    // Load-bearing for server/lifecycle.ts's drift + upgrade-ready watches: they
    // notice an npm swap ONLY because the version is re-read from disk. A stamp
    // that won would be frozen at launch and could never report an upgrade.
    const root = mkdtempSync(join(tmpdir(), 'dc-npm-'));
    mkdirSync(join(root, 'dist'), { recursive: true });
    copyFileSync(BUILT_CLI, join(root, 'dist', 'index.js'));
    writeFileSync(
      join(root, 'package.json'),
      // `type: module` mirrors the real package and keeps node from reparsing
      // the ESM bundle as CJS (a noisy MODULE_TYPELESS_PACKAGE_JSON warning).
      JSON.stringify({ name: 'dreamcontext', version: '99.9.9', type: 'module' }),
    );

    expect(run(join(root, 'dist', 'index.js'), ['--version']).trim()).toBe('99.9.9');
  });
});
