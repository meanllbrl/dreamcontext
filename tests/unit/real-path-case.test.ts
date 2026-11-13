import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realPath } from '../../src/lib/real-path.js';
import { findRegisteredVault, vaultNameForContextRoot } from '../../src/lib/app-link.js';
import { resolveProject } from '../../src/lib/apps/client.js';

/**
 * One folder, two spellings (owner 2026-11-13, app-kurulum-claude): the registry held
 * `/Users/x/Projects/kitup-dreamco` and an agent ran `apps install` from `/Users/x/projects/kitup-dreamco`.
 * On a case-insensitive disk that is the same folder, so no command may answer
 * `project_not_registered`. The cases only exist on such a disk; elsewhere they are skipped.
 */

let scratch: string;
let home: string;

beforeEach(() => {
  scratch = realPath(mkdtempSync(join(tmpdir(), 'dc-case-')));
  home = mkdtempSync(join(tmpdir(), 'dc-case-home-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function caseInsensitiveDisk(): boolean {
  const probe = join(scratch, 'CaseProbe');
  mkdirSync(probe);
  return existsSync(join(scratch, 'caseprobe'));
}

function project(): { real: string; lower: string } {
  const real = join(scratch, 'Projects', 'Kitup-Dreamco');
  mkdirSync(join(real, '_dream_context'), { recursive: true });
  return { real, lower: join(scratch, 'projects', 'kitup-dreamco') };
}

function register(path: string): void {
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'kitup', path }] }));
}

describe('realPath answers with the on-disk spelling', () => {
  it('returns the real case for a differently spelled path, and throws for a missing one', () => {
    const { real, lower } = project();
    if (caseInsensitiveDisk()) expect(realPath(lower)).toBe(real);
    expect(realPath(real)).toBe(real);
    expect(() => realPath(join(scratch, 'nope'))).toThrow();
  });
});

describe('a registered project is found however its folder is spelled', () => {
  it('names the vault for a lower-case spelling of the registered path', () => {
    if (!caseInsensitiveDisk()) return;
    const { real, lower } = project();
    register(real);
    expect(vaultNameForContextRoot(join(lower, '_dream_context'), home)).toBe('kitup');
    expect(findRegisteredVault(join(lower, '_dream_context'), home)?.name).toBe('kitup');
  });

  it('names the vault when the REGISTRY holds the other spelling', () => {
    if (!caseInsensitiveDisk()) return;
    const { real, lower } = project();
    register(lower);
    expect(vaultNameForContextRoot(join(real, '_dream_context'), home)).toBe('kitup');
  });

  it('`dreamcontext apps …` resolves the project from a differently spelled cwd (no project_not_registered)', () => {
    if (!caseInsensitiveDisk()) return;
    const { real, lower } = project();
    register(real);
    const ref = resolveProject(lower, home);
    expect(ref.vault).toBe('kitup');
  });
});

describe('stored state keeps its key across the realPath change (review r1)', () => {
  it('a per-project key hashes the path as given, so a vault registered under another spelling keeps its data', async () => {
    if (!caseInsensitiveDisk()) return;
    const { real, lower } = project();
    const { keyPath } = await import('../../src/lib/real-path.js');
    const { projectKey } = await import('../../src/lib/local-store.js');
    const { appHash } = await import('../../src/lib/apps/bundle.js');
    const { realpathSync } = await import('node:fs');
    expect(keyPath(lower)).toBe(realpathSync(lower));
    expect(keyPath(lower)).not.toBe(realPath(lower));
    const { createHash } = await import('node:crypto');
    expect(projectKey(lower)).toBe(createHash('sha256').update(realpathSync(lower), 'utf8').digest('hex').slice(0, 16));
    expect(appHash(lower, 'tahmin')).not.toBe(appHash(real, 'tahmin'));
  });

  it('the same folder under two spellings is registered once', async () => {
    if (!caseInsensitiveDisk()) return;
    const { real, lower } = project();
    const { addVault } = await import('../../src/lib/vaults.js');
    addVault('ilk', real, home);
    expect(() => addVault('ikinci', lower, home)).toThrow(/already registered/);
  });
});
