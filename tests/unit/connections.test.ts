import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { addVault, vaultsFilePath, listVaults, VaultError } from '../../src/lib/vaults.js';
import {
  addConnection,
  listConnections,
  readConnections,
  removeConnection,
  markStale,
  connectionsPath,
  writeConnections,
} from '../../src/lib/connections.js';

function makeHome(): string {
  const dir = join(tmpdir(), `dc-conn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a registered project dir; returns its context root. */
function makeVault(base: string, name: string, home: string): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  addVault(name, projectRoot, home);
  return join(projectRoot, '_dream_context');
}

describe('connections (federation P2.1)', () => {
  let home: string;
  let base: string;

  beforeEach(() => {
    home = makeHome();
    base = makeHome();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('round-trips a connection through read/write', () => {
    const cur = makeVault(base, 'cur', home);
    makeVault(base, 'peer', home);
    addConnection(cur, 'cur', 'peer', 'both', ['auth', 'billing'], home);

    const conns = listConnections(cur);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({
      vault: 'peer',
      direction: 'both',
      topics: ['auth', 'billing'],
      status: 'active',
      last_synced_at: null,
    });
  });

  it('rejects a self-connect by name with a VaultError', () => {
    const cur = makeVault(base, 'cur', home);
    expect(() => addConnection(cur, 'cur', 'cur', 'both', null, home)).toThrow(VaultError);
  });

  it('rejects a self-connect by resolved path (peer name differs, points back here)', () => {
    // Build the cur vault directory and register 'cur' via makeVault.
    const cur = makeVault(base, 'cur', home);
    // Simulate a hand-edited registry: write a second entry 'alias' pointing at
    // the exact same project root, bypassing addVault's duplicate-path guard.
    const curProjectRoot = resolve(join(base, 'cur'));
    const registryPath = vaultsFilePath(home);
    const existing = listVaults(home);
    writeFileSync(
      registryPath,
      JSON.stringify({ vaults: [...existing, { name: 'alias', path: curProjectRoot }] }, null, 2) +
        '\n',
      'utf-8',
    );
    expect(() => addConnection(cur, 'cur', 'alias', 'both', null, home)).toThrow(VaultError);
  });

  it('rejects an unknown (unregistered) vault', () => {
    const cur = makeVault(base, 'cur', home);
    expect(() => addConnection(cur, 'cur', 'ghost', 'both', null, home)).toThrow(VaultError);
  });

  it('rejects an invalid direction', () => {
    const cur = makeVault(base, 'cur', home);
    makeVault(base, 'peer', home);
    // @ts-expect-error — deliberately wrong direction at the boundary
    expect(() => addConnection(cur, 'cur', 'peer', 'sideways', null, home)).toThrow(VaultError);
  });

  it('malformed .connections.json reads as empty (never throws)', () => {
    const cur = makeVault(base, 'cur', home);
    writeFileSync(connectionsPath(cur), '{not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readConnections(cur)).toEqual({ version: 1, connections: [] });
  });

  it('filters malformed individual entries on read', () => {
    const cur = makeVault(base, 'cur', home);
    writeConnections(cur, {
      version: 1,
      // @ts-expect-error — crafting a mixed-validity file on purpose
      connections: [
        { vault: 'good', direction: 'out', topics: null, last_synced_at: null, status: 'active' },
        { vault: 'bad', direction: 'nope' },
        { direction: 'out' },
        null,
      ],
    });
    const conns = listConnections(cur);
    expect(conns.map((c) => c.vault)).toEqual(['good']);
  });

  it('upsert preserves last_synced_at across an edit', () => {
    const cur = makeVault(base, 'cur', home);
    makeVault(base, 'peer', home);
    addConnection(cur, 'cur', 'peer', 'out', null, home);

    // Simulate a sync having advanced the watermark.
    const file = readConnections(cur);
    file.connections[0].last_synced_at = '2026-06-01T00:00:00.000Z';
    writeConnections(cur, file);

    // Re-connect with a new direction/topics — the watermark must survive.
    addConnection(cur, 'cur', 'peer', 'both', ['x'], home);
    const after = listConnections(cur)[0];
    expect(after.direction).toBe('both');
    expect(after.topics).toEqual(['x']);
    expect(after.last_synced_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('removeConnection returns true/false and never throws', () => {
    const cur = makeVault(base, 'cur', home);
    makeVault(base, 'peer', home);
    addConnection(cur, 'cur', 'peer', 'out', null, home);
    expect(removeConnection(cur, 'peer')).toBe(true);
    expect(removeConnection(cur, 'peer')).toBe(false);
    expect(listConnections(cur)).toHaveLength(0);
  });

  it('markStale flips status to stale (idempotent)', () => {
    const cur = makeVault(base, 'cur', home);
    makeVault(base, 'peer', home);
    addConnection(cur, 'cur', 'peer', 'both', null, home);
    expect(markStale(cur, 'peer')).toBe(true);
    expect(listConnections(cur)[0].status).toBe('stale');
    expect(markStale(cur, 'peer')).toBe(false); // already stale
    expect(markStale(cur, 'absent')).toBe(false);
  });
});
