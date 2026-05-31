import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addVault,
  listVaults,
  removeVault,
  vaultsFilePath,
  VaultError,
  type Vault,
} from '../../src/lib/vaults.js';

function makeHome(): string {
  const raw = join(tmpdir(), `dc-vaults-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return raw;
}

/** Creates a minimal valid vault directory (with _dream_context/ child). */
function makeVaultDir(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, '_dream_context'), { recursive: true });
  return dir;
}

describe('vaultsFilePath', () => {
  it('returns path under the given home directory', () => {
    const fp = vaultsFilePath('/tmp/fakehome');
    expect(fp).toBe(join('/tmp/fakehome', '.dreamcontext', 'vaults.json'));
  });
});

describe('listVaults', () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns [] when vaults.json does not exist', () => {
    expect(listVaults(home)).toEqual([]);
  });

  it('returns [] and does NOT throw on malformed JSON', () => {
    const fp = vaultsFilePath(home);
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(fp, '{not valid json}', 'utf-8');
    expect(() => listVaults(home)).not.toThrow();
    expect(listVaults(home)).toEqual([]);
  });

  it('returns [] when JSON is valid but vaults array is missing', () => {
    const fp = vaultsFilePath(home);
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(fp, JSON.stringify({ something: 'else' }), 'utf-8');
    expect(listVaults(home)).toEqual([]);
  });

  it('returns registered vaults after addVault', () => {
    const vaultDir = makeVaultDir(home, 'project1');
    addVault('proj1', vaultDir, home);
    const all = listVaults(home);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('proj1');
  });
});

describe('addVault', () => {
  let home: string;
  let projectBase: string;

  beforeEach(() => {
    home = makeHome();
    projectBase = makeHome(); // separate area for vault dirs
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectBase, { recursive: true, force: true });
  });

  it('accepts a valid directory with _dream_context/ child', () => {
    const vaultDir = makeVaultDir(projectBase, 'valid');
    const vault = addVault('myvault', vaultDir, home);
    expect(vault.name).toBe('myvault');
    expect(vault.path).toBe(vaultDir);
  });

  it('resolves relative paths to absolute', () => {
    const vaultDir = makeVaultDir(projectBase, 'reltest');
    // addVault should resolve to the same absolute path
    const vault = addVault('reltest', vaultDir, home);
    expect(vault.path).toMatch(/^\//); // absolute path
  });

  it('writes entry with name and path to the registry file', () => {
    const vaultDir = makeVaultDir(projectBase, 'writetest');
    addVault('writetest', vaultDir, home);

    const fp = vaultsFilePath(home);
    const raw = readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.vaults).toHaveLength(1);
    expect(parsed.vaults[0].name).toBe('writetest');
    expect(typeof parsed.vaults[0].path).toBe('string');
  });

  it('writes pretty JSON with trailing newline', () => {
    const vaultDir = makeVaultDir(projectBase, 'pretty');
    addVault('pretty', vaultDir, home);

    const fp = vaultsFilePath(home);
    const raw = readFileSync(fp, 'utf-8');
    // Should end with newline
    expect(raw.endsWith('\n')).toBe(true);
    // Should be pretty-printed (contain newlines within)
    expect(raw.split('\n').length).toBeGreaterThan(2);
  });

  it('throws VaultError when path does not exist', () => {
    expect(() =>
      addVault('missing', join(projectBase, 'nonexistent'), home),
    ).toThrow(VaultError);
  });

  it('throws VaultError when path exists but has no _dream_context/ child', () => {
    const bareDir = join(projectBase, 'nodc');
    mkdirSync(bareDir, { recursive: true });
    expect(() => addVault('nodc', bareDir, home)).toThrow(VaultError);
  });

  it('throws VaultError on duplicate name', () => {
    const vault1 = makeVaultDir(projectBase, 'dup1');
    const vault2 = makeVaultDir(projectBase, 'dup2');
    addVault('samename', vault1, home);
    expect(() => addVault('samename', vault2, home)).toThrow(VaultError);
  });

  it('throws VaultError on duplicate resolved path (same dir, different call)', () => {
    const vaultDir = makeVaultDir(projectBase, 'duppath');
    addVault('first', vaultDir, home);
    expect(() => addVault('second', vaultDir, home)).toThrow(VaultError);
  });

  it('throws VaultError on duplicate path via trailing slash variant', () => {
    const vaultDir = makeVaultDir(projectBase, 'trailtest');
    addVault('first', vaultDir, home);
    // Pass path with trailing slash — resolve() normalizes it
    expect(() => addVault('second', vaultDir + '/', home)).toThrow(VaultError);
  });

  it('creates the .dreamcontext/ dir for the registry file when missing', () => {
    const vaultDir = makeVaultDir(projectBase, 'mkdirtest');
    // home has no .dreamcontext dir yet
    addVault('mkdirtest', vaultDir, home);
    expect(() => readFileSync(vaultsFilePath(home), 'utf-8')).not.toThrow();
  });

  it('returns the registered Vault object', () => {
    const vaultDir = makeVaultDir(projectBase, 'retval');
    const vault = addVault('retval', vaultDir, home);
    expect(vault).toMatchObject<Vault>({ name: 'retval', path: vaultDir });
  });
});

describe('removeVault', () => {
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

  it('returns true and removes the vault when it exists', () => {
    const vaultDir = makeVaultDir(projectBase, 'toremove');
    addVault('toremove', vaultDir, home);

    const result = removeVault('toremove', home);
    expect(result).toBe(true);
    expect(listVaults(home)).toHaveLength(0);
  });

  it('returns false when vault name is not found', () => {
    expect(removeVault('nonexistent', home)).toBe(false);
  });

  it('only removes the named vault, leaving others intact', () => {
    const v1 = makeVaultDir(projectBase, 'v1');
    const v2 = makeVaultDir(projectBase, 'v2');
    addVault('vault1', v1, home);
    addVault('vault2', v2, home);

    removeVault('vault1', home);
    const remaining = listVaults(home);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('vault2');
  });

  it('second remove of the same vault returns false', () => {
    const vaultDir = makeVaultDir(projectBase, 'doubleremove');
    addVault('dr', vaultDir, home);
    removeVault('dr', home);
    expect(removeVault('dr', home)).toBe(false);
  });
});
