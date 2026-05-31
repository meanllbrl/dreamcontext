import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault, resolveVaultContextRoot, VaultError } from '../../src/lib/vaults.js';

function makeHome(): string {
  const raw = join(tmpdir(), `dc-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return raw;
}

/** Creates a minimal valid project directory (with _dream_context/ child). */
function makeVaultDir(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, '_dream_context'), { recursive: true });
  return dir;
}

describe('resolveVaultContextRoot', () => {
  let home: string;
  let projectBase: string;

  beforeEach(() => {
    home = makeHome();
    projectBase = makeHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectBase, { recursive: true, force: true });
  });

  // ─── Case 1: valid filesystem path ─────────────────────────────────────────
  it('returns <path>/_dream_context for a valid project path', () => {
    const vaultDir = makeVaultDir(projectBase, 'myproject');
    const result = resolveVaultContextRoot(vaultDir, home);
    expect(result).toBe(join(vaultDir, '_dream_context'));
  });

  // ─── Case 2: registered vault name ─────────────────────────────────────────
  it('resolves a registered vault name to its _dream_context directory', () => {
    const vaultDir = makeVaultDir(projectBase, 'named');
    addVault('myname', vaultDir, home);

    const result = resolveVaultContextRoot('myname', home);
    expect(result).toBe(join(vaultDir, '_dream_context'));
  });

  // ─── Case 3: nonexistent path ──────────────────────────────────────────────
  it('throws VaultError for a path that does not exist', () => {
    const nonexistent = join(projectBase, 'ghost-project');
    expect(() => resolveVaultContextRoot(nonexistent, home)).toThrow(VaultError);
  });

  // ─── Case 4: path exists but has no _dream_context/ ────────────────────────
  it('throws VaultError for a directory without _dream_context/', () => {
    const bareDir = join(projectBase, 'bare');
    mkdirSync(bareDir, { recursive: true });
    expect(() => resolveVaultContextRoot(bareDir, home)).toThrow(VaultError);
  });

  // ─── Case 5: unknown name that is also not a valid path ────────────────────
  it('throws VaultError for an unknown name that is not a valid filesystem path', () => {
    // Using a name that won't exist as a directory
    expect(() => resolveVaultContextRoot('no-such-registered-name', home)).toThrow(VaultError);
  });
});
