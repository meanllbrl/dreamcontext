import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverVaults } from '../../src/lib/vault-discovery.js';

function makeTree(): string {
  const dir = join(tmpdir(), `dc-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a dreamcontext project (a dir holding `_dream_context/`) at `base/name`. */
function makeProject(base: string, ...segments: string[]): string {
  const dir = join(base, ...segments);
  mkdirSync(join(dir, '_dream_context'), { recursive: true });
  return dir;
}

describe('discoverVaults (federation P1.1)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTree();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds every _dream_context/ project under a tree', () => {
    const a = makeProject(root, 'projects', 'alpha');
    const b = makeProject(root, 'projects', 'beta');

    const found = discoverVaults(root);
    expect(found).toContain(a);
    expect(found).toContain(b);
    expect(found.length).toBe(2);
  });

  it('ignores a _dream_context/ buried inside node_modules (decoy)', () => {
    const real = makeProject(root, 'real');
    // A vendored copy under node_modules must never be discovered.
    makeProject(root, 'node_modules', 'some-pkg', 'fixtures', 'vendored');

    const found = discoverVaults(root);
    expect(found).toEqual([real]);
  });

  it('returns project directories (parent of _dream_context/), absolute + sorted + de-duped', () => {
    const z = makeProject(root, 'zeta');
    const a = makeProject(root, 'apple');

    const found = discoverVaults(root);
    expect(found).toEqual([a, z]); // sorted ascending
    expect(new Set(found).size).toBe(found.length); // de-duped
  });

  it('returns [] for a tree with no projects', () => {
    mkdirSync(join(root, 'empty', 'nested'), { recursive: true });
    expect(discoverVaults(root)).toEqual([]);
  });
});
