import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const raw = join(tmpdir(), `dc-vcli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

/** Create a minimal valid vault directory with _dream_context/ child. */
function makeVaultDir(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, '_dream_context'), { recursive: true });
  return realpathSync(dir);
}

function run(args: string, fakeHome: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, HOME: fakeHome },
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    const stdout = (e.stdout ?? '') + (e.stderr ?? '');
    const exitCode = typeof e.status === 'number' ? e.status : 1;
    return { stdout, exitCode };
  }
}

describe('vaults CLI (integration)', () => {
  let home: string;       // fake HOME — holds ~/.dreamcontext/vaults.json
  let projectBase: string; // holds test project dirs

  beforeEach(() => {
    home = makeTmpDir();
    projectBase = makeTmpDir();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectBase, { recursive: true, force: true });
  });

  // ─── list (empty) ───────────────────────────────────────────────────────────
  it('vaults list prints (none) when registry is empty', () => {
    const { stdout, exitCode } = run('vaults list', home);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(none)');
  });

  // ─── add success ────────────────────────────────────────────────────────────
  it('vaults add registers a valid project directory', () => {
    const vaultDir = makeVaultDir(projectBase, 'myproject');
    const { stdout, exitCode } = run(`vaults add myproject ${vaultDir}`, home);

    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toMatch(/registered|success|✓/);
    expect(stdout).toContain('myproject');

    // registry file must exist under the fake HOME
    const registryPath = join(home, '.dreamcontext', 'vaults.json');
    expect(existsSync(registryPath)).toBe(true);
  });

  // ─── list after add ─────────────────────────────────────────────────────────
  it('vaults list shows the registered vault', () => {
    const vaultDir = makeVaultDir(projectBase, 'listed');
    run(`vaults add listed ${vaultDir}`, home);

    const { stdout, exitCode } = run('vaults list', home);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('listed');
    expect(stdout).not.toContain('(none)');
  });

  // ─── add rejection (non-vault dir) ─────────────────────────────────────────
  it('vaults add rejects a path without _dream_context/', () => {
    const bareDir = join(projectBase, 'bare');
    mkdirSync(bareDir, { recursive: true });

    const { stdout, exitCode } = run(`vaults add bare ${bareDir}`, home);
    expect(exitCode).not.toBe(0);
    // Clean error message, no stack trace
    expect(stdout).toMatch(/no.*_dream_context|not a dreamcontext project/i);
    expect(stdout).not.toContain('at Object.');
    expect(stdout).not.toContain('at Module.');
  });

  // ─── add rejection (missing path) ──────────────────────────────────────────
  it('vaults add rejects a path that does not exist', () => {
    const { stdout, exitCode } = run(`vaults add ghost ${join(projectBase, 'nonexistent')}`, home);
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/does not exist|not found/i);
  });

  // ─── remove success ─────────────────────────────────────────────────────────
  it('vaults remove removes an existing vault', () => {
    const vaultDir = makeVaultDir(projectBase, 'toremove');
    run(`vaults add toremove ${vaultDir}`, home);

    const { stdout: removeOut, exitCode: removeCode } = run('vaults remove toremove', home);
    expect(removeCode).toBe(0);
    expect(removeOut.toLowerCase()).toMatch(/removed|success|✓/);

    // Should be gone from list
    const { stdout: listOut } = run('vaults list', home);
    expect(listOut).toContain('(none)');
  });

  // ─── remove non-existent ────────────────────────────────────────────────────
  it('vaults remove prints not-found message for unknown vault', () => {
    const { stdout, exitCode } = run('vaults remove doesnotexist', home);
    // Non-zero exit and some indication it wasn't found
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/no vault|not found|doesnotexist/i);
  });

  // ─── add + list multiple ────────────────────────────────────────────────────
  it('vaults list shows multiple registered vaults', () => {
    const vault1 = makeVaultDir(projectBase, 'proj1');
    const vault2 = makeVaultDir(projectBase, 'proj2');
    run(`vaults add proj1 ${vault1}`, home);
    run(`vaults add proj2 ${vault2}`, home);

    const { stdout } = run('vaults list', home);
    expect(stdout).toContain('proj1');
    expect(stdout).toContain('proj2');
  });
});
