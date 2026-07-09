import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readSetupConfig,
  updateSetupConfig,
  writeSetupConfig,
  type SetupConfig,
} from '../../src/lib/setup-config.js';

function makeProjectRoot(): string {
  const dir = join(tmpdir(), `dc-linkedrepos-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  return dir;
}

function configPath(root: string): string {
  return join(root, '_dream_context', 'state', '.config.json');
}

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.15.0',
  disableNativeMemory: true,
};

describe('setup-config linkedRepos field', () => {
  let root: string;

  beforeEach(() => {
    root = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a .config.json containing linkedRepos through read -> update -> read UNCHANGED', () => {
    const linkedRepos = [
      { name: 'api', gitRemoteUrl: 'https://github.com/acme/api.git' },
      { name: 'web', gitRemoteUrl: 'https://github.com/acme/web.git' },
    ];
    writeSetupConfig(root, { ...BASE, linkedRepos });
    expect(readSetupConfig(root)?.linkedRepos).toEqual(linkedRepos);

    // updateSetupConfig with an UNRELATED patch must leave linkedRepos untouched
    // (both readSetupConfig and updateSetupConfig rebuild field-by-field, so
    // linkedRepos must be explicitly threaded through both).
    updateSetupConfig(root, { disableNativeMemory: false });
    expect(readSetupConfig(root)?.linkedRepos).toEqual(linkedRepos);
  });

  it('updateSetupConfig can set linkedRepos without clobbering other fields', () => {
    writeSetupConfig(root, { ...BASE, packs: ['core'] });
    const linkedRepos = [{ name: 'api', gitRemoteUrl: 'https://github.com/acme/api.git' }];
    updateSetupConfig(root, { linkedRepos });
    const cfg = readSetupConfig(root);
    expect(cfg?.linkedRepos).toEqual(linkedRepos);
    expect(cfg?.packs).toEqual(['core']);
  });

  it('a hand-injected path key on an entry is STRIPPED by sanitizeLinkedRepos', () => {
    writeFileSync(
      configPath(root),
      JSON.stringify({
        ...BASE,
        linkedRepos: [
          { name: 'api', gitRemoteUrl: 'https://github.com/acme/api.git', path: '/Users/alice/code/api' },
        ],
      }) + '\n',
    );
    const cfg = readSetupConfig(root);
    expect(cfg?.linkedRepos).toEqual([{ name: 'api', gitRemoteUrl: 'https://github.com/acme/api.git' }]);
    // The path field must never survive a read.
    expect(JSON.stringify(cfg?.linkedRepos)).not.toContain('path');
    expect(JSON.stringify(cfg?.linkedRepos)).not.toContain('/Users/alice');
  });

  it('Shared linkedRepos entries provably carry name + gitRemoteUrl only after any write', () => {
    updateSetupConfig(root, { linkedRepos: [{ name: 'api', gitRemoteUrl: 'https://github.com/acme/api.git' }] });
    const onDisk = JSON.parse(readFileSync(configPath(root), 'utf-8'));
    expect(onDisk.linkedRepos).toHaveLength(1);
    expect(Object.keys(onDisk.linkedRepos[0]).sort()).toEqual(['gitRemoteUrl', 'name']);
  });

  it('drops entries missing name or gitRemoteUrl, and non-object entries', () => {
    writeFileSync(
      configPath(root),
      JSON.stringify({
        ...BASE,
        linkedRepos: [
          { name: 'ok', gitRemoteUrl: 'https://github.com/acme/ok.git' },
          { name: 'no-url' },
          { gitRemoteUrl: 'https://github.com/acme/no-name.git' },
          'not-an-object',
          42,
        ],
      }) + '\n',
    );
    expect(readSetupConfig(root)?.linkedRepos).toEqual([{ name: 'ok', gitRemoteUrl: 'https://github.com/acme/ok.git' }]);
  });

  it('absent linkedRepos ⇒ undefined (no migration, never throws)', () => {
    writeSetupConfig(root, BASE);
    expect(readSetupConfig(root)?.linkedRepos).toBeUndefined();
  });

  it('empty linkedRepos array ⇒ undefined (normalized, not [])', () => {
    writeFileSync(configPath(root), JSON.stringify({ ...BASE, linkedRepos: [] }) + '\n');
    expect(readSetupConfig(root)?.linkedRepos).toBeUndefined();
  });

  it('re-canonicalize: linkRepo-style consumers must canonicalize non-canonical stored urls themselves — setup-config stores verbatim strings unchanged', () => {
    // setup-config.ts does NOT canonicalize (it must not import git-sync) — it
    // only sanitizes shape. A non-canonical string round-trips as-is; the
    // linked-repos.ts layer (resolveLinkedRepos / linkRepo) is what canonicalizes.
    const linkedRepos = [{ name: 'api', gitRemoteUrl: 'acme/api' }];
    updateSetupConfig(root, { linkedRepos });
    expect(readSetupConfig(root)?.linkedRepos).toEqual([{ name: 'api', gitRemoteUrl: 'acme/api' }]);
  });
});
