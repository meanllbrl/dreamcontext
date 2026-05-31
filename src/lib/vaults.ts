import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Vault {
  name: string;
  path: string; // resolved absolute path
}

export interface VaultRegistry {
  vaults: Vault[];
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/**
 * Returns the path to the vaults registry file.
 * Accepts an injectable `home` parameter for testability.
 */
export function vaultsFilePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'vaults.json');
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read the vault registry synchronously.
 * Missing file → [].
 * Malformed JSON → logs + [].
 * Never throws.
 */
export function listVaults(home?: string): Vault[] {
  const filePath = vaultsFilePath(home);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VaultRegistry>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.vaults)) {
      return [];
    }
    return parsed.vaults.filter(
      (v): v is Vault =>
        v !== null &&
        typeof v === 'object' &&
        typeof v.name === 'string' &&
        typeof v.path === 'string',
    );
  } catch {
    console.error('[dreamcontext] vaults.json is malformed — treating registry as empty.');
    return [];
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

function writeRegistry(filePath: string, registry: VaultRegistry): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

// ─── Add ──────────────────────────────────────────────────────────────────────

/**
 * Register a new vault.
 *
 * Validates:
 * - dirPath must exist on disk
 * - dirPath must contain a `_dream_context/` child directory
 * - name must not duplicate an existing vault name
 * - resolved path must not duplicate an existing vault path
 *
 * Throws `VaultError` on any validation failure.
 * Returns the registered `Vault` on success.
 */
export function addVault(name: string, dirPath: string, home?: string): Vault {
  const resolved = resolve(dirPath);

  // Validate existence
  if (!existsSync(resolved)) {
    throw new VaultError(`Path does not exist: ${resolved}`);
  }

  // Validate _dream_context/ child
  if (!existsSync(join(resolved, '_dream_context'))) {
    throw new VaultError(
      `Path is not a dreamcontext project (no _dream_context/ directory): ${resolved}`,
    );
  }

  const filePath = vaultsFilePath(home);
  const existing = listVaults(home);

  // Duplicate name check
  if (existing.some((v) => v.name === name)) {
    throw new VaultError(`A vault named "${name}" is already registered.`);
  }

  // Duplicate path check (compare resolved paths)
  if (existing.some((v) => resolve(v.path) === resolved)) {
    throw new VaultError(`Path is already registered: ${resolved}`);
  }

  const vault: Vault = { name, path: resolved };
  const registry: VaultRegistry = { vaults: [...existing, vault] };
  writeRegistry(filePath, registry);

  return vault;
}

// ─── Resolve ──────────────────────────────────────────────────────────────────

/**
 * Resolve a `--vault` argument (registered name or filesystem path) to the
 * absolute `_dream_context/` context root for that vault.
 *
 * Resolution order:
 * 1. If `arg` matches a registered vault name in `listVaults(home)`, use its path.
 * 2. Otherwise treat `arg` as a filesystem path and `resolve()` it.
 *
 * In both cases the resolved project directory must:
 * - exist on disk
 * - contain a `_dream_context/` child directory
 *
 * Returns `join(resolved, '_dream_context')` on success.
 * Throws `VaultError` on any validation failure.
 *
 * Injectable `home` parameter makes this fully testable without touching the
 * real `~/.dreamcontext/vaults.json`.
 */
export function resolveVaultContextRoot(arg: string, home: string = homedir()): string {
  const vaults = listVaults(home);

  // Try registered-name match first
  const named = vaults.find((v) => v.name === arg);
  const resolved = named ? named.path : resolve(arg);

  // Require the directory to exist
  if (!existsSync(resolved)) {
    throw new VaultError(`Vault path does not exist: ${resolved}`);
  }

  // Require _dream_context/ child
  if (!existsSync(join(resolved, '_dream_context'))) {
    throw new VaultError(
      `Path is not a dreamcontext project (no _dream_context/ directory): ${resolved}`,
    );
  }

  return join(resolved, '_dream_context');
}

// ─── Remove ───────────────────────────────────────────────────────────────────

/**
 * Remove a vault by name.
 * Returns true if a vault was removed, false if no vault with that name exists.
 * Never throws.
 */
export function removeVault(name: string, home?: string): boolean {
  const existing = listVaults(home);
  const index = existing.findIndex((v) => v.name === name);
  if (index === -1) return false;

  const remaining = existing.filter((_, i) => i !== index);
  const filePath = vaultsFilePath(home);
  writeRegistry(filePath, { vaults: remaining });
  return true;
}
