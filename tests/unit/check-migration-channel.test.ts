/**
 * Beta brain safety (plan npmsiz-beta C12a): a beta publish fails while the migration registry
 * holds a step above the current stable, unless the owner allows it for that publish.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs release script, no type declarations
import { checkMigrationChannel, migrationVersions } from '../../scripts/check-migration-channel.mjs';
import { REGISTRY } from '../../src/migrations/index.js';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-migration-channel.mjs');

describe('migrationVersions', () => {
  it('reads exactly the REGISTRY\'s versions from the file names (a new step needs both)', () => {
    expect([...migrationVersions()].sort()).toEqual(REGISTRY.map((m) => m.version).sort());
  });
});

describe('checkMigrationChannel', () => {
  const versions = ['0.40.2', '0.41.0', '0.42.1'];
  it('passes a beta with no step above stable', () => {
    expect(checkMigrationChannel({ stable: '0.42.1', versions })).toEqual({ ok: true, above: [] });
  });
  it('fails a beta with a step above stable, and names it', () => {
    expect(checkMigrationChannel({ stable: '0.41.5', versions })).toEqual({ ok: false, above: ['0.42.1'] });
  });
  it('passes it with the owner\'s allow-migration-in-beta', () => {
    expect(checkMigrationChannel({ stable: '0.41.5', versions, allow: true })).toEqual({ ok: true, above: ['0.42.1'] });
  });
  it('refuses a stable version that is not a plain X.Y.Z', () => {
    expect(() => checkMigrationChannel({ stable: 'v0.41.5', versions })).toThrow(/X\.Y\.Z/);
  });
});

describe('the CLI', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
  it('exits 1 on a step above stable, 0 with --allow, 0 with none, 2 on bad usage', () => {
    expect(run('--stable', '0.0.1').status).toBe(1);
    expect(run('--stable', '0.0.1', '--allow').status).toBe(0);
    expect(run('--stable', '999.0.0').status).toBe(0);
    expect(run().status).toBe(2);
    expect(run('--stable', '1.0.0', '--yes').status).toBe(2);
  });
});
