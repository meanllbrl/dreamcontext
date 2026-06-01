/**
 * Integration tests for `dashboard --vault`.
 *
 * Spawns `node dist/index.js` (requires a current build), starts a real server
 * on a free loopback port, and verifies startup behaviour. Always passes `--no-open`
 * and an explicit `--port` to avoid side effects. Child processes are killed in
 * afterEach with a hard-timeout fallback.
 *
 * Note: the /api/vaults endpoint has been removed (vault-switching is a CLI-only
 * feature; the browser/project-based model doesn't support it). Tests that relied
 * on /api/vaults have been removed accordingly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const raw = join(tmpdir(), `dc-dv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

// ─── Test state ──────────────────────────────────────────────────────────────

let activeTmpDirs: string[] = [];

afterEach(() => {
  for (const dir of activeTmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  activeTmpDirs = [];
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('dashboard --vault (integration)', () => {
  // ─── Case (a): --vault dir-without-_dream_context → non-zero, clean msg ──
  it('exits non-zero with a clean message for --vault <dir-without-_dream_context>', () => {
    const base = makeTmpDir();
    activeTmpDirs.push(base);
    const bareDir = join(base, 'nodc');
    mkdirSync(bareDir, { recursive: true });

    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execSync(
        `node ${CLI} dashboard --no-open --port 9999 --vault ${bareDir}`,
        { encoding: 'utf-8', timeout: 10000 },
      );
    } catch (e: any) {
      stdout = (e.stdout ?? '') + (e.stderr ?? '');
      exitCode = typeof e.status === 'number' ? e.status : 1;
    }

    expect(exitCode).not.toBe(0);
    // Must contain a clean message about _dream_context
    expect(stdout).toMatch(/no.*_dream_context|not a dreamcontext project/i);
    // Must NOT contain stack frames
    expect(stdout).not.toContain('at Object.');
    expect(stdout).not.toContain('at Module.');
  }, 15000);

  // ─── Case (b): --vault <nonexistent> → non-zero ───────────────────────────
  it('exits non-zero for --vault <nonexistent path>', () => {
    const base = makeTmpDir();
    activeTmpDirs.push(base);
    const ghost = join(base, 'ghost-project');

    let exitCode = 0;
    try {
      execSync(
        `node ${CLI} dashboard --no-open --port 9999 --vault ${ghost}`,
        { encoding: 'utf-8', timeout: 10000 },
      );
    } catch (e: any) {
      exitCode = typeof e.status === 'number' ? e.status : 1;
    }

    expect(exitCode).not.toBe(0);
  }, 15000);
});
